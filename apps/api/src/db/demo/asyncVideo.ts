// Async Video Interview demo seed — enterprise dataset.
//
// Produces a non-empty, realistic page on first load:
//  - 6 campaigns across realistic demands, mixing draft / published / archived,
//    each with 3-5 ordered async_video_questions (varied prep/take/retake).
//  - ~120 submissions spanning every status (invited → reviewed), realistic
//    Hinglish candidate names (via ctx.candidateIds), some shortlisted, some
//    with drop_off_prompt_index set (drop-off analytics) and device_check
//    populated.
//  - For ~40 submitted/reviewed ones: 2-3 scorecards each (varied scores so the
//    inter-rater agreement/delta panel is non-trivial), threaded comments, AI
//    artifacts (stub transcript+summary+skills marked provider='stub'), and a
//    few share-links (active + expired + revoked).
//  - Audit rows for create/publish/invite/review on the seeded entities so the
//    per-submission activity timeline is non-empty.
//
// Bulk path: seedAsyncVideoBulk(n) inserts N submissions across the published
// campaigns via a batched INSERT ... SELECT generate_series for the A4
// pagination / p95 check. Gated behind SEED_BULK=1 by the caller.
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  asyncVideoAiArtifacts,
  asyncVideoAuditLog,
  asyncVideoCampaigns,
  asyncVideoComments,
  asyncVideoQuestions,
  asyncVideoScorecards,
  asyncVideoShareLinks,
  asyncVideoSubmissions,
  db,
} from "@j2w/db";
import { DEMO_ORG_ID } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo, daysFromNow, intBetween, pick, type Rng } from "./rng.js";

type CampaignStatus = "draft" | "published" | "archived";
type SubStatus = "invited" | "started" | "submitted" | "reviewed" | "expired";

interface QSpec {
  text: string;
  competencyKey?: string;
  prepSeconds?: number;
  maxSeconds?: number;
  maxRetakes?: number;
}

const CAMPAIGN_SPECS: Array<{ title: string; status: CampaignStatus; blindReview: boolean; questions: QSpec[] }> = [
  {
    title: "Senior Backend — Self-introduction",
    status: "published",
    blindReview: false,
    questions: [
      { text: "Walk us through your career so far in 2 minutes.", competencyKey: "communication", prepSeconds: 30, maxSeconds: 120 },
      { text: "Describe one production system you built that you're proud of.", competencyKey: "system-design", prepSeconds: 45, maxSeconds: 180, maxRetakes: 1 },
      { text: "Tell us about a time you handled a production incident. What did you learn?", competencyKey: "ownership", prepSeconds: 30, maxSeconds: 150 },
    ],
  },
  {
    title: "React Mid — Code Walkthrough",
    status: "published",
    blindReview: true,
    questions: [
      { text: "Walk us through the component tree of your most recent React project.", competencyKey: "frontend", prepSeconds: 60, maxSeconds: 180 },
      { text: "How would you refactor a component that's grown beyond 500 lines?", competencyKey: "code-quality", prepSeconds: 30, maxSeconds: 150 },
      { text: "Explain how you'd debug a re-render performance issue.", competencyKey: "debugging", prepSeconds: 30, maxSeconds: 120 },
    ],
  },
  {
    title: "DevOps Lead — Scenario-based",
    status: "published",
    blindReview: false,
    questions: [
      { text: "How would you investigate a sudden cluster-wide CPU spike on EKS?", competencyKey: "ops", prepSeconds: 45, maxSeconds: 180 },
      { text: "Describe how you'd architect zero-downtime deploys for a stateful service.", competencyKey: "system-design", prepSeconds: 45, maxSeconds: 180, maxRetakes: 1 },
      { text: "What's your approach to on-call hygiene and reducing alert fatigue?", competencyKey: "ownership", prepSeconds: 30, maxSeconds: 120 },
      { text: "How do you keep IaC drift in check across many environments?", competencyKey: "ops", prepSeconds: 30, maxSeconds: 120 },
    ],
  },
  {
    title: "Data Engineer — Pipeline Design",
    status: "published",
    blindReview: false,
    questions: [
      { text: "Walk us through a batch pipeline you've designed end-to-end.", competencyKey: "data-eng", prepSeconds: 45, maxSeconds: 180 },
      { text: "How do you guarantee idempotency and exactly-once semantics?", competencyKey: "data-eng", prepSeconds: 45, maxSeconds: 150 },
      { text: "Describe how you'd handle a late-arriving-data scenario.", competencyKey: "problem-solving", prepSeconds: 30, maxSeconds: 120 },
    ],
  },
  {
    title: "QA Automation — Strategy",
    status: "draft",
    blindReview: false,
    questions: [
      { text: "What's your test-pyramid philosophy and where do you draw the lines?", competencyKey: "qa", prepSeconds: 30, maxSeconds: 150 },
      { text: "How would you stabilise a flaky end-to-end suite?", competencyKey: "qa", prepSeconds: 30, maxSeconds: 120 },
      { text: "Describe how you measure and report test coverage meaningfully.", competencyKey: "communication", prepSeconds: 30, maxSeconds: 120 },
    ],
  },
  {
    title: "Frontend Lead — Legacy Screen (archived)",
    status: "archived",
    blindReview: false,
    questions: [
      { text: "How do you mentor a team through a large migration?", competencyKey: "leadership", prepSeconds: 30, maxSeconds: 150 },
      { text: "Describe a design-system decision you championed.", competencyKey: "frontend", prepSeconds: 30, maxSeconds: 120 },
    ],
  },
];

