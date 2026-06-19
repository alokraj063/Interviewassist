// Assessments + async video + proctor sessions. The proctor cockpit page
// renders a feed of recent sessions/events; we want both surfaces to look
// busy on first load.
import { randomUUID } from "node:crypto";
import {
  assessmentAttempts,
  assessmentAuditLog,
  assessmentItems,
  assessmentSections,
  assessmentTemplates,
  assessmentVersions,
  db,
  PROCTOR_SIGNAL_KINDS,
  proctorAuditEvents,
  proctorEvents,
  proctorIdentityChecks,
  proctorInterventions,
  proctorPolicies,
  proctorSessions,
  type AssessmentItemType,
  type ProctorSignalConfig,
} from "@j2w/db";
import {
  computeRiskScore,
  DEFAULT_SIGNAL_SEVERITY,
  DEFAULT_SIGNAL_WEIGHTS,
  type RiskEventLike,
} from "../../proctor/risk.js";
import {
  computeTotals,
  gradeObjective,
  type CandidateResponse,
  type SnapshotItem,
} from "../../assessments/grade.js";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo, daysFromNow, floatBetween, intBetween, pick, type Rng } from "./rng.js";
import { seedDemoAsyncVideo } from "./asyncVideo.js";

// A typed item template per assessment. Spans all 8 item types with REAL answer
// keys so grade.ts produces non-fabricated scores. Each is given a section.
interface SeedItemSpec {
  type: AssessmentItemType;
  prompt: string;
  points: number;
  config: SnapshotItem["config"];
  section: string;
}

// Build a realistic 8-type item set for a given subject area.
function itemSetFor(subject: string): SeedItemSpec[] {
  const o = (label: string, correct: boolean) => ({ id: randomUUID(), label, correct });
  return [
    {
      type: "mcq_single",
      prompt: `${subject}: Which statement about immutability is correct?`,
      points: 5,
      config: { options: [o("Frozen objects can be reassigned", false), o("Immutable data avoids shared-state bugs", true), o("Immutability slows all reads", false), o("It only applies to strings", false)] },
      section: "Fundamentals",
    },
    {
      type: "mcq_multi",
      prompt: `${subject}: Select ALL valid concurrency primitives.`,
      points: 6,
      config: { options: [o("Mutex", true), o("Semaphore", true), o("Banana", false), o("Atomic counter", true)] },
      section: "Fundamentals",
    },
    {
      type: "true_false",
      prompt: `${subject}: A pure function has no side effects.`,
      points: 3,
      config: { correct: true },
      section: "Fundamentals",
    },
    {
      type: "coding",
      prompt: `${subject}: Write a function that returns the sum of stdin integers.`,
      points: 10,
      config: {
        language: "python",
        starterCode: "import sys\n",
        testCases: [
          { id: randomUUID(), stdin: "1 2 3", expected: "6", hidden: false, weight: 1 },
          { id: randomUUID(), stdin: "10 20", expected: "30", hidden: true, weight: 1 },
          { id: randomUUID(), stdin: "5", expected: "5", hidden: true, weight: 1 },
        ],
        timeoutMs: 5000,
      },
      section: "Practical",
    },
    {
      type: "short_answer",
      prompt: `${subject}: In one line, define idempotency.`,
      points: 4,
      config: { sampleAnswer: "An operation that yields the same result no matter how many times it runs." },
      section: "Depth",
    },
    {
      type: "long_answer",
      prompt: `${subject}: Describe how you'd design a retry strategy for a flaky downstream service.`,
      points: 8,
      config: { sampleAnswer: "Exponential backoff with jitter, capped attempts, idempotency keys, circuit breaker, and a dead-letter queue." },
      section: "Depth",
    },
    {
      type: "file_upload",
      prompt: `${subject}: Upload a code sample you're proud of.`,
      points: 3,
      config: { acceptedTypes: ["pdf", "zip", "txt"], maxSizeMb: 10 },
      section: "Practical",
    },
    {
      type: "video_response",
      prompt: `${subject}: Record a 60s walkthrough of your most complex project.`,
      points: 5,
      config: { prepSeconds: 30, maxSeconds: 120, retakes: 1 },
      section: "Depth",
    },
  ];
}

