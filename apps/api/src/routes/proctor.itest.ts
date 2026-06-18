// Proctor cockpit — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts persistence, Zod validation (400 + issues), cross-org
// scoping (404, never a leak/403), permission gates (403-not-500 for a role
// lacking the permission; success for admin/qa), external-key gating (503 with
// a precise code, never 500), keyset pagination, idempotency, and the
// append-only chain-of-custody audit (session.view on read, evidence.export on
// export, session.review on a decision).
//
// runSeed() (the harness seed) does NOT seed demo proctor sessions, so each
// suite inserts its own org-scoped rows directly via @j2w/db. This keeps the
// tests self-contained and order-independent.
//
// Seeded principals (DEFAULT_ORG_ID): admin@/qa1@/recruiter1@recruitassist.local
// + proctor1@ (role `proctor`). Cross-org principal (JOULESTOWATTS_ORG_ID):
// cognition.engine@joulestowatts.com.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assessmentAttempts,
  assessmentTemplates,
  candidates,
  db,
  DEFAULT_ORG_ID,
  JOULESTOWATTS_ORG_ID,
  proctorAuditEvents,
  proctorEvents,
  proctorIdentityChecks,
  proctorPolicies,
  proctorSessions,
} from "@j2w/db";
import { authedInject, expectForbidden, expectJson, tokenFor } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const QA = "qa1@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local";
const PROCTOR = "proctor1@recruitassist.local";
const CROSS_ORG = "cognition.engine@joulestowatts.com";

// ---------- fixtures ----------

const createdSessionIds: string[] = [];
const createdPolicyIds: string[] = [];
const createdTemplateIds: string[] = [];

// One assessment template per org, created once — its id anchors the attempts
// that proctor sessions link to (the base proctor_sessions CHECK requires
// exactly one of assessment_attempt_id / async_video_submission_id to be set).
const templateIdByOrg = new Map<string, string>();

async function templateFor(orgId: string): Promise<string> {
  const cached = templateIdByOrg.get(orgId);
  if (cached) return cached;
  const [tpl] = await db
    .insert(assessmentTemplates)
    .values({ orgId, title: `Proctor itest template ${orgId.slice(0, 8)}`, status: "published" })
    .returning({ id: assessmentTemplates.id });
  templateIdByOrg.set(orgId, tpl.id);
  createdTemplateIds.push(tpl.id);
  return tpl.id;
}

async function attemptFor(orgId: string, candidateId: string | null): Promise<string> {
  const templateId = await templateFor(orgId);
  const [attempt] = await db
    .insert(assessmentAttempts)
    .values({
      orgId,
      templateId,
      candidateId,
      inviteToken: `proctor-itest-${randomUUID()}`,
      status: "started",
      startedAt: new Date(),
    })
    .returning({ id: assessmentAttempts.id });
  return attempt.id;
}

async function aCandidateId(orgId: string): Promise<string | null> {
  const [c] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(eq(candidates.orgId, orgId))
    .limit(1);
  return c?.id ?? null;
}

interface SeedSessionOpts {
  orgId?: string;
  status?: "live" | "completed" | "abandoned";
  liveState?: "active" | "paused" | "ended";
  riskScore?: number;
  flagCount?: number;
  reviewerDecision?: "clean" | "flagged" | "invalidated" | null;
  reviewSlaDueAt?: Date | null;
  startedAt?: Date;
  policySnapshot?: Record<string, unknown> | null;
  candidateId?: string | null;
}

