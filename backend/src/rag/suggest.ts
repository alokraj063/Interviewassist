import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import {
  callSessions,
  candidates as candidatesTable,
  clients as clientsTable,
  db,
  demands as demandsTable,
  suggestions,
  transcriptTurns,
} from "@j2w/db";
import type {
  Citation,
  Speaker,
  SuggestionPayload,
  TranscriptTurn,
} from "@j2w/shared-types";
import type { FastifyBaseLogger } from "fastify";
import { chatModel, env } from "../env.js";
import { recordUsage } from "../usage/tracker.js";
import { broadcastToCall } from "../ws/session.js";

// Cache callId → orgId so the per-turn usage record doesn't re-query each time.
const orgIdCache = new Map<string, string>();
async function orgIdForCall(callId: string): Promise<string | null> {
  const hit = orgIdCache.get(callId);
  if (hit) return hit;
  const [row] = await db.select({ orgId: callSessions.orgId }).from(callSessions).where(eq(callSessions.id, callId)).limit(1);
  if (row?.orgId) orgIdCache.set(callId, row.orgId);
  return row?.orgId ?? null;
}
import { recordRetrieval } from "../routes/kb.js";
import { retrieve } from "./retrieve.js";

// System prompt kept intentionally >1024 tokens so OpenAI prompt caching can
// kick in across rapid successive suggestions in the same call session.
//
// This is the RECRUITER live-assist prompt — the user is a recruiter at a
// staffing firm on a phone call with a candidate they're sourcing for an
// open role (a "demand"). Candidates speak Hinglish (Hindi + English code-mix);
// recruiters are bilingual. Recruiters need fast, specific coaching that helps
// them capture key discovery facts (CTC, notice period, location, reason for
// change) and probe candidate fit against the active demand's requirements.
const SYSTEM_PROMPT = `
You are the live co-pilot for a recruiter at a staffing firm. The recruiter
is on a phone call with a candidate they may submit to an open role (a
"demand"). Your job is to produce short, high-signal guidance the recruiter
can read in under 2 seconds while the candidate is talking. Every time the
candidate finishes speaking (or whenever a transcript chunk arrives in mixed-
mono mode where speakers aren't reliably labeled), you review the last
several turns plus the active demand context plus retrieved knowledge-base
chunks, and emit one structured JSON object the UI renders across panels.

Important context cues:
- Candidates speak Hinglish (Hindi + English code-mix). Don't flag code-mix
  as a problem; it's normal. Suggestions can mix English technical terms
  with Hindi conversational glue when natural ("aapka current CTC kya hai?").
- The recruiter's primary mission this call is DISCOVERY: capture current
  company/role, total experience, current CTC, expected CTC, notice period
  (and whether negotiable), current location, willingness to relocate, and
  the candidate's reason for considering a change.
- Secondary mission is FIT to the demand: probe whether the candidate's
  experience aligns with the must-have skills, salary band, work mode, and
  notice period the demand specifies.
- Be alert to RED FLAGS: vague experience claims ("I've worked on many
  projects"), unrealistic CTC vs. demand band, conflicting notice period,
  evasiveness on reason-for-change.

Your outputs must follow these rules:

1. "suggestion" — a single concrete next action the recruiter can take.
   Phrase as an imperative sentence or a short quoted question the recruiter
   can ask verbatim. Maximum 40 words. Prefer the single best next move over
   a list. Pull a question directly from the demand's question bank or KB
   chunks when it fits.

   Q&A ALIGNMENT (most important): follow the conversation as a sequence of
   questions and answers. Track the LAST question the recruiter asked and
   whether the candidate actually answered it.
   - If the candidate's latest turn does NOT answer the open question (vague,
     dodged, or went off-topic), suggest a crisp re-ask or a narrower probe to
     get the missing fact.
   - If the candidate answered, acknowledge briefly and move to the next
     logical question — pick the highest-value unanswered discovery/fit item
     rather than repeating what was just covered.
   - When the candidate has just dropped a fact (e.g. their CTC), suggest the
     natural follow-up that captures the next missing discovery item.
   - When the candidate is hesitant or evasive, open with rapport before
     probing.

   LANGUAGE: the user message carries a LANGUAGE directive. Write the
   "suggestion" text in that language so the recruiter can read it aloud
   verbatim — Hindi → natural Hindi (Devanagari is fine), English → English,
   Hinglish → natural Hindi+English code-mix. Keep proper nouns and technical
   terms (CTC, notice period, React, AWS, etc.) as-is.

2. "citations" — an array {chunkId, sourceId, snippet, score} pointing at
   KB chunks you actually used. Omit entries you didn't reference. Never
   cite chunks not in the retrieved list. Snippet under 140 chars.

3. "sentiment" — a number in [-1, 1] estimating the CANDIDATE's emotional
   valence over the last few turns. -1 hostile/disengaged, 0 neutral, 1
   warm/enthusiastic. Don't weight the recruiter's turns.

4. "topics" — up to 4 short topic labels, each 1–3 words, capturing what
   the conversation is actually about right now. Use the recruiter
   vocabulary: "current_role_fit", "salary_range", "notice_negotiation",
   "tech_depth", "location_match", "red_flag", "follow_up_required",
   "rapport_building". Include a "confidence" field in [0,1] for each.

5. "complianceFlags" — discovery-checklist items the recruiter has NOT
   yet captured. Use these exact identifiers when applicable:
   "captured_current_ctc", "captured_expected_ctc", "captured_notice_period",
   "captured_reason_for_change", "captured_location_pref",
   "captured_total_experience", "captured_current_company". Only list items
   that appear to still be missing from the conversation so far.

6. "confidence" — overall confidence the suggestion is useful and
   well-grounded, in [0,1]. Low confidence signals the UI to display
   tentatively.

7. "lastSpeaker" — who spoke the MOST RECENT transcript turn, inferred from
   content, not from the (possibly wrong) label already attached. The
   recruiter asks questions, probes, leads, and explains the role; the
   candidate answers, describes their own experience/CTC/notice, and asks
   about the job. Output exactly "recruiter", "candidate", or "unclear".
   This is used to correct live speaker labels on a single mixed-mic source,
   so decide from the words themselves.

Tone: concise, operational, warm-but-professional. Never invent salary
numbers, candidate facts, or policies. Never output anything other than
the JSON object.
`.trim();

