// Coaching scenarios + run history. Each scenario is a simulated candidate
// persona; runs are recruiter practice attempts with scores.
import { coachingRuns, coachingScenarios, db } from "@j2w/db";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo, intBetween, pick, pickN, type Rng } from "./rng.js";

const SCENARIO_SPECS: Array<{
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard";
  tags: string[];
  candidatePersona: Record<string, unknown>;
  rubricPurpose: "general_screen" | "technical_screen" | "senior_technical";
}> = [
  {
    title: "Disengaged senior engineer",
    description: "Practice keeping a senior candidate engaged when they're already mid-interview with another company.",
    difficulty: "hard",
    tags: ["objection", "senior"],
    candidatePersona: {
      name: "Vivaan",
      mood: "skeptical",
      currentCompany: "Amazon India",
      yearsExperience: 8,
      hiddenContext: "Has another offer at 50 LPA fixed. Tests if recruiter will pivot positioning to non-comp factors.",
    },
    rubricPurpose: "senior_technical",
  },
  {
    title: "Compensation negotiation",
    description: "Walk through CTC anchoring and band positioning when a candidate's expectation is 20% above the demand cap.",
    difficulty: "medium",
    tags: ["compensation", "objection"],
    candidatePersona: { name: "Anjali", mood: "firm", currentCtc: 28, expectedCtc: 50, hiddenContext: "Will accept 38 + variable if positioned with growth." },
    rubricPurpose: "general_screen",
  },
  {
    title: "Notice period stretch",
    description: "Candidate is firm on 90 days; demand needs joining within 45.",
    difficulty: "medium",
    tags: ["notice", "objection"],
    candidatePersona: { name: "Krishna", mood: "logical", currentNoticePeriod: 90, hiddenContext: "Has 22 days of leave available; willing to use if asked." },
    rubricPurpose: "general_screen",
  },
  {
    title: "Hostile candidate",
    description: "Candidate annoyed by previous recruiter spam. Recover trust in 90 seconds.",
    difficulty: "hard",
    tags: ["recovery", "objection"],
    candidatePersona: { name: "Riya", mood: "annoyed", hiddenContext: "Will warm up if recruiter explicitly acknowledges past spam and gets to point quickly." },
    rubricPurpose: "general_screen",
  },
  {
    title: "Quiet technical candidate",
    description: "Technical candidate gives 1-line answers. Probe for depth without making them defensive.",
    difficulty: "medium",
    tags: ["technical", "depth"],
    candidatePersona: { name: "Ishaan", mood: "introverted", hiddenContext: "Knows depth but won't volunteer. Open-ended questions unlock detail." },
    rubricPurpose: "technical_screen",
  },
  {
    title: "Counter-offer scenario",
    description: "Candidate at offer-acceptance stage gets a counter from current employer.",
    difficulty: "hard",
    tags: ["counter-offer", "closing"],
    candidatePersona: { name: "Aarav", mood: "torn", hiddenContext: "Counter-offer is +25% but no role change. Tests counter-pitch on growth + scope." },
    rubricPurpose: "senior_technical",
  },
];

export async function seedDemoCoaching(ctx: DemoContext, rng: Rng): Promise<void> {
  const scenarioRows = await db
    .insert(coachingScenarios)
    .values(
      SCENARIO_SPECS.map((s) => ({
        orgId: DEMO_ORG_ID,
        title: s.title,
        description: s.description,
        difficulty: s.difficulty,
        candidatePersona: s.candidatePersona,
        targetRubricId: ctx.rubricIdByPurpose.get(s.rubricPurpose) ?? null,
        tags: s.tags,
        isPublished: true,
        createdByUserId: ctx.adminUserId,
      })),
    )
    .returning({ id: coachingScenarios.id });

  const runRows = [] as Array<typeof coachingRuns.$inferInsert>;
  const recruiters = pickN(ctx.recruiterUserIds, Math.min(ctx.recruiterUserIds.length, 8), rng);
  for (let i = 0; i < VOLUMES.coachingRuns; i += 1) {
    const scenario = scenarioRows[i % scenarioRows.length];
    const recruiter = recruiters[i % recruiters.length];
    const status = pick(["completed", "completed", "completed", "abandoned", "live"], rng);
    const startedAt = daysAgo(intBetween(0, 35, rng));
    const completedAt = status === "completed" ? new Date(startedAt.getTime() + intBetween(8, 22, rng) * 60_000) : null;
    runRows.push({
      orgId: DEMO_ORG_ID,
      scenarioId: scenario.id,
      recruiterUserId: recruiter,
      callId: null,
      status: status as "completed" | "abandoned" | "live",
      startedAt,
      completedAt,
      cachedOverallScore: status === "completed" ? String(intBetween(45, 95, rng)) : null,
      feedback:
        status === "completed"
          ? {
              strengths: ["Strong opener", "Clear objection acknowledgement"],
              improvements: ["Pause longer before pivoting", "Ask one more open-ended depth question"],
              modelVersion: "demo-coaching-v0.1",
            }
          : null,
    });
  }
  if (runRows.length) await db.insert(coachingRuns).values(runRows);
}
