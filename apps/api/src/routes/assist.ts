// Structured interview-flow co-pilot for the recruiter wedge.
//
// Inspired by the standalone Interview-Assist project's /assist/* loop: instead
// of firing a fresh free-form suggestion on every transcript turn, this drives
// the interview ONE question at a time —
//
//   plan   → a personalized, JD+resume-anchored question plan (+ a fit read)
//   next   → the single next question to ask, given the conversation so far
//   verify → did the candidate actually ANSWER the current question? (per answer)
//   final  → the end-of-call calibrated score
//
// All endpoints are stateless: each loads the call's demand (the JD) and
// candidate (the "resume") fresh from the DB, scoped to the caller's org. The
// client (useInterviewFlow) owns the loop and tracks which question is current,
// whether it was asked, and whether it was answered.
//
// Everything the co-pilot emits is in ENGLISH by design (recruiter-facing),
// regardless of the language the candidate speaks on the call.
import OpenAI from "openai";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  callSessions,
  candidates as candidatesTable,
  clients as clientsTable,
  db,
  demands as demandsTable,
} from "@j2w/db";
import { chatModel, env } from "../env.js";
import { recordUsage, usageSummary } from "../usage/tracker.js";

let _client: OpenAI | null = null;
function openai(): OpenAI {
  if (!_client) {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _client;
}

// `track` (orgId + operation [+ callId]) records the call's token usage + cost.
async function gptJson(
  system: string,
  user: string,
  track: { orgId: string; operation: string; callId?: string | null },
): Promise<Record<string, unknown>> {
  const model = chatModel();
  const resp = await openai().chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });
  void recordUsage({
    orgId: track.orgId,
    callId: track.callId ?? null,
    operation: track.operation,
    model,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
  });
  try {
    return JSON.parse(resp.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Build the "JD" + "resume" strings the prompts need from our DB rows. */
async function loadJdResume(
  callId: string,
  orgId: string,
): Promise<{ jd: string; resume: string; candidateName: string } | null> {
  const [call] = await db
    .select({
      orgId: callSessions.orgId,
      demandId: callSessions.demandId,
      candidateId: callSessions.candidateId,
    })
    .from(callSessions)
    .where(eq(callSessions.id, callId));
  if (!call || call.orgId !== orgId) return null;

  let jd = "";
  if (call.demandId) {
    const [d] = await db
      .select({
        title: demandsTable.title,
        designation: demandsTable.designation,
        description: demandsTable.description,
        responsibilities: demandsTable.responsibilities,
        experienceMinYears: demandsTable.experienceMinYears,
        experienceMaxYears: demandsTable.experienceMaxYears,
        primaryLocation: demandsTable.primaryLocation,
        clientId: demandsTable.clientId,
      })
      .from(demandsTable)
      .where(eq(demandsTable.id, call.demandId));
    if (d) {
      let client: string | null = null;
      if (d.clientId) {
        const [c] = await db
          .select({ name: clientsTable.companyName })
          .from(clientsTable)
          .where(eq(clientsTable.id, d.clientId));
        client = c?.name ?? null;
      }
      const exp = [d.experienceMinYears, d.experienceMaxYears].filter(Boolean).join("–");
      jd = [
        `ROLE: ${d.title ?? "(untitled)"}${d.designation ? ` (${d.designation})` : ""}`,
        client ? `CLIENT: ${client}` : "",
        exp ? `EXPERIENCE REQUIRED: ${exp} years` : "",
        d.primaryLocation ? `LOCATION: ${d.primaryLocation}` : "",
        d.description ? `\nJOB DESCRIPTION:\n${d.description}` : "",
        d.responsibilities ? `\nRESPONSIBILITIES:\n${d.responsibilities}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }

  let resume = "";
  let candidateName = "";
  if (call.candidateId) {
    const [k] = await db
      .select({
        displayName: candidatesTable.displayName,
        currentTitle: candidatesTable.currentTitle,
        currentCompany: candidatesTable.currentCompany,
        totalExperienceYears: candidatesTable.totalExperienceYears,
        currentLocation: candidatesTable.currentLocation,
        currentCtcLakhs: candidatesTable.currentCtcLakhs,
        expectedCtcLakhs: candidatesTable.expectedCtcLakhs,
        noticePeriodDays: candidatesTable.noticePeriodDays,
      })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, call.candidateId));
    if (k) {
      candidateName = k.displayName ?? "";
      resume = [
        `NAME: ${k.displayName ?? "(unknown)"}`,
        k.currentTitle ? `CURRENT TITLE: ${k.currentTitle}` : "",
        k.currentCompany ? `CURRENT COMPANY: ${k.currentCompany}` : "",
        k.totalExperienceYears ? `TOTAL EXPERIENCE: ${k.totalExperienceYears} years` : "",
        k.currentLocation ? `LOCATION: ${k.currentLocation}` : "",
        k.currentCtcLakhs ? `CURRENT CTC: ${k.currentCtcLakhs} LPA` : "",
        k.expectedCtcLakhs ? `EXPECTED CTC: ${k.expectedCtcLakhs} LPA` : "",
        k.noticePeriodDays != null ? `NOTICE PERIOD: ${k.noticePeriodDays} days` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }

  return { jd, resume, candidateName };
}

// --- Prompts (ported + adapted from the Interview-Assist reference) ----------

const PLAN_SYSTEM = `You are an interview architect + a sharp, honest screener. Given a JOB DESCRIPTION (the role's must-haves) and a CANDIDATE profile/resume (what they claim), do TWO things.

(1) A calibrated pre-call FIT read, judged ONLY against the JD's core must-haves. Be evidence-based and skeptical, not flattering. If info is thin, use "Not enough info" rather than inflating.

(2) A TECHNICAL question bank tailored to THIS candidate and role. Generate EXACTLY 20 questions that test the role's required technologies and the specific skills, tools, and projects on the resume.

Hard rules for the questions:
- TECHNICAL and CONCRETE only. Every question must name a specific technology, tool, framework, concept, algorithm, or a project/claim from the resume or a must-have from the JD. NEVER vague ("tell me about your experience", "what are your strengths", "describe a challenge") — those are banned.
- Anchor in BOTH the JD's required tech stack AND the candidate's resume. If the JD requires X and the resume claims Y, ask pointed questions about X and probe the depth of Y.
- Group into EXACTLY three difficulty buckets by "name": "Easy" (core fundamentals / definitions / warm-up on the required tech), "Medium" (applied/practical usage, trade-offs, "how would you…" on real tasks), "Hard" (internals, system design, debugging, scaling, edge cases). Distribute roughly 6 Easy, 8 Medium, 6 Hard — 20 questions total.
- Each question is ONE clear sentence a recruiter can read aloud — max ~20 words. No preamble, no multi-part/stacked-clause questions.
- ALWAYS produce all 20 even if the fit is weak — probe whether they actually have each required skill. Never return empty "questions" arrays.

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"fitVerdict": one of "Strong fit"|"Possible fit"|"Weak fit"|"Not enough info",
 "summary": str (2-3 sentences on must-haves met vs missed),
 "strengths": [up to 3 concrete strengths vs the JD],
 "gaps": [up to 3 concrete missing/unclear must-haves to probe],
 "categories": [{"name": "Easy"|"Medium"|"Hard", "questions": [str, ...]}, ...]}`;

const NEXT_SYSTEM = `You are an interview coach driving the conversation ONE question at a time. You receive the JOB DESCRIPTION, the CANDIDATE profile/resume, the structured Q&A so far (for coverage), and the RECENT TRANSCRIPT (the verbatim last ~10 turns of the actual conversation). Produce the single next question to ask.

CONTEXT IS CRITICAL — never produce a random question:
- READ the RECENT TRANSCRIPT first. The next question must FOLLOW ON naturally from what was just said. If the candidate's last answer opened a thread, raised a tool/project, gave a partial or weak answer, or said something worth drilling into, probe THAT specifically.
- Use the structured Q&A history only to avoid repeating covered ground and to track coverage of the JD must-haves. Use the recent transcript for the immediate, in-context next move.
- If the conversation just moved to a new topic, continue on that topic rather than snapping back to an unrelated planned question.

Hard rules:
- Anchor every question in a SPECIFIC JD requirement AND/OR a specific candidate detail or something they JUST said. Never generic.
- Prioritise the JD's MUST-HAVE skills first.
- ROTATE TOPICS — after 1-2 questions on a topic, move to a different uncovered JD requirement.
- Pace through phases in order: "Opener" (one warm-up tying their background to the role), "Skills" (verify each JD must-have), "Technical Deep-Dive" (drill into a claimed project), "Experience" (behavioural / impact).
- Only use "Follow-up" if the LAST answer was Weak/Vague/Off-topic AND the topic is worth one more probe. Never follow up more than once on the same topic.
- After ~6-9 substantive Q&As covering the main must-haves, OR when there's enough signal, set done=true with question="".
- BREVITY IS CRITICAL: the "question" must be ONE short, natural spoken sentence the recruiter can read aloud — max ~16 words. No preamble, no "I see that…", no multi-part or stacked-clause questions. Just the direct question.

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"category": one of "Opener"|"Skills"|"Technical Deep-Dive"|"Experience"|"Follow-up"|"Wrap-up",
 "question": str (empty if done), "done": bool}`;

const VERIFY_SYSTEM = `You are a PRACTICAL interview evaluator helping the recruiter judge each answer in real time. Be FAIR — not harsh. Most real answers are imperfect but acceptable; the recruiter needs to keep moving.

You are given the CURRENT QUESTION and the candidate's ANSWER so far. First decide whether the answer even ADDRESSES the question.

Calibration (lean lenient):
- "Strong"   = clear, specific, technically sound; concrete example.
- "Adequate" = on-topic with some real content. DEFAULT for any answer that addresses the question — even briefly. satisfied=true.
- "Weak"     = on-topic but genuinely thin, no specifics, clearly hiding lack of knowledge. satisfied=false.
- "Vague"    = wandering buzzwords with zero substance. Rare. satisfied=false.
- "Off-topic"= answered a different question, refused, or hasn't actually answered yet. satisfied=false.
Default to "Adequate" when in doubt. A correct one-sentence answer is Adequate, not Weak. Penalise only true lack of substance, never brevity.

FEEDBACK: one short plain-English sentence about the candidate ("They…"), scannable in a second. If Weak/Vague/Off-topic, give ONE specific probing follow-up; otherwise followUp is "".

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"satisfied": bool, "verdict": one of "Strong"|"Adequate"|"Weak"|"Off-topic"|"Vague", "feedback": str, "followUp": str}`;

const FINAL_SYSTEM = `You are a senior interview evaluator producing the FINAL evaluation after the interview. You receive the JD, the candidate profile/resume, and the full transcript (every Q with its answer + the live verdict). Be honest and calibrated — don't inflate or deflate; ground claims in what the candidate actually said. If the interview was short, lower confidence and prefer "Borderline".

Score each dimension 0-100: communication, relevance, depth, skills_match, overall (a hire-recommendation, not just the average).

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"verdict": one of "Strong yes"|"Lean yes"|"Borderline"|"Lean no"|"Strong no",
 "score": {"overall": int, "communication": int, "relevance": int, "depth": int, "skills_match": int},
 "summary": str (2-3 sentences), "strengths": [up to 3], "concerns": [up to 3]}`;

function fmtHistory(history: Array<{ category?: string; question?: string; answer?: string; verdict?: string }>): string {
  if (!history.length) return "(none — this is the opener)";
  return history
    .map((h, i) => {
      const cat = (h.category || "?").trim();
      const verdict = (h.verdict || "—").trim();
      return `Q${i + 1} [${cat}] (verdict: ${verdict}): ${(h.question || "").trim()}\nA${i + 1}: ${(h.answer || "").trim()}`;
    })
    .join("\n\n");
}

// Detects when the interviewer asks a NEW question off-script. Judges from
// CONTENT, not speaker labels (the mixed-mic diarization is unreliable).
const DETECT_SYSTEM = `You watch a LIVE interview transcript and decide whether the INTERVIEWER (recruiter) has just asked a NEW question to the candidate.

CRITICAL: the speaker labels in the transcript may be WRONG — it's a single mixed microphone. Do NOT trust the labels. Judge from CONTENT and conversational role:
- The INTERVIEWER asks questions that probe the candidate (about their experience, skills, projects, decisions). Usually phrased as a question or a request ("tell me about…", "how did you…", "what is…").
- The CANDIDATE answers — describing what THEY did, their experience, opinions.

You are given the CURRENT planned question and the most recent transcript turns. Decide:
- Has the interviewer, in the latest turn(s), asked a question to the candidate that is MATERIALLY DIFFERENT from the CURRENT question (a different topic/skill, or a clearly different ask)? Ignore acknowledgements, small talk, restating the same question, or the candidate speaking.
- If yes: return asked=true with "question" = the question the interviewer actually asked, cleaned into ONE short, clear sentence (max ~16 words), and a short "category" (e.g. "Recruiter asked", "Skills", "Follow-up").
- If the latest turns are just the candidate answering, or the interviewer asked essentially the SAME current question, or nothing question-like was asked: asked=false with question="".

Respond ONLY as JSON: {"asked": bool, "question": str, "category": str}`;

const detectSchema = z.object({
  callId: z.string().uuid(),
  currentQuestion: z.string().default(""),
  transcript: z
    .array(z.object({ speaker: z.string().default(""), text: z.string() }))
    .max(40)
    .default([]),
});

const historySchema = z.array(
  z.object({
    category: z.string().optional(),
    question: z.string().optional(),
    answer: z.string().optional(),
    verdict: z.string().optional(),
  }),
);

export async function assistRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Pre-call: fit read + personalized question plan from the JD + candidate.
  app.post("/plan", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z.object({ callId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const ctx = await loadJdResume(body.data.callId, req.authUser!.orgId);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none provided)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none provided)"}`;
    const result = await gptJson(PLAN_SYSTEM, user, { orgId: req.authUser!.orgId, operation: "plan", callId: body.data.callId });
    return {
      ok: true,
      candidateName: ctx.candidateName,
      fitVerdict: (result.fitVerdict as string) ?? "Not enough info",
      summary: (result.summary as string) ?? "",
      strengths: (result.strengths as string[]) ?? [],
      gaps: (result.gaps as string[]) ?? [],
      categories: (result.categories as Array<{ name: string; questions: string[] }>) ?? [],
    };
  });

  // The single next question to ask, given the conversation so far + the live
  // transcript of the last several turns (so follow-ups stay in context).
  app.post("/next", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z
      .object({
        callId: z.string().uuid(),
        history: historySchema.default([]),
        transcript: z
          .array(z.object({ speaker: z.string().default(""), text: z.string() }))
          .max(40)
          .default([]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const ctx = await loadJdResume(body.data.callId, req.authUser!.orgId);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const recent = body.data.transcript
      .slice(-10)
      .map((t) => `${(t.speaker || "?").toUpperCase()}: ${t.text}`)
      .join("\n");
    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none)"}\n\nQ&A SO FAR (coverage):\n${fmtHistory(body.data.history)}\n\nRECENT TRANSCRIPT (last turns, verbatim — use for immediate context; labels may be imperfect):\n${recent || "(nothing spoken yet)"}`;
    const result = await gptJson(NEXT_SYSTEM, user, { orgId: req.authUser!.orgId, operation: "next", callId: body.data.callId });
    return {
      ok: true,
      category: ((result.category as string) ?? "").trim(),
      question: ((result.question as string) ?? "").trim(),
      done: Boolean(result.done),
    };
  });

  // Did the candidate actually answer the current question?
  app.post("/verify", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z
      .object({
        callId: z.string().uuid(),
        question: z.string(),
        answer: z.string().default(""),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });

    const user = `CURRENT QUESTION:\n${body.data.question}\n\nCANDIDATE ANSWER SO FAR:\n${body.data.answer || "(nothing substantive yet)"}`;
    const result = await gptJson(VERIFY_SYSTEM, user, { orgId: req.authUser!.orgId, operation: "verify", callId: body.data.callId });
    return {
      ok: true,
      satisfied: Boolean(result.satisfied),
      verdict: ((result.verdict as string) ?? "Off-topic").trim(),
      feedback: ((result.feedback as string) ?? "").trim(),
      followUp: ((result.followUp as string) ?? "").trim(),
    };
  });

  // Did the interviewer just ask a NEW (off-script) question? Content-based.
  app.post("/detect-question", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = detectSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    if (body.data.transcript.length === 0) return { ok: true, asked: false, question: "", category: "" };

    const lines = body.data.transcript
      .slice(-12)
      .map((t) => `${(t.speaker || "?").toUpperCase()}: ${t.text}`)
      .join("\n");
    const user = `CURRENT QUESTION: ${body.data.currentQuestion || "(none yet)"}\n\nRECENT TRANSCRIPT (labels may be wrong — judge by content):\n${lines}`;
    const result = await gptJson(DETECT_SYSTEM, user, {
      orgId: req.authUser!.orgId,
      operation: "detect",
      callId: body.data.callId,
    });
    return {
      ok: true,
      asked: Boolean(result.asked),
      question: ((result.question as string) ?? "").trim(),
      category: ((result.category as string) ?? "Recruiter asked").trim(),
    };
  });

  // End-of-call calibrated score.
  app.post("/final", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z
      .object({ callId: z.string().uuid(), history: historySchema.default([]) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const ctx = await loadJdResume(body.data.callId, req.authUser!.orgId);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none)"}\n\nFULL INTERVIEW:\n${fmtHistory(body.data.history)}`;
    const result = await gptJson(FINAL_SYSTEM, user, { orgId: req.authUser!.orgId, operation: "final", callId: body.data.callId });

    const evaluation = {
      kind: "interview_eval" as const,
      verdict: (result.verdict as string) ?? "Borderline",
      score: (result.score as Record<string, number>) ?? {},
      summary: (result.summary as string) ?? "",
      strengths: (result.strengths as string[]) ?? [],
      concerns: (result.concerns as string[]) ?? [],
      // Persist the full asked/answered transcript so the call's score + rubric
      // are retrievable after the call ends.
      questions: body.data.history,
      candidateName: ctx.candidateName,
      generatedAt: new Date().toISOString(),
    };

    // Save the score + summary + rubric on the call row (jsonb `summary`).
    try {
      await db
        .update(callSessions)
        .set({ summary: evaluation, endedAt: new Date(), status: "ended" })
        .where(eq(callSessions.id, body.data.callId));
    } catch (err) {
      req.log.warn({ err, callId: body.data.callId }, "failed to persist interview evaluation");
    }

    return { ok: true, saved: true, ...evaluation };
  });

  // Fetch a saved evaluation (score + summary + rubric + Q&A) for a call.
  app.get<{ Params: { callId: string } }>("/:callId/evaluation", async (req, reply) => {
    const [call] = await db
      .select({ orgId: callSessions.orgId, summary: callSessions.summary })
      .from(callSessions)
      .where(eq(callSessions.id, req.params.callId));
    if (!call || call.orgId !== req.authUser!.orgId) return reply.code(404).send({ error: "not_found" });
    const evalData = call.summary as { kind?: string } | null;
    if (!evalData || evalData.kind !== "interview_eval") return { ok: true, evaluation: null };
    return { ok: true, evaluation: evalData };
  });

  // Token-usage + cost summary for the Live Assist co-pilot (this org).
  app.get<{ Querystring: { days?: string } }>("/usage", async (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const summary = await usageSummary(req.authUser!.orgId, days);
    return { ok: true, ...summary };
  });
}
