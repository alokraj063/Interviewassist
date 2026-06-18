// Triage console — backend integration tests.
//
// Drives the real Fastify app (buildServer + inject) against the disposable
// seeded DB. Asserts persistence (draft save → publish → version history),
// Zod + rule validation (400 + issues: duplicate priority / missing fallback /
// weight 0 / sla 4), cross-org scoping (404, never leak), permission gates
// (403-not-500 for a role lacking triage.write/operate; success for admin),
// external-key gating (terminate → 503 vapi_not_configured, never 500), keyset
// pagination on /sessions/active, dry-run correctness, and the append-only
// config audit (ruleset.published + session.reassigned rows).
//
// Each suite creates its own org-scoped triage flow + rules directly via @j2w/db
// so tests are self-contained and order-independent.
//
// Seeded principals (DEFAULT_ORG_ID): admin@ (all triage.*), recruiter1@ (only
// triage.read), qa1@ (only triage.read). Cross-org (JOULESTOWATTS_ORG_ID):
// cognition.engine@joulestowatts.com.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  callRoutingEvents,
  callSessions,
  db,
  DEFAULT_ORG_ID,
  JOULESTOWATTS_ORG_ID,
  teams,
  triageAuditEvents,
  triageRoutingRules,
  triageRuleSets,
  voiceAgents,
} from "@j2w/db";
import { authedInject, expectForbidden, expectJson, tokenFor } from "../test/harness.js";

const ADMIN = "admin@recruitassist.local";
const RECRUITER = "recruiter1@recruitassist.local"; // role recruiter → triage.read only
const QA = "qa1@recruitassist.local"; // role qa_reviewer → triage.read only
const CROSS_ORG = "cognition.engine@joulestowatts.com";

const createdFlowIds: string[] = [];
const createdTeamIds: string[] = [];
const createdCallIds: string[] = [];

// Create a triage flow + a routing team in the given org. Returns ids.
async function makeFlow(orgId: string): Promise<{ flowId: string; teamId: string }> {
  const [team] = await db
    .insert(teams)
    .values({ orgId, name: `Triage itest team ${randomUUID().slice(0, 8)}` })
    .returning({ id: teams.id });
  const [flow] = await db
    .insert(voiceAgents)
    .values({
      orgId,
      name: `Triage itest flow ${randomUUID().slice(0, 8)}`,
      kind: "triage",
      status: "active",
      purpose: "itest",
      routing: { intentVocabulary: ["billing", "support"] },
    })
    .returning({ id: voiceAgents.id });
  createdFlowIds.push(flow.id);
  createdTeamIds.push(team.id);
  return { flowId: flow.id, teamId: team.id };
}

// A valid 2-rule draft payload (one intent rule + one '*' fallback).
function validRules(teamId: string) {
  return {
    rules: [
      {
        priority: 1,
        intent: "billing",
        destinationType: "human_team" as const,
        destinationRef: teamId,
        destinationLabel: "Billing Pod",
        handoffMode: "warm" as const,
        enabled: true,
        slaTargetSec: 60,
        routingStrategy: "round_robin" as const,
        weight: 2,
      },
      {
        priority: 99,
        intent: "*",
        destinationType: "voicemail" as const,
        destinationRef: "voicemail",
        destinationLabel: "Voicemail",
        handoffMode: "voicemail" as const,
        enabled: true,
        routingStrategy: "first_idle" as const,
        weight: 1,
      },
    ],
  };
}

afterAll(async () => {
  if (createdCallIds.length) {
    await db.delete(callRoutingEvents).where(inArray(callRoutingEvents.callId, createdCallIds));
    await db.delete(callSessions).where(inArray(callSessions.id, createdCallIds));
  }
  if (createdFlowIds.length) {
    await db.delete(triageAuditEvents).where(inArray(triageAuditEvents.triageAgentId, createdFlowIds));
    await db.delete(triageRoutingRules).where(inArray(triageRoutingRules.triageAgentId, createdFlowIds));
    await db.delete(triageRuleSets).where(inArray(triageRuleSets.triageAgentId, createdFlowIds));
    await db.delete(voiceAgents).where(inArray(voiceAgents.id, createdFlowIds));
  }
  if (createdTeamIds.length) {
    await db.delete(teams).where(inArray(teams.id, createdTeamIds));
  }
});