const JSON_SCHEMA = {
  name: "live_copilot_suggestion",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["suggestion", "citations", "sentiment", "topics", "complianceFlags", "confidence", "lastSpeaker"],
    properties: {
      suggestion: { type: "string" },
      lastSpeaker: { type: "string", enum: ["recruiter", "candidate", "unclear"] },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["chunkId", "sourceId", "snippet", "score"],
          properties: {
            chunkId: { type: "number" },
            sourceId: { type: "string" },
            snippet: { type: "string" },
            score: { type: "number" },
          },
        },
      },
      sentiment: { type: "number" },
      topics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "confidence"],
          properties: {
            name: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      complianceFlags: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
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

interface RecruiterCallContext {
  callId: string;
  // The call's selected transcription/interview language token
  // ("multi" | "en-US" | "en-IN" | "hi-IN"). Drives the language the
  // suggestion text is written in.
  language: string;
  demand: {
    title: string | null;
    designation: string | null;
    salaryFromLakhs: string | null;
    salaryToLakhs: string | null;
    experienceMinYears: string | null;
    experienceMaxYears: string | null;
    primaryLocation: string | null;
    workMode?: string | null;
    isVip: boolean;
    customer: string | null;
  } | null;
  candidate: {
    displayName: string | null;
    currentCompany: string | null;
    currentTitle: string | null;
    totalExperienceYears: string | null;
    currentCtcLakhs: string | null;
    expectedCtcLakhs: string | null;
    noticePeriodDays: number | null;
    currentLocation: string | null;
  } | null;
}

interface CallContext {
  turns: TranscriptTurn[]; // ring buffer, newest last
  lastSuggestionAt: number;
  inFlight: boolean;
  // Lazy-loaded recruiter context (demand + candidate). Loaded once per
  // call on first suggestion and cached for the call's lifetime.
  recruiterCtx?: RecruiterCallContext;
  recruiterCtxLoading?: Promise<RecruiterCallContext>;
}

const ctx = new Map<string, CallContext>();
const RING_SIZE = 12;
const DEBOUNCE_MS = 400;

export function rememberTurn(callId: string, turn: TranscriptTurn): void {
  const c = ensureCtx(callId);
  c.turns.push(turn);
  if (c.turns.length > RING_SIZE) c.turns.splice(0, c.turns.length - RING_SIZE);
}

function ensureCtx(callId: string): CallContext {
  let c = ctx.get(callId);
  if (!c) {
    c = { turns: [], lastSuggestionAt: 0, inFlight: false };
    ctx.set(callId, c);
  }
  return c;
}

export function dropCall(callId: string): void {
  ctx.delete(callId);
}

export async function maybeSuggest(
  callId: string,
  triggerTurnId: number | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const c = ensureCtx(callId);
  if (c.inFlight) return;
  const now = Date.now();
  if (now - c.lastSuggestionAt < DEBOUNCE_MS) return;
  if (c.turns.length === 0) return;

  // Fire on every final utterance. On the mixed-mono wedge the live speaker
  // label is only a provisional diarization guess (and this same pass is what
  // corrects it), so we can't gate on speaker === 'candidate' without starving
  // suggestions when the guess is wrong. Running each turn also powers the
  // Q&A-alignment guidance ("did the candidate actually answer that?").
  const last = c.turns[c.turns.length - 1];

  c.inFlight = true;
  c.lastSuggestionAt = now;
  const t0 = Date.now();
  const requestId = randomUUID();

  try {
    if (!env.OPENAI_API_KEY) {
      // No key — emit a one-shot error suggestion so the UI stops waiting.
      broadcastToCall(callId, {
        type: "suggestion.begin",
        requestId,
        triggerTurnId: triggerTurnId ?? -1,
      });
      broadcastToCall(callId, {
        type: "suggestion.delta",
        requestId,
        text: "OpenAI key not configured — suggestions disabled.",
      });
      broadcastToCall(callId, {
        type: "suggestion.end",
        requestId,
        payload: emptyPayload("OpenAI key not configured — suggestions disabled."),
        latencyMs: 0,
      });
      return;
    }

    // Retrieve grounding chunks for the last customer utterance.
    let citations: Citation[] = [];
    const retrT0 = Date.now();
    try {
      citations = await retrieve(last.text, { limit: 6 });
    } catch (err) {
      log.warn({ err, callId }, "rag retrieve failed");
    }
    // Telemetry: one kb_retrieval_events row per served chunk (or a single
    // zero-result row) so KB analytics / content-gaps / retrievals7d MOVE when
    // a live call actually retrieves. Best-effort; never breaks the suggestion.
    void recordCallRetrieval(callId, last.text, citations, Date.now() - retrT0, log);

    broadcastToCall(callId, {
      type: "suggestion.begin",
      requestId,
      triggerTurnId: triggerTurnId ?? last.id,
    });

    // Lazy-load demand + candidate context on first suggestion of the call.
    if (!c.recruiterCtx && !c.recruiterCtxLoading) {
      c.recruiterCtxLoading = loadRecruiterContext(callId).catch((err) => {
        log.warn({ err, callId }, "load recruiter context failed");
        return { callId, language: "multi", demand: null, candidate: null };
      });
    }
    if (c.recruiterCtxLoading) {
      c.recruiterCtx = await c.recruiterCtxLoading;
      c.recruiterCtxLoading = undefined;
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserMessage(c.turns, citations, c.recruiterCtx),
      },
    ];

    const stream = await client().chat.completions.create({
      model: chatModel(),
      messages,
      stream: true,
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      // Lower temperature: structured suggestions shouldn't be creative.
      temperature: 0.2,
      // Emit a final usage chunk so we can record token cost for the Usage tab.
      stream_options: { include_usage: true },
    });

    let full = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta?.content;
      if (!delta) continue;
      full += delta;
      broadcastToCall(callId, { type: "suggestion.delta", requestId, text: delta });
    }
    if (usage) {
      void orgIdForCall(callId).then((orgId) => {
        if (orgId) {
          void recordUsage({
            orgId,
            callId,
            operation: "suggestion",
            model: chatModel(),
            promptTokens: usage!.prompt_tokens ?? 0,
            completionTokens: usage!.completion_tokens ?? 0,
          });
        }
      });
    }

    let payload: SuggestionPayload;
    try {
      const parsed = JSON.parse(full) as {
        suggestion: string;
        citations: Array<{ chunkId: number; sourceId: string; snippet: string; score: number }>;
        sentiment: number;
        topics: Array<{ name: string; confidence: number }>;
        complianceFlags: string[];
        confidence: number;
        lastSpeaker?: "recruiter" | "candidate" | "unclear";
      };
      // Enrich citations with server-side metadata we kept from retrieval.
      const byId = new Map(citations.map((c) => [c.chunkId, c]));
      const enriched: Citation[] = parsed.citations.map((c) => {
        const src = byId.get(c.chunkId);
        return {
          chunkId: c.chunkId,
          sourceId: c.sourceId,
          sourceName: src?.sourceName,
          documentId: src?.documentId ?? "",
          documentTitle: src?.documentTitle ?? null,
          corpus: src?.corpus,
          snippet: c.snippet,
          score: c.score,
        };
      });
      payload = {
        suggestion: parsed.suggestion,
        citations: enriched,
        sentiment: parsed.sentiment,
        topics: parsed.topics.map((t) => t.name),
        complianceFlags: parsed.complianceFlags,
        confidence: parsed.confidence,
      };
      // Side-channels: topic + compliance + sentiment to their own panels.
      broadcastToCall(callId, {
        type: "topics.update",
        topics: parsed.topics,
      });
      broadcastToCall(callId, {
        type: "compliance.update",
        items: buildComplianceItems(parsed.complianceFlags),
      });
      broadcastToCall(callId, {
        type: "sentiment.update",
        value: parsed.sentiment,
        ts: Date.now(),
      });
      // Authoritative speaker correction: the model judges who actually spoke
      // the most recent turn from content. If that disagrees with the live
      // diarization label we applied, relabel that turn in the DB + UI.
      void relabelLastSpeaker(callId, last, parsed.lastSpeaker, log);
    } catch (parseErr) {
      log.warn({ parseErr, full: full.slice(0, 200) }, "suggestion JSON parse failed");
      payload = emptyPayload(full || "suggestion generation failed");
    }

    const latencyMs = Date.now() - t0;
    broadcastToCall(callId, {
      type: "suggestion.end",
      requestId,
      payload,
      latencyMs,
    });

    try {
      await db.insert(suggestions).values({
        callId,
        triggerTurnId: triggerTurnId ?? null,
        kind: "live",
        content: payload,
        citations: payload.citations,
        latencyMs,
      });
    } catch (err) {
      log.warn({ err, callId }, "persist suggestion failed");
    }
  } catch (err) {
    log.error({ err, callId }, "suggestion loop failed");
    broadcastToCall(callId, {
      type: "suggestion.end",
      requestId,
      payload: emptyPayload(err instanceof Error ? err.message : String(err)),
      latencyMs: Date.now() - t0,
    });
  } finally {
    c.inFlight = false;
  }
}

