// Candidates API — recruiter ATS candidate pool with dedup-aware create.
//
// Org-scoped via req.authUser.orgId. Permission gating uses
// `candidates.read` and `candidates.write` from the seeded matrix.
//
// Dedup model:
//   - email is normalized to lower-case (citext column already case-insensitive,
//     but we store the normalized form so we can index without depending on
//     downstream readers calling lower()).
//   - phone is normalized to E.164 last-10 (strip country code, all non-digits).
//   - PAN dedup is a future-state hook (column not added in 0010).
//
// POST /candidates returns 409 if any (email, phone) match exists for the
// org, with the existing candidate in the body. The caller can re-POST with
// `confirmDuplicate: true` to bypass the check (e.g. after a recruiter
// explicitly says "yes, this is a different person at the same address").
//
// GET /candidates supports filters: q (free-text on name/title/company),
// skill (skillId), source, location.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  candidateExperiences,
  candidateQualifications,
  candidateResumes,
  candidateSkills,
  candidates,
  db,
  demands,
  jdMatchRuns,
  prospects,
  skills,
  submissions,
} from "@j2w/db";
import { runJdMatch, runJdMatchAgainstOpenDemands } from "../jd-match/engine.js";
import {
  findCandidateByEmail,
  findCandidateByPhone,
  isOfferLetterConfigured,
  type OlCandidateRow,
} from "@j2w/offer-letter-db";
import {
  blobStore,
  extractResumeFields,
  getResumeParseQueue,
  parseDocument,
  ResumeExtractionError,
  type ParsedResume,
} from "@j2w/ingest-shared";

function normalizeEmail(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  return trimmed || null;
}

function normalizePhone(s: string | undefined | null): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // Keep last 10 (Indian format). Falls back to as-is if shorter.
  return digits.slice(-10);
}

const dedupCheckSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(4).max(20).optional(),
}).refine((d) => d.email || d.phone, "either email or phone required");

const parsedExperienceSchema = z.object({
  companyName: z.string().min(1),
  title: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  isCurrent: z.boolean().default(false),
  description: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

const parsedQualificationSchema = z.object({
  degree: z.string().nullable().optional(),
  institution: z.string().nullable().optional(),
  fieldOfStudy: z.string().nullable().optional(),
  yearOfCompletion: z.number().int().nullable().optional(),
  marksOrGrade: z.string().nullable().optional(),
});

const resumeMetaSchema = z.object({
  sha256: z.string().optional(),
  bytes: z.number().int().optional(),
  mime: z.string().optional(),
  filename: z.string().optional(),
  modelUsed: z.string().optional(),
});

const createSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(4).max(20).optional(),
  firstName: z.string().min(1).max(120),
  lastName: z.string().max(120).optional(),
  displayName: z.string().max(240).optional(),
  currentTitle: z.string().max(200).optional(),
  currentCompany: z.string().max(200).optional(),
  totalExperienceYears: z.number().min(0).max(50).optional(),
  currentCtcLakhs: z.number().min(0).optional(),
  expectedCtcLakhs: z.number().min(0).optional(),
  noticePeriodDays: z.number().int().min(0).max(365).optional(),
  noticePeriodNegotiable: z.boolean().optional(),
  currentLocation: z.string().max(120).optional(),
  preferredLocations: z.array(z.string().max(120)).default([]),
  linkedinUrl: z.string().url().optional(),
  naukriProfileUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  summary: z.string().max(10_000).optional(),
  source: z.enum(["naukri", "linkedin", "referral", "direct", "internal_db", "imported", "other"]).default("direct"),
  skillIds: z.array(z.string().uuid()).default([]),
  confirmDuplicate: z.boolean().default(false),
  // Resume-from-preview attachment (Flow B: parse-resume-preview → user submits create form).
  resumeBlobKey: z.string().max(500).optional(),
  parsedResumeJson: z.record(z.unknown()).optional(),
  resumeMeta: resumeMetaSchema.optional(),
  experiences: z.array(parsedExperienceSchema).optional(),
  qualifications: z.array(parsedQualificationSchema).optional(),
  skillNames: z.array(z.string().min(1)).optional(),
});

const patchSchema = createSchema
  .partial()
  .omit({
    confirmDuplicate: true,
    resumeBlobKey: true,
    parsedResumeJson: true,
    resumeMeta: true,
    experiences: true,
    qualifications: true,
    skillNames: true,
  });

const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  source: z.string().optional(),
  skillId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

