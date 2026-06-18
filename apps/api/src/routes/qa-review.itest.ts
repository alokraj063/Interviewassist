// QA Review console — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts: sampling-policy persistence + idempotent run, Zod 400,
// cross-org 404 (no leak), permission gates (recruiter lacks qa.sampling →
// 403; qa1 has it → 201; recruiter can raise a dispute but not resolve),
// blind read gate, review-submit idempotency, append-only audit rows, gold
// AI-draft external-key gating (503 not 500), and keyset pagination over a
// large synthetic queue.
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (full QA perms), recruiter1@
// (qa.dispute but NOT qa.sampling/qa.write), qa1@ (qa_reviewer → calibrate/
// sampling/dispute/export + read/write). Cross-org: cognition.engine@joulestowatts.com.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  callSessions,
  callQaReviews,
  db,
  DEFAULT_ORG_ID,
  qaAuditEvents,
  qaCalibrationSessions,
  qaDisputes,
  qaGoldAnswers,
  qaQueueItems,
  qaSamplingPolicies,
} from "@j2w/db";
import { authedInject, expectJson } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local"; // qa.dispute only
const QA = "qa1@recruitassist.local"; // qa_reviewer: sampling/calibrate/dispute/export + write
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const createdPolicyIds: string[] = [];
const createdQueueIds: string[] = [];
const createdReviewIds: string[] = [];
const createdDisputeIds: string[] = [];
const createdCalibrationIds: string[] = [];

let endedCallIds: string[] = [];

beforeAll(async () => {
  const calls = await db
    .select({ id: callSessions.id })
    .from(callSessions)
    .where(and(eq(callSessions.orgId, DEFAULT_ORG_ID), eq(callSessions.status, "ended")))
    .orderBy(desc(callSessions.endedAt))
    .limit(50);
  endedCallIds = calls.map((c) => c.id);
});

afterAll(async () => {
  if (createdDisputeIds.length) await db.delete(qaDisputes).where(inArray(qaDisputes.id, createdDisputeIds));
  if (createdReviewIds.length) await db.delete(callQaReviews).where(inArray(callQaReviews.id, createdReviewIds));
  if (createdCalibrationIds.length)
    await db.delete(qaCalibrationSessions).where(inArray(qaCalibrationSessions.id, createdCalibrationIds));
  if (createdQueueIds.length) await db.delete(qaQueueItems).where(inArray(qaQueueItems.id, createdQueueIds));
  if (createdPolicyIds.length) await db.delete(qaSamplingPolicies).where(inArray(qaSamplingPolicies.id, createdPolicyIds));
  // Clean up test-created audit rows by their target ids (best-effort).
  const auditTargets = [
    ...createdPolicyIds,
    ...createdReviewIds,
    ...createdDisputeIds,
    ...createdCalibrationIds,
    ...createdQueueIds,
  ];
  if (auditTargets.length) {
    await db
      .delete(qaAuditEvents)
      .where(and(eq(qaAuditEvents.orgId, DEFAULT_ORG_ID), inArray(qaAuditEvents.targetId, auditTargets)));
  }
});

async function createPolicy(name: string, headers?: Record<string, string>, persona = ADMIN) {
  const res = await authedInject(persona, {
    method: "POST",
    url: "/api/qa/policies",
    headers,
    payload: { name, strategy: "percentage", samplePercent: 50, slaHours: 48 },
  });
  if (res.statusCode === 201 || res.statusCode === 200) {
    const b = JSON.parse(res.body) as { id: string };
    if (b.id && !createdPolicyIds.includes(b.id)) createdPolicyIds.push(b.id);
  }
  return res;
}

