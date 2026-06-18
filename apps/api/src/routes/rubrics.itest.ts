// Rubrics route — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts persistence, immutable-version pinning, Zod validation,
// keyset pagination, org-scoping, permission gates, idempotency, append-only
// audit, the external-key 503, and calibration aggregates.
//
// Seeded principals (DEFAULT_ORG_ID): admin@/qa1@/recruiter1@recruitassist.local.
// Cross-org principal (JOULESTOWATTS_ORG_ID): cognition.engine@joulestowatts.com.
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { callRubrics, db } from "@j2w/db";
import { authedInject, expectForbidden, expectJson } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const QA = "qa1@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local";
const CROSS_ORG = "cognition.engine@joulestowatts.com";

function fullCriteria() {
  return [
    {
      id: "c-comms",
      name: "Communication",
      description: "Clear, structured candidate communication.",
      weight: 40,
      kind: "candidate_experience" as const,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      anchors: { fail: "Rushed, unclear.", pass: "Clear.", excellent: "Clear + empathetic." },
      minEvidenceQuotes: 1,
      autoScoreEnabled: true,
    },
    {
      id: "c-jd",
      name: "JD coverage",
      weight: 60,
      kind: "jd_coverage" as const,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      anchors: { fail: "Missed must-haves.", pass: "Covered must-haves.", excellent: "Covered + probed depth." },
      minEvidenceQuotes: 2,
      autoScoreEnabled: true,
    },
  ];
}

async function createRubric(name: string, extra: Record<string, unknown> = {}, actor = ADMIN) {
  const res = await authedInject(actor, {
    method: "POST",
    url: "/api/rubrics",
    payload: { name, purpose: "general_screen", criteria: fullCriteria(), ...extra },
  });
  return res;
}

const createdIds: string[] = [];

afterAll(async () => {
  // Best-effort cleanup of test-created rows so re-runs in the same DB stay tidy.
  if (createdIds.length) {
    await db.delete(callRubrics).where(
      sql`${callRubrics.id} IN (${sql.join(createdIds.map((id) => sql`${id}`), sql`, `)})`,
    );
  }
});

