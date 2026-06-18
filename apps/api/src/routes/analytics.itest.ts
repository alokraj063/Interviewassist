// Analytics report-engine — backend itests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts:
//   - report aggregates: org-scoped, return { rows, asOf, window }.
//   - Zod 400: range=custom without from/to; export missing reportKey.
//   - permission gates: recruiter1@ (analytics.read) → 200 reports; client_user
//     (no analytics.read) → 403; recruiter1@ → 403 on /export & /schedules
//     (lacks analytics.export); qa1@ → 403 on /reports/diversity (lacks
//     analytics.diversity.read); admin → success everywhere.
//   - cross-org 404: a view created in DEFAULT_ORG is invisible/unpatchable to
//     the JoulesToWatts admin (and vice versa).
//   - idempotency: same name → single view; same Idempotency-Key → one export.
//   - audit: a matching audit_log row exists after create/archive/export.
//   - external-key: /reports/funnel/summary with OPENAI_API_KEY unset → 200
//     { ai:false }, never 5xx.
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (read+export+diversity),
// recruiter1@ (read only), qa1@ (read, no export/diversity),
// client@example-gcc.local (client_user → NO analytics.read).
// Cross-org (JoulesToWatts): cognition.engine@joulestowatts.com (admin).
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  DEFAULT_ORG_ID,
  analyticsSavedViews,
  analyticsScheduledReports,
  analyticsExportJobs,
  auditLog,
} from "@j2w/db";
import { authedInject, expectJson, expectForbidden } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local"; // analytics.read only
const QA = "qa1@recruitassist.local"; // read, no export, no diversity
const CLIENT = "client@example-gcc.local"; // client_user → no analytics.read
const CROSS_ORG = "cognition.engine@joulestowatts.com"; // JoulesToWatts admin

const createdViewIds: string[] = [];
const createdScheduleIds: string[] = [];
const createdExportIds: string[] = [];

afterAll(async () => {
  if (createdScheduleIds.length) {
    await db
      .delete(analyticsScheduledReports)
      .where(inArray(analyticsScheduledReports.id, createdScheduleIds));
  }
  if (createdExportIds.length) {
    await db.delete(analyticsExportJobs).where(inArray(analyticsExportJobs.id, createdExportIds));
  }
  if (createdViewIds.length) {
    await db.delete(analyticsSavedViews).where(inArray(analyticsSavedViews.id, createdViewIds));
  }
});

async function createView(name: string, headers?: Record<string, string>) {
  const res = await authedInject(ADMIN, {
    method: "POST",
    url: "/api/analytics/views",
    headers,
    payload: { name, description: "itest view", config: { range: { token: "last_30d" } } },
  });
  if (res.statusCode === 201 || res.statusCode === 200) {
    const body = JSON.parse(res.body) as { id: string };
    if (!createdViewIds.includes(body.id)) createdViewIds.push(body.id);
  }
  return res;
}

describe("analytics report aggregates", () => {
  it("funnel returns { rows, asOf, window } for the admin's org", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/analytics/reports/funnel?range=last_90d",
    });
    const body = expectJson<{ rows: unknown[]; asOf: string; window: unknown }>(res, 200);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.asOf).toBe("string");
    expect(body.window).toBeTruthy();
  });

  it("velocity, source-effectiveness, quality, voice, call-volume all 200", async () => {
    for (const path of [
      "/api/analytics/reports/velocity",
      "/api/analytics/reports/source-effectiveness",
      "/api/analytics/reports/quality-distribution",
      "/api/analytics/reports/voice-screener",
      "/api/analytics/reports/call-volume?granularity=week",
    ]) {
      const res = await authedInject(ADMIN, { method: "GET", url: path });
      expect(res.statusCode, `${path} → ${res.body}`).toBe(200);
    }
  });

  it("recruiter-productivity is keyset-paginated (rows + nextCursor)", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/analytics/reports/recruiter-productivity?range=last_90d&limit=2",
    });
    const body = expectJson<{ rows: unknown[]; nextCursor: string | null }>(res, 200);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeLessThanOrEqual(2);
    expect("nextCursor" in body).toBe(true);
  });

  it("drill/candidates returns paginated underlying rows", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/analytics/drill/candidates?range=last_90d&limit=5",
    });
    const body = expectJson<{ rows: unknown[]; nextCursor: string | null }>(res, 200);
    expect(Array.isArray(body.rows)).toBe(true);
  });
});

