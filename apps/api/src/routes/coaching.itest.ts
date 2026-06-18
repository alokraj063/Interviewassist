// Coaching — AI-roleplay scenario authoring, real per-criterion scoring,
// curricula/assignments, append-only audit. Backend itests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts: scenario persistence (full builder payload incl.
// objections/successCriteria/persona), Zod 400 (missing title / bad difficulty
// / estimatedMinutes out of range), cross-org 404 (org-scoped WHERE), run
// not-your-run 403, permission gates (recruiter has coaching.run → 201 on
// /runs but lacks coaching.write → 403 on /scenarios; coaching.assign /
// coaching.manage enforced), idempotency (same Idempotency-Key → same id, no
// dup), external-key gating (/runs/:id/ai-call → 503 vapi_public_key_missing
// not 500; /runs/:id/score with no OPENAI_API_KEY → 200 stub-scored), audit
// rows on publish/assign/score, keyset pagination (disjoint pages, accurate
// total).
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (full coaching.*), recruiter1@ +
// recruiter2@ (coaching.read + coaching.run only — NO write/assign/manage/
// read.all), qa1@ (read + run + read.all + manage, NOT write/assign). Cross-org
// (JoulesToWatts): cognition.engine@joulestowatts.com (admin).
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  coachingAssignments,
  coachingAuditEvents,
  coachingRuns,
  coachingScenarios,
  db,
  DEFAULT_ORG_ID,
  users,
} from "@j2w/db";
import { authedInject, expectJson } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local"; // coaching.read + coaching.run
const RECRUITER2 = "recruiter2@recruitassist.local"; // ditto; for cross-recruiter 403
const QA = "qa1@recruitassist.local"; // read.all + manage, NOT write/assign
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const createdScenarioIds: string[] = [];
const createdRunIds: string[] = [];
const createdAssignmentIds: string[] = [];

afterAll(async () => {
  if (createdRunIds.length) {
    await db.delete(coachingAuditEvents).where(inArray(coachingAuditEvents.runId, createdRunIds));
    await db.delete(coachingRuns).where(inArray(coachingRuns.id, createdRunIds));
  }
  if (createdAssignmentIds.length) {
    await db.delete(coachingAuditEvents).where(inArray(coachingAuditEvents.assignmentId, createdAssignmentIds));
    await db.delete(coachingAssignments).where(inArray(coachingAssignments.id, createdAssignmentIds));
  }
  if (createdScenarioIds.length) {
    await db.delete(coachingAuditEvents).where(inArray(coachingAuditEvents.scenarioId, createdScenarioIds));
    await db.delete(coachingScenarios).where(inArray(coachingScenarios.id, createdScenarioIds));
  }
});

const validScenario = (over: Record<string, unknown> = {}) => ({
  title: `ITest scenario ${Math.random().toString(36).slice(2, 8)}`,
  description: "An itest scenario.",
  difficulty: "hard",
  language: "hinglish",
  openingLine: "Haan ji, boliye.",
  candidatePersona: { candidateName: "Test Candidate", resistance: "high", hiddenContext: "secret" },
  objections: ["I won't move for less than 50 LPA.", "Counter-offer pending."],
  successCriteria: [
    { id: "sc-1", label: "Builds rapport", weight: 1 },
    { id: "sc-2", label: "Closes next step", weight: 2 },
  ],
  estimatedMinutes: 10,
  tags: ["negotiation"],
  isPublished: false,
  ...over,
});

async function createScenario(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/scenarios", payload: validScenario(over), headers });
  return res;
}