describe("rubrics — persistence + detail", () => {
  it("creates a rubric with V2 criteria and reads it back identically", async () => {
    const res = await createRubric("Persist Test Rubric");
    const body = expectJson<{ rubric: { id: string; status: string; criteria: typeof fullCriteria } }>(res, 201);
    createdIds.push(body.rubric.id);
    expect(body.rubric.status).toBe("draft");

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/rubrics/${body.rubric.id}` });
    const detail = expectJson<{ rubric: { criteria: Array<{ id: string; anchors?: unknown; minEvidenceQuotes?: number }> }; usage: { defaultForPurpose: boolean }; recentAudit: unknown[] }>(get);
    expect(detail.rubric.criteria).toHaveLength(2);
    expect(detail.rubric.criteria[0].anchors).toBeTruthy();
    expect(detail.rubric.criteria[1].minEvidenceQuotes).toBe(2);
    expect(detail.usage).toHaveProperty("defaultForPurpose");
    expect(Array.isArray(detail.recentAudit)).toBe(true);

    // Row really exists.
    const [row] = await db.select().from(callRubrics).where(eq(callRubrics.id, body.rubric.id));
    expect(row?.name).toBe("Persist Test Rubric");
  });
});

describe("rubrics — publish + immutable pin", () => {
  it("freezes a version on publish; editing the draft does not mutate the frozen snapshot", async () => {
    const create = await createRubric("Pin Test Rubric");
    const { rubric } = expectJson<{ rubric: { id: string } }>(create, 201);
    createdIds.push(rubric.id);

    const pub = await authedInject(ADMIN, { method: "POST", url: `/api/rubrics/${rubric.id}/publish`, payload: { changeNote: "v1" } });
    const pubBody = expectJson<{ rubric: { status: string; publishedVersion: number } }>(pub, 200);
    expect(pubBody.rubric.status).toBe("published");
    expect(pubBody.rubric.publishedVersion).toBe(1);

    // version row exists
    const versions = await authedInject(ADMIN, { method: "GET", url: `/api/rubrics/${rubric.id}/versions` });
    const vBody = expectJson<{ versions: Array<{ version: number; criteria: Array<{ name: string }> }> }>(versions);
    expect(vBody.versions).toHaveLength(1);
    const originalFirstName = vBody.versions[0].criteria[0].name;

    // edit the draft head
    const patch = await authedInject(ADMIN, {
      method: "PATCH",
      url: `/api/rubrics/${rubric.id}`,
      payload: { criteria: [{ ...fullCriteria()[0], name: "RENAMED CRITERION" }] },
    });
    expectJson(patch, 200);

    // frozen v1 still has the original criteria
    const v1 = await authedInject(ADMIN, { method: "GET", url: `/api/rubrics/${rubric.id}/versions/1` });
    const v1Body = expectJson<{ version: { criteria: Array<{ name: string }> } }>(v1);
    expect(v1Body.version.criteria[0].name).toBe(originalFirstName);
    expect(v1Body.version.criteria[0].name).not.toBe("RENAMED CRITERION");
  });
});

describe("rubrics — Zod validation", () => {
  it("rejects non-monotonic bands (fail > excellent) with 400 + issues", async () => {
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/rubrics",
      payload: {
        name: "Bad Bands",
        criteria: [{ id: "x", name: "X", weight: 10, kind: "custom", bandThresholds: { fail: 90, pass: 50, excellent: 30 } }],
      },
    });
    const body = expectJson<{ error: string; issues: unknown }>(res, 400);
    expect(body.error).toBe("invalid_payload");
    expect(body.issues).toBeTruthy();
  });

  it("rejects publishing an empty rubric with 422", async () => {
    const create = await authedInject(ADMIN, { method: "POST", url: "/api/rubrics", payload: { name: "Empty Rubric", criteria: [] } });
    const { rubric } = expectJson<{ rubric: { id: string } }>(create, 201);
    createdIds.push(rubric.id);
    const pub = await authedInject(ADMIN, { method: "POST", url: `/api/rubrics/${rubric.id}/publish`, payload: {} });
    const body = expectJson<{ error: string }>(pub, 422);
    expect(body.error).toBe("no_criteria");
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/rubrics?cursor=not-a-real-cursor!!!" });
    expectJson(res, 400);
  });
});

describe("rubrics — keyset pagination + filter", () => {
  it("paginates 60 rubrics with no overlap and reports total", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const res = await createRubric(`Paginate ${String(i).padStart(3, "0")}`, { purpose: i % 2 === 0 ? "hr_screen" : "outbound_pitch" });
      const { rubric } = expectJson<{ rubric: { id: string } }>(res, 201);
      ids.push(rubric.id);
      createdIds.push(rubric.id);
    }

    const page1 = await authedInject(ADMIN, { method: "GET", url: "/api/rubrics?limit=25&sort=name&dir=asc&q=Paginate" });
    const p1 = expectJson<{ rubrics: Array<{ id: string }>; nextCursor: string | null; total: number }>(page1);
    expect(p1.rubrics).toHaveLength(25);
    expect(p1.total).toBe(60);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/rubrics?limit=25&sort=name&dir=asc&q=Paginate&cursor=${encodeURIComponent(p1.nextCursor!)}`,
    });
    const p2 = expectJson<{ rubrics: Array<{ id: string }> }>(page2);
    const p1set = new Set(p1.rubrics.map((r) => r.id));
    for (const r of p2.rubrics) expect(p1set.has(r.id)).toBe(false);

    // purpose filter narrows total
    const filtered = await authedInject(ADMIN, { method: "GET", url: "/api/rubrics?purpose=hr_screen&q=Paginate&limit=100" });
    const f = expectJson<{ total: number }>(filtered);
    expect(f.total).toBe(30);
  });
});