function buildUserMessage(
  turns: TranscriptTurn[],
  chunks: Citation[],
  recruiterCtx?: RecruiterCallContext,
): string {
  const transcript = turns
    .map((t) => `${t.speaker.toUpperCase()}: ${t.text}`)
    .join("\n");
  const kb =
    chunks.length === 0
      ? "(no knowledge base chunks retrieved — answer only from common-sense guidance)"
      : chunks
          .map(
            (c) =>
              `CHUNK ${c.chunkId} [${c.sourceName ?? c.sourceId}] score=${c.score.toFixed(3)}:\n${c.snippet}`,
          )
          .join("\n---\n");

  const ctxBlock = recruiterCtx
    ? formatRecruiterContext(recruiterCtx)
    : "(call context not yet loaded — proceed with discovery basics)";

  const langToken = recruiterCtx?.language ?? "multi";
  const langDirective =
    langToken === "hi-IN"
      ? "Hindi — write the suggestion in natural Hindi (Devanagari is fine)."
      : langToken === "en-IN" || langToken === "en-US"
        ? "English — write the suggestion in English."
        : "Hinglish — write the suggestion in natural Hindi+English code-mix, matching how the candidate is speaking.";

  return `LANGUAGE directive: ${langDirective}

Active demand and candidate:
${ctxBlock}

Recent transcript (most recent last):
${transcript}

Retrieved knowledge-base chunks:
${kb}

Respond with the JSON object per the schema.`;
}