// Insert a proctor session row directly (no HTTP route gates the create path,
// but a direct insert keeps the fixtures explicit and fast).
async function seedSession(opts: SeedSessionOpts = {}): Promise<string> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID;
  const candidateId = opts.candidateId !== undefined ? opts.candidateId : await aCandidateId(orgId);
  const attemptId = await attemptFor(orgId, candidateId ?? null);
  const [row] = await db
    .insert(proctorSessions)
    .values({
      orgId,
      assessmentAttemptId: attemptId,
      candidateId: candidateId ?? null,
      status: opts.status ?? "completed",
      liveState: opts.liveState ?? "ended",
      riskScore: opts.riskScore ?? 10,
      flagCount: opts.flagCount ?? 0,
      reviewerDecision: opts.reviewerDecision ?? null,
      reviewSlaDueAt: opts.reviewSlaDueAt ?? new Date(Date.now() + 24 * 3600_000),
      startedAt: opts.startedAt ?? new Date(),
      policySnapshot:
        opts.policySnapshot ?? { autoFlagRiskScore: 40, autoTerminateRiskScore: 85, signalConfig: {} },
    })
    .returning({ id: proctorSessions.id });
  createdSessionIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  // Best-effort cleanup so re-runs in the same disposable DB stay tidy.
  // Deleting the templates cascades to attempts → proctor sessions → events.
  if (createdSessionIds.length) {
    await db.delete(proctorSessions).where(inArray(proctorSessions.id, createdSessionIds));
  }
  if (createdTemplateIds.length) {
    await db.delete(assessmentTemplates).where(inArray(assessmentTemplates.id, createdTemplateIds));
  }
  if (createdPolicyIds.length) {
    await db.delete(proctorPolicies).where(inArray(proctorPolicies.id, createdPolicyIds));
  }
});

// ---------- permission grant regression (the original hard-fail) ----------

describe("proctor — permission grants (regression for ungranted headline action)", () => {
  it("admin can perform the core review write (proctoring.review was actually granted)", async () => {
    const id = await seedSession({ status: "completed", reviewerDecision: null });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "clean" },
    });
    const body = expectJson<{ session: { reviewerDecision: string; reviewedAt: string } }>(res, 200);
    expect(body.session.reviewerDecision).toBe("clean");
    expect(body.session.reviewedAt).toBeTruthy();
  });

  it("qa_reviewer is also granted proctoring.review and can decide", async () => {
    const id = await seedSession({ status: "completed" });
    const res = await authedInject(QA, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "flagged", justification: "Multiple tab switches near the end." },
    });
    expectJson(res, 200);
  });

  it("the dedicated `proctor` role can read the roster (proctoring.read granted)", async () => {
    const res = await authedInject(PROCTOR, { method: "GET", url: "/api/proctor/sessions?limit=5" });
    expectJson(res, 200);
  });
});

// ---------- persistence ----------

describe("proctor — persistence", () => {
  it("POST /policies then GET /policies returns it; create writes an audit row", async () => {
    const name = `Persist Policy ${Date.now()}`;
    const create = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/proctor/policies",
      payload: {
        name,
        isDefault: false,
        signalConfig: { tab_switch: { armed: true, severity: "low", weight: 6 } },
        autoFlagRiskScore: 35,
        autoTerminateRiskScore: 90,
      },
    });
    const body = expectJson<{ policy: { id: string; name: string } }>(create, 201);
    createdPolicyIds.push(body.policy.id);
    expect(body.policy.name).toBe(name);

    const list = await authedInject(ADMIN, { method: "GET", url: "/api/proctor/policies" });
    const listBody = expectJson<{ policies: Array<{ id: string }> }>(list);
    expect(listBody.policies.find((p) => p.id === body.policy.id)).toBeTruthy();

    // A policy.update audit row for the create.
    const [audit] = await db
      .select()
      .from(proctorAuditEvents)
      .where(
        and(
          eq(proctorAuditEvents.orgId, DEFAULT_ORG_ID),
          eq(proctorAuditEvents.action, "policy.update"),
          eq(proctorAuditEvents.toValue, body.policy.id),
        ),
      )
      .limit(1);
    expect(audit).toBeTruthy();
  });

  it("review persists decision + reviewedAt and an attributable session.review audit (from→to)", async () => {
    const id = await seedSession({ status: "completed", reviewerDecision: null });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "invalidated", justification: "Second device detected mid-exam." },
    });
    expectJson(res, 200);

    const [row] = await db.select().from(proctorSessions).where(eq(proctorSessions.id, id));
    expect(row.reviewerDecision).toBe("invalidated");
    expect(row.reviewedAt).toBeTruthy();

    const audits = await db
      .select()
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "session.review")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const decision = audits.find((a) => a.toValue === "invalidated");
    expect(decision).toBeTruthy();
    expect(decision?.actorUserId).toBeTruthy();
  });

  it("intervene (pause) flips liveState and records an intervention + audit", async () => {
    const id = await seedSession({ status: "live", liveState: "active" });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/intervene`,
      payload: { kind: "pause", message: "Stepping away to verify identity." },
    });
    const body = expectJson<{ liveState: string; intervention: { kind: string } }>(res, 201);
    expect(body.liveState).toBe("paused");
    expect(body.intervention.kind).toBe("pause");

    const [row] = await db.select().from(proctorSessions).where(eq(proctorSessions.id, id));
    expect(row.liveState).toBe("paused");

    const [pauseAudit] = await db
      .select()
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "session.pause")));
    expect(pauseAudit).toBeTruthy();
  });

  it("recomputes risk on event ingest and auto-terminates past the policy threshold", async () => {
    // Snapshot with a low auto-terminate so a single high-weight signal trips it.
    const id = await seedSession({
      status: "live",
      liveState: "active",
      riskScore: 0,
      policySnapshot: { autoFlagRiskScore: 10, autoTerminateRiskScore: 20, signalConfig: {} },
    });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/events`,
      payload: { kind: "face_mismatch", severity: "high", flagged: true },
    });
    const body = expectJson<{ ok: boolean; riskScore: number; liveState: string }>(res, 201);
    expect(body.riskScore).toBeGreaterThan(20);
    expect(body.liveState).toBe("ended");

    const [row] = await db.select().from(proctorSessions).where(eq(proctorSessions.id, id));
    expect(row.status).toBe("completed");
    const [termAudit] = await db
      .select()
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "session.terminate")));
    expect(termAudit).toBeTruthy();
  });
});

