// Resolution-vs-KB analysis pipeline.
//
// Goal: given a completed call transcript, answer the QA question "did the
// agent say the operationally-correct thing per the knowledge base?"
//
// The pipeline runs two LLM calls and one round of RAG retrieval:
//
//   1. CLAIM EXTRACT   — GPT-4o reads the transcript and extracts a short,
//                        checkable set of factual claims the agent made, plus
//                        a one-paragraph summary of the resolution.
//   2. RAG RETRIEVE    — for each claim, pgvector returns the top-K KB chunks
//                        most likely to contain the SOP answer.
//   3. CLAIM VERDICT   — GPT-4o reviews each claim against its retrieved
//                        chunks and emits supported / contradicted /
//                        unsupported / not_applicable with a one-line gap
//                        explanation.
//
// Result is persisted in qa_resolution_analyses keyed by callId. GET returns
// the cached row; POST /recompute forces a fresh run.
//
// Cost is roughly 2 LLM calls + N embedding calls per review (~$0.02–0.05
// at current OpenAI pricing). At 100 reviews/day that's <$5/day — fine.

import { asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { FastifyBaseLogger } from "fastify";
import type { Citation } from "@j2w/shared-types";
import { db, qaResolutionAnalyses, transcriptTurns, callSessions } from "@j2w/db";
import { env } from "../env.js";
import { retrieve } from "./retrieve.js";

export type ResolutionVerdict = "supported" | "contradicted" | "unsupported" | "not_applicable";

export interface ResolutionClaim {
  id: string;
  text: string;
  verdict: ResolutionVerdict;
  gap: string;
  evidenceTs?: string;
  evidenceQuote?: string;
  kbSource?: string;
  citations: Citation[];
}

export interface ResolutionAnalysis {
  callId: string;
  agentResolution: string;
  kbAnswer: string;
  claims: ResolutionClaim[];
  overallSeverity: "low" | "medium" | "high" | "critical";
  computedAt: string;
  modelVersion: string;
}

const CLAIM_EXTRACT_SYSTEM = `
You review a completed contact-center call transcript and extract the factual
claims the agent made to the customer. Your output is consumed by a QA
workflow that will independently verify each claim against a knowledge base.

Focus on CHECKABLE factual statements: promised actions, policy claims,
timelines, amounts, prerequisites. Skip generic empathy phrases or routine
acknowledgments. Do not infer claims the agent didn't actually say. Prefer
3-6 high-signal claims over a long exhaustive list.

Return ONLY the JSON object per the schema.
`.trim();

const CLAIM_EXTRACT_SCHEMA = {
  name: "resolution_extract",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "resolution", "claims"],
    properties: {
      intent: {
        type: "string",
        description: "One-line summary of what the customer was calling about.",
      },
      resolution: {
        type: "string",
        description: "Two-to-three sentence summary of what the agent told the customer.",
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text", "evidenceQuote"],
          properties: {
            id: { type: "string", description: "Short stable id like c1, c2, c3." },
            text: {
              type: "string",
              description: "The claim rewritten as a single self-contained factual sentence.",
            },
            evidenceQuote: {
              type: "string",
              description: "The exact span from the transcript that establishes this claim.",
            },
          },
        },
      },
    },
  },
} as const;

const CLAIM_VERDICT_SYSTEM = `
You verify each claim a contact-center agent made against retrieved knowledge
base chunks. Emit one verdict per claim:

- supported: The KB clearly confirms the claim.
- contradicted: The KB clearly says something different. The agent is wrong.
- unsupported: The KB does not address this claim either way, OR the claim is
  too vague to verify.
- not_applicable: The claim is general small talk or outside the KB's scope.

"gap" is a ONE-LINE explanation, only when verdict is contradicted or
unsupported. Empty string otherwise.

Ground verdicts strictly in the retrieved chunks. Do not invent policy.
Return ONLY the JSON object per the schema.
`.trim();

const CLAIM_VERDICT_SCHEMA = {
  name: "resolution_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["kbAnswer", "verdicts"],
    properties: {
      kbAnswer: {
        type: "string",
        description: "2-4 sentence synthesis of the canonical answer to this call, per the KB.",
      },
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claimId", "verdict", "gap"],
          properties: {
            claimId: { type: "string" },
            verdict: {
              type: "string",
              enum: ["supported", "contradicted", "unsupported", "not_applicable"],
            },
            gap: { type: "string" },
          },
        },
      },
    },
  },
} as const;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

