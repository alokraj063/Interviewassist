// Calls + everything hung off them. Each call gets:
//   - a call_sessions row
//   - 25-30 transcript turns (Hinglish dialogue)
//   - rubric scores (for ~25 of the 40 calls)
//   - technical Q&A (for ~15 of the 40 calls)
//   - a QA review row (for ~18 of the 40 calls)
//   - a synthetic WAV file in DUMP_DIR
import {
  callQaReviews,
  callRubrics,
  callRubricScores,
  callSessions,
  callTechnicalQa,
  db,
  prospectCalls,
  type RubricCriterion,
  transcriptTurns,
} from "@j2w/db";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import { HINGLISH_CALL_HEADLINES, HINGLISH_DIALOGUES, HINGLISH_PROSPECT_SUMMARIES, type DialogueTurn } from "./hinglishCorpus.js";
import {
  daysAgo,
  intBetween,
  pick,
  pickN,
  stableUuid,
  type Rng,
} from "./rng.js";
import { synthesiseCallWav } from "./wavSynthesizer.js";

const TECHNICAL_PROMPTS: Array<{ skill: string; difficulty: "easy" | "medium" | "hard"; question: string; goodAnswer: string; weakAnswer: string }> = [
  { skill: "Java", difficulty: "medium", question: "Walk me through the difference between volatile, synchronized, and AtomicInteger.", goodAnswer: "Volatile guarantees visibility but not atomicity. Synchronized gives mutual exclusion + memory ordering. AtomicInteger uses CAS for lock-free updates of a single 32-bit value.", weakAnswer: "Volatile makes a variable thread-safe. Synchronized blocks code." },
  { skill: "Java", difficulty: "hard", question: "How does the JVM optimise a tight loop with Just-In-Time compilation?", goodAnswer: "C1 compiles quickly with profiling; C2 recompiles hot loops with deeper optimisations like inlining, escape analysis, OSR.", weakAnswer: "JIT just makes things faster. I haven't looked into it." },
  { skill: "PostgreSQL", difficulty: "medium", question: "What's the difference between a B-tree index and a GIN index?", goodAnswer: "B-tree for ordered/equality queries on scalars; GIN for composite values like jsonb, full-text vectors — slower writes but fast contains-lookups.", weakAnswer: "Both are indexes, GIN is for special types." },
  { skill: "System Design", difficulty: "hard", question: "Design a notification fan-out service for 1M users.", goodAnswer: "Producer enqueues to Kafka partitioned by user_id. Workers read in batches, lookup user prefs in Redis, route to FCM/SES with provider-side rate-limit (token bucket). Track delivery in metrics; DLQ retries.", weakAnswer: "Use a queue and send notifications." },
  { skill: "Kafka", difficulty: "medium", question: "Explain at-least-once vs exactly-once semantics in Kafka.", goodAnswer: "At-least-once = retry on producer ack failure → duplicates possible. Exactly-once via idempotent producer + transactional commit across consumer offset + sink.", weakAnswer: "Exactly-once is built into Kafka by default." },
  { skill: "Spring Boot", difficulty: "medium", question: "How does @Transactional propagation work?", goodAnswer: "Default is REQUIRED — joins existing tx or starts new. REQUIRES_NEW always starts a new tx, suspending the outer. NESTED uses savepoints.", weakAnswer: "It just makes the method transactional." },
  { skill: "AWS", difficulty: "easy", question: "When would you choose SQS over Kinesis?", goodAnswer: "SQS for decoupled work-queue with at-least-once and DLQ. Kinesis for ordered, replayable streams with multiple consumers reading independently.", weakAnswer: "They're both message queues; SQS is older." },
];

const RUBRIC_RATIONALES: Record<string, string> = {
  script_adherence: "Recruiter followed the standard intro and qualification flow. All 5 must-capture data points covered.",
  jd_coverage: "Probed must-have skills (Java, Spring Boot, distributed systems) and confirmed candidate's hands-on exposure.",
  salary_handling: "CTC band stated up front. Captured current and expected without pressure.",
  positioning: "Industry context and team scale described. Could have positioned the engineering culture more.",
  candidate_experience: "Open-ended objection handling. Candidate had space to ask questions on interview process.",
  compliance_disclosure: "Stated PII rules clearly. Did not request prohibited data.",
  technical_depth: "Hit JVM concurrency, DB internals, system design layered question. Depth probe well calibrated.",
};