async function findDedupMatches(orgId: string, normEmail: string | null, normPhone: string | null) {
  const conds = [];
  if (normEmail) conds.push(eq(candidates.emailNormalized, normEmail));
  if (normPhone) conds.push(eq(candidates.phoneE164Normalized, normPhone));
  if (conds.length === 0) return [];

  return db
    .select({
      id: candidates.id,
      displayName: candidates.displayName,
      email: candidates.email,
      phone: candidates.phone,
      currentTitle: candidates.currentTitle,
      currentCompany: candidates.currentCompany,
      totalExperienceYears: candidates.totalExperienceYears,
      createdAt: candidates.createdAt,
    })
    .from(candidates)
    .where(and(eq(candidates.orgId, orgId), or(...conds)!))
    .limit(5);
}

// On a dedup-check miss, ask the Offer Letter MySQL whether the candidate
// already exists there. If yes, mirror the row into our local candidates
// table with `external_offer_letter_user_id` populated. Returns the new
// local rows so the caller can include them in the dedup response.
//
// We only mirror when local lookup found nothing — this avoids re-mirroring
// the same OL candidate every time a recruiter dedup-checks the same email.
// Any subsequent dedup-check will hit the local row first.
async function mirrorOfferLetterCandidates(
  orgId: string,
  normEmail: string | null,
  normPhone: string | null,
): Promise<
  Array<{
    id: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    currentTitle: string | null;
    currentCompany: string | null;
    totalExperienceYears: string | null;
    createdAt: Date;
  }>
> {
  if (!isOfferLetterConfigured()) return [];

  const olRows: OlCandidateRow[] = [];
  if (normEmail) {
    try {
      olRows.push(...(await findCandidateByEmail(normEmail)));
    } catch {
      // OL hiccup shouldn't block dedup; local-only result still lands.
      return [];
    }
  }
  if (normPhone) {
    try {
      const phoneHits = await findCandidateByPhone(normPhone);
      // Avoid duplicates if email and phone hit the same MySQL user.
      for (const h of phoneHits) {
        if (!olRows.some((e) => e.id === h.id)) olRows.push(h);
      }
    } catch {
      // ignore — return what we have
    }
  }
  if (olRows.length === 0) return [];

  // Skip MySQL hits that are already mirrored locally.
  const existing = await db
    .select({ id: candidates.id, externalId: candidates.externalOfferLetterUserId })
    .from(candidates)
    .where(
      and(
        eq(candidates.orgId, orgId),
        inArray(
          candidates.externalOfferLetterUserId,
          olRows.map((r) => r.id),
        ),
      ),
    );
  const alreadyMirrored = new Set(existing.map((e) => e.externalId));
  const fresh = olRows.filter((r) => !alreadyMirrored.has(r.id));
  if (fresh.length === 0) return [];

  const inserted: Array<typeof candidates.$inferSelect> = [];
  for (const row of fresh) {
    const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email;
    const phoneNorm = row.contact_phone ? normalizePhone(row.contact_phone) : null;
    try {
      const [created] = await db
        .insert(candidates)
        .values({
          orgId,
          email: row.email ?? null,
          emailNormalized: row.email ? row.email.trim().toLowerCase() : null,
          phone: row.contact_phone ?? null,
          phoneE164Normalized: phoneNorm,
          firstName: row.first_name ?? null,
          lastName: row.last_name ?? null,
          displayName: displayName ?? "(no name)",
          totalExperienceYears: row.total_experience ?? null,
          currentCtcLakhs: row.current_ctc ?? null,
          expectedCtcLakhs: row.expected_ctc ?? null,
          noticePeriodDays: parseNoticePeriodDays(row.notice_period),
          source: "internal_db",
          externalOfferLetterUserId: row.id,
          metadata: { mirroredFromOfferLetter: true, mirroredAt: new Date().toISOString() },
        })
        .returning();
      inserted.push(created);
    } catch {
      // Race: another request mirrored the same row. Ignore and continue.
    }
  }

  return inserted.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    email: c.email,
    phone: c.phone,
    currentTitle: c.currentTitle,
    currentCompany: c.currentCompany,
    totalExperienceYears: c.totalExperienceYears,
    createdAt: c.createdAt,
  }));
}

// LLM returns "YYYY" or "YYYY-MM" or "YYYY-MM-DD". Postgres `date` columns
// require a full ISO date — pad month/year-only forms to the first of the
// month / first of January, returning null for anything we can't parse.
function normalizeDateForDb(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return null;
  const yyyy = m[1];
  const mm = m[2] ?? "01";
  const dd = m[3] ?? "01";
  return `${yyyy}-${mm}-${dd}`;
}

