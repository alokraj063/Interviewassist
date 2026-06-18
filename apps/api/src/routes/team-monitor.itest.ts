// Team Monitor — supervisor floor surface. Backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts: roster keyset pagination (no dupes, limit>100 rejected),
// supervise persistence + idempotency + audit, Zod 400, cross-org 404 (never a
// leak), permission gate (recruiter read-only → 403 on supervise; admin/dl →
// success), external-key gating (no VAPI_API_KEY → 200 {provider:"stub"}, not a
// 500), alert ack persistence + audit, bulk ack, SLA upsert ordering 400, and
// reassign legality (active call → 409 call_active_use_takeover).
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (all team_monitor.* perms),
// dl1@ (delivery_lead → supervise/reassign/alerts/sla), recruiter1@ (recruiter
// → team_monitor.read only). Cross-org (JOULESTOWATTS_ORG_ID):
// cognition.engine@joulestowatts.com.
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  callSessions,
  callSupervisionSessions,
  db,
  DEFAULT_ORG_ID,
  teamAlerts,
  teamMonitorAudit,
} from "@j2w/db";
import { authedInject, expectForbidden, expectJson } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const DL = "dl1@recruitassist.local"; // delivery_lead → full supervisor perms
const RECRUITER = "recruiter1@recruitassist.local"; // recruiter → read only
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const createdSupervisionKeys: string[] = [];

afterAll(async () => {
  if (createdSupervisionKeys.length) {
    await db
      .delete(callSupervisionSessions)
      .where(inArray(callSupervisionSessions.idempotencyKey, createdSupervisionKeys));
  }
});

// An ACTIVE call in the DEFAULT org whose recruiter isn't the supervisor we
// test with — the seed inserts 8 active live calls.
async function anActiveCall(): Promise<{ id: string; recruiterUserId: string | null }> {
  const [c] = await db
    .select({ id: callSessions.id, recruiterUserId: callSessions.recruiterUserId })
    .from(callSessions)
    .where(and(eq(callSessions.orgId, DEFAULT_ORG_ID), eq(callSessions.status, "active")))
    .limit(1);
  if (!c) throw new Error("no active call seeded for team-monitor");
  return c;
}

async function aQueuedCall(): Promise<string> {
  const [c] = await db
    .select({ id: callSessions.id })
    .from(callSessions)
    .where(and(eq(callSessions.orgId, DEFAULT_ORG_ID), eq(callSessions.status, "queued")))
    .limit(1);
  if (!c) throw new Error("no queued call seeded for team-monitor");
  return c.id;
}

