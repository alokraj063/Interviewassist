// Auto-scoring engine for coaching practice runs.
//
// scoreRun(runId) loads a run → its linked call transcript → the scenario's
// target rubric criteria → asks OpenAI to score each criterion 0..100 with a
// band + one evidence quote, plus strengths/improvements/coach-note. The
// per-criterion rows are persisted into coaching_run_scores (upsert on
// (run_id, criterion_id)); the rollup feedback blob + weighted overall land on
// coaching_runs; scoringStatus flips to 'scored'. A `run.scored` audit row is
// written inside the same transaction as the state change.
//
// Provider wiring mirrors rag/live-rubric.ts: real OpenAI path when
// OPENAI_API_KEY is set, otherwise a DETERMINISTIC stub (seeded by the run id)
// so persistence + UI are fully testable without a key. Never throws to the
// caller — on any error the run is marked scoringStatus='failed' and the
// promise resolves. The route returns 200 with the resulting status (never 500
// from a missing key).
import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import {
  callRubrics,
  coachingAuditEvents,
  coachingRunScores,
  coachingRuns,
  coachingScenarios,
  db,
  transcriptTurns,
  type RubricCriterion,
} from "@j2w/db";
import { chatModel, env } from "../env.js";

export type ScoreResult = {
  status: "scored" | "failed";
  overall: number | null;
  generatedBy: "ai" | "stub";
};

type CriterionScore = {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number;
  band: "fail" | "pass" | "excellent";
  evidence: string;
};

function bandFor(c: RubricCriterion, score: number): "fail" | "pass" | "excellent" {
  const t = c.bandThresholds;
  if (score >= (t?.excellent ?? 80)) return "excellent";
  if (score >= (t?.pass ?? 60)) return "pass";
  return "fail";
}

// Deterministic 0..1 from a string seed — stable per run so the stub path is
// reproducible (tests can assert a numeric score without flakiness).
function seeded(seed: string): number {
  const h = crypto.createHash("sha256").update(seed).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

function stubScores(runId: string, criteria: RubricCriterion[]): {
  perCriterion: CriterionScore[];
  strengths: string[];
  improvements: string[];
  coachNote: string;
} {
  const perCriterion = criteria.map((c, i) => {
    const raw = 55 + Math.floor(seeded(`${runId}:${c.id}:${i}`) * 40); // 55..94
    return {
      criterionId: c.id,
      criterionName: c.name,
      weight: c.weight ?? 1,
      score: raw,
      band: bandFor(c, raw),
      evidence: `Deterministic stub assessment for "${c.name}" (no OPENAI_API_KEY; enable for real scoring).`,
    };
  });
  return {
    perCriterion,
    strengths: [
      "Opened with a warm, on-language hook.",
      "Acknowledged the candidate's main objection before pitching.",
    ],
    improvements: [
      "Probe hidden context earlier in the call.",
      "Confirm a concrete next step before closing.",
    ],
    coachNote: "Stub coach note — connect OPENAI_API_KEY for a graded, transcript-grounded review.",
  };
}

function buildSchema(criteria: RubricCriterion[]) {
  return {
    name: "coaching_run_score",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["scores", "strengths", "improvements", "coachNote"],
      properties: {
        scores: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionId", "score", "band", "evidence"],
            properties: {
              criterionId: { type: "string", enum: criteria.map((c) => c.id) },
              score: { type: "number", minimum: 0, maximum: 100 },
              band: { type: "string", enum: ["fail", "pass", "excellent"] },
              evidence: { type: "string" },
            },
          },
        },
        strengths: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } },
        coachNote: { type: "string" },
      },
    },
  } as const;
}

const SYSTEM = `
You are a recruiting coach scoring a recruiter's PRACTICE call against a
structured rubric. The recruiter spoke with an AI candidate. Score ONLY from
the supplied transcript. For each criterion give a 0..100 score, a band based
on the criterion's thresholds, and one short evidence quote. Then give 2-4
concrete strengths, 2-4 improvements, and a one-paragraph coach note. Be fair
but specific — vague praise helps no one.
`.trim();

