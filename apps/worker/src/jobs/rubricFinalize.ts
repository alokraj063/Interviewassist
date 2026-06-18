// Rubric-finalize worker.
//
// Post-call: pick the call's applicable rubric (org-default or
// linked-via-demand), feed the full transcript to an LLM along with the
// rubric criteria definitions, and persist a row per criterion in
// call_rubric_scores. Also seeds a `pending` call_qa_reviews row so the
// QA queue picks the call up for human review.
//
// No-ops gracefully when OPENAI_API_KEY isn't set (writes a skip note to
// the worker log; QA queue stays empty so reviewers don't see ghosts).
import { and, asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { Logger } from "pino";
import {
  callQaReviews,
  callRubrics,
  callRubricScores,
  callRubricVersions,
  callSessions,
  db,
  transcriptTurns,
  type RubricCriterion,
} from "@j2w/db";
import type { RubricFinalizeJob } from "@j2w/ingest-shared";

interface FinalizeResult {
  rubricId: string | null;
  scoresWritten: number;
  qaReviewCreated: boolean;
  skipped: boolean;
  reason?: string;
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  if (!_client) _client = new OpenAI({ apiKey: key });
  return _client;
}

const SYSTEM = `
You score a recruiter-candidate phone call against a structured rubric.
For each criterion, output a numeric score in [0,100], a band ("fail",
"pass", "excellent") based on the criterion's bandThresholds, a 1–2
sentence rationale, and 0–3 short evidence quotes lifted from the
transcript that support the score. Be faithful — do NOT invent.
`.trim();

function buildSchema(criteria: RubricCriterion[]) {
  return {
    name: "rubric_score",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores"],
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionId", "score", "band", "rationale", "evidenceQuotes"],
            properties: {
              criterionId: { type: "string", enum: criteria.map((c) => c.id) },
              score: { type: "number" },
              band: { type: "string", enum: ["fail", "pass", "excellent"] },
              rationale: { type: "string" },
              evidenceQuotes: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["tsStartMs", "tsEndMs", "text"],
                  properties: {
                    tsStartMs: { type: "number" },
                    tsEndMs: { type: "number" },
                    text: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  } as const;
}

export async function processRubricFinalize(
  data: RubricFinalizeJob,
  log: Logger,
): Promise<FinalizeResult> {
  const { callId } = data;

  // 1) Resolve call + org
  const [call] = await db
    .select({ id: callSessions.id, orgId: callSessions.orgId, recruiterUserId: callSessions.recruiterUserId })
    .from(callSessions)
    .where(eq(callSessions.id, callId))
    .limit(1);
  if (!call?.orgId) {
    return { rubricId: null, scoresWritten: 0, qaReviewCreated: false, skipped: true, reason: "no_call_or_org" };
  }

  // 2) Pick the applicable rubric. Today: the org's default rubric, if any.
  // Future: filter by demand.client_id when call.demandId is set.
  //
  // Pinning: if the rubric has a published_version, score against the frozen
  // call_rubric_versions snapshot (so a later in-flight draft edit doesn't
  // retroactively change what a call was scored against). The 0027 migration
  // backfills a v-row for every published rubric, so this is fallback-safe; if
  // no snapshot resolves we fall back to the mutable head criteria.
  const [head] = await db
    .select({
      id: callRubrics.id,
      name: callRubrics.name,
      criteria: callRubrics.criteria,
      publishedVersion: callRubrics.publishedVersion,
    })
    .from(callRubrics)
    .where(and(eq(callRubrics.orgId, call.orgId), eq(callRubrics.isDefault, true)))
    .limit(1);
  if (!head || head.criteria.length === 0) {
    return { rubricId: null, scoresWritten: 0, qaReviewCreated: false, skipped: true, reason: "no_rubric" };
  }
  let pinnedCriteria = head.criteria;
  if (head.publishedVersion != null) {
    const [snap] = await db
      .select({ criteria: callRubricVersions.criteria })
      .from(callRubricVersions)
      .where(and(eq(callRubricVersions.rubricId, head.id), eq(callRubricVersions.version, head.publishedVersion)))
      .limit(1);
    if (snap && snap.criteria.length > 0) pinnedCriteria = snap.criteria as typeof head.criteria;
  }
  const rubric = { id: head.id, name: head.name, criteria: pinnedCriteria };

  if (!process.env.OPENAI_API_KEY) {
    log.info({ callId, rubricId: rubric.id }, "OPENAI_API_KEY missing — rubric finalize skipped");
    return { rubricId: rubric.id, scoresWritten: 0, qaReviewCreated: false, skipped: true, reason: "no_openai_key" };
  }

  // 3) Pull the full transcript with timestamps for evidence.
  const turns = await db
    .select({
      speaker: transcriptTurns.speaker,
      text: transcriptTurns.text,
      tsStartMs: transcriptTurns.tsStartMs,
      tsEndMs: transcriptTurns.tsEndMs,
    })
    .from(transcriptTurns)
    .where(and(eq(transcriptTurns.callId, callId), eq(transcriptTurns.isFinal, true)))
    .orderBy(asc(transcriptTurns.tsStartMs));

  if (turns.length === 0) {
    return { rubricId: rubric.id, scoresWritten: 0, qaReviewCreated: false, skipped: true, reason: "no_transcript" };
  }

  // Cap the transcript at ~10000 chars to keep token usage bounded; trim from
  // the start so the most recent context is preserved.
  const transcriptText = turns
    .map(
      (t) =>
        `[${t.tsStartMs}ms-${t.tsEndMs}ms ${t.speaker}] ${t.text.replace(/\s+/g, " ")}`,
    )
    .join("\n");
  const truncated =
    transcriptText.length > 10_000 ? transcriptText.slice(-10_000) : transcriptText;

  const criteriaBlock = rubric.criteria
    .map(
      (c) =>
        `- id="${c.id}" name="${c.name}" weight=${c.weight} kind=${c.kind} ` +
        `bands(fail<${c.bandThresholds.fail}, pass>=${c.bandThresholds.pass}, ` +
        `excellent>=${c.bandThresholds.excellent})${c.description ? `\n  desc: ${c.description}` : ""}`,
    )
    .join("\n");

  const userMessage = `Rubric: ${rubric.name}\nCriteria:\n${criteriaBlock}\n\nTranscript:\n${truncated}\n\nRespond with the JSON object per the schema.`;

  let parsed: {
    scores: Array<{
      criterionId: string;
      score: number;
      band: "fail" | "pass" | "excellent";
      rationale: string;
      evidenceQuotes: Array<{ tsStartMs: number; tsEndMs: number; text: string }>;
    }>;
  };
  try {
    const res = await client().chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_schema", json_schema: buildSchema(rubric.criteria) },
      temperature: 0.2,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) throw new Error("empty rubric response");
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error({ err, callId, rubricId: rubric.id }, "rubric LLM call failed");
    return { rubricId: rubric.id, scoresWritten: 0, qaReviewCreated: false, skipped: true, reason: "llm_failed" };
  }

  // 4) Persist rubric scores (one per criterion).
  let scoresWritten = 0;
  for (const s of parsed.scores) {
    try {
      await db
        .insert(callRubricScores)
        .values({
          callId,
          rubricId: rubric.id,
          criterionId: s.criterionId,
          score: String(s.score),
          band: s.band,
          rationale: s.rationale,
          evidenceQuotes: s.evidenceQuotes,
          confidence: null,
          modelVersion: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        })
        .onConflictDoUpdate({
          target: [callRubricScores.callId, callRubricScores.criterionId],
          set: {
            rubricId: rubric.id,
            score: String(s.score),
            band: s.band,
            rationale: s.rationale,
            evidenceQuotes: s.evidenceQuotes,
            modelVersion: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
          },
        });
      scoresWritten += 1;
    } catch (err) {
      log.warn({ err, callId, criterionId: s.criterionId }, "persist rubric score failed");
    }
  }

  // 5) Compute weighted aggregate AI score and seed a pending QA review row.
  const totalWeight = rubric.criteria.reduce((sum, c) => sum + (c.weight ?? 1), 0) || 1;
  const aggregate =
    parsed.scores.reduce((sum, s) => {
      const c = rubric.criteria.find((x) => x.id === s.criterionId);
      const w = c?.weight ?? 1;
      return sum + s.score * w;
    }, 0) / totalWeight;

  let qaReviewCreated = false;
  try {
    // Skip if an existing QA review row already exists (avoid duplicates on retry).
    const [existing] = await db
      .select({ id: callQaReviews.id })
      .from(callQaReviews)
      .where(eq(callQaReviews.callId, callId))
      .limit(1);
    if (!existing) {
      await db.insert(callQaReviews).values({
        callId,
        // Reviewer not assigned yet — the QA route stamps this on first grading.
        reviewerUserId: null,
        orgId: call.orgId,
        decision: "accept", // placeholder — flipped to "override"/"escalate" by reviewer.
        aiScore: String(Math.round(aggregate)),
        reviewerScore: null,
        criterionOverrides: {},
      });
      qaReviewCreated = true;
    }
  } catch (err) {
    log.warn({ err, callId }, "seed pending qa review failed");
  }

  log.info(
    { callId, rubricId: rubric.id, scoresWritten, aggregate: Math.round(aggregate) },
    "rubric finalize complete",
  );
  return { rubricId: rubric.id, scoresWritten, qaReviewCreated, skipped: false };
}