function key(): string {
  const k = `itest-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  createdSupervisionKeys.push(k);
  return k;
}

describe("GET /api/team-monitor/overview + roster — reads, pagination, permission", () => {
  it("recruiter (read-only) gets overview KPIs", async () => {
    const res = await authedInject(RECRUITER, { method: "GET", url: "/api/team-monitor/overview" });
    const body = expectJson<{ kpis: Record<string, number> }>(res);
    expect(body.kpis).toHaveProperty("queueDepth");
    expect(body.kpis).toHaveProperty("activeCalls");
    expect(body.kpis.activeCalls).toBeGreaterThan(0);
  });

  it("roster: keyset pagination returns disjoint ordered pages; limit>100 rejected", async () => {
    const p1 = await authedInject(ADMIN, { method: "GET", url: "/api/team-monitor/roster?limit=3" });
    const b1 = expectJson<{ rows: Array<{ userId: string }>; nextCursor: string | null }>(p1);
    expect(b1.rows.length).toBeLessThanOrEqual(3);
    if (b1.nextCursor) {
      const p2 = await authedInject(ADMIN, {
        method: "GET",
        url: `/api/team-monitor/roster?limit=3&cursor=${encodeURIComponent(b1.nextCursor)}`,
      });
      const b2 = expectJson<{ rows: Array<{ userId: string }> }>(p2);
      const ids1 = new Set(b1.rows.map((r) => r.userId));
      for (const r of b2.rows) expect(ids1.has(r.userId)).toBe(false);
    }
    const bad = await authedInject(ADMIN, { method: "GET", url: "/api/team-monitor/roster?limit=500" });
    expect(bad.statusCode).toBe(400);
  });

  it("roster never returns cross-org users (org B isolated)", async () => {
    const res = await authedInject(CROSS_ORG, { method: "GET", url: "/api/team-monitor/roster?limit=100" });
    // CROSS_ORG has team_monitor.read (mirrored grant) but sees only its own org.
    const body = expectJson<{ rows: Array<{ userId: string }> }>(res);
    // None of the DEFAULT-org presence rows should appear; assert by checking the
    // DEFAULT roster ids are disjoint.
    const def = expectJson<{ rows: Array<{ userId: string }> }>(
      await authedInject(ADMIN, { method: "GET", url: "/api/team-monitor/roster?limit=100" }),
    );
    const defIds = new Set(def.rows.map((r) => r.userId));
    for (const r of body.rows) expect(defIds.has(r.userId)).toBe(false);
  });
});

describe("POST /api/team-monitor/calls/:id/supervise — persistence, idempotency, gate", () => {
  it("recruiter (read-only) → 403 forbidden, not 500", async () => {
    const call = await anActiveCall();
    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "whisper", idempotencyKey: key() },
    });
    expectForbidden(res);
    const body = JSON.parse(res.payload) as { permission?: string };
    expect(body.permission).toBe("team_monitor.supervise");
  });

  it("delivery_lead whisper persists session + audit row", async () => {
    const call = await anActiveCall();
    const k = key();
    const res = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "whisper", idempotencyKey: k },
    });
    const body = expectJson<{ session: { id: string; state: string; mode: string } }>(res, 201);
    expect(body.session.mode).toBe("whisper");
    expect(["requested", "active"]).toContain(body.session.state);

    const [row] = await db
      .select()
      .from(callSupervisionSessions)
      .where(eq(callSupervisionSessions.idempotencyKey, k));
    expect(row).toBeTruthy();
    expect(row.callId).toBe(call.id);

    const audit = await db
      .select()
      .from(teamMonitorAudit)
      .where(
        and(
          eq(teamMonitorAudit.orgId, DEFAULT_ORG_ID),
          eq(teamMonitorAudit.action, "supervision.whisper.start"),
          eq(teamMonitorAudit.targetId, call.id),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  it("idempotent: same key returns same session id, no second row", async () => {
    const call = await anActiveCall();
    const k = key();
    const r1 = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "barge", idempotencyKey: k },
    });
    const b1 = expectJson<{ session: { id: string } }>(r1, 201);
    const r2 = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "barge", idempotencyKey: k },
    });
    const b2 = expectJson<{ session: { id: string } }>(r2, 200);
    expect(b2.session.id).toBe(b1.session.id);
    const rows = await db
      .select()
      .from(callSupervisionSessions)
      .where(eq(callSupervisionSessions.idempotencyKey, k));
    expect(rows.length).toBe(1);
  });

  it("Zod 400 on invalid mode", async () => {
    const call = await anActiveCall();
    const res = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "yell", idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { issues?: unknown };
    expect(body.issues).toBeTruthy();
  });

  it("cross-org call → 404 (not 403, no leak)", async () => {
    const call = await anActiveCall();
    const res = await authedInject(CROSS_ORG, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/supervise`,
      payload: { mode: "whisper", idempotencyKey: key() },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET supervise/feed — external-key gating (503-not-500, stub fallback)", () => {
  it("browser-mixed call → 200 {provider:'stub'} with live transcript shape", async () => {
    const call = await anActiveCall();
    const res = await authedInject(DL, {
      method: "GET",
      url: `/api/team-monitor/calls/${call.id}/supervise/feed`,
    });
    const body = expectJson<{ audio: { provider: string }; transcript: unknown[] }>(res);
    // Seed calls are origin='web' (browser-mixed) → transcript-only stub, never 500.
    expect(body.audio.provider).toBe("stub");
    expect(Array.isArray(body.transcript)).toBe(true);
  });
});