// Resolve case-insensitive skill names against the existing taxonomy and
// attach matches to the candidate. Unmatched names are returned so the
// caller can stash them in parsedResumeJson for visibility. We don't
// auto-create skill rows — that would pollute the taxonomy with hallucinated
// or non-canonical names.
async function attachSkillsByName(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  candidateId: string,
  names: string[],
): Promise<{ matched: number; unmatched: string[] }> {
  const lowerNames = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean).map((n) => n.toLowerCase())));
  if (lowerNames.length === 0) return { matched: 0, unmatched: [] };

  const taxonomyRows = await tx
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(inArray(sql`lower(${skills.name})`, lowerNames));

  const matchedLower = new Set(taxonomyRows.map((r) => r.name.toLowerCase()));
  const unmatched = lowerNames.filter((n) => !matchedLower.has(n));

  if (taxonomyRows.length > 0) {
    await tx
      .insert(candidateSkills)
      .values(taxonomyRows.map((r) => ({ candidateId, skillId: r.id })))
      .onConflictDoNothing();
  }

  return { matched: taxonomyRows.length, unmatched };
}

// Best-effort parse of a free-text notice-period string ("30 days", "2 months",
// "Immediate") into days.
function parseNoticePeriodDays(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/(immediate|0 day|already serving)/.test(t)) return 0;
  const m = t.match(/(\d+)\s*(day|month|week)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2].startsWith("month")) return n * 30;
  if (m[2].startsWith("week")) return n * 7;
  return n;
}

const ALLOWED_RESUME_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/markdown",
]);
const ALLOWED_RESUME_EXTS = new Set(["pdf", "docx", "doc", "txt", "md"]);
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

function isAllowedResumeFile(mime: string | undefined, filename: string | undefined): boolean {
  if (mime && ALLOWED_RESUME_MIMES.has(mime.toLowerCase())) return true;
  if (mime && mime.toLowerCase().startsWith("text/")) return true;
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  return ALLOWED_RESUME_EXTS.has(ext);
}

interface IngestedResume {
  key: string;
  sha256: string;
  bytes: number;
  mime: string;
  filename: string;
  parsed: ParsedResume;
  modelUsed: string;
  parseMeta: { pages?: number; warnings?: string[] };
}

// Shared multipart → blob → parse → LLM extract pipeline. Sends the error
// reply directly when something goes wrong; the caller checks the return
// value (null = error already sent).
async function ingestResume(req: FastifyRequest, reply: FastifyReply): Promise<IngestedResume | null> {
  if (!req.isMultipart()) {
    void reply.code(400).send({ error: "expected_multipart" });
    return null;
  }
  const part = await req.file({ limits: { fileSize: MAX_RESUME_BYTES } });
  if (!part) {
    void reply.code(400).send({ error: "no_file" });
    return null;
  }
  if (!isAllowedResumeFile(part.mimetype, part.filename)) {
    void reply.code(415).send({
      error: "unsupported_media_type",
      hint: "Upload a PDF, DOCX, DOC, TXT, or MD file.",
    });
    return null;
  }
  let buf: Buffer;
  try {
    buf = await part.toBuffer();
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "FST_REQ_FILE_TOO_LARGE" || part.file.truncated) {
      void reply.code(413).send({ error: "file_too_large", maxBytes: MAX_RESUME_BYTES });
      return null;
    }
    throw err;
  }
  if (part.file.truncated) {
    void reply.code(413).send({ error: "file_too_large", maxBytes: MAX_RESUME_BYTES });
    return null;
  }

  const { key, sha256, bytes } = await blobStore.put(buf);
  const { text, meta } = await parseDocument(buf, part.mimetype, part.filename);

  if (text.trim().length < 50) {
    void reply.code(422).send({
      error: "unparseable_resume",
      blobKey: key,
      hint: "Could not extract enough text from this file. Try a different format or a higher-quality scan.",
    });
    return null;
  }

  try {
    const { parsed, modelUsed } = await extractResumeFields(text, req.log);
    return {
      key,
      sha256,
      bytes,
      mime: part.mimetype || "application/octet-stream",
      filename: part.filename ?? "resume",
      parsed,
      modelUsed,
      parseMeta: meta,
    };
  } catch (err) {
    if (err instanceof ResumeExtractionError && err.code === "openai_not_configured") {
      void reply.code(503).send({ error: "openai_not_configured" });
      return null;
    }
    req.log.error({ err: (err as Error).message }, "resume_extract_failed");
    void reply.code(502).send({ error: "extraction_failed" });
    return null;
  }
}

