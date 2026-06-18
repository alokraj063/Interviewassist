// resume_parse worker.
//
// Async resume reparse. The user-driven upload paths in apps/api/src/routes/
// candidates.ts (parse-resume-preview, /:id/resume) parse synchronously
// because the UI needs the structured data inline. This worker handles
// background reparse on existing blobs — useful when:
//
//   - the model is upgraded and we want to re-extract older resumes
//   - the original sync extract failed (e.g. transient OpenAI 5xx) and
//     we want a retry without the user-facing flow
//   - bulk reparse of an org's candidate pool from the platform admin UI
//
// On success, updates `candidates` (non-destructive scalar merge — fills
// nulls only) and inserts a `candidate_resumes` history row. The
// candidate's existing skills/experiences/qualifications are NOT
// overwritten; the worker's job is to refresh the parsed_resume_json
// blob, not to rewrite catalog rows. Rewriting those is the inline
// upload path's responsibility.
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { candidateResumes, candidates, db } from "@j2w/db";
import {
  blobStore,
  extractResumeFields,
  parseDocument,
  ResumeExtractionError,
  type ResumeParseJob,
} from "@j2w/ingest-shared";

interface ParseResult {
  skipped: boolean;
  reason?: string;
  candidateId?: string;
  modelUsed?: string;
}

export async function processResumeParse(
  job: ResumeParseJob,
  log: Logger,
): Promise<ParseResult> {
  const { candidateId, storageKey, mime, filename } = job;

  const [existing] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);
  if (!existing) {
    return { skipped: true, reason: "candidate_not_found" };
  }

  let buf: Buffer;
  try {
    buf = await blobStore.get(storageKey);
  } catch (err) {
    log.warn({ err, storageKey, candidateId }, "blob fetch failed");
    return { skipped: true, reason: "blob_missing" };
  }

  const { text } = await parseDocument(buf, mime, filename);
  if (text.trim().length < 50) {
    log.info({ candidateId, storageKey }, "resume parse: text too short, skipping");
    return { skipped: true, reason: "unparseable" };
  }

  let parsed;
  let modelUsed: string;
  try {
    const result = await extractResumeFields(text, log);
    parsed = result.parsed;
    modelUsed = result.modelUsed;
  } catch (err) {
    if (err instanceof ResumeExtractionError && err.code === "openai_not_configured") {
      log.info({ candidateId }, "resume parse: OPENAI_API_KEY not set — skipping");
      return { skipped: true, reason: "no_openai_key" };
    }
    log.error({ err, candidateId }, "resume parse: extraction failed");
    throw err; // let BullMQ retry
  }

  const parsedResumeJson = {
    parsed,
    sha256: undefined as string | undefined,
    sourceFilename: filename,
    parsedAt: new Date().toISOString(),
    modelUsed,
    parseMeta: undefined as Record<string, unknown> | undefined,
  };

  // Non-destructive scalar merge — only fill candidate columns currently null.
  const updates: Record<string, unknown> = {
    parsedResumeJson,
    updatedAt: new Date(),
  };
  const tryFill = (col: string, current: unknown, value: unknown) => {
    if (
      (current === null || current === undefined) &&
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      updates[col] = value;
    }
  };
  tryFill("firstName", existing.firstName, parsed.firstName);
  tryFill("lastName", existing.lastName, parsed.lastName);
  tryFill("currentTitle", existing.currentTitle, parsed.currentTitle);
  tryFill("currentCompany", existing.currentCompany, parsed.currentCompany);
  tryFill(
    "totalExperienceYears",
    existing.totalExperienceYears,
    parsed.totalExperienceYears != null ? String(parsed.totalExperienceYears) : null,
  );
  tryFill(
    "currentCtcLakhs",
    existing.currentCtcLakhs,
    parsed.currentCtcLakhs != null ? String(parsed.currentCtcLakhs) : null,
  );
  tryFill(
    "expectedCtcLakhs",
    existing.expectedCtcLakhs,
    parsed.expectedCtcLakhs != null ? String(parsed.expectedCtcLakhs) : null,
  );
  tryFill("noticePeriodDays", existing.noticePeriodDays, parsed.noticePeriodDays);
  tryFill("currentLocation", existing.currentLocation, parsed.currentLocation);
  tryFill("summary", existing.summary, parsed.summary);
  tryFill("linkedinUrl", existing.linkedinUrl, parsed.linkedinUrl);
  tryFill("githubUrl", existing.githubUrl, parsed.githubUrl);

  await db.update(candidates).set(updates).where(eq(candidates.id, candidateId));

  try {
    await db.insert(candidateResumes).values({
      candidateId,
      blobKey: storageKey,
      sha256: null,
      bytes: buf.byteLength,
      mime,
      originalFilename: filename,
      parsedResumeJson,
      modelUsed,
      uploadedByUserId: null,
    });
  } catch (err) {
    log.warn({ err, candidateId }, "candidate_resumes history insert failed");
  }

  log.info({ candidateId, modelUsed }, "resume parse complete");
  return { skipped: false, candidateId, modelUsed };
}