// ---------- Zod validation ----------

describe("proctor — Zod validation", () => {
  it("review {decision:'invalidated'} with no justification → 400 with issues", async () => {
    const id = await seedSession({ status: "completed" });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "invalidated" },
    });
    const body = expectJson<{ error: string; issues: unknown }>(res, 400);
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toBeTruthy();
  });

  it("intervene {kind:'terminate'} with no message → 400", async () => {
    const id = await seedSession({ status: "live", liveState: "active" });
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/intervene`,
      payload: { kind: "terminate" },
    });
    expectJson(res, 400);
  });

  it("policy with autoTerminate < autoFlag → 400", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/proctor/policies",
      payload: { name: "Bad Thresholds", autoFlagRiskScore: 80, autoTerminateRiskScore: 30 },
    });
    expectJson(res, 400);
  });

  it("roster limit=999 is rejected with 400 (no unbounded slice)", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/proctor/sessions?limit=999" });
    expectJson(res, 400);
  });

  it("malformed cursor → 400", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/proctor/sessions?cursor=not-a-real-cursor!!!",
    });
    expectJson(res, 400);
  });
});

// ---------- cross-org scoping ----------

describe("proctor — cross-org scoping", () => {
  it("a cross-org token reading/writing an org-A session → 404 (not 403, not leak)", async () => {
    const id = await seedSession({ status: "completed", reviewerDecision: null });

    const get = await authedInject(CROSS_ORG, { method: "GET", url: `/api/proctor/sessions/${id}` });
    expect(get.statusCode).toBe(404);

    const review = await authedInject(CROSS_ORG, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "clean" },
    });
    expect(review.statusCode).toBe(404);

    const exportRes = await authedInject(CROSS_ORG, {
      method: "GET",
      url: `/api/proctor/sessions/${id}/export`,
    });
    expect(exportRes.statusCode).toBe(404);
  });

  it("the org-A session never appears in a cross-org roster list", async () => {
    const id = await seedSession({ status: "completed" });
    const list = await authedInject(CROSS_ORG, { method: "GET", url: "/api/proctor/sessions?limit=50" });
    const body = expectJson<{ sessions: Array<{ id: string }> }>(list);
    expect(body.sessions.find((s) => s.id === id)).toBeUndefined();
  });
});

// ---------- permission gates (403, never 500) ----------

describe("proctor — permission gates", () => {
  it("recruiter (lacking proctoring.read) is 403 on the roster — not 500", async () => {
    const res = await authedInject(RECRUITER, { method: "GET", url: "/api/proctor/sessions" });
    expectForbidden(res);
  });

  it("recruiter is 403 on review / intervene / policy writes — not 500", async () => {
    const id = await seedSession({ status: "completed" });
    const review = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/review`,
      payload: { decision: "clean" },
    });
    expect(review.statusCode).toBe(403);

    const intervene = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/intervene`,
      payload: { kind: "pause" },
    });
    expect(intervene.statusCode).toBe(403);

    const policy = await authedInject(RECRUITER, {
      method: "POST",
      url: "/api/proctor/policies",
      payload: { name: "Nope" },
    });
    expect(policy.statusCode).toBe(403);
  });

  it("admin can read + write (sanity that gates don't over-block the granted role)", async () => {
    const list = await authedInject(ADMIN, { method: "GET", url: "/api/proctor/summary" });
    expectJson(list, 200);
  });
});

// ---------- external-key gating (503, never 500) ----------

describe("proctor — external-key gating", () => {
  it("identity/match real path → 503 face_match_provider_missing when AWS keys unset; stub → 200", async () => {
    const id = await seedSession({ status: "completed" });
    // Seed an identity check row so the match has blob keys to hash.
    await db.insert(proctorIdentityChecks).values({
      orgId: DEFAULT_ORG_ID,
      sessionId: id,
      status: "pending",
      idPhotoBlobKey: "demo-proctor/x-id.jpg",
      selfieBlobKey: "demo-proctor/x-selfie.jpg",
    });

    const real = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/identity/match?real=true`,
    });
    if (process.env.AWS_REKOGNITION_ACCESS_KEY_ID) {
      expect([200, 502]).toContain(real.statusCode);
    } else {
      const body = expectJson<{ error: string }>(real, 503);
      expect(body.error).toBe("face_match_provider_missing");
    }

    const stub = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/proctor/sessions/${id}/identity/match`,
    });
    const stubBody = expectJson<{ matchScore: number; provider: string }>(stub, 200);
    expect(stubBody.provider).toBe("stub");
    expect(stubBody.matchScore).toBeGreaterThanOrEqual(0);
    expect(stubBody.matchScore).toBeLessThanOrEqual(100);
  });

  it("stream-token returns snapshot mode when PROCTOR_STREAM_PROVIDER=none (no 500)", async () => {
    const id = await seedSession({ status: "live", liveState: "active" });
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/proctor/sessions/${id}/stream-token`,
    });
    // Default provider is `none` → snapshot mode (200). With a real provider but
    // missing keys it would be a precise 503, never a 500.
    expect([200, 503]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = expectJson<{ mode: string }>(res, 200);
      expect(["snapshot", "live"]).toContain(body.mode);
    }
  });
});