export async function candidatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---------- LIST ----------
  app.get("/", { preHandler: [app.requirePermission("candidates.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });

    const wheres = [eq(candidates.orgId, ctx.orgId)];
    if (parsed.data.q) {
      const like = `%${parsed.data.q}%`;
      wheres.push(
        or(
          ilike(candidates.displayName, like),
          ilike(candidates.firstName, like),
          ilike(candidates.lastName, like),
          ilike(candidates.currentTitle, like),
          ilike(candidates.currentCompany, like),
        )!,
      );
    }
    if (parsed.data.source) {
      wheres.push(eq(candidates.source, parsed.data.source as "direct"));
    }

    let candidateIdsBySkill: string[] | null = null;
    if (parsed.data.skillId) {
      const rows = await db
        .select({ candidateId: candidateSkills.candidateId })
        .from(candidateSkills)
        .where(eq(candidateSkills.skillId, parsed.data.skillId));
      candidateIdsBySkill = rows.map((r) => r.candidateId);
      if (candidateIdsBySkill.length === 0) return { candidates: [] };
      wheres.push(inArray(candidates.id, candidateIdsBySkill));
    }

    const rows = await db
      .select({
        id: candidates.id,
        displayName: candidates.displayName,
        email: candidates.email,
        phone: candidates.phone,
        currentTitle: candidates.currentTitle,
        currentCompany: candidates.currentCompany,
        totalExperienceYears: candidates.totalExperienceYears,
        currentCtcLakhs: candidates.currentCtcLakhs,
        expectedCtcLakhs: candidates.expectedCtcLakhs,
        noticePeriodDays: candidates.noticePeriodDays,
        currentLocation: candidates.currentLocation,
        source: candidates.source,
        createdAt: candidates.createdAt,
      })
      .from(candidates)
      .where(and(...wheres))
      .orderBy(desc(candidates.createdAt))
      .limit(parsed.data.limit);

    return { candidates: rows };
  });

  // ---------- DEDUP CHECK ----------
  app.post("/dedup-check", { preHandler: [app.requirePermission("candidates.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = dedupCheckSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const normEmail = normalizeEmail(parsed.data.email);
    const normPhone = normalizePhone(parsed.data.phone);

    const localMatches = await findDedupMatches(ctx.orgId, normEmail, normPhone);

    // If local has nothing, see if Offer Letter MySQL has the candidate
    // and mirror them into our table. Subsequent dedup-checks for this
    // email/phone hit the local row first.
    let mirroredMatches: typeof localMatches = [];
    if (localMatches.length === 0) {
      mirroredMatches = await mirrorOfferLetterCandidates(ctx.orgId, normEmail, normPhone);
    }

    const matches = [...localMatches, ...mirroredMatches];
    if (matches.length === 0) return { matches: [] };

    const submissionRows = await db
      .select({ candidateId: submissions.candidateId, count: sql<number>`count(*)::int`.as("count") })
      .from(submissions)
      .where(and(inArray(submissions.candidateId, matches.map((m) => m.id)), eq(submissions.status, "active")))
      .groupBy(submissions.candidateId);
    const counts = new Map(submissionRows.map((r) => [r.candidateId, r.count]));

    return {
      matches: matches.map((m) => ({
        ...m,
        activeSubmissionCount: counts.get(m.id) ?? 0,
        sourceFromOfferLetter: mirroredMatches.some((mm) => mm.id === m.id),
      })),
    };
  });

  // ---------- CREATE ----------
  app.post("/", { preHandler: [app.requirePermission("candidates.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const d = parsed.data;
    const normEmail = normalizeEmail(d.email);
    const normPhone = normalizePhone(d.phone);

    if (!d.confirmDuplicate) {
      const matches = await findDedupMatches(ctx.orgId, normEmail, normPhone);
      if (matches.length > 0) {
        return reply.code(409).send({
          error: "duplicate_candidate",
          matches,
          hint: "Re-post with confirmDuplicate=true to create anyway.",
        });
      }
    }

    // resumeBlobKey + parsedResumeJson must travel together — they're the
    // output of the /parse-resume-preview endpoint and only that endpoint.
    if (d.resumeBlobKey && (!d.parsedResumeJson || !d.resumeMeta)) {
      return reply.code(400).send({
        error: "invalid_payload",
        hint: "resumeBlobKey requires parsedResumeJson and resumeMeta from /parse-resume-preview.",
      });
    }

    const displayName = d.displayName ?? `${d.firstName}${d.lastName ? " " + d.lastName : ""}`;

    const candidateId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(candidates)
        .values({
          orgId: ctx.orgId,
          email: d.email ?? null,
          emailNormalized: normEmail,
          phone: d.phone ?? null,
          phoneE164Normalized: normPhone,
          firstName: d.firstName,
          lastName: d.lastName ?? null,
          displayName,
          currentTitle: d.currentTitle ?? null,
          currentCompany: d.currentCompany ?? null,
          totalExperienceYears: d.totalExperienceYears != null ? String(d.totalExperienceYears) : null,
          currentCtcLakhs: d.currentCtcLakhs != null ? String(d.currentCtcLakhs) : null,
          expectedCtcLakhs: d.expectedCtcLakhs != null ? String(d.expectedCtcLakhs) : null,
          noticePeriodDays: d.noticePeriodDays ?? null,
          noticePeriodNegotiable: d.noticePeriodNegotiable ?? null,
          currentLocation: d.currentLocation ?? null,
          preferredLocations: d.preferredLocations,
          linkedinUrl: d.linkedinUrl ?? null,
          naukriProfileUrl: d.naukriProfileUrl ?? null,
          githubUrl: d.githubUrl ?? null,
          summary: d.summary ?? null,
          source: d.source,
          resumeBlobKey: d.resumeBlobKey ?? null,
          parsedResumeJson: d.parsedResumeJson ?? null,
        })
        .returning({ id: candidates.id });

      if (d.skillIds.length > 0) {
        await tx
          .insert(candidateSkills)
          .values(d.skillIds.map((skillId) => ({ candidateId: row.id, skillId })))
          .onConflictDoNothing();
      }

      if (d.experiences && d.experiences.length > 0) {
        await tx.insert(candidateExperiences).values(
          d.experiences.map((e) => ({
            candidateId: row.id,
            companyName: e.companyName,
            title: e.title ?? null,
            startDate: normalizeDateForDb(e.startDate ?? null),
            endDate: e.isCurrent ? null : normalizeDateForDb(e.endDate ?? null),
            isCurrent: e.isCurrent,
            description: e.description ?? null,
          })),
        );
      }

      if (d.qualifications && d.qualifications.length > 0) {
        await tx.insert(candidateQualifications).values(
          d.qualifications.map((q) => ({
            candidateId: row.id,
            degree: q.degree ?? null,
            institution: q.institution ?? null,
            fieldOfStudy: q.fieldOfStudy ?? null,
            yearOfCompletion: q.yearOfCompletion ?? null,
            marksOrGrade: q.marksOrGrade ?? null,
          })),
        );
      }

      if (d.skillNames && d.skillNames.length > 0) {
        await attachSkillsByName(tx, row.id, d.skillNames);
      }

      if (d.resumeBlobKey && d.resumeMeta && d.parsedResumeJson) {
        await tx.insert(candidateResumes).values({
          candidateId: row.id,
          blobKey: d.resumeBlobKey,
          sha256: d.resumeMeta.sha256 ?? null,
          bytes: d.resumeMeta.bytes ?? null,
          mime: d.resumeMeta.mime ?? null,
          originalFilename: d.resumeMeta.filename ?? null,
          parsedResumeJson: d.parsedResumeJson,
          modelUsed: d.resumeMeta.modelUsed ?? null,
          uploadedByUserId: ctx.id,
        });
      }

      return row.id;
    });

    return { candidateId };
  });

  // ---------- DETAIL ----------
  app.get("/:id", { preHandler: [app.requirePermission("candidates.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [c] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)));
    if (!c) return reply.code(404).send({ error: "candidate_not_found" });

    const skillRows = await db
      .select({
        skillId: skills.id,
        name: skills.name,
        proficiencyLevel: candidateSkills.proficiencyLevel,
        yearsOfExperience: candidateSkills.yearsOfExperience,
      })
      .from(candidateSkills)
      .innerJoin(skills, eq(skills.id, candidateSkills.skillId))
      .where(eq(candidateSkills.candidateId, id));

    const expRows = await db
      .select()
      .from(candidateExperiences)
      .where(eq(candidateExperiences.candidateId, id))
      .orderBy(desc(candidateExperiences.startDate));

    const qualRows = await db
      .select()
      .from(candidateQualifications)
      .where(eq(candidateQualifications.candidateId, id));

    const submissionRows = await db
      .select({
        id: submissions.id,
        currentStage: submissions.currentStage,
        submittedAt: submissions.submittedAt,
        status: submissions.status,
        demandId: submissions.demandId,
      })
      .from(submissions)
      .where(eq(submissions.candidateId, id))
      .orderBy(desc(submissions.submittedAt));

    const prospectRows = await db
      .select({
        id: prospects.id,
        status: prospects.status,
        demandId: prospects.demandId,
        recruiterId: prospects.recruiterId,
        createdAt: prospects.createdAt,
        lastContactedAt: prospects.lastContactedAt,
      })
      .from(prospects)
      .where(eq(prospects.candidateId, id))
      .orderBy(desc(prospects.createdAt));

    const resumeRows = await db
      .select({
        id: candidateResumes.id,
        mime: candidateResumes.mime,
        bytes: candidateResumes.bytes,
        originalFilename: candidateResumes.originalFilename,
        modelUsed: candidateResumes.modelUsed,
        createdAt: candidateResumes.createdAt,
      })
      .from(candidateResumes)
      .where(eq(candidateResumes.candidateId, id))
      .orderBy(desc(candidateResumes.createdAt));

    return {
      candidate: c,
      skills: skillRows,
      experiences: expRows,
      qualifications: qualRows,
      submissions: submissionRows,
      prospects: prospectRows,
      resumes: resumeRows,
    };
  });

  // ---------- PATCH ----------
  app.patch("/:id", { preHandler: [app.requirePermission("candidates.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const d = parsed.data;
    if (d.email !== undefined) {
      updates.email = d.email ?? null;
      updates.emailNormalized = normalizeEmail(d.email ?? null);
    }
    if (d.phone !== undefined) {
      updates.phone = d.phone ?? null;
      updates.phoneE164Normalized = normalizePhone(d.phone ?? null);
    }
    if (d.firstName !== undefined) updates.firstName = d.firstName;
    if (d.lastName !== undefined) updates.lastName = d.lastName;
    if (d.displayName !== undefined) updates.displayName = d.displayName;
    if (d.currentTitle !== undefined) updates.currentTitle = d.currentTitle;
    if (d.currentCompany !== undefined) updates.currentCompany = d.currentCompany;
    if (d.totalExperienceYears !== undefined) updates.totalExperienceYears = String(d.totalExperienceYears);
    if (d.currentCtcLakhs !== undefined) updates.currentCtcLakhs = String(d.currentCtcLakhs);
    if (d.expectedCtcLakhs !== undefined) updates.expectedCtcLakhs = String(d.expectedCtcLakhs);
    if (d.noticePeriodDays !== undefined) updates.noticePeriodDays = d.noticePeriodDays;
    if (d.noticePeriodNegotiable !== undefined) updates.noticePeriodNegotiable = d.noticePeriodNegotiable;
    if (d.currentLocation !== undefined) updates.currentLocation = d.currentLocation;
    if (d.preferredLocations !== undefined) updates.preferredLocations = d.preferredLocations;
    if (d.linkedinUrl !== undefined) updates.linkedinUrl = d.linkedinUrl;
    if (d.naukriProfileUrl !== undefined) updates.naukriProfileUrl = d.naukriProfileUrl;
    if (d.githubUrl !== undefined) updates.githubUrl = d.githubUrl;
    if (d.summary !== undefined) updates.summary = d.summary;
    if (d.source !== undefined) updates.source = d.source;

    const result = await db
      .update(candidates)
      .set(updates)
      .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)))
      .returning({ id: candidates.id });
    if (result.length === 0) return reply.code(404).send({ error: "candidate_not_found" });

    return { ok: true };
  });

  // ---------- PARSE RESUME (preview — Flow B) ----------
  // Used by the New Candidate page to autopopulate the form before the
  // candidate row exists. Stores the blob, extracts text, calls OpenAI, and
  // returns the parsed structure. The blob lives until either (a) the user
  // submits the create form, in which case we link it via candidate_resumes
  // in the create handler, or (b) it's left orphaned in the blob store —
  // dedup on sha256 means re-uploads of the same file don't waste storage.
  app.post(
    "/parse-resume-preview",
    { preHandler: [app.requirePermission("candidates.write")] },
    async (req, reply) => {
      const result = await ingestResume(req, reply);
      if (!result) return;
      return {
        blobKey: result.key,
        sha256: result.sha256,
        bytes: result.bytes,
        mime: result.mime,
        filename: result.filename,
        parsed: result.parsed,
        modelUsed: result.modelUsed,
        parseMeta: result.parseMeta,
      };
    },
  );

  // ---------- UPLOAD RESUME (Flow A — to existing candidate) ----------
  // Stores blob, parses, inserts a candidate_resumes history row, fills any
  // null scalar fields on the candidate, and inserts experience /
  // qualification / skill rows from the parse. Re-uploads are allowed and
  // each upload is preserved in candidate_resumes; only the candidates row
  // points at the latest one.
  app.post("/:id/resume", { preHandler: [app.requirePermission("candidates.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [existing] = await db
      .select()
      .from(candidates)
      .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)));
    if (!existing) return reply.code(404).send({ error: "candidate_not_found" });

    const result = await ingestResume(req, reply);
    if (!result) return;

    const p = result.parsed;

    // Non-destructive scalar merge: fill columns that are currently null.
    const updates: Record<string, unknown> = {
      resumeBlobKey: result.key,
      parsedResumeJson: {
        parsed: p,
        parseMeta: result.parseMeta,
        sha256: result.sha256,
        sourceFilename: result.filename,
        parsedAt: new Date().toISOString(),
        modelUsed: result.modelUsed,
      },
      updatedAt: new Date(),
    };
    const merged: string[] = [];
    const tryFill = (col: string, current: unknown, value: unknown) => {
      if ((current === null || current === undefined) && value !== null && value !== undefined && value !== "") {
        updates[col] = value;
        merged.push(col);
      }
    };
    tryFill("firstName", existing.firstName, p.firstName);
    tryFill("lastName", existing.lastName, p.lastName);
    tryFill("currentTitle", existing.currentTitle, p.currentTitle);
    tryFill("currentCompany", existing.currentCompany, p.currentCompany);
    tryFill(
      "totalExperienceYears",
      existing.totalExperienceYears,
      p.totalExperienceYears != null ? String(p.totalExperienceYears) : null,
    );
    tryFill(
      "currentCtcLakhs",
      existing.currentCtcLakhs,
      p.currentCtcLakhs != null ? String(p.currentCtcLakhs) : null,
    );
    tryFill(
      "expectedCtcLakhs",
      existing.expectedCtcLakhs,
      p.expectedCtcLakhs != null ? String(p.expectedCtcLakhs) : null,
    );
    tryFill("noticePeriodDays", existing.noticePeriodDays, p.noticePeriodDays);
    tryFill("currentLocation", existing.currentLocation, p.currentLocation);
    tryFill("summary", existing.summary, p.summary);
    tryFill("linkedinUrl", existing.linkedinUrl, p.linkedinUrl);
    tryFill("githubUrl", existing.githubUrl, p.githubUrl);
    if (!existing.email && p.email) {
      updates.email = p.email;
      updates.emailNormalized = normalizeEmail(p.email);
      merged.push("email");
    }
    if (!existing.phone && p.phone) {
      updates.phone = p.phone;
      updates.phoneE164Normalized = normalizePhone(p.phone);
      merged.push("phone");
    }
    if (!existing.displayName && (p.firstName || p.lastName)) {
      const dn = `${p.firstName ?? ""}${p.lastName ? " " + p.lastName : ""}`.trim();
      if (dn) {
        updates.displayName = dn;
        merged.push("displayName");
      }
    }

    let resumeId = "";
    let matchedSkillCount = 0;
    let unmatchedSkillNames: string[] = [];

    await db.transaction(async (tx) => {
      const [resumeRow] = await tx
        .insert(candidateResumes)
        .values({
          candidateId: id,
          blobKey: result.key,
          sha256: result.sha256,
          bytes: result.bytes,
          mime: result.mime,
          originalFilename: result.filename,
          parsedResumeJson: {
            parsed: p,
            parseMeta: result.parseMeta,
            modelUsed: result.modelUsed,
          },
          modelUsed: result.modelUsed,
          uploadedByUserId: ctx.id,
        })
        .returning({ id: candidateResumes.id });
      resumeId = resumeRow.id;

      await tx.update(candidates).set(updates).where(eq(candidates.id, id));

      if (p.experiences.length > 0) {
        await tx.insert(candidateExperiences).values(
          p.experiences.map((e) => ({
            candidateId: id,
            companyName: e.companyName,
            title: e.title,
            startDate: normalizeDateForDb(e.startDate),
            endDate: e.isCurrent ? null : normalizeDateForDb(e.endDate),
            isCurrent: e.isCurrent,
            description: e.description,
          })),
        );
      }

      if (p.qualifications.length > 0) {
        await tx.insert(candidateQualifications).values(
          p.qualifications.map((q) => ({
            candidateId: id,
            degree: q.degree,
            institution: q.institution,
            fieldOfStudy: q.fieldOfStudy,
            yearOfCompletion: q.yearOfCompletion,
            marksOrGrade: q.marksOrGrade,
          })),
        );
      }

      if (p.skills.length > 0) {
        const res = await attachSkillsByName(
          tx,
          id,
          p.skills.map((s) => s.name),
        );
        matchedSkillCount = res.matched;
        unmatchedSkillNames = res.unmatched;
      }
    });

    return {
      candidateId: id,
      resumeId,
      resumeBlobKey: result.key,
      parsed: p,
      modelUsed: result.modelUsed,
      mergedFields: merged,
      addedExperienceCount: p.experiences.length,
      addedQualificationCount: p.qualifications.length,
      matchedSkillCount,
      unmatchedSkillNames,
    };
  });

  // ---------- STREAM RESUME FILE ----------
  // Auth-checked download of a stored resume blob. Accepts ?token= so
  // <a target="_blank"> links work without forcing a bearer header.
  app.get("/:id/resumes/:resumeId/file", async (req, reply) => {
    const ctx = req.authUser!;
    const { id, resumeId } = req.params as { id: string; resumeId: string };

    const [row] = await db
      .select({
        blobKey: candidateResumes.blobKey,
        mime: candidateResumes.mime,
        originalFilename: candidateResumes.originalFilename,
        bytes: candidateResumes.bytes,
      })
      .from(candidateResumes)
      .innerJoin(candidates, eq(candidates.id, candidateResumes.candidateId))
      .where(
        and(
          eq(candidateResumes.id, resumeId),
          eq(candidateResumes.candidateId, id),
          eq(candidates.orgId, ctx.orgId),
        ),
      );
    if (!row) return reply.code(404).send({ error: "resume_not_found" });

    let buf: Buffer;
    try {
      buf = await blobStore.get(row.blobKey);
    } catch {
      return reply.code(404).send({ error: "blob_missing" });
    }

    const filename = (row.originalFilename ?? "resume").replace(/[\r\n"\\]/g, "");
    return reply
      .header("Content-Type", row.mime ?? "application/octet-stream")
      .header("Content-Disposition", `inline; filename="${filename}"`)
      .send(buf);
  });

  // ---------- REPARSE RESUME (async, queued) ----------
  // Re-parse the candidate's stored latest resume blob via the
  // resume_parse worker. Useful after model upgrades or when the
  // original sync extract failed for transient reasons.
  app.post(
    "/:id/reparse-resume",
    { preHandler: [app.requirePermission("candidates.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const [c] = await db
        .select()
        .from(candidates)
        .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)));
      if (!c) return reply.code(404).send({ error: "candidate_not_found" });

      const [latest] = await db
        .select()
        .from(candidateResumes)
        .where(eq(candidateResumes.candidateId, id))
        .orderBy(desc(candidateResumes.createdAt))
        .limit(1);

      // Fall back to the candidates row's mirror if no history exists.
      const blobKey = latest?.blobKey ?? c.resumeBlobKey ?? null;
      if (!blobKey) {
        return reply.code(409).send({
          error: "no_resume_on_file",
          hint: "Upload a resume before triggering a reparse.",
        });
      }
      const mime = latest?.mime ?? "application/pdf";
      const filename = latest?.originalFilename ?? "resume";

      const jobId = `resume-parse-${id}-${Date.now()}`;
      try {
        await getResumeParseQueue().add(
          jobId,
          { candidateId: id, storageKey: blobKey, mime, filename },
          { jobId },
        );
      } catch (err) {
        req.log.error({ err, candidateId: id }, "resume reparse enqueue failed");
        return reply.code(500).send({ error: "enqueue_failed" });
      }
      return reply.code(202).send({ jobId, candidateId: id });
    },
  );

  // ---------- JD MATCHES ----------
  // Read latest match runs for this candidate. Returns one row per
  // (candidate, demand) — the most recent run wins.
  app.get(
    "/:id/jd-matches",
    { preHandler: [app.requirePermission("candidates.read")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const [c] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)));
      if (!c) return reply.code(404).send({ error: "candidate_not_found" });

      const runs = await db
        .select({
          id: jdMatchRuns.id,
          demandId: jdMatchRuns.demandId,
          demandTitle: demands.title,
          overallScore: jdMatchRuns.overallScore,
          verdict: jdMatchRuns.verdict,
          mustHavesScore: jdMatchRuns.mustHavesScore,
          niceToHavesScore: jdMatchRuns.niceToHavesScore,
          experienceFitScore: jdMatchRuns.experienceFitScore,
          compensationFitScore: jdMatchRuns.compensationFitScore,
          locationFitScore: jdMatchRuns.locationFitScore,
          noticePeriodFitScore: jdMatchRuns.noticePeriodFitScore,
          strengths: jdMatchRuns.strengths,
          gaps: jdMatchRuns.gaps,
          explanation: jdMatchRuns.explanation,
          createdAt: jdMatchRuns.createdAt,
          modelVersion: jdMatchRuns.modelVersion,
        })
        .from(jdMatchRuns)
        .leftJoin(demands, eq(demands.id, jdMatchRuns.demandId))
        .where(eq(jdMatchRuns.candidateId, id))
        .orderBy(desc(jdMatchRuns.createdAt));

      // Latest-per-demand: keep the first occurrence of each demandId.
      const byDemand = new Map<string, typeof runs[number]>();
      for (const r of runs) {
        if (!byDemand.has(r.demandId)) byDemand.set(r.demandId, r);
      }
      return { matches: Array.from(byDemand.values()) };
    },
  );

  // Trigger a fresh match. Body { demandId } scores against one demand;
  // omit demandId to score against every open demand for the org.
  app.post(
    "/:id/jd-matches/run",
    { preHandler: [app.requirePermission("candidates.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { demandId?: string };

      const [c] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)));
      if (!c) return reply.code(404).send({ error: "candidate_not_found" });

      try {
        if (body.demandId) {
          const result = await runJdMatch({
            candidateId: id,
            demandId: body.demandId,
            triggeredBy: "manual",
            triggeredByUserId: ctx.id,
          });
          return { matches: [result] };
        }
        const matches = await runJdMatchAgainstOpenDemands({
          candidateId: id,
          orgId: ctx.orgId,
          triggeredBy: "batch",
          triggeredByUserId: ctx.id,
        });
        return { matches };
      } catch (err) {
        req.log.error({ err, candidateId: id }, "jd-match run failed");
        return reply.code(500).send({ error: "match_failed" });
      }
    },
  );
}
