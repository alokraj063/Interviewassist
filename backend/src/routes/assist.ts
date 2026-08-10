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
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import { chatModel, chatTemperature, env } from "../env.js";
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
    ...chatTemperature(0.3),
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

/** Build the "JD" + "resume" strings the prompts need from the call doc.
 *  We read the inline snapshots written by POST /api/calls (demandSnapshot +
 *  candidate) so the assist endpoints don't depend on any "demands" or
 *  "candidates" persistence — both are gone now (jobs live in OL, candidate
 *  is ephemeral). Scoping is by `recruiterUserId`. */
async function loadJdResume(
  callId: string,
  recruiterUserId: string,
): Promise<{ jd: string; resume: string; candidateName: string } | null> {
  const call = await collections.interviews().findOne<{
    recruiterUserId: string;
    demandSnapshot?: {
      title?: string | null; designation?: string | null;
      client?: string | null;
      experienceFrom?: number | null; experienceTo?: number | null;
      primaryLocation?: string | null;
      description?: string | null; responsibilities?: string | null;
    } | null;
    candidate?: {
      name?: string | null; currentTitle?: string | null; currentCompany?: string | null;
      totalExperienceYears?: number | null; currentLocation?: string | null;
      parsedResume?: Record<string, unknown> | null;
    } | null;
  }>({ id: callId });
  if (!call || call.recruiterUserId !== recruiterUserId) return null;

  let jd = "";
  if (call.demandSnapshot) {
    const d = call.demandSnapshot;
    const exp = [d.experienceFrom, d.experienceTo].filter((v) => v != null).join("–");
    jd = [
      `ROLE: ${d.title ?? "(untitled)"}${d.designation ? ` (${d.designation})` : ""}`,
      d.client ? `CLIENT: ${d.client}` : "",
      exp ? `EXPERIENCE REQUIRED: ${exp} years` : "",
      d.primaryLocation ? `LOCATION: ${d.primaryLocation}` : "",
      d.description ? `\nJOB DESCRIPTION:\n${d.description}` : "",
      d.responsibilities ? `\nRESPONSIBILITIES:\n${d.responsibilities}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // Candidate identity lives inline on the call doc (ephemeral upload).
  // If the resume parser produced a `parsedResume` JSON, include its raw
  // form so the prompts can lift skills/experience/CTC etc. without us
  // having to schema-match every field.
  let resume = "";
  let candidateName = "";
  const k = call.candidate;
  if (k) {
    candidateName = k.name ?? "";
    const lines = [
      `NAME: ${k.name ?? "(unknown)"}`,
      k.currentTitle ? `CURRENT TITLE: ${k.currentTitle}` : "",
      k.currentCompany ? `CURRENT COMPANY: ${k.currentCompany}` : "",
      k.totalExperienceYears != null ? `TOTAL EXPERIENCE: ${k.totalExperienceYears} years` : "",
      k.currentLocation ? `LOCATION: ${k.currentLocation}` : "",
    ].filter(Boolean);
    if (k.parsedResume && Object.keys(k.parsedResume).length > 0) {
      lines.push("\nPARSED RESUME (raw):");
      lines.push(JSON.stringify(k.parsedResume, null, 2));
    }
    resume = lines.join("\n").trim();
  }

  return { jd, resume, candidateName };
}

// --- Prompts (ported + adapted from the Interview-Assist reference) ----------

const PLAN_SYSTEM = `You are an interview architect + a sharp, honest screener. Given a JOB DESCRIPTION (the role's must-haves) and a CANDIDATE profile/resume (what they claim), do TWO things.

(1) A calibrated pre-call FIT read, judged ONLY against the JD's core must-haves. Be evidence-based and skeptical, not flattering. If info is thin, use "Not enough info" rather than inflating.

(2) A TECHNICAL question bank tailored to THIS candidate and role. Generate EXACTLY 20 questions that test the role's required technologies and the specific skills, tools, and projects on the resume.

Hard rules for the questions:
- GROUNDING — ANTI-HALLUCINATION: every technology/tool/skill you name MUST literally appear in the JD or the resume provided. NEVER invent or assume a technology the inputs don't contain. If the JD/resume is thin, ask about the role's core named skills only — do not fabricate specifics.
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
- If RECRUITER-PICKED QUESTIONS are provided, treat them as the recruiter's preferred direction: keep your next question aligned with those topics, depth, and style (don't repeat them verbatim).

GROUNDING — ANTI-HALLUCINATION (the most important rule):
- NEVER invent, assume, or infer a technology, tool, framework, system, product, or project. You may ONLY name something if that exact word/phrase LITERALLY appears in the JOB DESCRIPTION, the CANDIDATE RESUME, or the verbatim RECENT TRANSCRIPT.
- If you cannot find a specific to anchor on, ask a plain question about a CORE skill named in the JD. Do NOT fabricate a specific (e.g. never reference "RAC systems", "knowledge graphs", or any term the candidate/JD/resume did not actually contain).
- The transcript is live speech-to-text and is OFTEN GARBLED. If a turn looks like noise or a misheard word, IGNORE it — do not treat a mis-transcribed fragment as a real topic the candidate raised.
- When in doubt, prefer a safe JD-grounded question over a clever-but-invented one.

Hard rules:
- Anchor every question in a SPECIFIC JD requirement AND/OR a specific candidate detail or something they JUST said — but only things that literally appear in the inputs (see GROUNDING). Never generic, never invented.
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

const VERIFY_SYSTEM = `You are a PRACTICAL interview evaluator helping the recruiter judge, IN REAL TIME, whether the candidate's answer to the CURRENT question is landing. Be FAIR — not harsh. Most real answers are imperfect but acceptable; the recruiter needs to keep moving.

You are given the CURRENT QUESTION and the RECENT TRANSCRIPT (the last few turns, verbatim).

CRITICAL — read BOTH sides, trust NO labels: this is a single mixed microphone, so the speaker labels (RECRUITER/CANDIDATE) are frequently WRONG. The candidate's actual answer may be mislabeled as the recruiter, or split across turns. Read EVERYTHING in the transcript and reconstruct the candidate's answer from CONTENT — the parts where someone describes their own experience/skills/decisions are the candidate answering; the short probing question is the recruiter. Never discard a turn just because of its label, or you will miss the real answer.

Judge whether the candidate has, across those recent turns, ANSWERED the current question.

GROUNDING — ANTI-HALLUCINATION (critical): Judge ONLY what is LITERALLY in the transcript. NEVER claim the candidate "mentioned X", "talked about X", or "referenced X" unless that exact word/topic actually appears in the transcript above. If the transcript is empty, garbled speech-to-text noise, or doesn't address the question, mark it Off-topic with feedback like "They haven't answered yet." — do NOT invent content or attribute a topic they never said. Your feedback must be defensible against the verbatim transcript.

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

const FINAL_SYSTEM = `You are a senior interview evaluator producing the FINAL evaluation after the interview. You receive the JD, the candidate profile/resume, and the full transcript (every Q with its answer + the live verdict). Be honest and calibrated — don't inflate or deflate; ground claims in what the candidate actually said. If the interview was short, lower confidence and prefer "Average".

EVIDENCE WEIGHTING — THE MOST IMPORTANT RULE: score from what the candidate actually SAID in the interview. The resume and JD are context that tell you what to look for — they are NOT evidence of ability. A resume claim only counts when the candidate backed it up with specifics on the call. An impressive resume with thin answers is a WEAK interview and must score as one. skills_match reflects only skills demonstrated or credibly discussed in the answers; depth reflects the concrete detail they actually gave. Strengths/concerns must cite the answers, never resume facts.

Score each dimension 0-100: communication, relevance, depth, skills_match, overall (a hire-recommendation, not just the average). Hard rule: if no answer contains a concrete example, depth and skills_match must be ≤ 50 and overall ≤ 55.

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"verdict": one of "Good"|"Above Average"|"Average"|"Below Average"|"Poor",
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
- If yes: return asked=true with "question" = the question the interviewer ACTUALLY asked, paraphrased faithfully into ONE short, clear sentence (max ~16 words), and a short "category" (e.g. "Recruiter asked", "Skills", "Follow-up").
- If the latest turns are just the candidate answering, or the interviewer asked essentially the SAME current question, or nothing question-like was asked: asked=false with question="".

ANTI-HALLUCINATION: only report a question that was LITERALLY asked in the transcript. Never invent a topic or technology that isn't in the turns. The transcript is live speech-to-text and is often garbled — if the latest turns are noise / unintelligible, return asked=false. Do not turn a misheard fragment into a question.

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
const BANK_TARGET_QUESTIONS = 33;   // aim for ~33 in ONE call — speed over bulk
const BANK_TOPUP_THRESHOLD = 30;    // top up (once) only if the first call fell short
const BANK_MAX_QUESTIONS = 35;      // hard cap enforced in code — models over-count
const BANK_SYSTEM = `You are an expert technical interviewer building a reusable QUESTION BANK for a specific JOB DESCRIPTION. The bank is organised SKILL-WISE: grouped by the distinct skills/areas the JD requires.

STEP 1 — Pick the skill list to cover. The user message may contain a CALIBRATION block with "PRIMARY SKILLS" and/or "SECONDARY SKILLS" lists — the reconciled, authoritative skill classification for this demand. Choose the skill set STRICTLY in this order, and cover ONLY the list you land on (do not blend in the other tier, and do not add extra JD skills outside it):
  1. PRIMARY SKILLS present and non-empty → use ONLY the Primary Skills list. Ignore Secondary Skills entirely.
  2. PRIMARY SKILLS absent/empty AND SECONDARY SKILLS present and non-empty → fall back to ONLY the Secondary Skills list.
  3. Neither list present (no calibration was run for this demand) → fall back to the general extraction: read the JD and list its distinct required skills/areas (each named module, technology, process, integration, tool, methodology). Example for an SAP MM + VMS role: "SAP MM – Procurement", "Inventory Management", "Material Valuation", "Goods Receipt / Goods Issue", "Invoice Verification", "MM Configuration (purchasing orgs/groups, material types, valuation classes)", "Master Data", "SD & FICO Integration", "IDOC / Flat-file Interfaces", "VMS".

STEP 2 — For EACH skill, write DETAILED, SPECIFIC, HIGH-QUALITY questions that probe real hands-on depth in THAT skill — name the exact configuration object, process step, or scenario. Each question is 1–2 sentences (a brief concrete scenario then a precise ask) that only someone who has actually done the work could answer well. NO generic questions ("tell me about your experience", "what are your strengths", "are you familiar with X"). NO yes/no questions and NO duplicates or near-duplicates. Mix difficulties within each skill and tag each: "Easy" (fundamentals), "Medium" (applied configuration/usage, trade-offs), "Hard" (complex scenarios, integration/debugging, performance, edge cases).

QUALITY BAR — each question must: (a) target ONE concrete competency an interviewer can score; (b) be answerable verbally in under ~2 minutes (not an essay); (c) invite a "how/why/walk me through" explanation, not recall of a definition; (d) use precise domain terminology from the JD. Prefer real scenarios ("A GR posts to the wrong valuation class — how do you find and fix it?") over abstract prompts ("explain valuation classes").

DEPTH & DIFFICULTY MIX — lean HARD/TECHNICAL. Aim for roughly 20% Easy, 45% Medium, 35% Hard. The bank must be dominated by hands-on TECHNICAL questions — configuration, transactions/commands, tables/objects, debugging, integration, performance, edge cases — not definitional or behavioural ones. At most ONE "Easy" fundamentals question per skill; spend the rest on Medium/Hard depth.

TYPE MIX — STRICT: at most 20% of all questions may be type "Concept". Every other question must be hands-on: "Scenario", "Coding", "Query", "Command", "Config", or "Design". If a question can be phrased as "write the query / show the command / name the config object / walk through this failure" instead of "explain X", it MUST be. Definitional "what is X" questions are banned.

QUESTION TYPE — tag EACH question with "type", exactly one of:
  • "Concept" — explain how/why something works.
  • "Scenario" — a real troubleshooting or situational problem.
  • "Coding" — write code / a function / a formula.
  • "Query" — write a SQL / DB / API query.
  • "Command" — an exact CLI / transaction / tool command or step sequence.
  • "Config" — configuration objects / paths / values to set.
  • "Design" — architecture / approach / trade-offs.
Choose "Coding"/"Query"/"Command"/"Config" whenever the question asks the candidate to WRITE something, SHOW syntax, or GIVE AN EXAMPLE.

ANSWER — FORMAT MUST MATCH THE TYPE:
  • Coding / Query / Command: the "answer" MUST contain the ACTUAL example — a short, correct, ready-to-read snippet / query / command (real syntax, not a description) — followed by " · " and 2–3 key points that make it correct. e.g. "SELECT dept_id, COUNT(*) FROM emp GROUP BY dept_id HAVING COUNT(*)>5; · GROUP BY, HAVING vs WHERE, aggregate".
  • Config: the exact objects/paths/values (e.g. "OMSY, plant, current period; OB52 posting periods; T001B").
  • Concept / Scenario / Design: 4–7 PRECISE comma-separated keywords/phrases — exact transaction/table/object names, parameters, standards — a cheat-sheet, NOT prose, ≤ 22 words. e.g. "MIGO / MB1A, movement type 201, cost center, reservation, OBYC GL auto-posting".
In ALL cases the answer is compact (one line where possible) — the interviewer scans it while listening.

GROUNDING — ANTI-HALLUCINATION: every technology/tool/skill you name (in questions AND answers) MUST literally appear in the JD provided (or the recruiter's added points). NEVER invent a technology the JD doesn't contain.

CALIBRATION: the JD may contain a "=== CALIBRATION (refined requirement — overrides JD on conflict) ===" block — the human-refined requirement from client calls. It is MORE authoritative than the JD text: if they conflict, follow the calibration (subject to the PRIMARY/SECONDARY skill selection already made in STEP 1). CAVEATS are disqualifiers the client flagged — include probing questions designed to expose whether the candidate falls into them, but ONLY for skills within the list you selected in STEP 1.

EMPHASIS: if the recruiter typed EMPHASIS NOTES or ADDITIONAL JD POINTS, weight the bank accordingly — give those skills MORE questions and HARDER ones, and put them first, EVEN IF the skill falls outside the STEP 1 list — an explicit human ask always wins over the calibration tiering.

SIZE — STRICT: Produce AT LEAST 30 and AT MOST 35 questions total (target ${BANK_TARGET_QUESTIONS}). COUNT your questions before responding — fewer than 30 is a hard failure, more than 35 is a hard failure. Spread evenly across the STEP 1 skill list — if it has few skills, go deeper on each (more Medium/Hard) until you reach ${BANK_TARGET_QUESTIONS}; if it has many, keep every skill represented rather than dropping any, thinning per-skill count as needed to stay within the cap.

All output text MUST be in English.

Respond ONLY as JSON with this exact shape:
{"skills": [{"skill": str, "questions": [{"difficulty": "Easy"|"Medium"|"Hard", "type": "Concept"|"Scenario"|"Coding"|"Query"|"Command"|"Config"|"Design", "question": str, "answer": str}, ...]}, ...]}`;

const BANK_TYPES = ["Concept", "Scenario", "Coding", "Query", "Command", "Config", "Design"];

export interface JdQuestionBank {
  kind: "jd_question_bank";
  skills: Array<{ skill: string; questions: Array<{ difficulty: string; type?: string; question: string; answer?: string }> }>;
  notesUsed: string;
  total: number;
  generatedAt: string;
}
type BankSkillGroup = JdQuestionBank["skills"][number];

function parseBankSkills(result: Record<string, unknown>): BankSkillGroup[] {
  const rawSkills = Array.isArray(result.skills) ? (result.skills as unknown[]) : [];
  return rawSkills
    .map((s) => {
      const o = s as { skill?: unknown; questions?: unknown };
      const qs = Array.isArray(o.questions) ? (o.questions as unknown[]) : [];
      return {
        skill: typeof o.skill === "string" ? o.skill : "General",
        questions: qs
          .map((q) => {
            const qo = q as { difficulty?: unknown; type?: unknown; question?: unknown; answer?: unknown };
            return {
              difficulty: ["Easy", "Medium", "Hard"].includes(qo.difficulty as string) ? (qo.difficulty as string) : "Medium",
              type: BANK_TYPES.includes(qo.type as string) ? (qo.type as string) : "Concept",
              question: typeof qo.question === "string" ? qo.question.trim() : "",
              answer: typeof qo.answer === "string" ? qo.answer.trim() : "",
            };
          })
          .filter((q) => q.question.length > 0),
      };
    })
    .filter((s) => s.questions.length > 0);
}

const normQ = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function mergeBankSkills(base: BankSkillGroup[], extra: BankSkillGroup[]): BankSkillGroup[] {
  const seen = new Set(base.flatMap((s) => s.questions.map((q) => normQ(q.question))));
  const out = base.map((s) => ({ skill: s.skill, questions: [...s.questions] }));
  for (const g of extra) {
    const fresh = g.questions.filter((q) => !seen.has(normQ(q.question)));
    fresh.forEach((q) => seen.add(normQ(q.question)));
    if (fresh.length === 0) continue;
    const existing = out.find((s) => normQ(s.skill) === normQ(g.skill));
    if (existing) existing.questions.push(...fresh);
    else out.push({ skill: g.skill, questions: fresh });
  }
  return out;
}
const countBankQ = (skills: BankSkillGroup[]) => skills.reduce((n, s) => n + s.questions.length, 0);

// Enforce the size cap deterministically: drop the last question of the
// currently-largest skill group until within `max`, so no skill is wiped out
// and coverage stays balanced.
function trimBankSkills(skills: BankSkillGroup[], max: number): BankSkillGroup[] {
  let total = countBankQ(skills);
  if (total <= max) return skills;
  const out = skills.map((s) => ({ skill: s.skill, questions: [...s.questions] }));
  while (total > max) {
    const largest = out.reduce((a, b) => (b.questions.length > a.questions.length ? b : a));
    largest.questions.pop();
    total--;
  }
  return out.filter((s) => s.questions.length > 0);
}

/**
 * Generate a skill-wise question bank for a JD (+ optional emphasis notes).
 * Normally a SINGLE model call targeting ~${BANK_TARGET_QUESTIONS} questions;
 * one top-up round only if the first call falls far short (< threshold).
 */
export async function generateJdQuestionBank(
  jd: string,
  notes: string,
  track: { orgId: string; operation: string; callId?: string | null },
): Promise<JdQuestionBank> {
  const baseUser = `JOB DESCRIPTION:\n${jd || "(none provided)"}\n\nEMPHASIS NOTES / ADDITIONAL JD POINTS (weight these too):\n${notes?.trim() || "(none)"}`;
  let skills = parseBankSkills(await gptJson(BANK_SYSTEM, baseUser, track));

  if (countBankQ(skills) < BANK_TOPUP_THRESHOLD) {
    const need = BANK_TARGET_QUESTIONS - countBankQ(skills);
    const have = skills.map((s) => `${s.skill}:\n${s.questions.map((q) => `- ${q.question}`).join("\n")}`).join("\n\n");
    const topUpUser = `${baseUser}\n\nQUESTIONS ALREADY WRITTEN (do NOT repeat or paraphrase these):\n${have}\n\nGenerate ${need} ADDITIONAL distinct, high-quality, JD-specific questions (deepen existing skills and/or add closely-related required skills). Same JSON shape.`;
    const more = parseBankSkills(await gptJson(BANK_SYSTEM, topUpUser, track));
    skills = mergeBankSkills(skills, more);
  }
  skills = trimBankSkills(skills, BANK_MAX_QUESTIONS);

  return {
    kind: "jd_question_bank",
    skills,
    notesUsed: notes?.trim() || "",
    total: countBankQ(skills),
    generatedAt: new Date().toISOString(),
  };
}

// --- Score a finished call from its inline transcript (when no live history
// was captured) so a report is always available for a completed call. --------
const FINAL_FROM_TRANSCRIPT_SYSTEM = `You are a senior interview evaluator. You are given the JOB DESCRIPTION, the candidate profile/resume, and the FULL CALL TRANSCRIPT of a screening call.

The call used a single mixed microphone, so speaker labels may be WRONG. Judge by CONTENT: the INTERVIEWER asks short probing questions; the CANDIDATE describes their own experience, skills, and decisions. Reconstruct the conversation from content, not labels.

EVIDENCE WEIGHTING — THE MOST IMPORTANT RULE: the TRANSCRIPT is the evaluation. The resume and JD are context that tell you what to LOOK FOR — they are NOT evidence of ability. A resume claim only counts toward a score when the candidate backed it up on the call with specifics (what they built, how it worked, decisions, trade-offs, numbers). NEVER lift a score because the resume looks strong: an impressive resume with a thin call is a WEAK interview, and the scores must say so.

Do TWO things:
(1) Reconstruct the interview as the key QUESTIONS the interviewer asked, each with the candidate's ANSWER (summarised from the transcript) and a short verdict.
(2) Produce a calibrated FINAL evaluation OF THE CALL. Be honest and grounded in what was actually said. If the call was very short or thin on substance, lower confidence, prefer "Average" or lower, and say so in the summary.

Score each dimension 0-100 from TRANSCRIPT EVIDENCE ONLY:
- communication: how clearly and coherently they actually spoke on the call.
- relevance: how much of what they SAID addresses the JD's must-haves — not how relevant their resume looks.
- depth: the specifics they gave — concrete examples, how/why detail, trade-offs. Vague or generic answers = low depth, whatever the resume says.
- skills_match: JD must-have skills the candidate DEMONSTRATED or credibly discussed on the call. Skills that appear only on the resume and were never substantiated in conversation do NOT raise this score.
- overall: a hire recommendation for this interview (not an average, and not a resume screen).

CALIBRATION CAPS (hard rules): if the candidate gave NO concrete example anywhere in the call, depth and skills_match must be ≤ 50 and overall ≤ 55. If the call contains only a handful of substantive answers, no dimension may exceed 70.

STRENGTHS and CONCERNS must each cite what happened ON THE CALL — something they said, demonstrated, or conspicuously failed to say. Never list a resume fact (e.g. "strong educational background") as a strength. A gap between what the resume claims and what the candidate could actually discuss IS a concern worth naming.

All output MUST be in English. Respond ONLY as JSON with this exact shape:
{"verdict": "Good"|"Above Average"|"Average"|"Below Average"|"Poor",
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
  questionCount: number;   // total questions the interviewer asked
  answeredCount: number;   // of those, how many the candidate actually answered
  candidateName: string;
  generatedAt: string;
}

// A question counts as "answered" when the candidate gave a substantive reply
// (not off-topic / no-answer).
function countAnswered(qs: CallEvaluation["questions"]): number {
  return qs.filter((q) => (q.answer ?? "").trim().length > 0 && q.verdict !== "Off-topic").length;
}

/**
 * Generate a full evaluation for a finished call straight from its inline
 * transcript[]. Returns null only when there's nothing to score.
 */
export async function evaluateCallFromTranscript(callId: string, uid: string): Promise<CallEvaluation | null> {
  if (!env.OPENAI_API_KEY) return null;
  const ctx = await loadJdResume(callId, uid);
  if (!ctx) return null;

  const call = await collections.interviews().findOne<{
    transcript?: Array<{ speaker?: string; text?: string; tsStartMs?: number }>;
  }>({ id: callId }, { projection: { _id: 0, transcript: 1 } });
  const turns = (call?.transcript ?? [])
    .slice()
    .sort((a, b) => (a.tsStartMs ?? 0) - (b.tsStartMs ?? 0));
  const transcript = turns
    .map((t) => `${(t.speaker || "?").toUpperCase()}: ${(t.text || "").trim()}`)
    .filter((l) => l.length > 3)
    .join("\n")
    .trim();
  if (!transcript) return null;

  // Objective size signals so the model calibrates "short/thin call" on
  // numbers instead of guessing from the text alone.
  const durationMs = turns.length >= 2 ? (turns[turns.length - 1].tsStartMs ?? 0) - (turns[0].tsStartMs ?? 0) : 0;
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));
  const wordCount = transcript.split(/\s+/).length;
  const stats = `CALL STATS: ~${durationMin} min, ${turns.length} transcript turns, ~${wordCount} words spoken total.`;

  const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME (context only — NOT scoring evidence):\n${ctx.resume || "(none)"}\n\n${stats}\n\nFULL CALL TRANSCRIPT (labels may be imperfect — judge by content; THIS is the evidence you score from):\n${transcript}`;
  const result = await gptJson(FINAL_FROM_TRANSCRIPT_SYSTEM, user, { orgId: uid, operation: "final", callId });
  const questions = (result.questions as CallEvaluation["questions"]) ?? [];
  return {
    kind: "interview_eval",
    verdict: (result.verdict as string) ?? "Average",
    score: (result.score as Record<string, number>) ?? {},
    summary: (result.summary as string) ?? "",
    strengths: (result.strengths as string[]) ?? [],
    concerns: (result.concerns as string[]) ?? [],
    questions,
    questionCount: questions.length,
    answeredCount: countAnswered(questions),
    candidateName: ctx.candidateName,
    generatedAt: new Date().toISOString(),
  };
}

// --- Plain-English recap of what was actually discussed on the call, as
// opposed to `evaluateCallFromTranscript`'s scoring verdict. Recruiters use
// this to skim a completed call without reading the full transcript. --------
const CONVERSATION_SUMMARY_SYSTEM = `You are summarising a recruiter-candidate screening call for a recruiter who did not attend it.

The call used a single mixed microphone, so speaker labels may be WRONG. Judge by CONTENT: the INTERVIEWER asks short probing questions; the CANDIDATE describes their own experience, skills, and decisions. Reconstruct the conversation from content, not labels.

Write a plain, readable recap of what was actually DISCUSSED — not a score, not a hire/no-hire verdict, not a judgement of the candidate's quality. Just: what topics came up, what the candidate said about each, and anything logistical that was agreed or raised (notice period, CTC, location, availability, etc.) if it came up.

All output MUST be in English, even if the call itself was in Hindi/Hinglish. Respond ONLY as JSON with this exact shape:
{"summary": str (a short narrative recap, 4-6 sentences),
 "topics": [str, ... up to 6 short topic labels covered on the call, in the order discussed],
 "logistics": str (notice period / CTC / location / availability mentioned on the call, or "" if none came up)}`;

export interface ConversationSummary {
  kind: "conversation_summary";
  summary: string;
  topics: string[];
  logistics: string;
  generatedAt: string;
}

/**
 * Plain narrative recap of a finished call's inline transcript[] — sibling to
 * `evaluateCallFromTranscript` but purely descriptive, no scoring. Returns
 * null only when there's nothing to summarise (no OpenAI key, or no captured
 * conversation).
 */
export async function summarizeCallTranscript(callId: string, uid: string): Promise<ConversationSummary | null> {
  if (!env.OPENAI_API_KEY) return null;
  const ctx = await loadJdResume(callId, uid);
  if (!ctx) return null;

  const call = await collections.interviews().findOne<{
    transcript?: Array<{ speaker?: string; text?: string; tsStartMs?: number }>;
  }>({ id: callId }, { projection: { _id: 0, transcript: 1 } });
  const turns = (call?.transcript ?? [])
    .slice()
    .sort((a, b) => (a.tsStartMs ?? 0) - (b.tsStartMs ?? 0));
  const transcript = turns
    .map((t) => `${(t.speaker || "?").toUpperCase()}: ${(t.text || "").trim()}`)
    .filter((l) => l.length > 3)
    .join("\n")
    .trim();
  if (!transcript) return null;

  const user = `ROLE THE CALL WAS ABOUT:\n${ctx.jd || "(none)"}\n\nCANDIDATE:\n${ctx.resume || "(none)"}\n\nFULL CALL TRANSCRIPT (labels may be imperfect — judge by content):\n${transcript}`;
  const result = await gptJson(CONVERSATION_SUMMARY_SYSTEM, user, { orgId: uid, operation: "conversation_summary", callId });
  return {
    kind: "conversation_summary",
    summary: (result.summary as string) ?? "",
    topics: (result.topics as string[]) ?? [],
    logistics: (result.logistics as string) ?? "",
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
    const ctx = await loadJdResume(body.data.callId, req.authUser!.uid);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none provided)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none provided)"}`;
    const result = await gptJson(PLAN_SYSTEM, user, { orgId: req.authUser!.uid, operation: "plan", callId: body.data.callId });
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
        // Questions the recruiter manually picked from the bank — their
        // preferred direction. Used to steer/improve subsequent questions.
        picked: z.array(z.string()).max(40).default([]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const ctx = await loadJdResume(body.data.callId, req.authUser!.uid);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const recent = body.data.transcript
      .slice(-6)
      .map((t) => `${(t.speaker || "?").toUpperCase()}: ${t.text}`)
      .join("\n");
    const pickedBlock = body.data.picked.length
      ? `\n\nRECRUITER-PICKED QUESTIONS (their chosen direction — align your next question to the same topics, depth, and style; don't repeat them verbatim):\n${body.data.picked.slice(-8).map((q) => `- ${q}`).join("\n")}`
      : "";
    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME:\n${ctx.resume || "(none)"}\n\nQ&A SO FAR (coverage):\n${fmtHistory(body.data.history)}\n\nRECENT TRANSCRIPT (last ~6 turns, verbatim — use for immediate context; labels may be imperfect):\n${recent || "(nothing spoken yet)"}${pickedBlock}`;
    const result = await gptJson(NEXT_SYSTEM, user, { orgId: req.authUser!.uid, operation: "next", callId: body.data.callId });
    return {
      ok: true,
      category: ((result.category as string) ?? "").trim(),
      question: ((result.question as string) ?? "").trim(),
      done: Boolean(result.done),
    };
  });

  // Is the candidate's answer to the current question landing? Judged from the
  // recent transcript (BOTH sides — labels are unreliable on a mixed mic).
  app.post("/verify", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z
      .object({
        callId: z.string().uuid(),
        question: z.string(),
        // Preferred: the last few transcript turns (both speakers). `answer`
        // is kept for backward compatibility when no transcript is sent.
        transcript: z
          .array(z.object({ speaker: z.string().default(""), text: z.string() }))
          .max(40)
          .default([]),
        answer: z.string().default(""),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });

    const recent = body.data.transcript
      .slice(-6)
      .map((t) => `${(t.speaker || "?").toUpperCase()}: ${t.text}`)
      .join("\n");
    const answerBlock = recent
      ? `RECENT TRANSCRIPT (last turns, both sides — labels may be wrong, read everything):\n${recent}`
      : `CANDIDATE ANSWER SO FAR:\n${body.data.answer || "(nothing substantive yet)"}`;
    const user = `CURRENT QUESTION:\n${body.data.question}\n\n${answerBlock}`;
    const result = await gptJson(VERIFY_SYSTEM, user, { orgId: req.authUser!.uid, operation: "verify", callId: body.data.callId });
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
      .slice(-6)
      .map((t) => `${(t.speaker || "?").toUpperCase()}: ${t.text}`)
      .join("\n");
    const user = `CURRENT QUESTION: ${body.data.currentQuestion || "(none yet)"}\n\nRECENT TRANSCRIPT (labels may be wrong — judge by content):\n${lines}`;
    const result = await gptJson(DETECT_SYSTEM, user, {
      orgId: req.authUser!.uid,
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

  // Auto-store a single answered Q&A on the interview doc (called by the UI
  // when it advances to the next question, so the asked/answered pair is saved
  // immediately — not only at /final).
  app.post("/answer", async (req, reply) => {
    const body = z
      .object({
        callId: z.string().uuid(),
        category: z.string().default(""),
        question: z.string(),
        answer: z.string().default(""),
        verdict: z.string().default(""),
        feedback: z.string().default(""),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const call = await collections.interviews().findOne<{ recruiterUserId: string }>({ id: body.data.callId });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ ok: false, error: "not_found" });
    const entry = {
      category: body.data.category,
      question: body.data.question,
      answer: body.data.answer,
      verdict: body.data.verdict,
      feedback: body.data.feedback,
      at: new Date(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collections.interviews().updateOne({ id: body.data.callId }, { $push: { qa: entry } } as any);
    return { ok: true };
  });

  // End-of-call calibrated score.
  app.post("/final", async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const body = z
      .object({ callId: z.string().uuid(), history: historySchema.default([]) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "invalid_payload" });
    const ctx = await loadJdResume(body.data.callId, req.authUser!.uid);
    if (!ctx) return reply.code(404).send({ ok: false, error: "call_not_found" });

    const user = `JOB DESCRIPTION:\n${ctx.jd || "(none)"}\n\nCANDIDATE PROFILE / RESUME (context only — NOT scoring evidence):\n${ctx.resume || "(none)"}\n\nFULL INTERVIEW (THIS is the evidence you score from):\n${fmtHistory(body.data.history)}`;
    const result = await gptJson(FINAL_SYSTEM, user, { orgId: req.authUser!.uid, operation: "final", callId: body.data.callId });

    const evaluation = {
      kind: "interview_eval" as const,
      verdict: (result.verdict as string) ?? "Average",
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
      await collections.interviews().updateOne(
        { id: body.data.callId },
        { $set: { summary: evaluation, endedAt: new Date(), status: "ended" } },
      );
    } catch (err) {
      req.log.warn({ err, callId: body.data.callId }, "failed to persist interview evaluation");
    }

    return { ok: true, saved: true, ...evaluation };
  });

  // Fetch a saved evaluation (score + summary + rubric + Q&A) for a call.
  app.get<{ Params: { callId: string } }>("/:callId/evaluation", async (req, reply) => {
    const call = await collections.interviews().findOne<{ recruiterUserId: string; summary: unknown }>({ id: req.params.callId });
    if (!call || call.recruiterUserId !== req.authUser!.uid) return reply.code(404).send({ error: "not_found" });
    const evalData = call.summary as { kind?: string } | null;
    if (!evalData || evalData.kind !== "interview_eval") return { ok: true, evaluation: null };
    return { ok: true, evaluation: evalData };
  });

  // Token-usage + cost summary for the Live Assist co-pilot (this org).
  app.get<{ Querystring: { days?: string } }>("/usage", async (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const summary = await usageSummary(req.authUser!.uid, days);
    return { ok: true, ...summary };
  });
}