describe("coaching scenarios", () => {
  it("persists the full builder payload (201) and reads it back", async () => {
    const res = await createScenario({ isPublished: true });
    const body = expectJson<{ scenario: { id: string; objections: string[]; successCriteria: unknown[]; candidatePersona: { candidateName: string }; publishedVersion: number } }>(res, 201);
    createdScenarioIds.push(body.scenario.id);
    expect(body.scenario.objections).toHaveLength(2);
    expect(body.scenario.successCriteria).toHaveLength(2);
    expect(body.scenario.candidatePersona.candidateName).toBe("Test Candidate");
    expect(body.scenario.publishedVersion).toBe(1);

    const get = await authedInject(ADMIN, { method: "GET", url: `/api/coaching/scenarios/${body.scenario.id}` });
    const g = expectJson<{ scenario: { objections: string[] }; auditEvents: { action: string }[] }>(get);
    expect(g.scenario.objections).toEqual(["I won't move for less than 50 LPA.", "Counter-offer pending."]);
    // created + published audit rows exist
    const actions = g.auditEvents.map((e) => e.action);
    expect(actions).toContain("scenario.created");
    expect(actions).toContain("scenario.published");
  });

  it("rejects bad payloads with 400 + issues (Zod)", async () => {
    const missingTitle = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/scenarios", payload: { ...validScenario(), title: "" } });
    expect(missingTitle.statusCode).toBe(400);
    const badDifficulty = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/scenarios", payload: { ...validScenario(), difficulty: "impossible" } });
    expect(badDifficulty.statusCode).toBe(400);
    const badMinutes = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/scenarios", payload: { ...validScenario(), estimatedMinutes: 999 } });
    expect(badMinutes.statusCode).toBe(400);
    const b = JSON.parse(badMinutes.payload);
    expect(b.error).toBe("invalid_payload");
    expect(b.issues).toBeTruthy();
  });

  it("gates create on coaching.write (recruiter 403, admin success)", async () => {
    const forbidden = await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/scenarios", payload: validScenario() });
    expect(forbidden.statusCode).toBe(403);
  });

  it("is org-scoped: cross-org token cannot read/patch/archive a scenario (404)", async () => {
    const res = await createScenario();
    const id = expectJson<{ scenario: { id: string } }>(res, 201).scenario.id;
    createdScenarioIds.push(id);
    const get = await authedInject(CROSS_ORG, { method: "GET", url: `/api/coaching/scenarios/${id}` });
    expect(get.statusCode).toBe(404);
    const patch = await authedInject(CROSS_ORG, { method: "PATCH", url: `/api/coaching/scenarios/${id}`, payload: { title: "hijack" } });
    expect(patch.statusCode).toBe(404);
    const archive = await authedInject(CROSS_ORG, { method: "POST", url: `/api/coaching/scenarios/${id}/archive` });
    expect(archive.statusCode).toBe(404);
  });

  it("publish via PATCH writes a scenario.published audit row", async () => {
    const id = expectJson<{ scenario: { id: string } }>(await createScenario({ isPublished: false }), 201).scenario.id;
    createdScenarioIds.push(id);
    const patch = await authedInject(ADMIN, { method: "PATCH", url: `/api/coaching/scenarios/${id}`, payload: { isPublished: true } });
    const pb = expectJson<{ scenario: { isPublished: boolean; publishedVersion: number } }>(patch);
    expect(pb.scenario.isPublished).toBe(true);
    const rows = await db.select().from(coachingAuditEvents).where(and(eq(coachingAuditEvents.scenarioId, id), eq(coachingAuditEvents.action, "scenario.published")));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("keyset paginates with accurate total and disjoint pages", async () => {
    // Create 3 scenarios with a unique tag so the filter isolates them.
    const tag = `itp-${Math.random().toString(36).slice(2, 7)}`;
    for (let i = 0; i < 3; i++) {
      const id = expectJson<{ scenario: { id: string } }>(await createScenario({ tags: [tag] }), 201).scenario.id;
      createdScenarioIds.push(id);
    }
    const page1 = expectJson<{ scenarios: { id: string }[]; nextCursor: string | null; total: number }>(
      await authedInject(ADMIN, { method: "GET", url: `/api/coaching/scenarios?tag=${tag}&limit=2` }),
    );
    expect(page1.total).toBe(3);
    expect(page1.scenarios).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = expectJson<{ scenarios: { id: string }[]; nextCursor: string | null }>(
      await authedInject(ADMIN, { method: "GET", url: `/api/coaching/scenarios?tag=${tag}&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}` }),
    );
    expect(page2.scenarios).toHaveLength(1);
    const ids1 = new Set(page1.scenarios.map((s) => s.id));
    expect(page2.scenarios.every((s) => !ids1.has(s.id))).toBe(true);
  });

  it("rejects limit > 100 (Zod)", async () => {
    const res = await authedInject(ADMIN, { method: "GET", url: "/api/coaching/scenarios?limit=500" });
    expect(res.statusCode).toBe(400);
  });
});

describe("coaching runs", () => {
  let scenarioId: string;

  it("recruiter (coaching.run) can start a run → 201", async () => {
    scenarioId = expectJson<{ scenario: { id: string } }>(await createScenario({ isPublished: true }), 201).scenario.id;
    createdScenarioIds.push(scenarioId);
    const res = await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } });
    const body = expectJson<{ run: { id: string; status: string } }>(res, 201);
    createdRunIds.push(body.run.id);
    expect(body.run.status).toBe("started");
    // run.started audit
    const audit = await db.select().from(coachingAuditEvents).where(and(eq(coachingAuditEvents.runId, body.run.id), eq(coachingAuditEvents.action, "run.started")));
    expect(audit.length).toBe(1);
  });

  it("is idempotent on Idempotency-Key (same run id, no dup)", async () => {
    const key = `itest-${Math.random().toString(36).slice(2)}`;
    const r1 = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId }, headers: { "idempotency-key": key } }), 201);
    createdRunIds.push(r1.run.id);
    const r2res = await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId }, headers: { "idempotency-key": key } });
    expect(r2res.statusCode).toBe(200);
    const r2 = JSON.parse(r2res.payload);
    expect(r2.run.id).toBe(r1.run.id);
    expect(r2.idempotent).toBe(true);
    const count = await db.select().from(coachingRuns).where(eq(coachingRuns.idempotencyKey, key));
    expect(count.length).toBe(1);
  });

  it("another recruiter cannot read someone else's run (403 not_your_run)", async () => {
    const own = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } }), 201);
    createdRunIds.push(own.run.id);
    const res = await authedInject(RECRUITER2, { method: "GET", url: `/api/coaching/runs/${own.run.id}` });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toBe("not_your_run");
    // QA has read.all → 200
    const qa = await authedInject(QA, { method: "GET", url: `/api/coaching/runs/${own.run.id}` });
    expect(qa.statusCode).toBe(200);
  });

  it("completing a run scores it via the stub (200, scored, generatedBy=stub) — never 500", async () => {
    const run = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } }), 201).run;
    createdRunIds.push(run.id);
    const patch = await authedInject(RECRUITER, { method: "PATCH", url: `/api/coaching/runs/${run.id}`, payload: { status: "completed" } });
    expect(patch.statusCode).toBe(200);
    // poll the run; in-process scoring ran synchronously on complete
    const got = expectJson<{ run: { scoringStatus: string; cachedOverallScore: string | null }; scores: { criterionId: string }[]; run2?: unknown }>(
      await authedInject(RECRUITER, { method: "GET", url: `/api/coaching/runs/${run.id}` }),
    );
    expect(got.run.scoringStatus).toBe("scored");
    expect(got.scores.length).toBeGreaterThan(0);
    // run.scored audit row written
    const audit = await db.select().from(coachingAuditEvents).where(and(eq(coachingAuditEvents.runId, run.id), eq(coachingAuditEvents.action, "run.scored")));
    expect(audit.length).toBeGreaterThan(0);
  });

  it("/runs/:id/score returns 200 + stub feedback when OPENAI_API_KEY unset (never 500)", async () => {
    const run = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } }), 201).run;
    createdRunIds.push(run.id);
    const res = await authedInject(RECRUITER, { method: "POST", url: `/api/coaching/runs/${run.id}/score` });
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.payload);
    expect(b.scoringStatus).toBe("scored");
    expect(b.generatedBy).toBe("stub");
  });

  it("/runs/:id/ai-call returns 503 vapi_public_key_missing (not 500) when unset", async () => {
    const run = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } }), 201).run;
    createdRunIds.push(run.id);
    const res = await authedInject(RECRUITER, { method: "POST", url: `/api/coaching/runs/${run.id}/ai-call` });
    // 503 when no VAPI public key, OR 200 if a key happens to be configured in env.
    expect([503, 200]).toContain(res.statusCode);
    if (res.statusCode === 503) {
      expect(JSON.parse(res.payload).error).toBe("vapi_public_key_missing");
    }
  });

  it("manager score override requires coaching.manage; recruiter 403", async () => {
    // Score a fresh run first so a criterion row exists.
    const run = expectJson<{ run: { id: string } }>(await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/runs", payload: { scenarioId } }), 201).run;
    createdRunIds.push(run.id);
    await authedInject(RECRUITER, { method: "POST", url: `/api/coaching/runs/${run.id}/score` });
    const detail = expectJson<{ scores: { criterionId: string }[] }>(await authedInject(QA, { method: "GET", url: `/api/coaching/runs/${run.id}` }));
    const critId = detail.scores[0]?.criterionId;
    expect(critId).toBeTruthy();
    // recruiter lacks coaching.manage → 403
    const recForbidden = await authedInject(RECRUITER, { method: "PATCH", url: `/api/coaching/runs/${run.id}/scores/${critId}`, payload: { score: 90, justification: "good" } });
    expect(recForbidden.statusCode).toBe(403);
    // qa has coaching.manage → 200, override persists + audit
    const ok = await authedInject(QA, { method: "PATCH", url: `/api/coaching/runs/${run.id}/scores/${critId}`, payload: { score: 12, justification: "harsh recount" } });
    expect(ok.statusCode).toBe(200);
    const audit = await db.select().from(coachingAuditEvents).where(and(eq(coachingAuditEvents.runId, run.id), eq(coachingAuditEvents.action, "run.score_overridden")));
    expect(audit.length).toBe(1);
  });
});