function defaultRubricCriteria(): RubricCriterion[] {
  return [
    { id: "script_adherence", name: "Script adherence", description: "Did the recruiter follow the standard intro and qualification flow?", weight: 0.15, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: true, kind: "script_adherence" },
    { id: "jd_coverage", name: "JD coverage", description: "Did the recruiter probe the must-have skills and responsibilities from the JD?", weight: 0.25, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: true, kind: "jd_coverage" },
    { id: "salary_handling", name: "Compensation handling", description: "Were CTC expectations and salary range positioning handled cleanly?", weight: 0.2, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: false, kind: "salary_handling" },
    { id: "positioning", name: "Client positioning", description: "Was the client and the role positioned with relevant context?", weight: 0.15, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: true, kind: "positioning" },
    { id: "candidate_experience", name: "Candidate experience", description: "Did the recruiter give the candidate space to ask questions and respond to objections?", weight: 0.25, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: false, kind: "candidate_experience" },
  ];
}
function technicalRubricCriteria(): RubricCriterion[] {
  return [
    ...defaultRubricCriteria(),
    { id: "technical_depth", name: "Technical depth", description: "Did the recruiter probe technical skills with depth-appropriate questions?", weight: 0.3, bandThresholds: { fail: 40, pass: 65, excellent: 85 }, autoScoreEnabled: true, kind: "technical_depth" },
  ];
}

export async function seedDemoRubrics(ctx: DemoContext): Promise<void> {
  const inserted = await db
    .insert(callRubrics)
    .values([
      { orgId: DEMO_ORG_ID, name: "General Screening", version: 1, purpose: "general_screen", criteria: defaultRubricCriteria(), isDefault: true },
      { orgId: DEMO_ORG_ID, name: "Technical Screening", version: 1, purpose: "technical_screen", criteria: technicalRubricCriteria(), isDefault: true },
      { orgId: DEMO_ORG_ID, name: "Senior Technical Screening", version: 1, purpose: "senior_technical", criteria: technicalRubricCriteria(), isDefault: true },
    ])
    .returning({ id: callRubrics.id, purpose: callRubrics.purpose });
  for (const r of inserted) ctx.rubricIdByPurpose.set(r.purpose, r.id);
}

function bandFor(score: number): "fail" | "pass" | "excellent" {
  if (score >= 85) return "excellent";
  if (score >= 65) return "pass";
  return "fail";
}