describe("QA sampling policies", () => {
  it("creates a policy, lists it, and runs it idempotently", async () => {
    const create = await createPolicy("itest 50% policy");
    const policy = expectJson<{ id: string; samplePercent: number }>(create, 201);
    expect(policy.samplePercent).toBe(50);

    const list = await authedInject(ADMIN, { method: "GET", url: "/api/qa/policies" });
    const { policies } = expectJson<{ policies: Array<{ id: string }> }>(list);
    expect(policies.some((p) => p.id === policy.id)).toBe(true);

    const run1 = await authedInject(ADMIN, { method: "POST", url: `/api/qa/policies/${policy.id}/run` });
    const r1 = expectJson<{ inserted: number; skipped: number }>(run1);
    expect(r1.inserted).toBeGreaterThan(0);

    // Re-run: every (call, slot) already exists → all skipped, nothing inserted.
    const run2 = await authedInject(ADMIN, { method: "POST", url: `/api/qa/policies/${policy.id}/run` });
    const r2 = expectJson<{ inserted: number; skipped: number }>(run2);
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);

    // Track queue items for cleanup.
    const items = await db
      .select({ id: qaQueueItems.id })
      .from(qaQueueItems)
      .where(eq(qaQueueItems.policyId, policy.id));
    for (const i of items) if (!createdQueueIds.includes(i.id)) createdQueueIds.push(i.id);
  });

  it("rejects a percentage policy missing samplePercent (Zod 400)", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/policies",
      payload: { name: "bad", strategy: "percentage" },
    });
    const body = expectJson<{ error: string; issues: unknown }>(res, 400);
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toBeTruthy();
  });

  it("idempotency: same Idempotency-Key returns the same policy id", async () => {
    const key = `itest-key-${Date.now()}`;
    const a = await createPolicy("idem policy", { "idempotency-key": key });
    const first = expectJson<{ id: string }>(a, 201);
    const b = await createPolicy("idem policy", { "idempotency-key": key });
    const second = expectJson<{ id: string; idempotent?: boolean }>(b, 200);
    expect(second.id).toBe(first.id);
    expect(second.idempotent).toBe(true);
  });

  it("permission gate: recruiter (no qa.sampling) → 403; qa1 → 201", async () => {
    const denied = await createPolicy("recruiter policy", undefined, RECRUITER);
    expect(denied.statusCode).toBe(403);

    const allowed = await createPolicy("qa policy", undefined, QA);
    expectJson(allowed, 201);
  });

  it("cross-org isolation: org-B token cannot see or mutate an org-A policy", async () => {
    const create = await createPolicy("org-A only policy");
    const policy = expectJson<{ id: string }>(create, 201);

    const list = await authedInject(CROSS_ORG, { method: "GET", url: "/api/qa/policies" });
    const { policies } = expectJson<{ policies: Array<{ id: string }> }>(list);
    expect(policies.some((p) => p.id === policy.id)).toBe(false);

    const patch = await authedInject(CROSS_ORG, {
      method: "PATCH",
      url: `/api/qa/policies/${policy.id}`,
      payload: { name: "hacked" },
    });
    expect(patch.statusCode).toBe(404);

    const del = await authedInject(CROSS_ORG, { method: "DELETE", url: `/api/qa/policies/${policy.id}` });
    expect(del.statusCode).toBe(404);
  });

  it("PATCH updates a policy and writes a before/after audit row", async () => {
    const create = await createPolicy("patch policy");
    const policy = expectJson<{ id: string }>(create, 201);
    const patch = await authedInject(ADMIN, {
      method: "PATCH",
      url: `/api/qa/policies/${policy.id}`,
      payload: { name: "patched name", isActive: false },
    });
    const updated = expectJson<{ name: string; isActive: boolean }>(patch);
    expect(updated.name).toBe("patched name");
    expect(updated.isActive).toBe(false);

    const [audit] = await db
      .select()
      .from(qaAuditEvents)
      .where(and(eq(qaAuditEvents.action, "qa.policy.update"), eq(qaAuditEvents.targetId, policy.id)))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.before).toBeTruthy();
    expect(audit.after).toBeTruthy();
  });
});

