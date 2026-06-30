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
import { eq, asc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  callSessions,
  candidates as candidatesTable,
  clients as clientsTable,
  db,
  demands as demandsTable,
  transcriptTurns,
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

const PLAN_SYSTEM = `You are an interview architect + a sharp, honest technical screener. Given a JOB DESCRIPTION (the role's must-haves) and a CANDIDATE profile/resume (what they claim), do TWO things.

(1) A calibrated pre-call FIT read, judged ONLY against the JD's core must-haves. Be evidence-based and skeptical, not flattering. If info is thin, use "Not enough info" rather than inflating.

(2) A DETAILED, JD-SPECIFIC technical question bank tailored to THIS role and candidate. Generate EXACTLY 30 questions.

HOW TO MAKE THE QUESTIONS JD-SPECIFIC (this is the most important rule):
- FIRST, read the JD and extract EVERY concrete requirement it lists — each named module, skill, tool, framework, configuration object, process, integration, interface, version, and methodology. (Example, for an SAP MM + VMS role: procurement, inventory management, material valuation, goods receipt, goods issue, invoice verification, configuration of purchasing organizations / purchasing groups / material types / valuation classes, master-data maintenance, SD and FICO integration, IDOC and flat-file interfaces, VMS, end-to-end implementation vs support, etc.)
- Then write questions that DIRECTLY probe those specific items BY NAME. Every question must reference a concrete technology, configuration object, process step, integration, scenario, or a specific claim from the resume — drawn from THIS JD, not generic interviewing.
- COVER THE BREADTH of the JD: touch every major requirement with at least one question; spend more questions on the must-haves the JD emphasises. Do not cluster all questions on a single area.
- Where the JD names a PROCESS, ask the candidate to walk through exactly how they configured/handled it end to end. Where it names an INTEGRATION/interface, probe the data flow, mapping, and failure handling. Where it names a TOOL/module/version, probe real hands-on usage, configuration steps, and edge cases.

DETAIL & ELABORATION:
- Questions must be DETAILED and elaborative — NOT short one-liners. Each question should be 1–2 sentences: optionally set a brief concrete scenario, then ask a precise, answerable question that names the exact JD element. Aim for the kind of question that someone who has NOT actually done the work cannot bluff.
- BANNED as too generic: "tell me about your experience", "what are your strengths", "describe a challenge you faced", "are you familiar with X". Replace each with a specific depth probe.

STRUCTURE:
- Group into EXACTLY three difficulty buckets by "name": "Easy" (core fundamentals / definitions on the required tech), "Medium" (applied configuration & practical usage, trade-offs, real tasks), "Hard" (complex multi-step scenarios, integration/debugging, performance, edge cases, design decisions).
- Distribute 10 Easy, 12 Medium, 8 Hard — 30 questions total.
- ALWAYS produce all 30 even if the fit is weak — probe whether they actually have each required skill. Never return empty "questions" arrays.

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

// --- JD-specific, SKILL-WISE question bank (generated once per demand) -------
const BANK_MIN_QUESTIONS = 30;
const BANK_SYSTEM = `You are an expert technical interviewer building a reusable QUESTION BANK for a specific JOB DESCRIPTION. The bank is organised SKILL-WISE: grouped by the distinct skills/areas the JD requires.

STEP 1 — Extract skills: read the JD and list its distinct required skills/areas (each named module, technology, process, integration, tool, methodology). Example for an SAP MM + VMS role: "SAP MM – Procurement", "Inventory Management", "Material Valuation", "Goods Receipt / Goods Issue", "Invoice Verification", "MM Configuration (purchasing orgs/groups, material types, valuation classes)", "Master Data", "SD & FICO Integration", "IDOC / Flat-file Interfaces", "VMS".

STEP 2 — For EACH skill, write DETAILED, SPECIFIC, HIGH-QUALITY questions that probe real hands-on depth in THAT skill — name the exact configuration object, process step, or scenario. Each question is 1–2 sentences (a brief concrete scenario then a precise ask) that only someone who has actually done the work could answer well. NO generic questions ("tell me about your experience", "what are your strengths", "are you familiar with X"). NO duplicates or near-duplicates. Mix difficulties within each skill and tag each: "Easy" (fundamentals), "Medium" (applied configuration/usage, trade-offs), "Hard" (complex scenarios, integration/debugging, performance, edge cases).

EMPHASIS: If the recruiter provided EMPHASIS NOTES, weight the bank accordingly — give the emphasised skills MORE questions and HARDER ones, and put those skills first.

SIZE — STRICT: Produce AT LEAST ${BANK_MIN_QUESTIONS} questions total. NEVER fewer than ${BANK_MIN_QUESTIONS}. If the JD names only a few skills, go DEEPER on each (more Easy/Medium/Hard per skill) and include the closely-related fundamentals and adjacent technologies the role genuinely requires, until you reach at least ${BANK_MIN_QUESTIONS} quality questions. Roughly 4–8 per skill.

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"skills": [{"skill": str, "questions": [{"difficulty": "Easy"|"Medium"|"Hard", "question": str}, ...]}, ...]}`;

export interface JdQuestionBank {
  kind: "jd_question_bank";
  skills: Array<{ skill: string; questions: Array<{ difficulty: string; question: string }> }>;
  notesUsed: string;
  total: number;
  generatedAt: string;
}
type SkillGroup = JdQuestionBank["skills"][number];

function parseSkills(result: Record<string, unknown>): SkillGroup[] {
  const rawSkills = Array.isArray(result.skills) ? (result.skills as unknown[]) : [];
  return rawSkills
    .map((s) => {
      const o = s as { skill?: unknown; questions?: unknown };
      const qs = Array.isArray(o.questions) ? (o.questions as unknown[]) : [];
      return {
        skill: typeof o.skill === "string" ? o.skill : "General",
        questions: qs
          .map((q) => {
            const qo = q as { difficulty?: unknown; question?: unknown };
            return {
              difficulty: ["Easy", "Medium", "Hard"].includes(qo.difficulty as string) ? (qo.difficulty as string) : "Medium",
              question: typeof qo.question === "string" ? qo.question.trim() : "",
            };
          })
          .filter((q) => q.question.length > 0),
      };
    })
    .filter((s) => s.questions.length > 0);
}

const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Merge extra skill groups into the base, de-duping questions by normalised text.
function mergeSkills(base: SkillGroup[], extra: SkillGroup[]): SkillGroup[] {
  const seen = new Set(base.flatMap((s) => s.questions.map((q) => norm(q.question))));
  const out = base.map((s) => ({ skill: s.skill, questions: [...s.questions] }));
  for (const g of extra) {
    const fresh = g.questions.filter((q) => !seen.has(norm(q.question)));
    fresh.forEach((q) => seen.add(norm(q.question)));
    if (fresh.length === 0) continue;
    const existing = out.find((s) => norm(s.skill) === norm(g.skill));
    if (existing) existing.questions.push(...fresh);
    else out.push({ skill: g.skill, questions: fresh });
  }
  return out;
}

const countQ = (skills: SkillGroup[]) => skills.reduce((n, s) => n + s.questions.length, 0);

/**
 * Generate a skill-wise question bank for a JD (+ optional emphasis notes).
 * Guarantees AT LEAST 30 questions by topping up (up to 2 extra rounds) if the
 * first pass returns fewer — without duplicating questions.
 */
export async function generateJdQuestionBank(
  jd: string,
  notes: string,
  track: { orgId: string; operation: string; callId?: string | null },
): Promise<JdQuestionBank> {
  const baseUser = `JOB DESCRIPTION:\n${jd || "(none provided)"}\n\nEMPHASIS NOTES (the recruiter wants extra weight here):\n${notes?.trim() || "(none)"}`;
  let skills = parseSkills(await gptJson(BANK_SYSTEM, baseUser, track));

  for (let round = 0; round < 2 && countQ(skills) < BANK_MIN_QUESTIONS; round++) {
    const need = BANK_MIN_QUESTIONS - countQ(skills);
    const have = skills.map((s) => `${s.skill}:\n${s.questions.map((q) => `- ${q.question}`).join("\n")}`).join("\n\n");
    const topUpUser = `${baseUser}\n\nQUESTIONS ALREADY WRITTEN (do NOT repeat or paraphrase these):\n${have}\n\nGenerate ${need} ADDITIONAL distinct, high-quality, JD-specific questions (deepen existing skills and/or add closely-related required skills). Same JSON shape.`;
    const more = parseSkills(await gptJson(BANK_SYSTEM, topUpUser, track));
    const merged = mergeSkills(skills, more);
    if (countQ(merged) === countQ(skills)) break; // no progress — stop
    skills = merged;
  }

  return {
    kind: "jd_question_bank",
    skills,
    notesUsed: notes?.trim() || "",
    total: countQ(skills),
    generatedAt: new Date().toISOString(),
  };
}

// --- Score a finished call from its raw transcript (when no live history was
// captured) so a report is always available for a completed call. ------------
const FINAL_FROM_TRANSCRIPT_SYSTEM = `You are a senior interview evaluator. You are given the JOB DESCRIPTION, the candidate profile/resume, and the FULL CALL TRANSCRIPT of a screening call.