export async function seedDemoCalls(ctx: DemoContext, rng: Rng): Promise<void> {
  const totalCalls = VOLUMES.callsBrowserMixed + VOLUMES.callsVapiOutbound;
  const callIds: string[] = [];

  // Pre-pick a per-call dialogue + duration profile.
  for (let i = 0; i < totalCalls; i += 1) {
    const isVapi = i >= VOLUMES.callsBrowserMixed;
    const callId = stableUuid(`demo-call-${i}`);
    callIds.push(callId);

    const dialogueIdx = i % HINGLISH_DIALOGUES.length;
    const dialogue: DialogueTurn[] = HINGLISH_DIALOGUES[dialogueIdx];
    const startedDaysAgo = intBetween(0, 60, rng);
    const startedAt = daysAgo(startedDaysAgo);

    // Walk turns to compute durations.
    let cursorMs = intBetween(500, 2000, rng); // small lead-in
    const turnRows = [] as Array<typeof transcriptTurns.$inferInsert>;
    for (let t = 0; t < dialogue.length; t += 1) {
      const turn = dialogue[t];
      const startMs = cursorMs;
      const endMs = startMs + turn.durationSec * 1000;
      cursorMs = endMs + intBetween(150, 600, rng);
      turnRows.push({
        callId,
        speaker: isVapi ? turn.speaker : i % 5 === 0 ? "unknown" : turn.speaker,
        text: turn.text,
        isFinal: true,
        tsStartMs: startMs,
        tsEndMs: endMs,
        sentiment: turn.speaker === "candidate" ? +(0.1 + rng() * 0.7).toFixed(2) : +(0.2 + rng() * 0.7).toFixed(2),
        sentimentModel: "afinn",
      });
    }
    const totalDurationMs = cursorMs;

    // Decide whether this call gets a synthetic WAV (every call does — file
    // is small enough). Pick tone variant.
    const wav = synthesiseCallWav(callId, { tone: i % 4 === 0 ? "sine440" : "silence" });

    // Pick a candidate + demand + recruiter for this call.
    const candidateId = ctx.candidateIds[i % ctx.candidateIds.length];
    const demandId = ctx.demandIds[i % ctx.demandIds.length];
    const recruiterId = ctx.recruiterUserIds[i % ctx.recruiterUserIds.length];

    await db.insert(callSessions).values({
      id: callId,
      orgId: DEMO_ORG_ID,
      recruiterUserId: recruiterId,
      candidateId,
      demandId,
      candidateRefOrPhone: `+91${9000000000 + intBetween(0, 99999999, rng)}`,
      status: "ended" as const,
      origin: isVapi ? "vapi" : "web",
      mode: isVapi ? "vapi_outbound" : "browser_mixed",
      createdByUserId: recruiterId,
      startedAt,
      acceptedAt: new Date(startedAt.getTime() + intBetween(2000, 8000, rng)),
      endedAt: new Date(startedAt.getTime() + totalDurationMs + intBetween(2000, 6000, rng)),
      summary: {
        headline: pick(HINGLISH_CALL_HEADLINES, rng),
        keyPoints: [
          "Candidate currently looking — actively interviewing.",
          "CTC and notice expectation captured.",
          "Recruiter to share full JD within 24 hours.",
        ],
        sentiment: { overall: +(0.3 + rng() * 0.5).toFixed(2), candidateTrend: "improving" },
        modelVersion: "demo-call-summary-v0.1",
      },
      recordingUrl: wav.recruiterRel,
      recordingDurationMs: totalDurationMs,
      recordingMime: wav.recruiterRel ? wav.mime : null,
    });

    await db.insert(transcriptTurns).values(turnRows);
  }

  ctx.callIds = callIds;

  // Rubric scores: 25 of the calls get scored against either the general or
  // technical rubric, depending on dialogue index.
  const generalRubricId = ctx.rubricIdByPurpose.get("general_screen")!;
  const technicalRubricId = ctx.rubricIdByPurpose.get("technical_screen")!;
  const scoredCalls = pickN(callIds, 25, rng);
  const scoreRows = [] as Array<typeof callRubricScores.$inferInsert>;
  for (const callId of scoredCalls) {
    const useTechnical = rng() > 0.5;
    const rubricId = useTechnical ? technicalRubricId : generalRubricId;
    const criteria = useTechnical ? technicalRubricCriteria() : defaultRubricCriteria();
    for (const c of criteria) {
      const score = +(45 + rng() * 50).toFixed(2);
      scoreRows.push({
        callId,
        rubricId,
        criterionId: c.id,
        score: String(score),
        band: bandFor(score),
        evidenceQuotes: [
          { tsStartMs: intBetween(5000, 30000, rng), tsEndMs: intBetween(35000, 60000, rng), text: "Candidate confirmed actively looking; CTC band aligned." },
        ],
        rationale: RUBRIC_RATIONALES[c.id] ?? "Auto-scored against rubric criterion.",
        confidence: String(+(0.6 + rng() * 0.35).toFixed(2)),
        modelVersion: "demo-rubric-v0.1",
      });
    }
  }
  if (scoreRows.length) {
    await db.insert(callRubricScores).values(scoreRows).onConflictDoNothing();
  }

  // Technical Q&A: 15 calls get 4-6 questions each.
  const techCalls = pickN(callIds, 15, rng);
  const techRows = [] as Array<typeof callTechnicalQa.$inferInsert>;
  for (const callId of techCalls) {
    const numQuestions = intBetween(4, 6, rng);
    const prompts = pickN(TECHNICAL_PROMPTS, numQuestions, rng);
    let cursor = intBetween(20000, 60000, rng);
    for (let i = 0; i < prompts.length; i += 1) {
      const p = prompts[i];
      const answeredWell = rng() > 0.35;
      const startMs = cursor;
      const endMs = startMs + intBetween(40_000, 120_000, rng);
      cursor = endMs + intBetween(15_000, 30_000, rng);
      techRows.push({
        callId,
        questionIndex: i,
        skill: p.skill,
        difficulty: p.difficulty,
        question: p.question,
        answer: answeredWell ? p.goodAnswer : p.weakAnswer,
        evaluation: answeredWell ? (rng() > 0.7 ? "correct" : "partially_correct") : (rng() > 0.5 ? "partially_correct" : "incorrect"),
        tsQuestionStartMs: startMs,
        tsAnswerEndMs: endMs,
        rationale: answeredWell
          ? "Layered answer with concrete production example. Hits the canonical points and one edge case."
          : "Surface-level answer — hits one canonical point but misses tradeoffs and edge cases.",
        confidence: String(+(0.65 + rng() * 0.3).toFixed(2)),
        modelVersion: "demo-technical-qa-v0.1",
      });
    }
  }
  if (techRows.length) {
    await db.insert(callTechnicalQa).values(techRows).onConflictDoNothing();
  }

  // QA reviews: 18 of the scored calls get a review (mix of decisions).
  const reviewedCalls = pickN(scoredCalls, Math.min(VOLUMES.qaReviews, scoredCalls.length), rng);
  const reviewerIds = ctx.qaUserIds.length ? ctx.qaUserIds : [ctx.adminUserId];
  const qaRows = [] as Array<typeof callQaReviews.$inferInsert>;
  for (let i = 0; i < reviewedCalls.length; i += 1) {
    const callId = reviewedCalls[i];
    const decision = i < 12 ? "accept" : i < 16 ? "override" : "escalate";
    const reviewerScore = decision === "override" ? intBetween(60, 85, rng) : intBetween(70, 95, rng);
    const aiScore = decision === "override" ? reviewerScore - intBetween(5, 15, rng) : reviewerScore + intBetween(-3, 3, rng);
    qaRows.push({
      callId,
      reviewerUserId: reviewerIds[i % reviewerIds.length],
      orgId: DEMO_ORG_ID,
      decision: decision as "accept" | "override" | "escalate",
      note:
        decision === "override"
          ? "Reviewer adjusted JD-coverage and salary-handling scores. Recruiter under-credited on script adherence."
          : decision === "escalate"
            ? "Salary discussion drifted off-script. Surface to delivery lead for coaching."
            : "AI scoring matched my read. No overrides.",
      criterionOverrides:
        decision === "override"
          ? {
              jd_coverage: { aiScore, reviewerScore: reviewerScore + 5, reason: "Recruiter probed must-haves more thoroughly than AI credit." },
              salary_handling: { aiScore: aiScore - 5, reviewerScore: reviewerScore - 3, reason: "Slight pressure observed; deduct 5 points." },
            }
          : {},
      reviewerScore,
      aiScore: String(aiScore),
      timeSpentMs: intBetween(45_000, 240_000, rng),
      createdAt: daysAgo(intBetween(0, 30, rng)),
    });
  }
  if (qaRows.length) {
    await db.insert(callQaReviews).values(qaRows);
  }

  // Prospect calls: link 50 of them to subset of prospects + 30 of the calls.
  const prospectIds = ctx.prospectIds.slice(0, 70);
  const prospectCallRows = [] as Array<typeof prospectCalls.$inferInsert>;
  let pcIdx = 0;
  for (let i = 0; i < VOLUMES.prospectCalls && pcIdx < prospectIds.length; i += 1) {
    const prospectId = prospectIds[pcIdx % prospectIds.length];
    pcIdx += 1;
    const linkedCallId = i < 30 ? callIds[i % callIds.length] : null;
    const outcome = pick(["connected", "no_answer", "voicemail", "callback_requested", "busy"], rng);
    prospectCallRows.push({
      prospectId,
      recruiterId: pick(ctx.recruiterUserIds, rng),
      callSessionId: linkedCallId,
      outcome: outcome as "connected" | "no_answer" | "voicemail" | "callback_requested" | "busy",
      durationSeconds: outcome === "connected" ? intBetween(180, 720, rng) : intBetween(0, 30, rng),
      summary: outcome === "connected" ? pick(HINGLISH_PROSPECT_SUMMARIES, rng) : null,
      nextStep: outcome === "connected" ? "Send full JD; schedule L1 within 48h." : "Retry later in evening slot.",
      createdAt: daysAgo(intBetween(0, 30, rng)),
    });
  }
  if (prospectCallRows.length) {
    await db.insert(prospectCalls).values(prospectCallRows);
  }
}