const ASSESSMENT_TEMPLATES: Array<{
  title: string;
  description: string;
  durationMins: number;
  passScore: number;
}> = [
  { title: "Java Backend — Senior Screen", description: "30-min screen covering JVM concurrency, Spring Boot, system design.", durationMins: 30, passScore: 65 },
  { title: "React + TypeScript — Mid-level", description: "20-min screen on hooks, state management, performance.", durationMins: 20, passScore: 60 },
  { title: "Data Engineering Foundations", description: "25-min mix of SQL, Python, and Kafka concepts.", durationMins: 25, passScore: 65 },
  { title: "DevOps + AWS Practical", description: "20-min scenario-based screen on Kubernetes + Terraform + AWS.", durationMins: 20, passScore: 60 },
  { title: "QA Automation — JavaScript", description: "15-min Playwright + REST API automation primer.", durationMins: 15, passScore: 55 },
];

// Canonical signal kinds (match PROCTOR_SIGNAL_KINDS) so the risk engine, the
// policy signalConfig, and the seeded events all line up.
const PROCTOR_EVENT_KINDS: Array<{ kind: string; severity: "low" | "medium" | "high" }> = [
  { kind: "tab_switch", severity: "low" },
  { kind: "multi_face", severity: "high" },
  { kind: "no_face", severity: "medium" },
  { kind: "other_voice", severity: "medium" },
  { kind: "window_blur", severity: "low" },
  { kind: "paste", severity: "high" },
  { kind: "second_device", severity: "high" },
  { kind: "fullscreen_exit", severity: "medium" },
];

// Build a full signalConfig (all 16 kinds armed) from the default weight/severity
// tables — used for the org-default policy + each session's policy snapshot.
function buildDefaultSignalConfig(): ProctorSignalConfig {
  const cfg: ProctorSignalConfig = {};
  for (const kind of PROCTOR_SIGNAL_KINDS) {
    cfg[kind] = {
      armed: true,
      severity: DEFAULT_SIGNAL_SEVERITY[kind] ?? "low",
      weight: DEFAULT_SIGNAL_WEIGHTS[kind] ?? 5,
    };
  }
  return cfg;
}

// Default scoring settings + pass bands applied to every seeded template, so
// computeTotals produces a real passBand label and the Results page renders a
// banded breakdown.
const SEED_PASS_BANDS = [
  { label: "Strong", minPercent: 80 },
  { label: "Borderline", minPercent: 55 },
  { label: "Fail", minPercent: 0 },
];

// Synthesize a candidate response for a snapshot item with a controlled
// correctness bias (0..1). Higher bias → more likely to be correct. Objective
// items are answered against the real key so grade.ts produces a non-fabricated
// score; subjective items get a plausible free-text answer (manual-pending).
function synthResponse(
  item: SnapshotItem,
  bias: number,
  rng: Rng,
): CandidateResponse {
  const correct = rng() < bias;
  if (item.type === "mcq_single") {
    const opts = item.config.options ?? [];
    const right = opts.find((o) => o.correct);
    const wrong = opts.find((o) => !o.correct);
    const chosen = correct ? right : (wrong ?? right);
    return { itemId: item.id, selectedOptionIds: chosen ? [chosen.id] : [] };
  }
  if (item.type === "mcq_multi") {
    const opts = item.config.options ?? [];
    const rightIds = opts.filter((o) => o.correct).map((o) => o.id);
    if (correct) return { itemId: item.id, selectedOptionIds: rightIds };
    // wrong: drop one correct + add one distractor for partial-credit variety
    const distractor = opts.find((o) => !o.correct);
    const partial = rightIds.slice(0, Math.max(0, rightIds.length - 1));
    if (distractor) partial.push(distractor.id);
    return { itemId: item.id, selectedOptionIds: partial };
  }
  if (item.type === "true_false") {
    const key = item.config.correct === true;
    return { itemId: item.id, boolValue: correct ? key : !key };
  }
  if (item.type === "coding") {
    // No sandbox in seed → coding stays manual (correct:null). Provide source.
    return { itemId: item.id, codeValue: "import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n" };
  }
  // subjective: short/long answer, file_upload, video_response
  return {
    itemId: item.id,
    textValue: correct
      ? "Exponential backoff with jitter, capped retries, idempotency keys, and a circuit breaker fronting a dead-letter queue."
      : "Just retry a few times until it works.",
  };
}

// Reusable rich-assessment seeder. Builds the full enterprise dataset
// (templates → sections → typed items spanning all 8 types → immutable v1
// versions → graded attempts → audit timeline) into a *given* org, using the
// supplied actors. Both the demo-org path (seedDemoAssessments) and the
// DEFAULT_ORG path (seedAssessmentForDefaultOrg in seed.ts) call this so the
// e2e/admin persona sees the same rich, gradeable data as the demo org — not a
// near-empty Templates list. Returns the created template ids + per-template
// snapshot/version maps so callers (e.g. the proctor seed) can anchor to them.
export interface RichAssessmentActors {
  orgId: string;
  adminUserId: string;
  recruiterUserIds: string[];
  qaUserIds: string[];
  candidateIds: string[];
  attempts?: number;
}