describe("coaching assignments", () => {
  let scenarioId: string;

  it("assign requires coaching.assign (recruiter 403, admin success + per-assignee rows + audit)", async () => {
    scenarioId = expectJson<{ scenario: { id: string } }>(await createScenario({ isPublished: true }), 201).scenario.id;
    createdScenarioIds.push(scenarioId);

    // resolve two recruiter user ids from the seed
    const [r1] = await db.select().from(users).where(eq(users.email, RECRUITER)).limit(1);
    const [r2] = await db.select().from(users).where(eq(users.email, RECRUITER2)).limit(1);

    const forbidden = await authedInject(RECRUITER, { method: "POST", url: "/api/coaching/assignments", payload: { scenarioId, assigneeUserIds: [r1.id] } });
    expect(forbidden.statusCode).toBe(403);

    const res = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/assignments", payload: { scenarioId, assigneeUserIds: [r1.id, r2.id], dueAt: new Date(Date.now() + 86400_000).toISOString() } });
    const body = expectJson<{ assignments: { id: string }[] }>(res, 201);
    expect(body.assignments).toHaveLength(2);
    for (const a of body.assignments) createdAssignmentIds.push(a.id);
    const audit = await db.select().from(coachingAuditEvents).where(inArray(coachingAuditEvents.assignmentId, body.assignments.map((a) => a.id)));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent on Idempotency-Key (no duplicate rows)", async () => {
    const [r1] = await db.select().from(users).where(eq(users.email, RECRUITER)).limit(1);
    const key = `assign-${Math.random().toString(36).slice(2)}`;
    const first = expectJson<{ assignments: { id: string }[] }>(
      await authedInject(ADMIN, { method: "POST", url: "/api/coaching/assignments", payload: { scenarioId, assigneeUserIds: [r1.id] }, headers: { "idempotency-key": key } }),
      201,
    );
    for (const a of first.assignments) createdAssignmentIds.push(a.id);
    const secondRes = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/assignments", payload: { scenarioId, assigneeUserIds: [r1.id] }, headers: { "idempotency-key": key } });
    expect(secondRes.statusCode).toBe(200);
    expect(JSON.parse(secondRes.payload).idempotent).toBe(true);
    const rows = await db.select().from(coachingAssignments).where(eq(coachingAssignments.idempotencyKey, key));
    expect(rows.length).toBe(1);
  });

  it("rejects an assignment with neither scenarioId nor curriculumId (Zod 400)", async () => {
    const res = await authedInject(ADMIN, { method: "POST", url: "/api/coaching/assignments", payload: { assigneeUserIds: ["00000000-0000-0000-0000-000000000001"] } });
    expect(res.statusCode).toBe(400);
  });
});