function formatRecruiterContext(c: RecruiterCallContext): string {
  const lines: string[] = [];
  if (c.demand) {
    const d = c.demand;
    lines.push(
      `DEMAND: "${d.title ?? "untitled"}" (${d.designation ?? "designation n/a"})${d.isVip ? " [VIP]" : ""}`,
    );
    if (d.customer) lines.push(`  Client: ${d.customer}`);
    const exp = [d.experienceMinYears, d.experienceMaxYears].filter(Boolean).join("–");
    if (exp) lines.push(`  Experience band: ${exp} years`);
    const sal = [d.salaryFromLakhs, d.salaryToLakhs].filter(Boolean).join("–");
    if (sal) lines.push(`  Salary band: ${sal} lakhs`);
    if (d.primaryLocation) lines.push(`  Location: ${d.primaryLocation}`);
    if (d.workMode) lines.push(`  Work mode: ${d.workMode}`);
  } else {
    lines.push("DEMAND: (no demand linked to this call)");
  }
  if (c.candidate) {
    const k = c.candidate;
    lines.push(
      `CANDIDATE: ${k.displayName ?? "(unknown)"}${
        k.currentTitle ? ` — ${k.currentTitle}` : ""
      }${k.currentCompany ? ` @ ${k.currentCompany}` : ""}`,
    );
    if (k.totalExperienceYears) lines.push(`  Total exp: ${k.totalExperienceYears} years`);
    if (k.currentCtcLakhs) lines.push(`  Current CTC: ${k.currentCtcLakhs} L`);
    if (k.expectedCtcLakhs) lines.push(`  Expected CTC: ${k.expectedCtcLakhs} L`);
    if (k.noticePeriodDays !== null) lines.push(`  Notice period: ${k.noticePeriodDays} days`);
    if (k.currentLocation) lines.push(`  Location: ${k.currentLocation}`);
  } else {
    lines.push("CANDIDATE: (no candidate profile linked)");
  }
  return lines.join("\n");
}