const RECOMMENDATIONS = ["strong_yes", "yes", "maybe", "no", "strong_no"] as const;
const SKILLS_POOL = [
  "communication",
  "system-design",
  "ownership",
  "debugging",
  "data-modeling",
  "leadership",
  "testing",
  "problem-solving",
];

function token(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Seed the full enterprise async-video dataset for the demo org. Returns the
 * created submission ids so the caller (assessments seed) can wire proctor
 * sessions against them, preserving the previous behavior.
 */
export async function seedDemoAsyncVideo(ctx: DemoContext, rng: Rng): Promise<string[]> {
  const reviewerPool = (ctx.qaUserIds.length ? ctx.qaUserIds : [ctx.adminUserId]).concat([ctx.adminUserId]);
  const submissionIds: string[] = [];

  for (const spec of CAMPAIGN_SPECS) {
    const [campaign] = await db
      .insert(asyncVideoCampaigns)
      .values({
        orgId: DEMO_ORG_ID,
        demandId: pick(ctx.demandIds, rng),
        title: spec.title,
        introText: "Please record short responses to each prompt. You'll have your prep time then a take limit per question.",
        outroText: "Thanks for recording — our team will review shortly.",
        prompts: spec.questions.map((q, idx) => ({ id: `q${idx}`, text: q.text })),
        maxSecondsPerPrompt: spec.questions[0]?.maxSeconds ?? 120,
        maxRetakes: spec.questions[0]?.maxRetakes ?? 0,
        status: spec.status,
        isPublished: spec.status === "published",
        blindReview: spec.blindReview,
        requireDeviceCheck: true,
        archivedAt: spec.status === "archived" ? daysAgo(40) : null,
        createdByUserId: ctx.adminUserId,
      })
      .returning({ id: asyncVideoCampaigns.id });

    const qRows = await db
      .insert(asyncVideoQuestions)
      .values(
        spec.questions.map((q, i) => ({
          orgId: DEMO_ORG_ID,
          campaignId: campaign.id,
          position: i,
          kind: "video" as const,
          text: q.text,
          prepSeconds: q.prepSeconds ?? 30,
          maxSeconds: q.maxSeconds ?? 120,
          maxRetakes: q.maxRetakes ?? 0,
          competencyKey: q.competencyKey ?? null,
        })),
      )
      .returning({ id: asyncVideoQuestions.id, position: asyncVideoQuestions.position });

    await db.insert(asyncVideoAuditLog).values({
      orgId: DEMO_ORG_ID,
      actorUserId: ctx.adminUserId,
      action: "campaign.create",
      targetType: "campaign",
      targetId: campaign.id,
      payload: { title: spec.title, questionCount: spec.questions.length },
    });
    if (spec.status === "published") {
      await db.insert(asyncVideoAuditLog).values({
        orgId: DEMO_ORG_ID,
        actorUserId: ctx.adminUserId,
        action: "campaign.publish",
        targetType: "campaign",
        targetId: campaign.id,
        payload: { questionCount: spec.questions.length },
      });
    }

    // Only published campaigns get submissions. ~22 each across the 4 published
    // ones → ~90; the draft/archived ones stay empty (realistic).
    if (spec.status !== "published") continue;

    const perCampaign = 22;
    for (let i = 0; i < perCampaign; i += 1) {
      const candidateId = ctx.candidateIds[(submissionIds.length * 17 + i * 5) % ctx.candidateIds.length];
      const status = pick<SubStatus>(
        ["invited", "invited", "started", "submitted", "submitted", "reviewed", "reviewed", "expired"],
        rng,
      );
      const submitted = status === "submitted" || status === "reviewed";
      const startedAt = status === "invited" ? null : daysAgo(intBetween(0, 25, rng));
      const submittedAt = submitted ? daysAgo(intBetween(0, 20, rng)) : null;
      const dropOff = status === "started" && rng() > 0.5 ? intBetween(0, qRows.length - 1, rng) : null;
      const reviewerId = status === "reviewed" ? pick(reviewerPool, rng) : null;

      const videos = submitted
        ? qRows.map((q) => ({
            promptIndex: q.position,
            blobKey: `demo-av/${campaign.id}-${i}-${q.position}.webm`,
            durationSec: intBetween(45, 150, rng),
            recordedAt: (submittedAt ?? new Date()).toISOString(),
          }))
        : [];

      const [sub] = await db
        .insert(asyncVideoSubmissions)
        .values({
          orgId: DEMO_ORG_ID,
          campaignId: campaign.id,
          candidateId,
          inviteToken: `demo-av-${campaign.id.slice(0, 8)}-${i}-${Math.floor(rng() * 1_000_000)}`,
          invitedByUserId: pick(ctx.recruiterUserIds.length ? ctx.recruiterUserIds : [ctx.adminUserId], rng),
          status,
          shortlisted: status === "reviewed" && rng() > 0.6,
          dropOffPromptIndex: dropOff,
          deviceCheck:
            status !== "invited"
              ? {
                  camera: true,
                  mic: true,
                  bandwidthKbps: intBetween(800, 6000, rng),
                  checkedAt: (startedAt ?? new Date()).toISOString(),
                }
              : null,
          reminderCount: status === "invited" ? intBetween(0, 2, rng) : 0,
          lastReminderAt: status === "invited" && rng() > 0.5 ? daysAgo(intBetween(1, 5, rng)) : null,
          expiresAt: status === "expired" ? daysAgo(intBetween(1, 6, rng)) : daysFromNow(intBetween(2, 14, rng)),
          videos,
          reviewerUserId: reviewerId,
          reviewerDecision:
            status === "reviewed" ? pick(["forward", "hold", "reject"] as const, rng) : null,
          reviewerNotes:
            status === "reviewed" ? "Clear communicator with strong ownership stories." : null,
          reviewerScore: status === "reviewed" ? intBetween(55, 95, rng) : null,
          startedAt,
          submittedAt,
          reviewedAt: status === "reviewed" ? daysAgo(intBetween(0, 10, rng)) : null,
        })
        .returning({ id: asyncVideoSubmissions.id });

      submissionIds.push(sub.id);

      // Audit: invite + (start/submit/review) for a believable timeline.
      await db.insert(asyncVideoAuditLog).values({
        orgId: DEMO_ORG_ID,
        actorUserId: pick(ctx.recruiterUserIds.length ? ctx.recruiterUserIds : [ctx.adminUserId], rng),
        action: "invite.create",
        targetType: "invite",
        targetId: sub.id,
        payload: { candidateId },
      });
      if (status !== "invited") {
        await db.insert(asyncVideoAuditLog).values({
          orgId: DEMO_ORG_ID,
          actorUserId: null,
          action: "submission.start",
          targetType: "submission",
          targetId: sub.id,
          payload: null,
        });
      }
      if (submitted) {
        await db.insert(asyncVideoAuditLog).values({
          orgId: DEMO_ORG_ID,
          actorUserId: null,
          action: "submission.submit",
          targetType: "submission",
          targetId: sub.id,
          payload: { clipCount: videos.length },
        });
      }

      // Rich review artifacts for submitted/reviewed submissions.
      if (submitted) {
        // AI artifacts — stub provider, transcript per question + whole-submission summary + skills.
        for (const q of qRows) {
          await db.insert(asyncVideoAiArtifacts).values({
            orgId: DEMO_ORG_ID,
            submissionId: sub.id,
            questionId: q.id,
            kind: "transcript",
            status: "ready",
            provider: "stub",
            model: "stub-v1",
            content: { text: "[stub transcript — set OPENAI_API_KEY for real Whisper transcription]" },
          });
        }
        await db.insert(asyncVideoAiArtifacts).values({
          orgId: DEMO_ORG_ID,
          submissionId: sub.id,
          questionId: null,
          kind: "summary",
          status: "ready",
          provider: "stub",
          model: "stub-v1",
          content: { summary: "[stub summary] Candidate gave structured, concrete answers across the screen. Set OPENAI_API_KEY for an AI-generated summary." },
        });
        await db.insert(asyncVideoAiArtifacts).values({
          orgId: DEMO_ORG_ID,
          submissionId: sub.id,
          questionId: null,
          kind: "skills",
          status: "ready",
          provider: "stub",
          model: "stub-v1",
          content: { skills: [pick(SKILLS_POOL, rng), pick(SKILLS_POOL, rng), pick(SKILLS_POOL, rng)] },
        });

        // 2-3 multi-reviewer scorecards (varied scores → visible agreement/delta).
        // Only reviewed submissions get scorecards (so queue scorecardCount is meaningful).
        if (status === "reviewed") {
          const reviewers = pickN(reviewerPool, intBetween(2, Math.min(3, reviewerPool.length), rng), rng);
          for (const rId of reviewers) {
            const questionScores = qRows.map((q) => ({
              questionId: q.id,
              score: intBetween(2, 5, rng),
              note: rng() > 0.6 ? "Solid, specific example." : undefined,
            }));
            const overall =
              Math.round((questionScores.reduce((a, b) => a + b.score, 0) / questionScores.length / 5) * 100 * 10) / 10;
            await db.insert(asyncVideoScorecards).values({
              orgId: DEMO_ORG_ID,
              submissionId: sub.id,
              reviewerUserId: rId,
              questionScores,
              overallScore: overall,
              recommendation: pick(RECOMMENDATIONS, rng),
              summaryNote: "Recommend advancing — strong fundamentals.",
              submitted: true,
            });
          }
          await db.insert(asyncVideoAuditLog).values({
            orgId: DEMO_ORG_ID,
            actorUserId: reviewerId,
            action: "scorecard.submit",
            targetType: "submission",
            targetId: sub.id,
            payload: { reviewerCount: reviewers.length },
          });

          // A threaded comment with a jump-to-moment marker.
          await db.insert(asyncVideoComments).values({
            orgId: DEMO_ORG_ID,
            submissionId: sub.id,
            authorUserId: reviewerId,
            questionId: qRows[0].id,
            timestampSec: intBetween(10, 60, rng),
            body: "Great structured answer here — flagged for the panel.",
          });

          // A few share-links: active / expired / revoked.
          const linkVariant = rng();
          await db.insert(asyncVideoShareLinks).values({
            orgId: DEMO_ORG_ID,
            submissionId: sub.id,
            token: token(),
            label: "Hiring manager review",
            canScore: true,
            createdByUserId: ctx.adminUserId,
            expiresAt:
              linkVariant < 0.34 ? daysAgo(intBetween(1, 4, rng)) : daysFromNow(intBetween(2, 20, rng)),
            revokedAt: linkVariant > 0.66 ? daysAgo(intBetween(0, 3, rng)) : null,
            viewCount: intBetween(0, 5, rng),
            lastViewedAt: rng() > 0.5 ? daysAgo(intBetween(0, 4, rng)) : null,
          });
        }
      }
    }
  }

  return submissionIds;
}

// Pick N distinct elements from a pool.
function pickN<T>(pool: T[], n: number, rng: Rng): T[] {
  const copy = [...new Set(pool)];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Bulk path for the A4 pagination / p95 check. Inserts N submissions across the
 * org's published campaigns via a single batched INSERT ... SELECT
 * generate_series. Each row is `submitted` so the queue's default view is busy.
 * Caller gates this behind SEED_BULK=1.
 */
export async function seedAsyncVideoBulk(orgId: string = DEMO_ORG_ID, n = 10_000): Promise<number> {
  const published = await db
    .select({ id: asyncVideoCampaigns.id })
    .from(asyncVideoCampaigns)
    .where(eq(asyncVideoCampaigns.orgId, orgId));
  if (published.length === 0) return 0;
  const campaignIds = published.map((c) => c.id);

  // Round-robin assign generated rows to campaigns by modulo of the series index.
  // A single statement keeps this fast even at 10k+.
  const arrayLiteral = sql.raw(`ARRAY[${campaignIds.map((id) => `'${id}'::uuid`).join(",")}]`);
  await db.execute(sql`
    INSERT INTO async_video_submissions
      (org_id, campaign_id, invite_token, status, expires_at, created_at, videos)
    SELECT
      ${orgId}::uuid,
      (${arrayLiteral})[(g % ${campaignIds.length}) + 1],
      'bulk-av-' || g || '-' || md5(random()::text),
      'submitted',
      now() + interval '14 days',
      now() - (g || ' seconds')::interval,
      '[]'::jsonb
    FROM generate_series(1, ${n}) AS g
  `);
  return n;
}

void randomUUID;