describe("coaching progress + team summary", () => {
  it("progress for self works for a recruiter; other-user requires read.all (403)", async () => {
    const mine = await authedInject(RECRUITER, { method: "GET", url: "/api/coaching/progress" });
    expect(mine.statusCode).toBe(200);
    const [r2] = await db.select().from(users).where(eq(users.email, RECRUITER2)).limit(1);
    const other = await authedInject(RECRUITER, { method: "GET", url: `/api/coaching/progress?userId=${r2.id}` });
    expect(other.statusCode).toBe(403);
    // admin (read.all) can view another user
    const adminView = await authedInject(ADMIN, { method: "GET", url: `/api/coaching/progress?userId=${r2.id}` });
    expect(adminView.statusCode).toBe(200);
  });

  it("team-summary requires coaching.read.all (recruiter 403, admin 200)", async () => {
    const forbidden = await authedInject(RECRUITER, { method: "GET", url: "/api/coaching/team-summary" });
    expect(forbidden.statusCode).toBe(403);
    const ok = await authedInject(ADMIN, { method: "GET", url: "/api/coaching/team-summary" });
    const body = expectJson<{ team: unknown[] }>(ok);
    expect(Array.isArray(body.team)).toBe(true);
  });
});

describe("coaching seed visibility (DEFAULT_ORG_ID)", () => {
  it("the e2e/itest admin sees seeded scenarios + runs", async () => {
    const scen = expectJson<{ scenarios: unknown[]; total: number }>(await authedInject(ADMIN, { method: "GET", url: "/api/coaching/scenarios?limit=50" }));
    expect(scen.total ?? scen.scenarios.length).toBeGreaterThan(0);
    const runs = expectJson<{ runs: unknown[] }>(await authedInject(ADMIN, { method: "GET", url: "/api/coaching/runs?scope=all&limit=50" }));
    expect(runs.runs.length).toBeGreaterThan(0);
    // seeded scenarios live in DEFAULT_ORG
    const dbCount = await db.select().from(coachingScenarios).where(eq(coachingScenarios.orgId, DEFAULT_ORG_ID));
    expect(dbCount.length).toBeGreaterThan(0);
  });
});
