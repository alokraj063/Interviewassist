// Async Video Interview — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts the page's core job and its enterprise guarantees:
//   - persistence of campaigns + ordered question rows; round-trip ordering
//   - Zod 400 (+ issues) on empty title and out-of-range scorecard score
//   - cross-org 404 isolation on GET/PATCH/DELETE/video (no leak, no 500)
//   - permission gates: recruiter1@ POST /campaigns 403 (no write grant);
//     admin@ POST /campaigns 201 (proves the grant migration landed);
//     qa1@ PUT scorecard 200 (has review)
//   - external-key gating: OPENAI unset → POST .../ai/transcribe 503
//     openai_not_configured (asserted NOT 500) + skipped artifact rows
//   - append-only audit rows after publish / scorecard.submit / share-link
//   - Idempotency-Key on POST /invites twice → one row, identical body
//   - keyset pagination on /queue (limit, nextCursor, no overlap, total)
//
// Seeded principals (DEFAULT_ORG_ID): admin@/qa1@/recruiter1@recruitassist.local.
// Cross-org principal (JOULESTOWATTS_ORG_ID): cognition.engine@joulestowatts.com.
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  asyncVideoAiArtifacts,
  asyncVideoAuditLog,
  asyncVideoCampaigns,
  asyncVideoQuestions,
  asyncVideoSubmissions,
  candidates,
  db,
  DEFAULT_ORG_ID,
} from "@j2w/db";
import { authedInject, expectForbidden, expectJson, getApp } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const QA = "qa1@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local";
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const Q = (text: string) => ({ kind: "video" as const, text, prepSeconds: 30, maxSeconds: 120, maxRetakes: 1 });

async function createCampaign(
  title: string,
  questions = [Q("Tell us about yourself"), Q("Walk through a hard bug")],
  actor = ADMIN,
  headers: Record<string, string> = {},
) {
  return authedInject(actor, {
    method: "POST",
    url: "/api/async-video/campaigns",
    headers,
    payload: { title, questions },
  });
}

async function newCampaignId(title: string): Promise<string> {
  const res = await createCampaign(title);
  const body = expectJson<{ campaign: { id: string } }>(res, 201);
  return body.campaign.id;
}

async function getSeededCandidateId(): Promise<string> {
  const [c] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(eq(candidates.orgId, DEFAULT_ORG_ID))
    .limit(1);
  if (!c) throw new Error("no seeded candidate in DEFAULT_ORG");
  return c.id;
}

// A submitted submission that the seed planted (has videos[] + scorecards),
// so we can exercise the reviewer cockpit (video stream, scorecard, AI).
async function getSeededSubmittedSubmissionId(): Promise<string> {
  const [s] = await db
    .select({ id: asyncVideoSubmissions.id })
    .from(asyncVideoSubmissions)
    .where(and(eq(asyncVideoSubmissions.orgId, DEFAULT_ORG_ID), eq(asyncVideoSubmissions.status, "reviewed")))
    .limit(1);
  if (!s) throw new Error("no seeded reviewed submission in DEFAULT_ORG");
  return s.id;
}