describe("triage: draft save + publish + version history persistence", () => {
  it("saves a draft, publishes it, and lists the published version", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);

    const save = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    const saved = expectJson<{ rules: unknown[]; draftDirty: boolean }>(save, 200);
    expect(saved.rules).toHaveLength(2);
    expect(saved.draftDirty).toBe(true);

    const pub = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "v1" },
    });
    const published = expectJson<{ ruleSet: { version: number; status: string } }>(pub, 200);
    expect(published.ruleSet.version).toBe(1);
    expect(published.ruleSet.status).toBe("published");

    const list = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/triage/flows/${flowId}/rule-sets`,
    });
    const { ruleSets } = expectJson<{ ruleSets: Array<{ version: number; status: string }> }>(list, 200);
    expect(ruleSets[0].version).toBe(1);
    expect(ruleSets[0].status).toBe("published");

    // Rules round-trip with SLA / strategy / weight.
    const rules = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/triage/flows/${flowId}/routing-rules`,
    });
    const body = expectJson<{ rules: Array<{ intent: string; slaTargetSec: number | null; routingStrategy: string; weight: number }> }>(rules, 200);
    const billing = body.rules.find((r) => r.intent === "billing")!;
    expect(billing.slaTargetSec).toBe(60);
    expect(billing.routingStrategy).toBe("round_robin");
    expect(billing.weight).toBe(2);
  });
});

describe("triage: rule validation (400 + issues)", () => {
  it("rejects duplicate priorities", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const p = validRules(teamId);
    p.rules[1].priority = 1; // collide with rule[0]
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p,
    });
    const body = expectJson<{ error: string; issues: string[] }>(res, 400);
    expect(body.error).toBe("invalid_rules");
    expect(body.issues.some((i) => i.startsWith("duplicate_priority"))).toBe(true);
  });

  it("rejects a missing '*' fallback", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const p = validRules(teamId);
    p.rules = [p.rules[0]]; // drop the fallback
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p,
    });
    const body = expectJson<{ error: string; issues: string[] }>(res, 400);
    expect(body.issues.some((i) => i.startsWith("missing_fallback"))).toBe(true);
  });

  it("rejects weight 0 via Zod (min 1)", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const p = validRules(teamId);
    (p.rules[0] as { weight: number }).weight = 0;
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects sla 4 via Zod (min 5)", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const p = validRules(teamId);
    (p.rules[0] as { slaTargetSec: number }).slaTargetSec = 4;
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unresolved team destination", async () => {
    const { flowId } = await makeFlow(DEFAULT_ORG_ID);
    const p = validRules(randomUUID()); // bogus team ref
    const res = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p,
    });
    const body = expectJson<{ issues: string[] }>(res, 400);
    expect(body.issues.some((i) => i.startsWith("unresolved_team_destination"))).toBe(true);
  });
});

describe("triage: cross-org scoping", () => {
  it("a cross-org token sees 404 (not a leak) for another org's flow", async () => {
    const { flowId } = await makeFlow(DEFAULT_ORG_ID);
    const res = await authedInject(CROSS_ORG, {
      method: "GET",
      url: `/api/triage/flows/${flowId}/routing-rules`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("a cross-org token cannot publish another org's flow", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    const res = await authedInject(CROSS_ORG, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "leak attempt" },
    });
    // cross-org admin HAS triage.write in its own org but the flow is foreign → 404
    expect(res.statusCode).toBe(404);
  });
});

describe("triage: GET /flows with triage call_sessions", () => {
  // Regression: the lastActivity aggregate (max(started_at)) comes back as a
  // string from the driver, and rowToFlow previously called .toISOString() on
  // it directly → 500. Seeded orgs always have triage call_sessions, so this is
  // the steady state, not an edge case.
  it("returns 200 and a normalized lastActivityAt when the flow has call_sessions", async () => {
    const { flowId } = await makeFlow(DEFAULT_ORG_ID);
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flowId,
      status: "ended",
      origin: "vapi",
      startedAt: new Date(),
    });
    createdCallIds.push(callId);

    const res = await authedInject(ADMIN, { method: "GET", url: `/api/triage/flows` });
    expect(res.statusCode).toBe(200);
    const body = expectJson(res) as { flows: Array<{ id: string; lastActivityAt: string | null }> };
    const flow = body.flows.find((f) => f.id === flowId);
    expect(flow).toBeTruthy();
    // lastActivityAt must be a valid ISO string, not a crash and not garbage.
    expect(flow!.lastActivityAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(flow!.lastActivityAt!))).toBe(false);
  });
});