export interface RichAssessmentResult {
  templateIds: string[];
  snapshotByTemplate: Map<string, SnapshotItem[]>;
  versionIdByTemplate: Map<string, string>;
}

export async function seedRichAssessmentsForOrg(
  actors: RichAssessmentActors,
  rng: Rng,
): Promise<RichAssessmentResult> {
  const orgId = actors.orgId;
  const recruiterUserIds = actors.recruiterUserIds.length ? actors.recruiterUserIds : [actors.adminUserId];
  const qaUserIds = actors.qaUserIds.length ? actors.qaUserIds : [actors.adminUserId];
  const attemptCount = actors.attempts ?? VOLUMES.assessmentAttempts;

  const templateRows = await db
    .insert(assessmentTemplates)
    .values(
      ASSESSMENT_TEMPLATES.map((t) => ({
        orgId,
        title: t.title,
        description: t.description,
        durationMins: t.durationMins,
        passScore: t.passScore,
        questionIds: [],
        status: "published" as const,
        isPublished: true,
        publishedVersion: 1,
        settings: { scoringMode: "percent" as const, passBands: SEED_PASS_BANDS, showResultsToCandidate: true, allowBacktrack: true },
        proctoringPolicy: {
          enabled: true,
          requireWebcam: true,
          lockdownFullscreen: true,
          blockCopyPaste: true,
          flagTabSwitch: true,
          flagMultiFace: true,
          flagNoFace: true,
          autoFlagThreshold: 60,
        },
        createdByUserId: actors.adminUserId,
      })),
    )
    .returning({
      id: assessmentTemplates.id,
      title: assessmentTemplates.title,
      passScore: assessmentTemplates.passScore,
      durationMins: assessmentTemplates.durationMins,
      settings: assessmentTemplates.settings,
      proctoringPolicy: assessmentTemplates.proctoringPolicy,
    });

  // Per-template snapshot items, indexed by template id. Used to grade attempts.
  const snapshotByTemplate = new Map<string, SnapshotItem[]>();
  const versionIdByTemplate = new Map<string, string>();
  const auditRows = [] as Array<typeof assessmentAuditLog.$inferInsert>;

  for (let ti = 0; ti < templateRows.length; ti += 1) {
    const tpl = templateRows[ti];
    const subject = ASSESSMENT_TEMPLATES[ti].title.split(" — ")[0].split(" (")[0];
    const specs = itemSetFor(subject);

    // Sections (deduplicated, ordered by first appearance).
    const sectionNames = [...new Set(specs.map((s) => s.section))];
    const sectionRows = await db
      .insert(assessmentSections)
      .values(
        sectionNames.map((name, idx) => ({
          orgId,
          templateId: tpl.id,
          title: name,
          position: idx,
          shuffleItems: false,
        })),
      )
      .returning({ id: assessmentSections.id, title: assessmentSections.title });
    const sectionIdByName = new Map(sectionRows.map((s) => [s.title, s.id]));

    // Typed items (all 8 types) with real answer keys.
    const itemRows = await db
      .insert(assessmentItems)
      .values(
        specs.map((s, idx) => ({
          orgId,
          templateId: tpl.id,
          sectionId: sectionIdByName.get(s.section) ?? null,
          type: s.type,
          position: idx,
          prompt: s.prompt,
          config: s.config as Record<string, unknown>,
          points: s.points,
          negativePoints: s.type === "mcq_single" ? 1 : 0,
          partialCredit: s.type === "mcq_multi",
          required: true,
        })),
      )
      .returning({
        id: assessmentItems.id,
        sectionId: assessmentItems.sectionId,
        type: assessmentItems.type,
        position: assessmentItems.position,
        prompt: assessmentItems.prompt,
        config: assessmentItems.config,
        points: assessmentItems.points,
        negativePoints: assessmentItems.negativePoints,
        partialCredit: assessmentItems.partialCredit,
        required: assessmentItems.required,
      });

    const snapItems: SnapshotItem[] = itemRows.map((it) => ({
      id: it.id,
      type: it.type,
      prompt: it.prompt,
      points: it.points,
      negativePoints: it.negativePoints,
      partialCredit: it.partialCredit,
      required: it.required,
      config: it.config as SnapshotItem["config"],
    }));
    snapshotByTemplate.set(tpl.id, snapItems);

    // Freeze a v1 immutable version snapshot — attempts pin this.
    const snapshot = {
      settings: tpl.settings,
      proctoringPolicy: tpl.proctoringPolicy,
      passScore: tpl.passScore,
      durationMins: tpl.durationMins,
      sections: sectionRows.map((s, idx) => ({ id: s.id, title: s.title, position: idx })),
      items: itemRows.map((it) => ({
        id: it.id,
        sectionId: it.sectionId,
        type: it.type,
        position: it.position,
        prompt: it.prompt,
        config: it.config,
        points: it.points,
        negativePoints: it.negativePoints,
        partialCredit: it.partialCredit,
        required: it.required,
      })),
    };
    const [version] = await db
      .insert(assessmentVersions)
      .values({ orgId, templateId: tpl.id, version: 1, snapshot, publishedByUserId: actors.adminUserId })
      .returning({ id: assessmentVersions.id });
    versionIdByTemplate.set(tpl.id, version.id);

    auditRows.push(
      { orgId, action: "template.created", targetKind: "template", targetId: tpl.id, templateId: tpl.id, actorUserId: actors.adminUserId, detail: { title: tpl.title }, createdAt: daysAgo(35) },
      { orgId, action: "template.published", targetKind: "version", targetId: version.id, templateId: tpl.id, actorUserId: actors.adminUserId, detail: { version: 1 }, createdAt: daysAgo(34) },
    );
  }

  // Attempts: distribute across templates with mixed statuses. Scored attempts
  // are graded by grade.ts over SYNTHESIZED responses (not random ints), so the
  // UI shows real graded data and item analysis is meaningful. The correctness
  // bias varies per attempt to spread p-values.
  const attemptRows = [] as Array<typeof assessmentAttempts.$inferInsert>;
  for (let i = 0; i < attemptCount; i += 1) {
    const template = templateRows[i % templateRows.length];
    const candidateId = actors.candidateIds[(i * 11) % actors.candidateIds.length];
    const status = pick(["invited", "started", "submitted", "submitted", "reviewed", "reviewed", "expired"], rng);
    const startedAt = status === "invited" ? null : daysAgo(intBetween(0, 30, rng));
    const submittedAt = status === "submitted" || status === "reviewed" ? daysAgo(intBetween(0, 25, rng)) : null;
    const scored = status === "submitted" || status === "reviewed";

    const snapItems = snapshotByTemplate.get(template.id) ?? [];
    let responses: CandidateResponse[] = [];
    let itemResults: ReturnType<typeof gradeObjective>["itemResults"] = [];
    let autoScore: number | null = null;
    let maxScore: number | null = null;
    let totalScore: number | null = null;
    let pass: boolean | null = null;
    let passBand: string | null = null;
    let manualScore: number | null = null;

    if (scored && snapItems.length) {
      const bias = floatBetween(0.35, 0.92, rng); // per-attempt skill level
      responses = snapItems.map((it) => synthResponse(it, bias, rng));
      const graded = gradeObjective(snapItems, responses);
      itemResults = graded.itemResults;
      // For reviewed attempts, simulate a human awarding subjective items.
      if (status === "reviewed") {
        for (const r of itemResults) {
          if (!r.autoGraded) {
            const award = rng() < bias ? r.max : Math.round(r.max * floatBetween(0.2, 0.7, rng));
            r.awarded = award;
            r.correct = award >= r.max ? true : award > 0 ? null : false;
          }
        }
        manualScore = Math.round(itemResults.filter((r) => !r.autoGraded).reduce((s, r) => s + r.awarded, 0));
      }
      const totals = computeTotals(itemResults, template.passScore, SEED_PASS_BANDS);
      autoScore = Math.round(itemResults.filter((r) => r.autoGraded).reduce((s, r) => s + r.awarded, 0));
      maxScore = totals.maxScore;
      totalScore = totals.percent;
      pass = totals.pass;
      passBand = totals.passBand;
    }

    const attemptId = randomUUID();
    attemptRows.push({
      id: attemptId,
      orgId,
      templateId: template.id,
      candidateId,
      inviteToken: `demo-att-${orgId.slice(0, 8)}-${i}-${Math.floor(rng() * 1_000_000)}`,
      invitedByUserId: pick(recruiterUserIds, rng),
      versionId: versionIdByTemplate.get(template.id) ?? null,
      status: status as "invited" | "started" | "submitted" | "reviewed" | "expired",
      startedAt,
      serverStartedAt: startedAt,
      deadlineAt: startedAt && template.durationMins ? new Date(startedAt.getTime() + template.durationMins * 60_000) : null,
      submittedAt,
      reviewedAt: status === "reviewed" ? daysAgo(intBetween(0, 12, rng)) : null,
      reviewerUserId: status === "reviewed" ? pick(qaUserIds, rng) : null,
      expiresAt: daysFromNow(intBetween(2, 14, rng)),
      responses: responses as unknown as typeof assessmentAttempts.$inferInsert["responses"],
      itemResults: itemResults as unknown as typeof assessmentAttempts.$inferInsert["itemResults"],
      autoScore,
      manualScore,
      maxScore,
      totalScore,
      pass,
      passBand,
    });

    // Audit trail for the timeline.
    if (status !== "invited")
      auditRows.push({ orgId, action: "attempt.started", targetKind: "attempt", targetId: attemptId, templateId: template.id, actorUserId: null, createdAt: startedAt ?? daysAgo(20) });
    if (scored) {
      auditRows.push({ orgId, action: "attempt.submitted", targetKind: "attempt", targetId: attemptId, templateId: template.id, actorUserId: null, createdAt: submittedAt ?? daysAgo(15) });
      auditRows.push({ orgId, action: "attempt.autograded", targetKind: "attempt", targetId: attemptId, templateId: template.id, actorUserId: null, detail: { percent: totalScore ?? 0 }, createdAt: submittedAt ?? daysAgo(15) });
    }
    if (status === "reviewed")
      auditRows.push({ orgId, action: "attempt.reviewed", targetKind: "attempt", targetId: attemptId, templateId: template.id, actorUserId: actors.adminUserId, detail: { percent: totalScore ?? 0, pass }, createdAt: daysAgo(intBetween(0, 12, rng)) });
  }
  if (attemptRows.length) await db.insert(assessmentAttempts).values(attemptRows);
  if (auditRows.length) await db.insert(assessmentAuditLog).values(auditRows);

  return {
    templateIds: templateRows.map((t) => t.id),
    snapshotByTemplate,
    versionIdByTemplate,
  };
}