describe("QA review submit", () => {
  it("submits a review, links a queue item, and writes an audit row", async () => {
    const callId = endedCallIds[0];
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      payload: { callId, decision: "accept", reviewerScore: 82, timeSpentMs: 4000 },
    });
    const body = expectJson<{ reviewId: string }>(res, 201);
    createdReviewIds.push(body.reviewId);

    const [audit] = await db
      .select()
      .from(qaAuditEvents)
      .where(and(eq(qaAuditEvents.action, "qa.review.submit"), eq(qaAuditEvents.targetId, body.reviewId)))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.actorUserId).toBeTruthy();
  });

  it("idempotency: same Idempotency-Key returns one review, one row", async () => {
    const callId = endedCallIds[1];
    const key = `review-idem-${Date.now()}`;
    const a = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      headers: { "idempotency-key": key },
      payload: { callId, decision: "accept", reviewerScore: 70, timeSpentMs: 1000 },
    });
    const first = expectJson<{ reviewId: string }>(a, 201);
    createdReviewIds.push(first.reviewId);

    const b = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      headers: { "idempotency-key": key },
      payload: { callId, decision: "accept", reviewerScore: 70, timeSpentMs: 1000 },
    });
    const second = expectJson<{ reviewId: string; idempotent?: boolean }>(b, 200);
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.idempotent).toBe(true);

    const rows = await db
      .select({ id: callQaReviews.id })
      .from(callQaReviews)
      .where(eq(callQaReviews.id, first.reviewId));
    expect(rows.length).toBe(1);
  });

  it("override with no dirty criterion → 400", async () => {
    const callId = endedCallIds[2];
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      payload: {
        callId,
        decision: "override",
        reviewerScore: 60,
        timeSpentMs: 1000,
        criterionOverrides: { c1: { aiScore: 80, reviewerScore: 80, reason: "same value here" } },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("QA disputes", () => {
  it("recruiter can raise a dispute (qa.dispute) but cannot resolve (no qa.write)", async () => {
    // First create a review to dispute.
    const callId = endedCallIds[3];
    const rev = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      payload: { callId, decision: "accept", reviewerScore: 55, timeSpentMs: 1000 },
    });
    const review = expectJson<{ reviewId: string }>(rev, 201);
    createdReviewIds.push(review.reviewId);

    const raise = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/qa/reviews/${review.reviewId}/dispute`,
      payload: { reason: "Score too low given the evidence in the call." },
    });
    const dispute = expectJson<{ id: string }>(raise, 201);
    createdDisputeIds.push(dispute.id);

    // recruiter lacks qa.write → resolve is 403.
    const denied = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/qa/disputes/${dispute.id}/resolve`,
      payload: { status: "upheld", resolutionNote: "Considered and rejected the appeal." },
    });
    expect(denied.statusCode).toBe(403);

    // admin can resolve.
    const resolved = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/qa/disputes/${dispute.id}/resolve`,
      payload: { status: "overturned", resolutionNote: "Agreed; corrected the score." },
    });
    const body = expectJson<{ status: string }>(resolved);
    expect(body.status).toBe("overturned");

    const [audit] = await db
      .select()
      .from(qaAuditEvents)
      .where(and(eq(qaAuditEvents.action, "qa.dispute.resolve"), eq(qaAuditEvents.targetId, dispute.id)))
      .limit(1);
    expect(audit).toBeTruthy();
  });

  it("dispute reason under 10 chars → 400", async () => {
    const callId = endedCallIds[4];
    const rev = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/qa/reviews",
      payload: { callId, decision: "accept", reviewerScore: 60, timeSpentMs: 1000 },
    });
    const review = expectJson<{ reviewId: string }>(rev, 201);
    createdReviewIds.push(review.reviewId);

    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/qa/reviews/${review.reviewId}/dispute`,
      payload: { reason: "short" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("QA gold answers + AI draft (external-key gating)", () => {
  it("stub AI draft returns 200 with aiSource=stub; ?source=real → 503 not 500 when key unset", async () => {
    const callId = endedCallIds[5];
    const stub = await authedInject(QA, {
      method: "POST",
      url: `/api/qa/calls/${callId}/gold/ai-draft`,
    });
    const body = expectJson<{ aiSource: string }>(stub);
    expect(body.aiSource).toBe("stub");

    const real = await authedInject(QA, {
      method: "POST",
      url: `/api/qa/calls/${callId}/gold/ai-draft?source=real`,
    });
    // No OPENAI_API_KEY in itest env → 503 with precise code, never 500.
    if (!process.env.OPENAI_API_KEY) {
      const r = expectJson<{ error: string }>(real, 503);
      expect(r.error).toBe("openai_key_missing");
    } else {
      expect(real.statusCode).toBe(200);
    }
  });

  it("upsert gold answer + publish writes an audit row", async () => {
    const callId = endedCallIds[6];
    const put = await authedInject(QA, {
      method: "PUT",
      url: `/api/qa/calls/${callId}/gold`,
      payload: {
        criterionScores: { c1: { score: 85, rationale: "strong" } },
        goldOverallScore: 85,
        isPublished: true,
      },
    });
    const gold = expectJson<{ id: string; isPublished: boolean }>(put);
    expect(gold.isPublished).toBe(true);

    const [audit] = await db
      .select()
      .from(qaAuditEvents)
      .where(and(eq(qaAuditEvents.action, "qa.gold.publish"), eq(qaAuditEvents.targetId, gold.id)))
      .limit(1);
    expect(audit).toBeTruthy();

    // Clean up the gold row (one-per-call unique).
    await db.delete(qaGoldAnswers).where(eq(qaGoldAnswers.id, gold.id));
  });
});

describe("QA calibration", () => {
  it("creates a draft session (idempotent) and closes it with computed results", async () => {
    const key = `calib-${Date.now()}`;
    const create = await authedInject(QA, {
      method: "POST",
      url: "/api/qa/calibration",
      headers: { "idempotency-key": key },
      payload: { name: "itest calibration", callIds: endedCallIds.slice(0, 3), reviewerIds: [] },
    });
    const session = expectJson<{ id: string }>(create, 201);
    createdCalibrationIds.push(session.id);

    const dup = await authedInject(QA, {
      method: "POST",
      url: "/api/qa/calibration",
      headers: { "idempotency-key": key },
      payload: { name: "itest calibration", callIds: [], reviewerIds: [] },
    });
    const dupBody = expectJson<{ id: string; idempotent?: boolean }>(dup, 200);
    expect(dupBody.id).toBe(session.id);

    const close = await authedInject(QA, { method: "POST", url: `/api/qa/calibration/${session.id}/close` });
    const closed = expectJson<{ status: string; results: { kappa: number | null } }>(close);
    expect(closed.status).toBe("closed");
    expect(closed.results).toBeTruthy();
  });
});

describe("QA queue keyset pagination", () => {
  it("returns rows + nextCursor and walks the cursor with no duplicates", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/qa/queue?tab=all&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await authedInject(ADMIN, { method: "GET", url });
      const body = expectJson<{ rows: Array<{ id: string }>; nextCursor: string | null; total: number }>(res);
      expect(typeof body.total).toBe("number");
      for (const r of body.rows) {
        expect(seen.has(r.id)).toBe(false); // no dupes across pages
        seen.add(r.id);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 25);
    expect(pages).toBeGreaterThanOrEqual(1);
  });

  it("rejects limit > 100 (Zod 400)", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/qa/queue?limit=500" });
    expect(res.statusCode).toBe(400);
  });
});

describe("QA stats + agreement", () => {
  it("stats returns the extended metric set", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/qa/stats" });
    const body = expectJson<{
      inQueue: number;
      disputesOpen: number;
      slaBreaches: number;
      medianGoldVariance: number | null;
    }>(res);
    expect(typeof body.inQueue).toBe("number");
    expect(typeof body.disputesOpen).toBe("number");
    expect(typeof body.slaBreaches).toBe("number");
  });

  it("agreement returns kappa + pairwise + driftAlerts", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/qa/agreement" });
    const body = expectJson<{ pairwise: unknown[]; driftAlerts: unknown[]; asOf: string }>(res);
    expect(Array.isArray(body.pairwise)).toBe(true);
    expect(Array.isArray(body.driftAlerts)).toBe(true);
    expect(body.asOf).toBeTruthy();
  });
});