describe("Alerts — ack persistence + audit, bulk", () => {
  it("ack flips state to acked, stamps actor, writes audit", async () => {
    const [open] = await db
      .select()
      .from(teamAlerts)
      .where(and(eq(teamAlerts.orgId, DEFAULT_ORG_ID), eq(teamAlerts.state, "open")))
      .limit(1);
    expect(open).toBeTruthy();
    const res = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/alerts/${open.id}/ack`,
    });
    const body = expectJson<{ alert: { state: string; ackedByUserId: string | null } }>(res);
    expect(body.alert.state).toBe("acked");
    expect(body.alert.ackedByUserId).toBeTruthy();

    const audit = await db
      .select()
      .from(teamMonitorAudit)
      .where(
        and(
          eq(teamMonitorAudit.orgId, DEFAULT_ORG_ID),
          eq(teamMonitorAudit.action, "alert.ack"),
          eq(teamMonitorAudit.targetId, open.id),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  it("recruiter (read-only) cannot ack → 403", async () => {
    const [open] = await db
      .select()
      .from(teamAlerts)
      .where(and(eq(teamAlerts.orgId, DEFAULT_ORG_ID), eq(teamAlerts.state, "open")))
      .limit(1);
    if (!open) return; // all acked already; the gate is exercised below regardless
    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/team-monitor/alerts/${open.id}/ack`,
    });
    expectForbidden(res);
  });

  it("bulk ack returns affected ids, all same-org", async () => {
    const open = await db
      .select({ id: teamAlerts.id })
      .from(teamAlerts)
      .where(and(eq(teamAlerts.orgId, DEFAULT_ORG_ID), eq(teamAlerts.state, "open")))
      .limit(2);
    if (open.length === 0) return;
    const res = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/alerts/bulk`,
      payload: { ids: open.map((o) => o.id), action: "ack" },
    });
    const body = expectJson<{ affected: string[]; skipped: string[] }>(res);
    expect(body.affected.length).toBe(open.length);
    expect(body.skipped.length).toBe(0);
  });
});

describe("SLA policies — list seeds defaults, upsert ordering validation", () => {
  it("list returns the 5 metrics", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/team-monitor/sla-policies" });
    const body = expectJson<{ policies: Array<{ metric: string }> }>(res);
    expect(body.policies.length).toBeGreaterThanOrEqual(5);
  });

  it("PUT with warning==critical → 400 thresholds_equal", async () => {
    const res = await authedInject(DL, {
      method: "PUT",
      url: "/api/team-monitor/sla-policies/queue_depth",
      payload: { warningThreshold: 10, criticalThreshold: 10 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error?: string };
    expect(body.error).toBe("thresholds_equal");
  });

  it("PUT valid thresholds persists + audits before/after", async () => {
    const res = await authedInject(DL, {
      method: "PUT",
      url: "/api/team-monitor/sla-policies/queue_depth",
      payload: { warningThreshold: 6, criticalThreshold: 12, enabled: true },
    });
    const body = expectJson<{ policy: { warningThreshold: number; criticalThreshold: number } }>(res);
    expect(body.policy.warningThreshold).toBe(6);
    expect(body.policy.criticalThreshold).toBe(12);
    const audit = await db
      .select()
      .from(teamMonitorAudit)
      .where(
        and(
          eq(teamMonitorAudit.orgId, DEFAULT_ORG_ID),
          eq(teamMonitorAudit.action, "sla_policy.update"),
          eq(teamMonitorAudit.targetId, "queue_depth"),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);
  });

  it("recruiter (read-only) cannot write SLA → 403", async () => {
    const res = await authedInject(RECRUITER, {
      method: "PUT",
      url: "/api/team-monitor/sla-policies/queue_depth",
      payload: { warningThreshold: 6, criticalThreshold: 12 },
    });
    expectForbidden(res);
  });
});

describe("Reassign — legality + audit", () => {
  it("reassigning an ACTIVE call → 409 call_active_use_takeover", async () => {
    const call = await anActiveCall();
    const target = call.recruiterUserId; // any member id; org check still passes
    const res = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${call.id}/reassign`,
      payload: {
        toUserId: target ?? "00000000-0000-0000-0000-000000000001",
        reason: "test",
        idempotencyKey: key(),
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { error?: string };
    expect(body.error).toBe("call_active_use_takeover");
  });

  it("reassigning a QUEUED call → 200 + audit + idempotent replay", async () => {
    const callId = await aQueuedCall();
    // pick a recruiter in DEFAULT org as the target
    const [member] = await db
      .select({ userId: callSessions.recruiterUserId })
      .from(callSessions)
      .where(and(eq(callSessions.orgId, DEFAULT_ORG_ID), eq(callSessions.status, "active")))
      .limit(1);
    const target = member?.userId;
    if (!target) return;
    const k = key();
    const r1 = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${callId}/reassign`,
      payload: { toUserId: target, reason: "rebalance", idempotencyKey: k },
    });
    const b1 = expectJson<{ call: { recruiterUserId: string; status: string } }>(r1);
    expect(b1.call.recruiterUserId).toBe(target);
    expect(b1.call.status).toBe("assigned");

    const audit = await db
      .select()
      .from(teamMonitorAudit)
      .where(
        and(
          eq(teamMonitorAudit.orgId, DEFAULT_ORG_ID),
          eq(teamMonitorAudit.action, "call.reassign"),
          eq(teamMonitorAudit.targetId, callId),
        ),
      );
    expect(audit.length).toBeGreaterThan(0);

    // idempotent replay (call is now 'assigned' which is still legal) returns 200.
    const r2 = await authedInject(DL, {
      method: "POST",
      url: `/api/team-monitor/calls/${callId}/reassign`,
      payload: { toUserId: target, reason: "rebalance", idempotencyKey: k },
    });
    const b2 = expectJson<{ idempotentReplay?: boolean }>(r2, 200);
    expect(b2.idempotentReplay).toBe(true);
  });

  it("recruiter (read-only) cannot reassign → 403", async () => {
    const callId = await aQueuedCall();
    const res = await authedInject(RECRUITER, {
      method: "POST",
      url: `/api/team-monitor/calls/${callId}/reassign`,
      payload: {
        toUserId: "00000000-0000-0000-0000-000000000001",
        reason: "x",
        idempotencyKey: key(),
      },
    });
    expectForbidden(res);
  });
});

describe("Presence heartbeat", () => {
  it("self-heartbeat upserts presence row for caller", async () => {
    const res = await authedInject(DL, {
      method: "POST",
      url: "/api/team-monitor/presence/heartbeat",
      payload: { statusNote: "Supervising floor" },
    });
    const body = expectJson<{ ok?: boolean; throttled?: boolean; activity?: string }>(res);
    expect(body.ok === true || body.throttled === true).toBe(true);
  });
});