export async function seedDemoAssessments(ctx: DemoContext, rng: Rng): Promise<void> {
  const { templateIds, versionIdByTemplate } = await seedRichAssessmentsForOrg(
    {
      orgId: DEMO_ORG_ID,
      adminUserId: ctx.adminUserId,
      recruiterUserIds: ctx.recruiterUserIds,
      qaUserIds: ctx.qaUserIds,
      candidateIds: ctx.candidateIds,
    },
    rng,
  );

  // Optional perf seed (~10k attempts) for the A4 keyset-pagination p95 check.
  // Gated behind SEED_LOAD=1 so the normal demo seed stays fast.
  if (process.env.SEED_LOAD === "1") {
    const firstTemplateId = templateIds[0];
    if (firstTemplateId) {
      await seedAssessmentLoad(ctx, rng, firstTemplateId, versionIdByTemplate.get(firstTemplateId) ?? null, { templates: 50, attemptsPerTemplate: 200 });
    }
  }

  // Async video campaigns + submissions — enterprise dataset (script builder
  // questions, multi-reviewer scorecards, AI artifacts, share links, audit
  // timeline). Returns the seeded submission ids for the proctor wiring below.
  const videoIds = await seedDemoAsyncVideo(ctx, rng);

  await seedDemoProctor(ctx, rng, templateIds, videoIds);
}