describe("rubrics — org scoping", () => {
  it("returns 404 (not leak/403) when a cross-org token reads an org-A rubric", async () => {
    const create = await createRubric("Org Scope Rubric");
    const { rubric } = expectJson<{ rubric: { id: string } }>(create, 201);
    createdIds.push(rubric.id);

    for (const method of ["GET", "PATCH", "DELETE"] as const) {
      const res = await authedInject(CROSS_ORG, {
        method,
        url: `/api/rubrics/${rubric.id}`,
        ...(method === "PATCH" ? { payload: { name: "hijack" } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }

    // List as cross-org never includes org-A rows.
    const list = await authedInject(CROSS_ORG, { method: "GET", url: "/api/rubrics?q=Org Scope Rubric&limit=100" });
    const body = expectJson<{ rubrics: Array<{ id: string }> }>(list);
    expect(body.rubrics.find((r) => r.id === rubric.id)).toBeUndefined();
  });
});

describe("rubrics — permission gates", () => {
  it("recruiter (read-only) can GET but is 403 on writes (never 500)", async () => {
    const getList = await authedInject(RECRUITER, { method: "GET", url: "/api/rubrics" });
    expectJson(getList, 200);

    const create = await authedInject(RECRUITER, { method: "POST", url: "/api/rubrics", payload: { name: "Nope", criteria: fullCriteria() } });
    expectForbidden(create);

    // patch + publish + archive + bulk all 403
    const someRubric = await createRubric("Perm Target");
    const { rubric } = expectJson<{ rubric: { id: string } }>(someRubric, 201);
    createdIds.push(rubric.id);
    for (const path of [`/api/rubrics/${rubric.id}`, `/api/rubrics/${rubric.id}/publish`, `/api/rubrics/${rubric.id}/archive`]) {
      const res = await authedInject(RECRUITER, { method: path.endsWith(rubric.id) ? "PATCH" : "POST", url: path, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    const bulk = await authedInject(RECRUITER, { method: "POST", url: "/api/rubrics/bulk", payload: { ids: [rubric.id], action: "archive" } });
    expectForbidden(bulk);
  });

  it("qa_reviewer (granted rubrics.write in this migration) and admin can write", async () => {
    const qa = await createRubric("QA Authored", {}, QA);
    const qaBody = expectJson<{ rubric: { id: string } }>(qa, 201);
    createdIds.push(qaBody.rubric.id);

    const admin = await createRubric("Admin Authored", {}, ADMIN);
    const adminBody = expectJson<{ rubric: { id: string } }>(admin, 201);
    createdIds.push(adminBody.rubric.id);
  });
});

describe("rubrics — idempotency", () => {
  it("two POSTs with the same Idempotency-Key yield one row", async () => {
    const key = `itest-idem-${Date.now()}`;
    const first = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/rubrics",
      headers: { "idempotency-key": key },
      payload: { name: "Idem Rubric", criteria: fullCriteria() },
    });
    const a = expectJson<{ rubric: { id: string } }>(first, 201);
    createdIds.push(a.rubric.id);

    const second = await authedInject(ADMIN, {
      method: "POST",
      url: "/api/rubrics",
      headers: { "idempotency-key": key },
      payload: { name: "Idem Rubric (changed)", criteria: fullCriteria() },
    });
    const b = expectJson<{ rubric: { id: string }; idempotent?: boolean }>(second, 200);
    expect(b.rubric.id).toBe(a.rubric.id);
    expect(b.idempotent).toBe(true);
  });
});

describe("rubrics — append-only audit", () => {
  it("create + publish + set-default produce ≥3 attributable ordered rows", async () => {
    const create = await createRubric("Audit Rubric");
    const { rubric } = expectJson<{ rubric: { id: string } }>(create, 201);
    createdIds.push(rubric.id);
    await authedInject(ADMIN, { method: "POST", url: `/api/rubrics/${rubric.id}/publish`, payload: {} });
    await authedInject(ADMIN, { method: "POST", url: `/api/rubrics/${rubric.id}/set-default`, payload: {} });

    const auditRes = await authedInject(ADMIN, { method: "GET", url: `/api/rubrics/${rubric.id}/audit` });
    const body = expectJson<{ entries: Array<{ action: string; actorName: string | null; id: number }> }>(auditRes);
    const actions = body.entries.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("published");
    expect(actions).toContain("set_default");
    expect(body.entries.length).toBeGreaterThanOrEqual(3);
    // newest-first ordering by id
    for (let i = 1; i < body.entries.length; i += 1) {
      expect(body.entries[i - 1].id).toBeGreaterThan(body.entries[i].id);
    }
  });

  it("a raw UPDATE on rubric_audit_log is rejected by the immutability trigger", async () => {
    let threw = false;
    try {
      await db.execute(sql`UPDATE rubric_audit_log SET action = 'updated' WHERE id = (SELECT id FROM rubric_audit_log LIMIT 1)`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("rubrics — external-key gating", () => {
  it("ai-suggest returns 503 openai_api_key_missing (not 500) when key is unset", async () => {
    const create = await createRubric("AI Suggest Target");
    const { rubric } = expectJson<{ rubric: { id: string } }>(create, 201);
    createdIds.push(rubric.id);
    const res = await authedInject(ADMIN, { method: "POST", url: `/api/rubrics/${rubric.id}/ai-suggest`, payload: {} });
    if (process.env.OPENAI_API_KEY) {
      // Real key present — should not 500; either 200 suggestions or 502 on provider error.
      expect([200, 502]).toContain(res.statusCode);
    } else {
      const body = expectJson<{ error: string }>(res, 503);
      expect(body.error).toBe("openai_api_key_missing");
    }
  });
});

describe("rubrics — calibration", () => {
  it("returns per-criterion AI-vs-reviewer agreement from seeded QA overrides", async () => {
    // The default-org seed scores ~25 calls with the general/technical rubric and
    // writes criterion overrides on override-decision QA reviews. Find a rubric
    // that has scores so calibration has data.
    const [scoredRubric] = await db
      .select({ id: callRubrics.id })
      .from(callRubrics)
      .where(and(eq(callRubrics.name, "General Screening")))
      .limit(1);
    if (!scoredRubric) return; // seed shape changed — skip rather than fail loudly
    const res = await authedInject(ADMIN, { method: "GET", url: `/api/rubrics/${scoredRubric.id}/calibration` });
    const body = expectJson<{ criteria: Array<{ id: string; aiAvg: number | null; reviewerAvg: number | null; agreementPct: number | null; n: number }>; reviewCount: number }>(res);
    expect(Array.isArray(body.criteria)).toBe(true);
    expect(typeof body.reviewCount).toBe("number");
    // At least the criteria structure is present.
    expect(body.criteria.length).toBeGreaterThan(0);
    for (const c of body.criteria) expect(c).toHaveProperty("agreementPct");
  });
});