describe("triage: permission gates", () => {
  it("recruiter1@ (no triage.write) → 403 on PUT, admin → success", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const denied = await authedInject(RECRUITER, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    expectForbidden(denied);

    const ok = await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    expect(ok.statusCode).toBe(200);
  });

  it("qa1@ (triage.read) → 200 on read, 403 on operate (reassign)", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    const read = await authedInject(QA, {
      method: "GET",
      url: `/api/triage/flows/${flowId}/routing-rules`,
    });
    expect(read.statusCode).toBe(200);

    // Build a live call to reassign.
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flowId,
      status: "active",
      origin: "vapi",
    });
    createdCallIds.push(callId);

    const denied = await authedInject(QA, {
      method: "POST",
      url: `/api/triage/sessions/${callId}/reassign`,
      payload: { destinationType: "human_team", destinationRef: teamId },
    });
    expectForbidden(denied);
  });
});

describe("triage: external-key gating (terminate)", () => {
  it("terminate → 503 vapi_not_configured (never 500) when Vapi unset", async () => {
    const { flowId } = await makeFlow(DEFAULT_ORG_ID);
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flowId,
      status: "active",
      origin: "vapi",
    });
    createdCallIds.push(callId);

    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/sessions/${callId}/terminate`,
      payload: { reason: "stuck" },
    });
    // When VAPI_API_KEY is unset in the test env, expect the precise 503.
    if (!process.env.VAPI_API_KEY) {
      const body = expectJson<{ error: string }>(res, 503);
      expect(body.error).toBe("vapi_not_configured");
    } else {
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("triage: audit rows", () => {
  it("records ruleset.published after publish and session.reassigned after reassign", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "audit-check" },
    });

    const pubAudit = await db
      .select()
      .from(triageAuditEvents)
      .where(and(eq(triageAuditEvents.triageAgentId, flowId), eq(triageAuditEvents.action, "ruleset.published")));
    expect(pubAudit.length).toBeGreaterThanOrEqual(1);

    // Reassign a live call.
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flowId,
      status: "active",
      origin: "vapi",
    });
    createdCallIds.push(callId);
    const reassign = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/sessions/${callId}/reassign`,
      payload: { destinationType: "human_team", destinationRef: teamId, reason: "manual move" },
    });
    expect(reassign.statusCode).toBe(200);

    const reAudit = await db
      .select()
      .from(triageAuditEvents)
      .where(
        and(
          eq(triageAuditEvents.targetId, callId),
          eq(triageAuditEvents.action, "session.reassigned"),
        ),
      );
    expect(reAudit.length).toBe(1);
    expect(reAudit[0].actorUserId).toBeTruthy();
  });

  it("audit endpoint returns the config timeline keyset-paginated", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    const res = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/triage/audit?flowId=${flowId}&limit=10`,
    });
    const body = expectJson<{ events: Array<{ action: string }>; nextCursor: number | null }>(res, 200);
    expect(body.events.some((e) => e.action === "ruleset.saved_draft")).toBe(true);
  });
});

describe("triage: dry-run correctness", () => {
  it("reports exactly 1 'would route differently' when a candidate re-routes one call", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);

    // Publish a baseline that routes 'billing' to the team.
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "baseline" },
    });

    // Seed 1 historical 'billing' classification for this flow.
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flowId,
      status: "ended",
      origin: "vapi",
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(Date.now() - 3500_000),
    });
    createdCallIds.push(callId);
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: 0,
      kind: "classified",
      classification: { intent: "billing", confidence: 0.9 },
      createdAt: new Date(Date.now() - 3500_000),
    });

    // Candidate rules route 'billing' to VOICEMAIL instead → differs from baseline.
    const candidate = {
      windowDays: 1,
      sampleLimit: 100,
      rules: [
        {
          priority: 1,
          intent: "billing",
          destinationType: "voicemail" as const,
          destinationRef: "voicemail",
          destinationLabel: "Voicemail",
          handoffMode: "voicemail" as const,
          enabled: true,
          routingStrategy: "first_idle" as const,
          weight: 1,
        },
        {
          priority: 99,
          intent: "*",
          destinationType: "voicemail" as const,
          destinationRef: "voicemail",
          destinationLabel: "Voicemail",
          handoffMode: "voicemail" as const,
          enabled: true,
          routingStrategy: "first_idle" as const,
          weight: 1,
        },
      ],
    };
    const res = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/dry-run`,
      payload: candidate,
    });
    const body = expectJson<{ evaluated: number; matched: number; wouldRouteDifferently: number }>(res, 200);
    expect(body.evaluated).toBeGreaterThanOrEqual(1);
    expect(body.matched).toBeGreaterThanOrEqual(1);
    expect(body.wouldRouteDifferently).toBe(1);
  });
});