interface CallRow {
  orgId: string | null;
}

async function loadCall(callId: string): Promise<CallRow | null> {
  const [row] = await db
    .select({ orgId: callSessions.orgId })
    .from(callSessions)
    .where(eq(callSessions.id, callId));
  return row ?? null;
}

async function loadTranscript(callId: string): Promise<Array<{ speaker: string; text: string; tsStartMs: number }>> {
  return db
    .select({ speaker: transcriptTurns.speaker, text: transcriptTurns.text, tsStartMs: transcriptTurns.tsStartMs })
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(asc(transcriptTurns.tsStartMs));
}

function formatTs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}

function buildTranscriptPrompt(
  turns: Array<{ speaker: string; text: string; tsStartMs: number }>,
): string {
  const full = turns.map((t) => `[${formatTs(t.tsStartMs)}] ${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
  return full.length > 12_000 ? full.slice(-12_000) : full;
}

function degenerateAnalysis(callId: string, note: string, modelVersion: string): ResolutionAnalysis {
  return {
    callId,
    agentResolution: note,
    kbAnswer: "",
    claims: [],
    overallSeverity: "low",
    computedAt: new Date().toISOString(),
    modelVersion,
  };
}

function severityFromVerdicts(claims: ResolutionClaim[]): ResolutionAnalysis["overallSeverity"] {
  const contradictions = claims.filter((c) => c.verdict === "contradicted").length;
  const unsupported = claims.filter((c) => c.verdict === "unsupported").length;
  if (contradictions >= 1) return "critical";
  if (unsupported > 1) return "high";
  if (unsupported === 1) return "medium";
  return "low";
}

async function persist(
  callId: string,
  orgId: string,
  analysis: ResolutionAnalysis,
): Promise<void> {
  await db
    .insert(qaResolutionAnalyses)
    .values({
      callId,
      orgId,
      payload: analysis as unknown as Record<string, unknown>,
      modelVersion: analysis.modelVersion,
      computedAt: new Date(analysis.computedAt),
    })
    .onConflictDoUpdate({
      target: qaResolutionAnalyses.callId,
      set: {
        payload: analysis as unknown as Record<string, unknown>,
        modelVersion: analysis.modelVersion,
        computedAt: new Date(analysis.computedAt),
      },
    });
}

/** Return a cached analysis if present; does not trigger compute. */
export async function getCachedResolution(callId: string): Promise<ResolutionAnalysis | null> {
  const [row] = await db
    .select()
    .from(qaResolutionAnalyses)
    .where(eq(qaResolutionAnalyses.callId, callId));
  if (!row) return null;
  return row.payload as unknown as ResolutionAnalysis;
}

/**
 * Compute (or recompute) the resolution analysis for a call and persist it.
 * On LLM/RAG failure returns a degenerate payload so the UI always has
 * *something* to render — this matches suggest.ts's fallback behavior.
 */
export async function analyzeResolution(
  callId: string,
  log: FastifyBaseLogger,
): Promise<ResolutionAnalysis> {
  const modelVersion = `${env.OPENAI_MODEL}/resolution-v1`;

  const call = await loadCall(callId);
  if (!call || !call.orgId) {
    return degenerateAnalysis(callId, "Call not found.", modelVersion);
  }

  if (!env.OPENAI_API_KEY) {
    const analysis = degenerateAnalysis(callId, "LLM not configured.", modelVersion);
    analysis.claims = [];
    analysis.kbAnswer = "LLM not configured — resolution analysis unavailable.";
    return analysis;
  }

  const turns = await loadTranscript(callId);
  if (turns.length === 0) {
    return degenerateAnalysis(callId, "Transcript unavailable.", modelVersion);
  }

  const transcript = buildTranscriptPrompt(turns);
  const tsByQuote = new Map<string, string>();
  for (const t of turns) {
    tsByQuote.set(t.text, formatTs(t.tsStartMs));
  }

  // Step 1: extract claims.
  let extract: {
    intent: string;
    resolution: string;
    claims: Array<{ id: string; text: string; evidenceQuote: string }>;
  };
  try {
    const res = await client().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: CLAIM_EXTRACT_SYSTEM },
        { role: "user", content: `Transcript:\n${transcript}\n\nReturn the JSON object.` },
      ],
      response_format: { type: "json_schema", json_schema: CLAIM_EXTRACT_SCHEMA },
      temperature: 0.2,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) throw new Error("empty extract response");
    extract = JSON.parse(raw);
  } catch (err) {
    log.warn({ err, callId }, "resolution claim-extract failed");
    return degenerateAnalysis(callId, "Claim extraction failed.", modelVersion);
  }

  if (extract.claims.length === 0) {
    return {
      callId,
      agentResolution: extract.resolution,
      kbAnswer: "No factual claims to verify in this transcript.",
      claims: [],
      overallSeverity: "low",
      computedAt: new Date().toISOString(),
      modelVersion,
    };
  }

  // Step 2: retrieve top-K chunks per claim (in parallel).
  const retrievals = await Promise.all(
    extract.claims.map(async (c) => {
      try {
        return { claim: c, chunks: await retrieve(c.text, { limit: 3 }) };
      } catch (err) {
        log.warn({ err, callId, claimId: c.id }, "resolution retrieve failed");
        return { claim: c, chunks: [] as Citation[] };
      }
    }),
  );

  const anyKbHit = retrievals.some((r) => r.chunks.length > 0);
  if (!anyKbHit) {
    // Distinct empty state — the UI shows a KB-empty callout.
    return {
      callId,
      agentResolution: extract.resolution,
      kbAnswer: "",
      claims: extract.claims.map((c) => ({
        id: c.id,
        text: c.text,
        verdict: "unsupported" as ResolutionVerdict,
        gap: "No KB entries matched — ask a Knowledge admin to index SOPs for this intent.",
        evidenceQuote: c.evidenceQuote,
        evidenceTs: tsByQuote.get(c.evidenceQuote),
        citations: [],
      })),
      overallSeverity: "medium",
      computedAt: new Date().toISOString(),
      modelVersion,
    };
  }

  // Step 3: batched verdict call.
  const verdictInput = retrievals
    .map((r) => {
      const chunkText =
        r.chunks.length === 0
          ? "(no retrieved chunks)"
          : r.chunks.map((c) => `CHUNK ${c.chunkId} [${c.sourceName ?? c.sourceId}]: ${c.snippet}`).join("\n---\n");
      return `CLAIM ${r.claim.id}: ${r.claim.text}\nRETRIEVED:\n${chunkText}`;
    })
    .join("\n\n====\n\n");

  let verdicts: { kbAnswer: string; verdicts: Array<{ claimId: string; verdict: ResolutionVerdict; gap: string }> };
  try {
    const res = await client().chat.completions.create({
      model: env.OPENAI_MODEL,
      messages: [
        { role: "system", content: CLAIM_VERDICT_SYSTEM },
        {
          role: "user",
          content: `Intent: ${extract.intent}\nAgent resolution: ${extract.resolution}\n\nClaims to verify:\n\n${verdictInput}\n\nReturn the JSON object.`,
        },
      ],
      response_format: { type: "json_schema", json_schema: CLAIM_VERDICT_SCHEMA },
      temperature: 0.2,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) throw new Error("empty verdict response");
    verdicts = JSON.parse(raw);
  } catch (err) {
    log.warn({ err, callId }, "resolution claim-verdict failed");
    return degenerateAnalysis(callId, "Verdict call failed.", modelVersion);
  }

  const verdictById = new Map(verdicts.verdicts.map((v) => [v.claimId, v]));

  const claims: ResolutionClaim[] = retrievals.map((r) => {
    const v = verdictById.get(r.claim.id) ?? {
      claimId: r.claim.id,
      verdict: "unsupported" as ResolutionVerdict,
      gap: "No verdict produced.",
    };
    const topChunk = r.chunks[0];
    return {
      id: r.claim.id,
      text: r.claim.text,
      verdict: v.verdict,
      gap: v.gap,
      evidenceQuote: r.claim.evidenceQuote,
      evidenceTs: tsByQuote.get(r.claim.evidenceQuote),
      kbSource: topChunk?.sourceName ?? topChunk?.documentTitle ?? undefined,
      citations: r.chunks,
    };
  });

  const analysis: ResolutionAnalysis = {
    callId,
    agentResolution: extract.resolution,
    kbAnswer: verdicts.kbAnswer,
    claims,
    overallSeverity: severityFromVerdicts(claims),
    computedAt: new Date().toISOString(),
    modelVersion,
  };

  try {
    await persist(callId, call.orgId, analysis);
  } catch (err) {
    log.warn({ err, callId }, "persist resolution analysis failed");
  }

  return analysis;
}