async function aiScores(
  runId: string,
  scenarioTitle: string,
  criteria: RubricCriterion[],
  transcript: string,
): Promise<{
  perCriterion: CriterionScore[];
  strengths: string[];
  improvements: string[];
  coachNote: string;
} | null> {
  if (!env.OPENAI_API_KEY) return null;
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const criteriaBlock = criteria
    .map(
      (c) =>
        `- id="${c.id}" name="${c.name}" weight=${c.weight} ` +
        `bands(fail<${c.bandThresholds?.fail}, pass>=${c.bandThresholds?.pass}, excellent>=${c.bandThresholds?.excellent})`,
    )
    .join("\n");
  const resp = await openai.chat.completions.create({
    model: chatModel(),
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: buildSchema(criteria) },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Scenario: ${scenarioTitle}\nCriteria:\n${criteriaBlock}\n\nTranscript:\n${transcript.slice(-8000)}\n\nReturn JSON per the schema.`,
      },
    ],
  });
  const raw = resp.choices[0]?.message?.content;
  if (!raw) return null;
  const parsed = JSON.parse(raw) as {
    scores: Array<{ criterionId: string; score: number; band: "fail" | "pass" | "excellent"; evidence: string }>;
    strengths: string[];
    improvements: string[];
    coachNote: string;
  };
  const byId = new Map(parsed.scores.map((s) => [s.criterionId, s]));
  const perCriterion = criteria.map((c) => {
    const s = byId.get(c.id);
    const score = s ? Math.max(0, Math.min(100, s.score)) : 50;
    return {
      criterionId: c.id,
      criterionName: c.name,
      weight: c.weight ?? 1,
      score,
      band: s?.band ?? bandFor(c, score),
      evidence: s?.evidence ?? "No evidence returned.",
    };
  });
  return {
    perCriterion,
    strengths: parsed.strengths ?? [],
    improvements: parsed.improvements ?? [],
    coachNote: parsed.coachNote ?? "",
  };
}

function weightedOverall(rows: CriterionScore[]): number {
  if (rows.length === 0) return 0;
  const totalW = rows.reduce((a, r) => a + (r.weight || 1), 0) || 1;
  const sum = rows.reduce((a, r) => a + r.score * (r.weight || 1), 0);
  return Math.round(sum / totalW);
}

/**
 * Score a run. Resolves to a ScoreResult; never rejects. `force` re-scores even
 * if already scored. `actorUserId` is recorded on the audit row.
 */
export async function scoreRun(
  runId: string,
  opts: { force?: boolean; actorUserId?: string | null } = {},
): Promise<ScoreResult> {
  try {
    const [run] = await db
      .select({
        id: coachingRuns.id,
        orgId: coachingRuns.orgId,
        scenarioId: coachingRuns.scenarioId,
        callId: coachingRuns.callId,
        scoringStatus: coachingRuns.scoringStatus,
      })
      .from(coachingRuns)
      .where(eq(coachingRuns.id, runId))
      .limit(1);
    if (!run) return { status: "failed", overall: null, generatedBy: "stub" };
    if (run.scoringStatus === "scored" && !opts.force) {
      const overall = await currentOverall(runId);
      return { status: "scored", overall, generatedBy: "stub" };
    }

    const [scenario] = await db
      .select({ title: coachingScenarios.title, targetRubricId: coachingScenarios.targetRubricId })
      .from(coachingScenarios)
      .where(eq(coachingScenarios.id, run.scenarioId))
      .limit(1);

    let criteria: RubricCriterion[] = [];
    if (scenario?.targetRubricId) {
      const [rubric] = await db
        .select({ criteria: callRubrics.criteria })
        .from(callRubrics)
        .where(and(eq(callRubrics.id, scenario.targetRubricId), eq(callRubrics.orgId, run.orgId)))
        .limit(1);
      criteria = (rubric?.criteria ?? []) as RubricCriterion[];
    }
    // Fall back to the org default rubric so a scenario without a pinned rubric
    // still produces per-criterion rows.
    if (criteria.length === 0) {
      const [def] = await db
        .select({ criteria: callRubrics.criteria })
        .from(callRubrics)
        .where(and(eq(callRubrics.orgId, run.orgId), eq(callRubrics.isDefault, true)))
        .limit(1);
      criteria = (def?.criteria ?? []) as RubricCriterion[];
    }
    if (criteria.length === 0) {
      // Nothing to score against. Mark skipped, not failed.
      await db
        .update(coachingRuns)
        .set({ scoringStatus: "skipped", updatedAt: new Date() })
        .where(eq(coachingRuns.id, runId));
      return { status: "failed", overall: null, generatedBy: "stub" };
    }

    let transcript = "";
    if (run.callId) {
      const turns = await db
        .select({ speaker: transcriptTurns.speaker, text: transcriptTurns.text })
        .from(transcriptTurns)
        .where(eq(transcriptTurns.callId, run.callId))
        .orderBy(asc(transcriptTurns.tsStartMs))
        .limit(400);
      transcript = turns.map((t) => `[${t.speaker}] ${t.text}`).join("\n");
    }

    let result: {
      perCriterion: CriterionScore[];
      strengths: string[];
      improvements: string[];
      coachNote: string;
    } | null = null;
    let generatedBy: "ai" | "stub" = "stub";
    if (env.OPENAI_API_KEY && transcript.trim().length > 0) {
      result = await aiScores(runId, scenario?.title ?? "Practice", criteria, transcript);
      if (result) generatedBy = "ai";
    }
    if (!result) {
      result = stubScores(runId, criteria);
      generatedBy = "stub";
    }

    const overall = weightedOverall(result.perCriterion);
    const modelVersion = generatedBy === "ai" ? chatModel() : "stub-v1";

    await db.transaction(async (tx) => {
      // Upsert per-criterion scores (delete-then-insert keeps it simple and
      // idempotent under the (run_id, criterion_id) unique index).
      await tx.delete(coachingRunScores).where(eq(coachingRunScores.runId, runId));
      await tx.insert(coachingRunScores).values(
        result!.perCriterion.map((r) => ({
          orgId: run.orgId,
          runId,
          criterionId: r.criterionId,
          criterionName: r.criterionName,
          weight: String(r.weight),
          score: String(r.score),
          band: r.band,
          evidence: r.evidence,
          source: "ai" as const,
        })),
      );
      await tx
        .update(coachingRuns)
        .set({
          cachedOverallScore: String(overall),
          scoringStatus: "scored",
          scoreSource: "ai",
          scoredAt: new Date(),
          feedback: {
            strengths: result!.strengths,
            improvements: result!.improvements,
            perCriterion: result!.perCriterion.map((r) => ({
              criterionId: r.criterionId,
              criterionName: r.criterionName,
              score: r.score,
              band: r.band,
              evidence: r.evidence,
            })),
            coachNote: result!.coachNote,
            modelVersion,
            generatedBy,
          },
          updatedAt: new Date(),
        })
        .where(eq(coachingRuns.id, runId));
      await tx.insert(coachingAuditEvents).values({
        orgId: run.orgId,
        action: "run.scored",
        actorUserId: opts.actorUserId ?? null,
        runId,
        scenarioId: run.scenarioId,
        detail: { overall, generatedBy, criteria: result!.perCriterion.length, modelVersion },
      });
    });

    return { status: "scored", overall, generatedBy };
  } catch (err) {
    await db
      .update(coachingRuns)
      .set({ scoringStatus: "failed", updatedAt: new Date() })
      .where(eq(coachingRuns.id, runId))
      .catch(() => {});
    return { status: "failed", overall: null, generatedBy: "stub" };
  }
}

async function currentOverall(runId: string): Promise<number | null> {
  const [r] = await db
    .select({ overall: coachingRuns.cachedOverallScore })
    .from(coachingRuns)
    .where(eq(coachingRuns.id, runId))
    .limit(1);
  return r?.overall != null ? Number(r.overall) : null;
}