// Resolve the call's org and write retrieval telemetry for the `suggest`
// surface. Fully isolated/best-effort — any failure is swallowed.
async function recordCallRetrieval(
  callId: string,
  query: string,
  citations: Citation[],
  latencyMs: number,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const [session] = await db
      .select({ orgId: callSessions.orgId })
      .from(callSessions)
      .where(eq(callSessions.id, callId))
      .limit(1);
    if (!session?.orgId) return;
    await recordRetrieval(
      session.orgId,
      "suggest",
      query,
      citations.map((c) => ({
        sourceId: c.sourceId,
        documentId: c.documentId,
        chunkId: typeof c.chunkId === "number" ? c.chunkId : undefined,
        score: c.score,
      })),
      latencyMs,
      callId,
    );
  } catch (err) {
    log.warn({ err, callId }, "kb retrieval telemetry failed");
  }
}

async function loadRecruiterContext(callId: string): Promise<RecruiterCallContext> {
  const [session] = await db
    .select({
      demandId: callSessions.demandId,
      candidateId: callSessions.candidateId,
      language: callSessions.transcriberLanguage,
    })
    .from(callSessions)
    .where(eq(callSessions.id, callId))
    .limit(1);

  const ctx: RecruiterCallContext = {
    callId,
    language: session?.language ?? "multi",
    demand: null,
    candidate: null,
  };
  if (session?.demandId) {
    const [d] = await db
      .select({
        title: demandsTable.title,
        designation: demandsTable.designation,
        salaryFromLakhs: demandsTable.salaryFrom,
        salaryToLakhs: demandsTable.salaryTo,
        experienceMinYears: demandsTable.experienceMinYears,
        experienceMaxYears: demandsTable.experienceMaxYears,
        primaryLocation: demandsTable.primaryLocation,
        probingDetails: demandsTable.probingDetails,
        isVip: demandsTable.isVip,
        clientId: demandsTable.clientId,
      })
      .from(demandsTable)
      .where(eq(demandsTable.id, session.demandId))
      .limit(1);
    if (d) {
      let customer: string | null = null;
      if (d.clientId) {
        const [c] = await db
          .select({ name: clientsTable.companyName })
          .from(clientsTable)
          .where(eq(clientsTable.id, d.clientId))
          .limit(1);
        customer = c?.name ?? null;
      }
      ctx.demand = {
        title: d.title,
        designation: d.designation,
        salaryFromLakhs: d.salaryFromLakhs,
        salaryToLakhs: d.salaryToLakhs,
        experienceMinYears: d.experienceMinYears,
        experienceMaxYears: d.experienceMaxYears,
        primaryLocation: d.primaryLocation,
        workMode: (d.probingDetails as { workMode?: string } | null)?.workMode ?? null,
        isVip: d.isVip,
        customer,
      };
    }
  }
  if (session?.candidateId) {
    const [k] = await db
      .select({
        displayName: candidatesTable.displayName,
        currentCompany: candidatesTable.currentCompany,
        currentTitle: candidatesTable.currentTitle,
        totalExperienceYears: candidatesTable.totalExperienceYears,
        currentCtcLakhs: candidatesTable.currentCtcLakhs,
        expectedCtcLakhs: candidatesTable.expectedCtcLakhs,
        noticePeriodDays: candidatesTable.noticePeriodDays,
        currentLocation: candidatesTable.currentLocation,
      })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, session.candidateId))
      .limit(1);
    if (k) ctx.candidate = k;
  }
  return ctx;
}