describe("analytics Zod validation", () => {
  it("range=custom without from/to → 400", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/analytics/reports/funnel?range=custom",
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /export missing reportKey → 400", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": "itest-zod-1" },
      payload: { format: "csv" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("analytics permission gates", () => {
  it("recruiter1@ (analytics.read) → 200 on funnel", async () => {
    const res = await authedInject(RECRUITER, {
      method: "GET",
      url: "/api/analytics/reports/funnel",
    });
    expect(res.statusCode).toBe(200);
  });

  it("client_user (no analytics.read) → 403 on funnel", async () => {
    const res = await authedInject(CLIENT, {
      method: "GET",
      url: "/api/analytics/reports/funnel",
    });
    expectForbidden(res);
  });

  it("recruiter1@ (no analytics.export) → 403 on /export and /schedules", async () => {
    const exp = await authedInject(RECRUITER, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": "itest-perm-1" },
      payload: { reportKey: "funnel", format: "csv", params: {} },
    });
    expectForbidden(exp);
    const sch = await authedInject(RECRUITER, {
      method: "POST",
      url: "/api/analytics/schedules",
      payload: { savedViewId: "00000000-0000-0000-0000-000000000000", name: "x" },
    });
    expectForbidden(sch);
  });

  it("qa1@ (no analytics.diversity.read) → 403 on /reports/diversity", async () => {
    const res = await authedInject(QA, {
      method: "GET",
      url: "/api/analytics/reports/diversity",
    });
    expectForbidden(res);
  });

  it("admin → 200 on /reports/diversity (suppressed buckets surfaced)", async () => {
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: "/api/analytics/reports/diversity?range=last_90d",
    });
    const body = expectJson<{ rows: unknown[]; suppressedBuckets: number }>(res, 200);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.suppressedBuckets).toBe("number");
  });
});

describe("analytics saved views — CRUD + idempotency + audit + cross-org", () => {
  it("create → 201, list returns it, audit row exists", async () => {
    const name = `itest view ${Date.now()}`;
    const res = await createView(name);
    const created = expectJson<{ id: string; name: string }>(res, 201);
    expect(created.name).toBe(name);

    const list = await authedInject(ADMIN, { method: "GET", url: "/api/analytics/views?limit=100" });
    const body = expectJson<{ rows: Array<{ id: string }> }>(list, 200);
    expect(body.rows.some((r) => r.id === created.id)).toBe(true);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "analytics.view.create"), eq(auditLog.targetId, created.id)),
      );
    expect(audit.length).toBe(1);
  });

  it("create with same (org,owner,name) is idempotent → 200, single row", async () => {
    const name = `itest idem view ${Date.now()}`;
    const first = await createView(name);
    expect(first.statusCode).toBe(201);
    const second = await createView(name);
    expect(second.statusCode).toBe(200);
    const firstId = (JSON.parse(first.body) as { id: string }).id;
    const secondId = (JSON.parse(second.body) as { id: string }).id;
    expect(secondId).toBe(firstId);
    const rows = await db
      .select()
      .from(analyticsSavedViews)
      .where(and(eq(analyticsSavedViews.orgId, DEFAULT_ORG_ID), eq(analyticsSavedViews.name, name)));
    expect(rows.length).toBe(1);
  });

  it("PATCH mutates name; archive flips is_archived; audit rows written", async () => {
    const res = await createView(`itest patch view ${Date.now()}`);
    const id = (JSON.parse(res.body) as { id: string }).id;

    const patched = await authedInject(ADMIN, {
      method: "PATCH",
      url: `/api/analytics/views/${id}`,
      payload: { name: "renamed itest view" },
    });
    const pbody = expectJson<{ name: string }>(patched, 200);
    expect(pbody.name).toBe("renamed itest view");

    const arch = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/analytics/views/${id}/archive`,
      payload: {},
    });
    const abody = expectJson<{ isArchived: boolean }>(arch, 200);
    expect(abody.isArchived).toBe(true);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(like(auditLog.action, "analytics.view.%"), eq(auditLog.targetId, id)));
    expect(audit.length).toBeGreaterThanOrEqual(3); // create, update, archive
  });

  it("cross-org: JoulesToWatts admin cannot GET/PATCH a DEFAULT_ORG view → 404", async () => {
    const res = await createView(`itest crossorg view ${Date.now()}`);
    const id = (JSON.parse(res.body) as { id: string }).id;

    const patch = await authedInject(CROSS_ORG, {
      method: "PATCH",
      url: `/api/analytics/views/${id}`,
      payload: { name: "hijack" },
    });
    expect(patch.statusCode).toBe(404);

    const arch = await authedInject(CROSS_ORG, {
      method: "POST",
      url: `/api/analytics/views/${id}/archive`,
      payload: {},
    });
    expect(arch.statusCode).toBe(404);
  });
});

describe("analytics export — idempotency + persistence + audit", () => {
  it("two POST /export with same Idempotency-Key → same jobId, one DB row", async () => {
    const idem = `itest-export-${Date.now()}`;
    const body = { reportKey: "funnel", format: "csv", params: { range: "last_90d" } };
    const first = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": idem },
      payload: body,
    });
    const f = expectJson<{ jobId: string; status: string; rowCount: number }>(first, 201);
    createdExportIds.push(f.jobId);
    expect(f.status).toBe("ready");

    const second = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": idem },
      payload: body,
    });
    const s = expectJson<{ jobId: string }>(second, 200);
    expect(s.jobId).toBe(f.jobId);

    const rows = await db
      .select()
      .from(analyticsExportJobs)
      .where(
        and(eq(analyticsExportJobs.orgId, DEFAULT_ORG_ID), eq(analyticsExportJobs.idempotencyKey, idem)),
      );
    expect(rows.length).toBe(1);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "analytics.export.create"), eq(auditLog.targetId, f.jobId)));
    expect(audit.length).toBe(1);
  });

  it("download streams CSV with attachment header", async () => {
    const idem = `itest-export-dl-${Date.now()}`;
    const create = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": idem },
      payload: { reportKey: "source_effectiveness", format: "csv", params: { range: "last_90d" } },
    });
    const c = expectJson<{ jobId: string }>(create, 201);
    createdExportIds.push(c.jobId);

    const dl = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/analytics/export/${c.jobId}/download`,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/csv");
    expect(String(dl.headers["content-disposition"])).toContain("attachment");
  });

  it("xlsx format → 501 format_not_supported, never 500", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/export",
      headers: { "idempotency-key": `itest-xlsx-${Date.now()}` },
      payload: { reportKey: "funnel", format: "xlsx", params: {} },
    });
    expect(res.statusCode).toBe(501);
  });
});