// Proctor cockpit enterprise dataset: org-default + per-template policies,
// sessions with real risk scores / policy snapshots / SLA / reviewer
// assignment, events with offsetMs + evidence snapshots, identity checks,
// interventions, and an append-only chain-of-custody audit. Everything is
// org-scoped to DEMO_ORG_ID.
async function seedDemoProctor(
  ctx: DemoContext,
  rng: Rng,
  templateIds: string[],
  videoIds: string[],
): Promise<void> {
  const defaultSignalConfig = buildDefaultSignalConfig();

  // 1. Policies — one org-default + one per template (one auto-terminating).
  const policyRows: Array<typeof proctorPolicies.$inferInsert> = [
    {
      orgId: DEMO_ORG_ID,
      name: "Org default — standard proctoring",
      assessmentTemplateId: null,
      isDefault: true,
      signalConfig: defaultSignalConfig,
      requireIdentity: true,
      requireWebcam: true,
      requireScreen: false,
      lockdownBrowser: false,
      autoFlagRiskScore: 40,
      autoTerminateRiskScore: null,
      createdByUserId: ctx.adminUserId,
    },
  ];
  templateIds.forEach((tid, idx) => {
    policyRows.push({
      orgId: DEMO_ORG_ID,
      name: `Policy for template ${idx + 1}`,
      assessmentTemplateId: tid,
      isDefault: false,
      signalConfig: defaultSignalConfig,
      requireIdentity: true,
      requireWebcam: true,
      requireScreen: idx % 2 === 0,
      lockdownBrowser: idx === 0,
      autoFlagRiskScore: 40,
      // First template runs a strict auto-terminate policy.
      autoTerminateRiskScore: idx === 0 ? 85 : null,
      createdByUserId: ctx.adminUserId,
    });
  });
  const insertedPolicies = await db
    .insert(proctorPolicies)
    .values(policyRows)
    .returning({ id: proctorPolicies.id, isDefault: proctorPolicies.isDefault });
  const defaultPolicyId = insertedPolicies.find((p) => p.isDefault)?.id ?? null;
  const policySnapshot = {
    policyId: defaultPolicyId,
    name: "Org default — standard proctoring",
    signalConfig: defaultSignalConfig,
    requireIdentity: true,
    requireWebcam: true,
    requireScreen: false,
    lockdownBrowser: false,
    autoFlagRiskScore: 40,
    autoTerminateRiskScore: null,
  } as Record<string, unknown>;

  const attemptIds = (await db.select({ id: assessmentAttempts.id }).from(assessmentAttempts)).map((r) => r.id);
  const reviewerPool = [...ctx.qaUserIds, ...ctx.proctorUserIds];
  const reviewers = reviewerPool.length ? reviewerPool : [ctx.adminUserId];

  // 2. Sessions — pre-generate ids so we can attach children + risk.
  interface SeededSession {
    id: string;
    status: "live" | "completed" | "abandoned";
    startedAt: Date;
    events: Array<{ kind: string; severity: "low" | "medium" | "high"; flagged: boolean; offsetMs: number; evidenceBlobKey: string | null; acked: boolean }>;
    riskScore: number;
    flagCount: number;
    assignedReviewerUserId: string | null;
    reviewSlaDueAt: Date;
  }
  const seeded: SeededSession[] = [];
  let eventBudget = VOLUMES.proctorEvents;

  for (let i = 0; i < VOLUMES.proctorSessions; i += 1) {
    const id = randomUUID();
    const useAttempt = i % 2 === 0 || videoIds.length === 0;
    const status = pick(["live", "completed", "completed", "completed", "abandoned"], rng) as
      | "live"
      | "completed"
      | "abandoned";
    const startedAt = daysAgo(intBetween(0, 28, rng));
    const sessionDurationMs = 25 * 60_000;

    // Generate events first so risk is REAL (computed from them).
    const targetEvents = Math.min(eventBudget, intBetween(0, 5, rng));
    eventBudget -= targetEvents;
    const events: SeededSession["events"] = [];
    for (let e = 0; e < targetEvents; e += 1) {
      const kind = pick(PROCTOR_EVENT_KINDS, rng);
      const flagged = kind.severity !== "low" || rng() > 0.4;
      events.push({
        kind: kind.kind,
        severity: kind.severity,
        flagged,
        offsetMs: Math.round((e + 1) * (sessionDurationMs / (targetEvents + 1))),
        evidenceBlobKey: rng() > 0.5 ? `demo-proctor/${id}-${e}.jpg` : null,
        acked: rng() > 0.5,
      });
    }
    const riskScore = computeRiskScore(events as RiskEventLike[], defaultSignalConfig);
    const flagCount = events.filter((e) => e.flagged).length;
    const assigned = status === "completed" && rng() > 0.35 ? pick(reviewers, rng) : null;
    // Mix of past-due (SLA-breached demo rows) and future SLAs.
    const reviewSlaDueAt =
      status === "completed" && rng() > 0.5 ? daysAgo(intBetween(0, 2, rng)) : daysFromNow(intBetween(0, 2, rng));

    seeded.push({ id, status, startedAt, events, riskScore, flagCount, assignedReviewerUserId: assigned, reviewSlaDueAt });

    void useAttempt;
  }

  // 3. Insert sessions.
  const sessionRows: Array<typeof proctorSessions.$inferInsert> = seeded.map((s, i) => {
    const useAttempt = i % 2 === 0 || videoIds.length === 0;
    const reviewed = s.status === "completed";
    const decision = reviewed
      ? s.riskScore > 60
        ? "flagged"
        : s.riskScore > 30
          ? (pick(["clean", "flagged"], rng) as "clean" | "flagged")
          : "clean"
      : null;
    return {
      id: s.id,
      orgId: DEMO_ORG_ID,
      assessmentAttemptId: useAttempt && attemptIds.length > 0 ? attemptIds[i % attemptIds.length] : null,
      asyncVideoSubmissionId: !useAttempt && videoIds.length > 0 ? videoIds[i % videoIds.length] : null,
      candidateId: ctx.candidateIds[(i * 19) % ctx.candidateIds.length],
      status: s.status,
      liveState: s.status === "live" ? ("active" as const) : ("ended" as const),
      riskScore: s.riskScore,
      policyId: defaultPolicyId,
      policySnapshot,
      startedAt: s.startedAt,
      endedAt: s.status === "live" ? null : daysAgo(intBetween(0, 25, rng)),
      flagCount: s.flagCount,
      assignedReviewerUserId: s.assignedReviewerUserId,
      reviewSlaDueAt: s.reviewSlaDueAt,
      reviewedAt: decision ? daysAgo(intBetween(0, 12, rng)) : null,
      reviewerUserId: decision ? s.assignedReviewerUserId ?? pick(reviewers, rng) : null,
      reviewerDecision: decision,
      reviewerNotes:
        decision && decision !== "clean"
          ? "Multiple integrity signals near the end of the attempt. Recommend retake or human follow-up."
          : null,
    };
  });
  await db.insert(proctorSessions).values(sessionRows);

  // 4. Events with offsetMs + evidence snapshots.
  const eventRows: Array<typeof proctorEvents.$inferInsert> = [];
  for (const s of seeded) {
    for (const e of s.events) {
      eventRows.push({
        sessionId: s.id,
        kind: e.kind,
        severity: e.severity,
        payload: { confidence: +(0.6 + rng() * 0.35).toFixed(2), context: { detected: true } },
        flagged: e.flagged,
        reviewerAcked: e.acked,
        offsetMs: e.offsetMs,
        evidenceBlobKey: e.evidenceBlobKey,
        createdAt: new Date(s.startedAt.getTime() + e.offsetMs),
      });
    }
  }
  if (eventRows.length) await db.insert(proctorEvents).values(eventRows);

  // 5. Identity checks — one per session, mixed statuses.
  const identityRows: Array<typeof proctorIdentityChecks.$inferInsert> = seeded.map((s) => {
    const status = pick(["pending", "verified", "verified", "mismatch"], rng) as
      | "pending"
      | "verified"
      | "mismatch";
    return {
      orgId: DEMO_ORG_ID,
      sessionId: s.id,
      status,
      idPhotoBlobKey: `demo-proctor/${s.id}-id.jpg`,
      selfieBlobKey: `demo-proctor/${s.id}-selfie.jpg`,
      envScanBlobKey: `demo-proctor/${s.id}-env.jpg`,
      matchScore: status === "mismatch" ? intBetween(20, 55, rng) : intBetween(72, 99, rng),
      matchProvider: "stub",
      verifiedByUserId: status === "pending" ? null : pick(reviewers, rng),
      verifiedAt: status === "pending" ? null : daysAgo(intBetween(0, 10, rng)),
    };
  });
  if (identityRows.length) await db.insert(proctorIdentityChecks).values(identityRows);

  // 6. Interventions on the higher-risk sessions.
  const interventionRows: Array<typeof proctorInterventions.$inferInsert> = [];
  for (const s of seeded.filter((x) => x.riskScore >= 35).slice(0, 8)) {
    interventionRows.push({
      orgId: DEMO_ORG_ID,
      sessionId: s.id,
      kind: "warn",
      actorUserId: null,
      message: `Auto-flagged: risk score ${s.riskScore} ≥ threshold 40`,
      createdAt: new Date(s.startedAt.getTime() + 8 * 60_000),
    });
    if (s.riskScore >= 70) {
      interventionRows.push({
        orgId: DEMO_ORG_ID,
        sessionId: s.id,
        kind: "terminate",
        actorUserId: pick(reviewers, rng),
        message: "Terminated after repeated multi-face detections and a confirmed second device.",
        createdAt: new Date(s.startedAt.getTime() + 18 * 60_000),
      });
    } else {
      interventionRows.push({
        orgId: DEMO_ORG_ID,
        sessionId: s.id,
        kind: "chat",
        actorUserId: pick(reviewers, rng),
        message: "Please keep your face centered in the webcam and close all other tabs.",
        createdAt: new Date(s.startedAt.getTime() + 10 * 60_000),
      });
    }
  }
  if (interventionRows.length) await db.insert(proctorInterventions).values(interventionRows);

  // 7. Chain-of-custody audit so the audit tab is populated.
  const auditRows: Array<typeof proctorAuditEvents.$inferInsert> = [];
  for (const s of seeded.slice(0, 12)) {
    const actor = s.assignedReviewerUserId ?? pick(reviewers, rng);
    auditRows.push({ orgId: DEMO_ORG_ID, sessionId: s.id, actorUserId: actor, action: "session.view", createdAt: daysAgo(intBetween(0, 10, rng)) });
    if (s.assignedReviewerUserId) {
      auditRows.push({ orgId: DEMO_ORG_ID, sessionId: s.id, actorUserId: ctx.adminUserId, action: "session.assign", fromValue: null, toValue: s.assignedReviewerUserId, createdAt: daysAgo(intBetween(0, 9, rng)) });
    }
    if (s.status === "completed") {
      auditRows.push({ orgId: DEMO_ORG_ID, sessionId: s.id, actorUserId: actor, action: "session.review", fromValue: null, toValue: s.riskScore > 60 ? "flagged" : "clean", createdAt: daysAgo(intBetween(0, 8, rng)) });
    }
    if (s.riskScore >= 35) {
      auditRows.push({ orgId: DEMO_ORG_ID, sessionId: s.id, actorUserId: null, action: "intervention.send", toValue: "warn", payload: { auto: true, riskScore: s.riskScore }, createdAt: daysAgo(intBetween(0, 8, rng)) });
    }
  }
  if (auditRows.length) await db.insert(proctorAuditEvents).values(auditRows);

  // 8. Optional 10k-row perf path for the keyset-pagination p95 check.
  if (process.env.PROCTOR_BULK) {
    const { seedProctorBulk } = await import("./proctorBulk.js");
    await seedProctorBulk(ctx, rng, defaultPolicyId, policySnapshot, Number(process.env.PROCTOR_BULK) || 10000);
  }
}