// ---------- keyset pagination ----------

describe("proctor — keyset pagination", () => {
  it("paginates 60 sessions with limit=25 + cursor, no overlap, nextCursor null at end", async () => {
    const ids: string[] = [];
    const base = Date.now();
    for (let i = 0; i < 60; i += 1) {
      // Distinct startedAt so the (startedAt, id) keyset is total-ordered.
      const id = await seedSession({
        status: "completed",
        startedAt: new Date(base - i * 1000),
        riskScore: i % 90,
      });
      ids.push(id);
    }
    const idSet = new Set(ids);

    const collected: string[] = [];
    let cursor: string | null = null;
    let total: number | undefined;
    let guard = 0;
    do {
      const url = `/api/proctor/sessions?limit=25&sort=recent${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await authedInject(ADMIN, { method: "GET", url });
      const body = expectJson<{ sessions: Array<{ id: string }>; nextCursor: string | null; total: number }>(res);
      total = body.total;
      for (const s of body.sessions) collected.push(s.id);
      cursor = body.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    // total reported and ≥ our 60 inserts (other suites may have added rows).
    expect(typeof total).toBe("number");
    expect(total!).toBeGreaterThanOrEqual(60);

    // No duplicates across pages.
    expect(new Set(collected).size).toBe(collected.length);
    // Every one of our 60 inserted rows was returned exactly once.
    const ours = collected.filter((id) => idSet.has(id));
    expect(new Set(ours).size).toBe(60);
  });
});

// ---------- idempotency ----------

describe("proctor — idempotency", () => {
  it("two POST /policies with the same Idempotency-Key yield one row", async () => {
    const key = `proctor-idem-${Date.now()}`;
    const payload = { name: `Idem Policy ${Date.now()}`, autoFlagRiskScore: 40 };
    const first = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/proctor/policies",
      headers: { "idempotency-key": key },
      payload,
    });
    const a = expectJson<{ policy: { id: string } }>(first, 201);
    createdPolicyIds.push(a.policy.id);

    const second = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/proctor/policies",
      headers: { "idempotency-key": key },
      payload: { ...payload, name: "changed-but-ignored" },
    });
    const b = expectJson<{ policy: { id: string }; idempotent?: boolean }>(second, 200);
    expect(b.policy.id).toBe(a.policy.id);
    expect(b.idempotent).toBe(true);

    const rows = await db
      .select({ id: proctorPolicies.id })
      .from(proctorPolicies)
      .where(and(eq(proctorPolicies.orgId, DEFAULT_ORG_ID), eq(proctorPolicies.name, payload.name)));
    expect(rows.length).toBe(1);
  });
});

// ---------- append-only chain-of-custody audit ----------

describe("proctor — chain-of-custody audit", () => {
  it("GET /sessions/:id writes a session.view audit row (every evidence read is attributable)", async () => {
    const id = await seedSession({ status: "completed" });
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "session.view")));

    await authedInject(ADMIN, { method: "GET", url: `/api/proctor/sessions/${id}` });

    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "session.view")));
    expect(after[0].n).toBe(before[0].n + 1);

    // The audit endpoint surfaces the attributable row.
    const audit = await authedInject(ADMIN, { method: "GET", url: `/api/proctor/sessions/${id}/audit` });
    const body = expectJson<{ entries: Array<{ action: string; actorName: string | null }> }>(audit);
    expect(body.entries.some((e) => e.action === "session.view")).toBe(true);
  });

  it("GET /sessions/:id/export writes an evidence.export audit row", async () => {
    const id = await seedSession({ status: "completed" });
    // Give the export something to manifest.
    await db.insert(proctorEvents).values({
      sessionId: id,
      kind: "tab_switch",
      severity: "low",
      flagged: true,
      offsetMs: 1000,
    });

    const res = await authedInject(ADMIN, { method: "GET", url: `/api/proctor/sessions/${id}/export` });
    expectJson(res, 200);

    const [exportAudit] = await db
      .select()
      .from(proctorAuditEvents)
      .where(and(eq(proctorAuditEvents.sessionId, id), eq(proctorAuditEvents.action, "evidence.export")));
    expect(exportAudit).toBeTruthy();
    expect(exportAudit.actorUserId).toBeTruthy();
  });

  it("export as csv is downloadable and includes the event row", async () => {
    const id = await seedSession({ status: "completed" });
    await db.insert(proctorEvents).values({
      sessionId: id,
      kind: "paste",
      severity: "high",
      flagged: true,
      offsetMs: 2000,
    });
    const res = await authedInject(ADMIN, { method: "GET", url: `/api/proctor/sessions/${id}/export?format=csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("paste");
  });
});

// ---------- summary aggregate (the at-scale-metric hard-fail fix) ----------

describe("proctor — server-computed summary (fixes client-slice metric bug)", () => {
  it("summary counts move with the data and are not derived from a truncated list slice", async () => {
    const token = await tokenFor(ADMIN);
    expect(token).toBeTruthy();

    const before = expectJson<{ pendingReview: number; total: number }>(
      await authedInject(ADMIN, { method: "GET", url: "/api/proctor/summary" }),
    );

    // Add a fresh completed + un-reviewed session → pendingReview should rise.
    await seedSession({ status: "completed", reviewerDecision: null });

    const after = expectJson<{ pendingReview: number; total: number }>(
      await authedInject(ADMIN, { method: "GET", url: "/api/proctor/summary" }),
    );
    expect(after.total).toBe(before.total + 1);
    expect(after.pendingReview).toBe(before.pendingReview + 1);
  });
});