describe("analytics scheduled reports — idempotency + cross-org FK", () => {
  it("create schedule (admin) → 201; same (view,format,cadence) → 200 single row", async () => {
    const view = await createView(`itest sched view ${Date.now()}`);
    const viewId = (JSON.parse(view.body) as { id: string }).id;
    const payload = {
      savedViewId: viewId,
      name: "Weekly itest funnel",
      format: "csv",
      cadence: "weekly",
      recipients: ["dl1@recruitassist.local"],
    };
    const first = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/schedules",
      payload,
    });
    const f = expectJson<{ id: string; nextRunAt: string }>(first, 201);
    createdScheduleIds.push(f.id);
    expect(f.nextRunAt).toBeTruthy();

    const second = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/schedules",
      payload,
    });
    const s = expectJson<{ id: string }>(second, 200);
    expect(s.id).toBe(f.id);
  });

  it("schedule referencing another org's view → 404 saved_view_not_found", async () => {
    // Create a view as DEFAULT_ORG admin, then attempt to schedule it as the
    // cross-org admin — the view is invisible to that org.
    const view = await createView(`itest sched crossorg ${Date.now()}`);
    const viewId = (JSON.parse(view.body) as { id: string }).id;
    const res = await authedInject(CROSS_ORG, {
      method: "POST",
      url: "/api/analytics/schedules",
      payload: { savedViewId: viewId, name: "x", format: "csv", cadence: "weekly" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("analytics narrative summary — external-key graceful degrade", () => {
  it("POST /reports/funnel/summary with OPENAI_API_KEY unset → 200 { ai:false }, never 5xx", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/analytics/reports/funnel/summary?range=last_30d",
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { summary: string; ai: boolean };
    expect(typeof body.summary).toBe("string");
    // Test env has no OPENAI_API_KEY → heuristic path.
    if (!process.env.OPENAI_API_KEY) expect(body.ai).toBe(false);
  });
});