// Perf seed path (SEED_LOAD=1). Inserts `templates * attemptsPerTemplate`
// lightweight attempts in batched chunks (1k/chunk) so the attempts list keyset
// pagination can be measured against a ~10k-row table. Reuses a real published
// template + version so rows are queryable through the same code paths.
export async function seedAssessmentLoad(
  ctx: DemoContext,
  rng: Rng,
  baseTemplateId: string,
  baseVersionId: string | null,
  opts: { templates: number; attemptsPerTemplate: number },
): Promise<void> {
  const total = opts.templates * opts.attemptsPerTemplate;
  const candidateIds = ctx.candidateIds.length ? ctx.candidateIds : [null];
  const CHUNK = 1000;
  let buffer = [] as Array<typeof assessmentAttempts.$inferInsert>;
  for (let i = 0; i < total; i += 1) {
    const status = pick(["invited", "submitted", "submitted", "reviewed"], rng);
    const scored = status === "submitted" || status === "reviewed";
    const totalScore = scored ? intBetween(20, 100, rng) : null;
    buffer.push({
      orgId: DEMO_ORG_ID,
      templateId: baseTemplateId,
      candidateId: candidateIds[i % candidateIds.length],
      inviteToken: `load-att-${i}-${Math.floor(rng() * 1_000_000_000)}`,
      invitedByUserId: ctx.recruiterUserIds.length ? pick(ctx.recruiterUserIds, rng) : ctx.adminUserId,
      versionId: baseVersionId,
      status: status as "invited" | "submitted" | "reviewed",
      startedAt: scored ? daysAgo(intBetween(0, 90, rng)) : null,
      submittedAt: scored ? daysAgo(intBetween(0, 80, rng)) : null,
      totalScore,
      maxScore: scored ? 100 : null,
      autoScore: totalScore,
      pass: totalScore != null ? totalScore >= 60 : null,
    });
    if (buffer.length >= CHUNK) {
      await db.insert(assessmentAttempts).values(buffer);
      buffer = [];
    }
  }
  if (buffer.length) await db.insert(assessmentAttempts).values(buffer);
  console.log(`[demo-seed] SEED_LOAD inserted ${total} assessment attempts`);
}