describe("triage: keyset pagination on /sessions/active", () => {
  it("returns nextCursor and a non-overlapping next page", async () => {
    const { flowId } = await makeFlow(DEFAULT_ORG_ID);
    // 3 recent live sessions with classifications.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const callId = randomUUID();
      ids.push(callId);
      createdCallIds.push(callId);
      await db.insert(callSessions).values({
        id: callId,
        orgId: DEFAULT_ORG_ID,
        voiceAgentId: flowId,
        candidateRefOrPhone: `+9190000000${i}`,
        status: "active",
        origin: "vapi",
        startedAt: new Date(Date.now() - (i + 1) * 60_000),
      });
      await db.insert(callRoutingEvents).values({
        callId,
        orgId: DEFAULT_ORG_ID,
        seq: 0,
        kind: "classified",
        classification: { intent: "billing", confidence: 0.8 },
        createdAt: new Date(Date.now() - (i + 1) * 60_000),
      });
    }

    const page1 = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/triage/sessions/active?flowId=${flowId}&limit=2`,
    });
    const b1 = expectJson<{ sessions: Array<{ callId: string }>; nextCursor: string | null; total: number }>(page1, 200);
    expect(b1.sessions.length).toBe(2);
    expect(b1.nextCursor).toBeTruthy();

    const page2 = await authedInject(ADMIN, {
      method: "GET",
      url: `/api/triage/sessions/active?flowId=${flowId}&limit=2&cursor=${encodeURIComponent(b1.nextCursor!)}`,
    });
    const b2 = expectJson<{ sessions: Array<{ callId: string }> }>(page2, 200);
    const page1Ids = new Set(b1.sessions.map((s) => s.callId));
    for (const s of b2.sessions) expect(page1Ids.has(s.callId)).toBe(false);
  });
});

describe("triage: rollback", () => {
  it("clones an older snapshot into a new published version", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    const pub1 = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "v1" },
    });
    const v1 = expectJson<{ ruleSet: { id: string; version: number } }>(pub1, 200);

    // publish a v2 (drop the billing rule, keep fallback only is invalid; add a rule)
    const p2 = validRules(teamId);
    p2.rules[0].destinationLabel = "Billing Pod v2";
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: p2,
    });
    await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      payload: { note: "v2" },
    });

    const rb = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/${v1.ruleSet.id}/rollback`,
      payload: {},
    });
    const body = expectJson<{ ruleSet: { version: number; status: string } }>(rb, 200);
    expect(body.ruleSet.version).toBe(3); // new published version
    expect(body.ruleSet.status).toBe("published");

    const rbAudit = await db
      .select()
      .from(triageAuditEvents)
      .where(and(eq(triageAuditEvents.triageAgentId, flowId), eq(triageAuditEvents.action, "ruleset.rolled_back")));
    expect(rbAudit.length).toBe(1);
  });
});

describe("triage: idempotency", () => {
  it("a repeated publish with the same Idempotency-Key returns the cached result", async () => {
    const { flowId, teamId } = await makeFlow(DEFAULT_ORG_ID);
    await authedInject(ADMIN, {
      method: "PUT",
      url: `/api/triage/flows/${flowId}/routing-rules`,
      payload: validRules(teamId),
    });
    const key = `itest-${randomUUID()}`;
    const first = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      headers: { "idempotency-key": key },
      payload: { note: "once" },
    });
    const a = expectJson<{ ruleSet: { id: string; version: number } }>(first, 200);
    const second = await authedInject(ADMIN, {
      method: "POST",
      url: `/api/triage/flows/${flowId}/rule-sets/publish`,
      headers: { "idempotency-key": key },
      payload: { note: "once" },
    });
    const b = expectJson<{ ruleSet: { id: string; version: number } }>(second, 200);
    expect(b.ruleSet.id).toBe(a.ruleSet.id);
    expect(b.ruleSet.version).toBe(a.ruleSet.version);

    // Only one published version should exist (no duplicate insert).
    const sets = await db
      .select()
      .from(triageRuleSets)
      .where(and(eq(triageRuleSets.triageAgentId, flowId), eq(triageRuleSets.status, "published")));
    expect(sets.length).toBe(1);
  });
});
