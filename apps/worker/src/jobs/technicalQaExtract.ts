// technical_qa_extract worker.
//
// LLM-extracts the technical question / candidate-answer pairs from a
// recruiter-candidate call transcript. Produces 0..N rows in
// call_technical_qa with skill tag, difficulty, evaluation, and a
// rationale that helps the QA reviewer scan candidate depth without
// re-listening to the recording.
//
// No-ops gracefully when OPENAI_API_KEY is missing or the call has no
// final-turn transcript.
import { and, asc, eq } from "drizzle-orm";
import OpenAI from "openai";
import type { Logger } from "pino";
import {
  callTechnicalQa,
  db,
  transcriptTurns,
  TECHNICAL_QA_DIFFICULTIES,
  TECHNICAL_QA_EVALUATIONS,
} from "@j2w/db";
import type { TechnicalQaExtractJob } from "@j2w/ingest-shared";

interface ExtractResult {
  skipped: boolean;
  reason?: string;
  inserted?: number;
}

const SYSTEM = `
You analyze a recruiter-candidate phone call transcript and extract the
technical question / answer exchanges. The recruiter is screening the
candidate against a role's required skills. Extract only EXPLICIT
technical questions the recruiter asked AND the candidate's answers (if
any). Skip small talk, salary/notice/logistics, and behavioural questions.

For each Q&A pair, output:
- questionIndex: 0-based, monotonically increasing in transcript order
- skill: a short tag like "react", "typescript", "system-design",
  "sql", "data-modeling", "leadership-stories" — leave null if unclear
- difficulty: "easy" | "medium" | "hard" (your judgment of the question)
- question: the recruiter's question, lightly cleaned for grammar
- answer: candidate's answer, lightly cleaned. null if no answer was given
- evaluation: how the candidate did:
  - "correct" — answer is technically sound
  - "partially_correct" — partially right, missed key parts
  - "incorrect" — wrong answer
  - "no_answer" — candidate didn't answer or said they don't know
- tsQuestionStartMs / tsAnswerEndMs: span in milliseconds from the
  transcript timestamps
- rationale: 1 sentence on why you marked it that evaluation
- confidence: 0..1, how sure you are of this extraction

Be strict — only output pairs that are unambiguously technical. It is
better to return zero items than to invent.
`.trim();

function buildSchema() {
  return {
    name: "technical_qa_extract",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "questionIndex",
              "skill",
              "difficulty",
              "question",
              "answer",
              "evaluation",
              "tsQuestionStartMs",
              "tsAnswerEndMs",
              "rationale",
              "confidence",
            ],
            properties: {
              questionIndex: { type: "integer" },
              skill: { type: ["string", "null"] },
              difficulty: { type: ["string", "null"], enum: [...TECHNICAL_QA_DIFFICULTIES, null] },
              question: { type: "string" },
              answer: { type: ["string", "null"] },
              evaluation: { type: "string", enum: [...TECHNICAL_QA_EVALUATIONS] },
              tsQuestionStartMs: { type: ["integer", "null"] },
              tsAnswerEndMs: { type: ["integer", "null"] },
              rationale: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
      },
    },
  } as const;
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  if (!_client) _client = new OpenAI({ apiKey: key });
  return _client;
}

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export async function processTechnicalQaExtract(
  job: TechnicalQaExtractJob,
  log: Logger,
): Promise<ExtractResult> {
  const { callId } = job;

  if (!process.env.OPENAI_API_KEY) {
    log.info({ callId }, "technical_qa: OPENAI_API_KEY not set — skipping");
    return { skipped: true, reason: "no_openai_key" };
  }

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
    log.info({ callId }, "technical_qa: no transcript turns — skipping");
    return { skipped: true, reason: "no_transcript" };
  }

  const transcript = turns
    .map(
      (t) =>
        `[${t.tsStartMs}-${t.tsEndMs}ms ${t.speaker}] ${t.text.replace(/\s+/g, " ")}`,
    )
    .join("\n");
  const truncated = transcript.length > 12_000 ? transcript.slice(-12_000) : transcript;

  let parsed: {
    items: Array<{
      questionIndex: number;
      skill: string | null;
      difficulty: "easy" | "medium" | "hard" | null;
      question: string;
      answer: string | null;
      evaluation: "correct" | "partially_correct" | "incorrect" | "no_answer";
      tsQuestionStartMs: number | null;
      tsAnswerEndMs: number | null;
      rationale: string;
      confidence: number;
    }>;
  };
  try {
    const res = await client().chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Transcript:\n${truncated}\n\nRespond with the JSON object per the schema.`,
        },
      ],
      response_format: { type: "json_schema", json_schema: buildSchema() },
      temperature: 0.1,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) throw new Error("empty technical_qa response");
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error({ err, callId }, "technical_qa LLM call failed");
    return { skipped: true, reason: "llm_failed" };
  }

  if (!parsed.items || parsed.items.length === 0) {
    log.info({ callId }, "technical_qa: no items extracted");
    // Clear any prior rows for this call so a re-run on a transcript
    // that lost its technical content doesn't leave stale Q&A.
    await db.delete(callTechnicalQa).where(eq(callTechnicalQa.callId, callId));
    return { skipped: false, inserted: 0 };
  }

  // Replace strategy: delete then insert. Cheaper and clearer than
  // diffing the new vs old set.
  await db.delete(callTechnicalQa).where(eq(callTechnicalQa.callId, callId));

  const rows = parsed.items.map((it) => ({
    callId,
    questionIndex: it.questionIndex,
    skill: it.skill,
    difficulty: it.difficulty,
    question: it.question,
    answer: it.answer,
    evaluation: it.evaluation,
    tsQuestionStartMs: it.tsQuestionStartMs,
    tsAnswerEndMs: it.tsAnswerEndMs,
    rationale: it.rationale,
    confidence: it.confidence != null ? String(it.confidence) : null,
    modelVersion: MODEL,
  }));

  // Use insert-many; the unique index on (call_id, question_index) gives
  // us idempotency guarantees if two enqueues land at once.
  let inserted = 0;
  try {
    await db.insert(callTechnicalQa).values(rows).onConflictDoNothing();
    inserted = rows.length;
  } catch (err) {
    log.warn({ err, callId, count: rows.length }, "persist technical_qa rows failed");
  }

  log.info({ callId, inserted }, "technical_qa extracted");
  return { skipped: false, inserted };
}