The call used a single mixed microphone, so speaker labels may be WRONG. Judge by CONTENT: the INTERVIEWER asks short probing questions; the CANDIDATE describes their own experience, skills, and decisions. Reconstruct the conversation from content, not labels.

Do TWO things:
(1) Reconstruct the interview as the key QUESTIONS the interviewer asked, each with the candidate's ANSWER (summarised from the transcript) and a short verdict.
(2) Produce a calibrated FINAL evaluation. Be honest and grounded in what was actually said. If the call was very short or thin on substance, lower confidence, prefer "Borderline" or lower, and say so in the summary.

Score each dimension 0-100: communication, relevance, depth, skills_match, overall (a hire recommendation, not just the average).

All output MUST be in English. Respond ONLY as JSON with this exact shape:
{"verdict": "Strong yes"|"Lean yes"|"Borderline"|"Lean no"|"Strong no",
 "score": {"overall": int, "communication": int, "relevance": int, "depth": int, "skills_match": int},
 "summary": str (2-3 sentences),
 "strengths": [up to 3],
 "concerns": [up to 3],
 "questions": [{"category": str, "question": str, "answer": str, "verdict": "Strong"|"Adequate"|"Weak"|"Off-topic"|"Vague"}]}`;

export interface CallEvaluation {
  kind: "interview_eval";
  verdict: string;
  score: Record<string, number>;
  summary: string;
  strengths: string[];
  concerns: string[];
  questions: Array<{ category?: string; question?: string; answer?: string; verdict?: string }>;
  candidateName: string;
  generatedAt: string;
}

/**
 * Generate a full evaluation for a finished call straight from its stored
 * transcript. Returns null only when there's nothing to score (no transcript).
 */
export async function evaluateCallFromTranscript(callId: string, orgId: string): Promise<CallEvaluation | null> {
  if (!env.OPENAI_API_KEY) return null;
  const ctx = await loadJdResume(callId, orgId);
  if (!ctx) return null;

  const turns = await db
    .select({ speaker: transcriptTurns.speaker, text: transcriptTurns.text })
    .from(transcriptTurns)
    .where(eq(transcriptTurns.callId, callId))
    .orderBy(asc(transcriptTurns.tsStartMs));
  const transcript = turns
    .map((t) => `${(t.speaker || "?").toUpperCase()}: ${(t.text || "").trim()}`)
    .filter((l) => l.length > 3)
    .join("\n")
    .trim();
  if (!transcript) return null;

  const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none)"}\n\nFULL CALL TRANSCRIPT (labels may be imperfect — judge by content):\n${transcript}`;
  const result = await gptJson(FINAL_FROM_TRANSCRIPT_SYSTEM, user, { orgId, operation: "final", callId });
  return {
    kind: "interview_eval",
    verdict: (result.verdict as string) ?? "Borderline",
    score: (result.score as Record<string, number>) ?? {},
    summary: (result.summary as string) ?? "",
    strengths: (result.strengths as string[]) ?? [],
    concerns: (result.concerns as string[]) ?? [],
    questions: (result.questions as CallEvaluation["questions"]) ?? [],
    candidateName: ctx.candidateName,
    generatedAt: new Date().toISOString(),
  };
}

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