/**
 * Apply the LLM's content-based speaker judgement to the most recent final
 * turn. No-op when the model is unsure, the turn isn't persisted yet, or the
 * label already matches. Updates the DB and broadcasts `transcript.relabel`
 * so the live UI flips the speaker on that bubble.
 */
async function relabelLastSpeaker(
  callId: string,
  last: TranscriptTurn,
  lastSpeaker: "recruiter" | "candidate" | "unclear" | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!lastSpeaker || lastSpeaker === "unclear") return;
  const role = lastSpeaker as Speaker;
  if (last.id < 0 || last.speaker === role) return;
  last.speaker = role; // keep the in-memory ring buffer consistent for next pass
  broadcastToCall(callId, { type: "transcript.relabel", turnId: last.id, speaker: role });
  try {
    await db.update(transcriptTurns).set({ speaker: role }).where(eq(transcriptTurns.id, last.id));
  } catch (err) {
    log.warn({ err, callId, turnId: last.id }, "speaker relabel persist failed");
  }
}

function emptyPayload(note: string): SuggestionPayload {
  return {
    suggestion: note,
    citations: [],
    sentiment: 0,
    topics: [],
    complianceFlags: [],
    confidence: 0,
  };
}

function buildComplianceItems(flags: string[]): Array<{ id: string; label: string; ok: boolean }> {
  // Discovery-checklist items the recruiter must capture in the call. Server
  // returns the IDs of items still MISSING; the UI renders the full known
  // list with ok=true/false so recruiters see progress.
  const KNOWN: Record<string, string> = {
    captured_current_company: "Current company",
    captured_total_experience: "Total experience",
    captured_current_ctc: "Current CTC",
    captured_expected_ctc: "Expected CTC",
    captured_notice_period: "Notice period",
    captured_reason_for_change: "Reason for change",
    captured_location_pref: "Location preference",
  };
  const pending = new Set(flags);
  const items: Array<{ id: string; label: string; ok: boolean }> = [];
  for (const [id, label] of Object.entries(KNOWN)) {
    items.push({ id, label, ok: !pending.has(id) });
    pending.delete(id);
  }
  for (const id of pending) {
    const label = id.replace(/^captured_/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    items.push({ id, label, ok: false });
  }
  return items;
}