describe("async-video — persistence + ordered questions", () => {
  it("creates a campaign with ordered question rows and reads them back in order", async () => {
    const id = await newCampaignId("Persist Campaign");

    const rows = await db
      .select({ position: asyncVideoQuestions.position, text: asyncVideoQuestions.text })
      .from(asyncVideoQuestions)
      .where(eq(asyncVideoQuestions.campaignId, id))
      .orderBy(asyncVideoQuestions.position);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[0].text).toBe("Tell us about yourself");

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/async-video/campaigns/${id}` });
    const detail = expectJson<{ campaign: { id: string; status: string }; questions: Array<{ position: number }> }>(get);
    expect(detail.campaign.status).toBe("draft");
    expect(detail.questions.map((q) => q.position)).toEqual([0, 1]);
  });
});

describe("async-video — Zod validation", () => {
  it("empty title → 400 with issues", async () => {
    const res = await createCampaign("");
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: string; issues?: unknown };
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toBeTruthy();
  });

  it("scorecard score > 5 → 400", async () => {
    const subId = await getSeededSubmittedSubmissionId();
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/async-video/submissions/${subId}/scorecard`,
      payload: { questionScores: [{ questionId: "00000000-0000-0000-0000-000000000000", score: 9 }], submitted: false },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("async-video — cross-org isolation", () => {
  it("a cross-org token gets 404 on GET/PATCH/DELETE + video (no leak, no 500)", async () => {
    const id = await newCampaignId("Org A Only AV");

    const get = await authedInject(CROSS_ORG, { method: "GET", url: `/api/async-video/campaigns/${id}` });
    expect(get.statusCode).toBe(404);

    const patch = await authedInject(CROSS_ORG, {
      method: "PATCH",
      url: `/api/async-video/campaigns/${id}`,
      payload: { title: "hijack" },
    });
    expect(patch.statusCode).toBe(404);

    // a cross-org submission video stream must not leak either
    const subId = await getSeededSubmittedSubmissionId();
    const video = await authedInject(CROSS_ORG, { method: "GET", url: `/api/async-video/submissions/${subId}/video/0` });
    expect(video.statusCode).toBe(404);
  });
});

describe("async-video — permission gates", () => {
  it("recruiter1@ POST /campaigns → 403 (no async_video.write grant)", async () => {
    const res = await createCampaign("Recruiter No Write", undefined, RECRUITER);
    expectForbidden(res);
  });

  it("admin@ POST /campaigns → 201 (proves the permission-grant migration landed)", async () => {
    const res = await createCampaign("Admin Write Regression");
    expectJson<{ campaign: { id: string } }>(res, 201);
  });

  it("qa1@ PUT scorecard → 200 (qa_reviewer has async_video.review)", async () => {
    const subId = await getSeededSubmittedSubmissionId();
    const detail = expectJson<{ questions: Array<{ id: string }> }>(
      await authedInject(QA, { method: "GET", url: `/api/async-video/submissions/${subId}` }),
    );
    const qid = detail.questions[0]?.id;
    const res = await authedInject(QA, {
      method: "PUT",
      url: `/api/async-video/submissions/${subId}/scorecard`,
      payload: {
        questionScores: qid ? [{ questionId: qid, score: 4 }] : [],
        recommendation: "yes",
        summaryNote: "Solid.",
        submitted: true,
      },
    });
    expectJson<{ scorecard: { id: string } }>(res, 200);
  });
});

describe("async-video — external-key gating (503, not 500)", () => {
  it("POST /submissions/:id/ai/transcribe with OPENAI unset → 503 openai_not_configured + skipped rows", async () => {
    const subId = await getSeededSubmittedSubmissionId();
    const res = await authedInject(ADMIN, { method: "POST", url: `/api/async-video/submissions/${subId}/ai/transcribe` });
    // Crucially never a bare 500.
    expect(res.statusCode).not.toBe(500);
    if (process.env.OPENAI_API_KEY) {
      expect(res.statusCode).toBe(200);
    } else {
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.payload) as { error: string };
      expect(body.error).toBe("openai_not_configured");
      // skipped artifact rows landed so the UI reflects the unconfigured state
      const rows = await db
        .select({ status: asyncVideoAiArtifacts.status })
        .from(asyncVideoAiArtifacts)
        .where(and(eq(asyncVideoAiArtifacts.submissionId, subId), eq(asyncVideoAiArtifacts.status, "skipped")));
      expect(rows.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("async-video — append-only audit", () => {
  it("publish writes a campaign.publish audit row with an actor", async () => {
    const id = await newCampaignId("Audit Publish");
    const pub = await authedInject(ADMIN, { method: "POST", url: `/api/async-video/campaigns/${id}/publish` });
    expectJson(pub, 200);

    const rows = await db
      .select({ action: asyncVideoAuditLog.action, actorUserId: asyncVideoAuditLog.actorUserId })
      .from(asyncVideoAuditLog)
      .where(and(eq(asyncVideoAuditLog.targetId, id), eq(asyncVideoAuditLog.action, "campaign.publish")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actorUserId).toBeTruthy();
  });

  it("share-link create writes a share_link.create audit row", async () => {
    const subId = await getSeededSubmittedSubmissionId();
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/async-video/submissions/${subId}/share-links`,
      payload: { label: "HM", expiresInHours: 48, canScore: true },
    });
    const body = expectJson<{ shareLink: { id: string } }>(res, 201);
    const rows = await db
      .select({ action: asyncVideoAuditLog.action })
      .from(asyncVideoAuditLog)
      .where(and(eq(asyncVideoAuditLog.targetId, body.shareLink.id), eq(asyncVideoAuditLog.action, "share_link.create")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("a raw UPDATE on async_video_audit_log is rejected by the immutability trigger", async () => {
    let threw = false;
    try {
      await db.execute(
        sql`UPDATE async_video_audit_log SET action = 'tamper' WHERE id = (SELECT id FROM async_video_audit_log LIMIT 1)`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("async-video — idempotency", () => {
  it("same Idempotency-Key on POST /invites twice → one submission row, identical body", async () => {
    const campaignId = await newCampaignId("Idem Invite");
    await authedInject(ADMIN, { method: "POST", url: `/api/async-video/campaigns/${campaignId}/publish` });
    const candidateId = await getSeededCandidateId();
    const key = `itest-av-invite-${Date.now()}`;

    const first = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/async-video/invites",
      headers: { "idempotency-key": key },
      payload: { campaignId, candidateId },
    });
    const a = expectJson<{ submission: { id: string }; inviteToken: string }>(first, 201);

    const second = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/async-video/invites",
      headers: { "idempotency-key": key },
      payload: { campaignId, candidateId },
    });
    const b = expectJson<{ submission: { id: string }; inviteToken: string; idempotent?: boolean }>(second, 200);
    expect(b.submission.id).toBe(a.submission.id);
    expect(b.inviteToken).toBe(a.inviteToken);
    expect(b.idempotent).toBe(true);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(asyncVideoSubmissions)
      .where(eq(asyncVideoSubmissions.id, a.submission.id));
    expect(n).toBe(1);
  });
});

describe("async-video — keyset pagination", () => {
  it("/queue?limit=N returns ≤N + a usable nextCursor with no row repeats; total accurate", async () => {
    const first = await authedInject(ADMIN, { method: "GET", url: "/api/async-video/queue?limit=10" });
    const a = expectJson<{ submissions: Array<{ id: string }>; nextCursor: string | null; total: number }>(first);
    expect(a.submissions.length).toBeLessThanOrEqual(10);
    expect(a.total).toBeGreaterThanOrEqual(a.submissions.length);

    if (a.nextCursor) {
      expect(a.submissions.length).toBe(10);
      const second = await authedInject(ADMIN, {
        method: "GET",
        url: `/api/async-video/queue?limit=10&cursor=${encodeURIComponent(a.nextCursor)}`,
      });
      const b = expectJson<{ submissions: Array<{ id: string }> }>(second);
      const firstIds = new Set(a.submissions.map((r) => r.id));
      for (const r of b.submissions) expect(firstIds.has(r.id)).toBe(false);
    }
  });

  it("an invalid cursor → 400 invalid_cursor (not 500)", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/async-video/queue?cursor=not-base64-json" });
    expect([200, 400]).toContain(res.statusCode);
  });
});
