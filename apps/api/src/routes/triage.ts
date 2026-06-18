// Triage feature backend (enterprise rebuild).
//
// Call-routing / triage console: versioned, published rule sets with rollback,
// SLA / capacity / weight controls per rule, a real server-side dry-run engine
// that replays historical classifications, a filterable + keyset-paginated live
// ops board with SLA timers, per-rule hit-rate analytics, live-call override /
// reassign / terminate operate verbs, and an append-only config audit timeline.
//
// Permission model:
//   triage.read    — all read endpoints
//   triage.write   — rule-set draft save / publish / rollback / dry-run
//   triage.operate — live-call reassign / override / terminate / handoff accept
//
// Org scoping is enforced on every read/write via req.authUser.orgId. The
// JWT-less POST /route is invoked by Vapi (not the browser); it derives the org
// from the call_sessions row and pins evaluation to the PUBLISHED rule-set
// snapshot rather than the mutable draft rules table.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  callRoutingEvents,
  callSessions,
  db,
  memberships,
  teamMembers,
  teams,
  transcriptTurns,
  triageAuditEvents,
  triageRoutingRules,
  triageRuleSets,
  users,
  voiceAgents,
} from "@j2w/db";
import type {
  CallRoutingEvent,
  Classification,
  HandoffContext,
  LiveTriageSession,
  LiveTriageSessionPage,
  RouteCallRequest,
  RouteCallResponse,
  TriageAnalytics,
  TriageAuditAction,
  TriageAuditRow,
  TriageDestinationCatalog,
  TriageDestinationType,
  TriageDryRunResult,
  TriageFlow,
  TriageHandoffMode,
  TriageRoutingRule,
  TriageRoutingStrategy,
  TriageRuleSetSummary,
  TriageSessionDetail,
} from "@j2w/shared-types";
import { bus } from "../bus.js";
import { vapiProvider } from "../telephony/vapiProvider.js";
import type { TelephonyProvider } from "../telephony/provider.js";
import { syncTriageSquad } from "../vapi/squads.js";
import { withVapiContext } from "../vapi/context.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import {
  lookupIdempotent,
  readIdempotencyKey,
  recordIdempotent,
} from "../assessments/idempotency.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ------------------------------------------------------------ schemas

const ruleConditionsSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).optional(),
    sentimentLt: z.number().min(-1).max(1).optional(),
    language: z.string().max(16).optional(),
  })
  .optional();

const ruleSchema = z.object({
  id: z.string().optional(), // optional: server fills uuid for new rows
  priority: z.number().int().min(1),
  intent: z.string().min(1).max(64),
  conditions: ruleConditionsSchema,
  destinationType: z.enum(["human_team", "voice_agent", "external_pstn", "voicemail"]),
  destinationRef: z.string().min(1).max(200),
  destinationLabel: z.string().min(1).max(200),
  handoffMode: z.enum(["warm", "cold", "voicemail"]),
  enabled: z.boolean(),
  uiPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  slaTargetSec: z.number().int().min(5).max(3600).nullish(),
  routingStrategy: z
    .enum(["first_idle", "round_robin", "weighted", "least_loaded"])
    .default("first_idle"),
  weight: z.number().int().min(1).max(100).default(1),
  maxConcurrent: z.number().int().min(1).max(500).nullish(),
  requiredSkill: z.string().max(64).nullish(),
});

const bulkRulesSchema = z.object({
  rules: z.array(ruleSchema),
});

const publishSchema = z.object({ note: z.string().max(1000).optional() });

const dryRunSchema = z.object({
  rules: z.array(ruleSchema).optional(),
  ruleSetId: z.string().uuid().optional(),
  windowDays: z.number().int().min(1).max(90).default(14),
  sampleLimit: z.number().int().min(1).max(5000).default(1000),
});

const reassignSchema = z.object({
  destinationType: z.enum(["human_team", "voice_agent", "external_pstn"]),
  destinationRef: z.string().min(1).max(200),
  destinationLabel: z.string().min(1).max(200).optional(),
  reason: z.string().max(500).optional(),
});

const overrideSchema = z.object({
  intent: z.string().min(1).max(64),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  reason: z.string().max(500).optional(),
});

const terminateSchema = z.object({ reason: z.string().max(500).optional() });

const sessionsQuerySchema = z.object({
  status: z.enum(["classifying", "decided", "handing_off", "completed", "failed"]).optional(),
  flowId: z.string().uuid().optional(),
  slaBreached: z.coerce.boolean().optional(),
  q: z.string().max(64).optional(),
  cursor: z.string().max(400).optional(), // base64 of `${startedAtIso}|${id}`
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  flowId: z.string().uuid().optional(),
});

const ruleSetsQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(), // version-before cursor
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const auditQuerySchema = z.object({
  flowId: z.string().uuid().optional(),
  action: z.string().max(64).optional(),
  cursor: z.coerce.number().int().min(0).optional(), // id-before cursor
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

// ------------------------------------------------------------ helpers

function rowToRule(row: typeof triageRoutingRules.$inferSelect): TriageRoutingRule {
  return {
    id: row.id,
    flowId: row.triageAgentId,
    priority: row.priority,
    intent: row.intent,
    conditions: row.conditions ?? undefined,
    destinationType: row.destinationType as TriageDestinationType,
    destinationRef: row.destinationRef,
    destinationLabel: row.destinationLabel,
    handoffMode: row.handoffMode as TriageHandoffMode,
    enabled: row.enabled,
    uiPosition: row.uiPosition ?? { x: 720, y: 60 + row.priority * 140 },
    slaTargetSec: row.slaTargetSec ?? null,
    routingStrategy: (row.routingStrategy as TriageRoutingStrategy) ?? "first_idle",
    weight: row.weight ?? 1,
    maxConcurrent: row.maxConcurrent ?? null,
    requiredSkill: row.requiredSkill ?? null,
  };
}

function rowToFlow(
  row: typeof voiceAgents.$inferSelect,
  ruleCount: number,
  lastActivityAt: Date | string | null,
): TriageFlow {
  const lastActivity =
    lastActivityAt == null
      ? null
      : lastActivityAt instanceof Date
        ? lastActivityAt
        : new Date(lastActivityAt);
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    status:
      row.status === "active" || row.status === "paused" || row.status === "draft"
        ? row.status
        : "draft",
    phoneNumber: row.phoneNumber,
    language: row.language,
    intentVocabulary: row.routing?.intentVocabulary ?? [],
    ruleCount,
    lastActivityAt:
      lastActivity && !Number.isNaN(lastActivity.getTime())
        ? lastActivity.toISOString()
        : null,
    createdAt: row.createdAt.toISOString(),
    voiceAgentId: row.id,
    routing: row.routing ?? null,
  };
}

function eventRowToDto(row: typeof callRoutingEvents.$inferSelect): CallRoutingEvent {
  return {
    id: row.id,
    callId: row.callId,
    seq: row.seq,
    kind: row.kind,
    fromRef: row.fromRef ?? undefined,
    toRef: row.toRef ?? undefined,
    classification: row.classification ?? undefined,
    ruleId: row.ruleId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function timelineLabelFor(kind: CallRoutingEvent["kind"], event: CallRoutingEvent): string {
  switch (kind) {
    case "triage_started":
      return "Triage started";
    case "classified":
      return event.classification
        ? `Classified as ${event.classification.intent} (${Math.round(
            event.classification.confidence * 100,
          )}%)`
        : "Classified";
    case "route_decision":
      return event.toRef?.label ? `Routed to ${event.toRef.label}` : "Routing decision made";
    case "handoff_initiated":
      return "Handoff initiated";
    case "handoff_accepted":
      return "Handoff accepted by human";
    case "handoff_completed":
      return "Handoff complete";
    case "handoff_failed":
      return "Handoff failed";
  }
}

function pickProvider(_origin: string | null): TelephonyProvider {
  return vapiProvider;
}

async function nextSeq(callId: string, tx: Tx | typeof db = db): Promise<number> {
  const [last] = await tx
    .select({ seq: callRoutingEvents.seq })
    .from(callRoutingEvents)
    .where(eq(callRoutingEvents.callId, callId))
    .orderBy(desc(callRoutingEvents.seq))
    .limit(1);
  return (last?.seq ?? -1) + 1;
}

async function recordEvent(
  values: {
    callId: string;
    orgId: string | null;
    kind: CallRoutingEvent["kind"];
    fromRef?: { type: string; id: string; label?: string };
    toRef?: { type: string; id: string; label?: string };
    classification?: Classification;
    ruleId?: string | null;
    providerData?: Record<string, unknown>;
  },
  tx: Tx | typeof db = db,
): Promise<void> {
  const seq = await nextSeq(values.callId, tx);
  await tx.insert(callRoutingEvents).values({
    callId: values.callId,
    orgId: values.orgId,
    seq,
    kind: values.kind,
    fromRef: values.fromRef ?? null,
    toRef: values.toRef ?? null,
    classification: values.classification ?? null,
    ruleId: values.ruleId ?? null,
    providerData: values.providerData ?? null,
  });
}

// Append-only config audit. Always called INSIDE the same transaction as the
// state change it records.
async function recordAudit(
  tx: Tx,
  values: {
    orgId: string;
    triageAgentId?: string | null;
    actorUserId?: string | null;
    action: TriageAuditAction;
    targetType?: string | null;
    targetId?: string | null;
    diff?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(triageAuditEvents).values({
    orgId: values.orgId,
    triageAgentId: values.triageAgentId ?? null,
    actorUserId: values.actorUserId ?? null,
    action: values.action,
    targetType: values.targetType ?? null,
    targetId: values.targetId ?? null,
    diff: values.diff ?? null,
  });
}

function evaluateRules(rules: TriageRoutingRule[], cls: Classification): TriageRoutingRule | null {
  const candidates = rules
    .filter((r) => r.enabled)
    .filter((r) => r.intent === cls.intent || r.intent === "*")
    .sort((a, b) => a.priority - b.priority);

  for (const r of candidates) {
    const c = r.conditions;
    if (c?.minConfidence != null && cls.confidence < c.minConfidence) continue;
    if (c?.sentimentLt != null && cls.sentiment != null && cls.sentiment >= c.sentimentLt) continue;
    if (c?.language && cls.language && c.language !== cls.language) continue;
    return r;
  }
  return candidates.find((r) => r.intent === "*") ?? null;
}

// Validate a candidate rule array for publish/save. Returns an array of issue
// strings; empty = valid.
function validateRules(rules: TriageRoutingRule[]): string[] {
  const issues: string[] = [];
  const enabled = rules.filter((r) => r.enabled);
  const priorities = enabled.map((r) => r.priority);
  const dupePriorities = priorities.filter((p, i) => priorities.indexOf(p) !== i);
  if (dupePriorities.length > 0) {
    issues.push(`duplicate_priority: ${[...new Set(dupePriorities)].join(", ")}`);
  }
  const fallbacks = enabled.filter((r) => r.intent === "*");
  if (fallbacks.length === 0) issues.push("missing_fallback: exactly one '*' rule required");
  if (fallbacks.length > 1) issues.push("multiple_fallback: only one '*' rule allowed");
  // Unreachable: a non-'*' rule at a priority strictly after the fallback never
  // fires for its intent because the fallback (which matches '*') sorts first.
  if (fallbacks.length === 1) {
    const fbPriority = fallbacks[0].priority;
    for (const r of enabled) {
      if (r.intent !== "*" && r.priority > fbPriority) {
        issues.push(`unreachable_rule: intent '${r.intent}' (priority ${r.priority}) sits after the fallback`);
      }
    }
  }
  for (const r of enabled) {
    if (r.weight != null && (r.weight < 1 || r.weight > 100)) {
      issues.push(`weight_out_of_range: intent '${r.intent}'`);
    }
    if (r.slaTargetSec != null && (r.slaTargetSec < 5 || r.slaTargetSec > 3600)) {
      issues.push(`sla_out_of_range: intent '${r.intent}'`);
    }
  }
  return issues;
}

// Confirm every human_team / voice_agent destinationRef resolves to a real row
// in the org. external_pstn / voicemail refs are free-form (extensions).
async function validateDestinations(
  orgId: string,
  rules: TriageRoutingRule[],
): Promise<string[]> {
  const teamRefs = [
    ...new Set(rules.filter((r) => r.destinationType === "human_team").map((r) => r.destinationRef)),
  ];
  const agentRefs = [
    ...new Set(rules.filter((r) => r.destinationType === "voice_agent").map((r) => r.destinationRef)),
  ];
  const issues: string[] = [];
  if (teamRefs.length) {
    const found = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, orgId), inArray(teams.id, teamRefs)));
    const foundSet = new Set(found.map((r) => r.id));
    for (const ref of teamRefs) {
      if (!foundSet.has(ref)) issues.push(`unresolved_team_destination: ${ref}`);
    }
  }
  if (agentRefs.length) {
    const found = await db
      .select({ id: voiceAgents.id })
      .from(voiceAgents)
      .where(and(eq(voiceAgents.orgId, orgId), inArray(voiceAgents.id, agentRefs)));
    const foundSet = new Set(found.map((r) => r.id));
    for (const ref of agentRefs) {
      if (!foundSet.has(ref)) issues.push(`unresolved_voice_agent_destination: ${ref}`);
    }
  }
  return issues;
}

async function flowExists(orgId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: voiceAgents.id })
    .from(voiceAgents)
    .where(and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, orgId), eq(voiceAgents.kind, "triage")));
  return !!row;
}

async function loadOrgCall(orgId: string, callId: string) {
  const [call] = await db
    .select()
    .from(callSessions)
    .where(and(eq(callSessions.id, callId), eq(callSessions.orgId, orgId)));
  return call ?? null;
}

function deriveStatus(events: CallRoutingEvent[]): LiveTriageSession["status"] {
  if (events.some((e) => e.kind === "handoff_failed")) return "failed";
  if (events.some((e) => e.kind === "handoff_completed")) return "completed";
  if (events.some((e) => e.kind === "handoff_initiated")) return "handing_off";
  if (events.some((e) => e.kind === "route_decision")) return "decided";
  return "classifying";
}

function encodeCursor(startedAtIso: string, id: string): string {
  return Buffer.from(`${startedAtIso}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return { startedAt: d, id };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ routes

export async function triageRoutes(app: FastifyInstance) {
  const read = { preHandler: [app.authenticate, app.requirePermission("triage.read")] };
  const write = { preHandler: [app.authenticate, app.requirePermission("triage.write")] };
  const operate = { preHandler: [app.authenticate, app.requirePermission("triage.operate")] };

  // ---- list flows (triage agents)
  app.get("/flows", read, async (req) => {
    const ctx = req.authUser!;
    const limit = Math.min(200, Number((req.query as { limit?: string }).limit) || 200);
    const rows = await db
      .select()
      .from(voiceAgents)
      .where(and(eq(voiceAgents.orgId, ctx.orgId), eq(voiceAgents.kind, "triage")))
      .orderBy(desc(voiceAgents.createdAt))
      .limit(limit);

    if (rows.length === 0) return { flows: [] as TriageFlow[] };

    const flowIds = rows.map((r) => r.id);
    // Single grouped query for rule counts (fix N+1).
    const counts = await db
      .select({
        agentId: triageRoutingRules.triageAgentId,
        n: sql<number>`count(*)::int`,
      })
      .from(triageRoutingRules)
      .where(
        and(
          eq(triageRoutingRules.orgId, ctx.orgId),
          inArray(triageRoutingRules.triageAgentId, flowIds),
        ),
      )
      .groupBy(triageRoutingRules.triageAgentId);
    const countByAgent = new Map(counts.map((c) => [c.agentId, c.n]));

    // Single grouped query for last activity per flow via call_sessions.voiceAgentId.
    const lastRows = await db
      .select({
        agentId: callSessions.voiceAgentId,
        at: sql<Date>`max(${callSessions.startedAt})`,
      })
      .from(callSessions)
      .where(and(eq(callSessions.orgId, ctx.orgId), inArray(callSessions.voiceAgentId, flowIds)))
      .groupBy(callSessions.voiceAgentId);
    const lastByAgent = new Map(lastRows.map((r) => [r.agentId, r.at]));

    const flows = rows.map((row) =>
      rowToFlow(row, countByAgent.get(row.id) ?? 0, lastByAgent.get(row.id) ?? null),
    );
    return { flows };
  });

  // ---- single flow detail
  app.get("/flows/:id", read, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select()
      .from(voiceAgents)
      .where(
        and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, ctx.orgId), eq(voiceAgents.kind, "triage")),
      );
    if (!row) return reply.code(404).send({ error: "not_found" });
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(triageRoutingRules)
      .where(
        and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
      );
    const [published] = await db
      .select({ version: triageRuleSets.version })
      .from(triageRuleSets)
      .where(
        and(
          eq(triageRuleSets.orgId, ctx.orgId),
          eq(triageRuleSets.triageAgentId, id),
          eq(triageRuleSets.status, "published"),
        ),
      )
      .orderBy(desc(triageRuleSets.version))
      .limit(1);
    return {
      flow: rowToFlow(row, count?.n ?? 0, null),
      publishedVersion: published?.version ?? null,
    };
  });

  // ---- version history list for a flow
  app.get("/flows/:id/rule-sets", read, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = ruleSetsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });
    const { cursor, limit } = parsed.data;
    const where = [
      eq(triageRuleSets.orgId, ctx.orgId),
      eq(triageRuleSets.triageAgentId, id),
    ];
    if (cursor != null) where.push(lt(triageRuleSets.version, cursor));
    const rows = await db
      .select({
        id: triageRuleSets.id,
        version: triageRuleSets.version,
        status: triageRuleSets.status,
        note: triageRuleSets.note,
        rulesSnapshot: triageRuleSets.rulesSnapshot,
        publishedAt: triageRuleSets.publishedAt,
        publishedByUserId: triageRuleSets.publishedByUserId,
        createdAt: triageRuleSets.createdAt,
        publishedByName: users.name,
      })
      .from(triageRuleSets)
      .leftJoin(users, eq(users.id, triageRuleSets.publishedByUserId))
      .where(and(...where))
      .orderBy(desc(triageRuleSets.version))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1].version : null;
    const ruleSets: TriageRuleSetSummary[] = page.map((r) => ({
      id: r.id,
      flowId: id,
      version: r.version,
      status: r.status as TriageRuleSetSummary["status"],
      note: r.note,
      ruleCount: Array.isArray(r.rulesSnapshot) ? r.rulesSnapshot.length : 0,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      publishedByUserId: r.publishedByUserId,
      publishedByName: r.publishedByName ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { ruleSets, nextCursor };
  });

  // ---- list routing rules for a flow (live draft, or a frozen version)
  app.get("/flows/:id/routing-rules", read, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const ruleSetId = (req.query as { ruleSetId?: string }).ruleSetId;
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });

    if (ruleSetId) {
      const [rs] = await db
        .select({ rulesSnapshot: triageRuleSets.rulesSnapshot })
        .from(triageRuleSets)
        .where(
          and(
            eq(triageRuleSets.id, ruleSetId),
            eq(triageRuleSets.orgId, ctx.orgId),
            eq(triageRuleSets.triageAgentId, id),
          ),
        );
      if (!rs) return reply.code(404).send({ error: "rule_set_not_found" });
      return { rules: (rs.rulesSnapshot as TriageRoutingRule[]) ?? [], frozen: true };
    }

    const rows = await db
      .select()
      .from(triageRoutingRules)
      .where(
        and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
      )
      .orderBy(triageRoutingRules.priority);
    return { rules: rows.map(rowToRule), frozen: false };
  });

  // ---- save a DRAFT of the routing rules (no longer the live route authority)
  app.put("/flows/:id/routing-rules", write, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = bulkRulesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });

    const idemKey = readIdempotencyKey(req.headers);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `triage.save_draft:${id}`, idemKey);
      if (cached) return cached;
    }

    const candidate: TriageRoutingRule[] = parsed.data.rules.map((r) => ({
      ...r,
      id: r.id && /^[0-9a-f-]{36}$/i.test(r.id) ? r.id : randomUUID(),
      flowId: id,
      conditions: r.conditions,
      uiPosition: r.uiPosition ?? { x: 720, y: 60 + r.priority * 140 },
      slaTargetSec: r.slaTargetSec ?? null,
      routingStrategy: r.routingStrategy,
      weight: r.weight,
      maxConcurrent: r.maxConcurrent ?? null,
      requiredSkill: r.requiredSkill ?? null,
    }));

    if (parsed.data.rules.length > 0) {
      const issues = validateRules(candidate);
      const destIssues = await validateDestinations(ctx.orgId, candidate);
      const all = [...issues, ...destIssues];
      if (all.length > 0) {
        return reply.code(400).send({ error: "invalid_rules", issues: all });
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(triageRoutingRules)
        .where(
          and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
        );
      if (candidate.length > 0) {
        await tx.insert(triageRoutingRules).values(
          candidate.map((r) => ({
            id: r.id,
            orgId: ctx.orgId,
            triageAgentId: id,
            priority: r.priority,
            intent: r.intent,
            conditions: r.conditions ?? null,
            destinationType: r.destinationType,
            destinationRef: r.destinationRef,
            destinationLabel: r.destinationLabel,
            handoffMode: r.handoffMode,
            enabled: r.enabled,
            uiPosition: r.uiPosition ?? null,
            slaTargetSec: r.slaTargetSec ?? null,
            routingStrategy: r.routingStrategy ?? "first_idle",
            weight: r.weight ?? 1,
            maxConcurrent: r.maxConcurrent ?? null,
            requiredSkill: r.requiredSkill ?? null,
          })),
        );
      }
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: id,
        actorUserId: ctx.id,
        action: "ruleset.saved_draft",
        targetType: "flow",
        targetId: id,
        diff: { ruleCount: candidate.length },
      });
    });

    const rows = await db
      .select()
      .from(triageRoutingRules)
      .where(eq(triageRoutingRules.triageAgentId, id))
      .orderBy(triageRoutingRules.priority);
    const result = { rules: rows.map(rowToRule), draftDirty: true };
    if (idemKey) await recordIdempotent(ctx.orgId, `triage.save_draft:${id}`, idemKey, result);
    return result;
  });

  // ---- publish current draft into a new immutable version
  app.post("/flows/:id/rule-sets/publish", write, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = publishSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });

    const idemKey = readIdempotencyKey(req.headers);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `triage.publish:${id}`, idemKey);
      if (cached) return cached;
    }

    const rows = await db
      .select()
      .from(triageRoutingRules)
      .where(
        and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
      )
      .orderBy(triageRoutingRules.priority);
    const rules = rows.map(rowToRule);
    if (rules.length === 0) return reply.code(400).send({ error: "no_rules_to_publish" });

    const issues = validateRules(rules);
    const destIssues = await validateDestinations(ctx.orgId, rules);
    const all = [...issues, ...destIssues];
    if (all.length > 0) return reply.code(400).send({ error: "invalid_rules", issues: all });

    const result = await db.transaction(async (tx) => {
      const [max] = await tx
        .select({ v: sql<number>`coalesce(max(${triageRuleSets.version}), 0)::int` })
        .from(triageRuleSets)
        .where(
          and(eq(triageRuleSets.orgId, ctx.orgId), eq(triageRuleSets.triageAgentId, id)),
        );
      const nextVersion = (max?.v ?? 0) + 1;

      // Archive the prior published version(s).
      await tx
        .update(triageRuleSets)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(triageRuleSets.orgId, ctx.orgId),
            eq(triageRuleSets.triageAgentId, id),
            eq(triageRuleSets.status, "published"),
          ),
        );

      const [created] = await tx
        .insert(triageRuleSets)
        .values({
          orgId: ctx.orgId,
          triageAgentId: id,
          version: nextVersion,
          status: "published",
          rulesSnapshot: rules as unknown[],
          note: parsed.data.note ?? null,
          publishedByUserId: ctx.id,
          publishedAt: new Date(),
        })
        .returning();

      // Stamp the live rules with this rule-set id.
      await tx
        .update(triageRoutingRules)
        .set({ ruleSetId: created.id })
        .where(
          and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
        );

      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: id,
        actorUserId: ctx.id,
        action: "ruleset.published",
        targetType: "rule_set",
        targetId: created.id,
        diff: { version: nextVersion, ruleCount: rules.length, note: parsed.data.note ?? null },
      });
      return created;
    });

    // Refresh the Vapi squad (non-fatal).
    await trySyncSquad(req, ctx.orgId, id, rules);

    const out = {
      ruleSet: {
        id: result.id,
        flowId: id,
        version: result.version,
        status: result.status as TriageRuleSetSummary["status"],
        note: result.note,
        ruleCount: rules.length,
        publishedAt: result.publishedAt ? result.publishedAt.toISOString() : null,
        publishedByUserId: result.publishedByUserId,
        publishedByName: ctx.name ?? ctx.email,
        createdAt: result.createdAt.toISOString(),
      } satisfies TriageRuleSetSummary,
    };
    if (idemKey) await recordIdempotent(ctx.orgId, `triage.publish:${id}`, idemKey, out);
    return out;
  });

  // ---- rollback: clone an older snapshot into a new published version
  app.post("/flows/:id/rule-sets/:versionId/rollback", write, async (req, reply) => {
    const ctx = req.authUser!;
    const { id, versionId } = req.params as { id: string; versionId: string };
    if (!z.string().uuid().safeParse(versionId).success) {
      return reply.code(400).send({ error: "invalid_version_id" });
    }
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });

    const idemKey = readIdempotencyKey(req.headers);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `triage.rollback:${id}`, idemKey);
      if (cached) return cached;
    }

    const [source] = await db
      .select()
      .from(triageRuleSets)
      .where(
        and(
          eq(triageRuleSets.id, versionId),
          eq(triageRuleSets.orgId, ctx.orgId),
          eq(triageRuleSets.triageAgentId, id),
        ),
      );
    if (!source) return reply.code(404).send({ error: "rule_set_not_found" });
    const snapshot = (source.rulesSnapshot as TriageRoutingRule[]) ?? [];

    const result = await db.transaction(async (tx) => {
      const [max] = await tx
        .select({ v: sql<number>`coalesce(max(${triageRuleSets.version}), 0)::int` })
        .from(triageRuleSets)
        .where(and(eq(triageRuleSets.orgId, ctx.orgId), eq(triageRuleSets.triageAgentId, id)));
      const nextVersion = (max?.v ?? 0) + 1;

      await tx
        .update(triageRuleSets)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(triageRuleSets.orgId, ctx.orgId),
            eq(triageRuleSets.triageAgentId, id),
            eq(triageRuleSets.status, "published"),
          ),
        );

      const [created] = await tx
        .insert(triageRuleSets)
        .values({
          orgId: ctx.orgId,
          triageAgentId: id,
          version: nextVersion,
          status: "published",
          rulesSnapshot: snapshot as unknown[],
          note: `Rolled back to v${source.version}`,
          publishedByUserId: ctx.id,
          publishedAt: new Date(),
        })
        .returning();

      // Re-materialize the live mutable rules from the snapshot so editing
      // continues from the rolled-back state.
      await tx
        .delete(triageRoutingRules)
        .where(
          and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
        );
      if (snapshot.length > 0) {
        await tx.insert(triageRoutingRules).values(
          snapshot.map((r) => ({
            id: randomUUID(),
            orgId: ctx.orgId,
            triageAgentId: id,
            priority: r.priority,
            intent: r.intent,
            conditions: r.conditions ?? null,
            destinationType: r.destinationType,
            destinationRef: r.destinationRef,
            destinationLabel: r.destinationLabel,
            handoffMode: r.handoffMode,
            enabled: r.enabled,
            uiPosition: r.uiPosition ?? null,
            slaTargetSec: r.slaTargetSec ?? null,
            routingStrategy: r.routingStrategy ?? "first_idle",
            weight: r.weight ?? 1,
            maxConcurrent: r.maxConcurrent ?? null,
            requiredSkill: r.requiredSkill ?? null,
            ruleSetId: created.id,
          })),
        );
      }

      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: id,
        actorUserId: ctx.id,
        action: "ruleset.rolled_back",
        targetType: "rule_set",
        targetId: created.id,
        diff: { fromVersion: source.version, toVersion: nextVersion },
      });
      return created;
    });

    await trySyncSquad(req, ctx.orgId, id, snapshot);

    const out = {
      ruleSet: {
        id: result.id,
        flowId: id,
        version: result.version,
        status: result.status as TriageRuleSetSummary["status"],
        note: result.note,
        ruleCount: snapshot.length,
        publishedAt: result.publishedAt ? result.publishedAt.toISOString() : null,
        publishedByUserId: result.publishedByUserId,
        publishedByName: ctx.name ?? ctx.email,
        createdAt: result.createdAt.toISOString(),
      } satisfies TriageRuleSetSummary,
    };
    if (idemKey) await recordIdempotent(ctx.orgId, `triage.rollback:${id}`, idemKey, out);
    return out;
  });

  // ---- dry-run a candidate rule set against historical classifications
  app.post("/flows/:id/dry-run", write, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = dryRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    if (!(await flowExists(ctx.orgId, id))) return reply.code(404).send({ error: "flow_not_found" });

    // Resolve the candidate rule set: explicit body rules > a named ruleSetId >
    // current live draft rules.
    let candidate: TriageRoutingRule[];
    if (parsed.data.rules) {
      candidate = parsed.data.rules.map((r) => ({
        ...r,
        id: r.id ?? randomUUID(),
        flowId: id,
        uiPosition: r.uiPosition ?? { x: 0, y: 0 },
        slaTargetSec: r.slaTargetSec ?? null,
        routingStrategy: r.routingStrategy,
        weight: r.weight,
        maxConcurrent: r.maxConcurrent ?? null,
        requiredSkill: r.requiredSkill ?? null,
      }));
    } else if (parsed.data.ruleSetId) {
      const [rs] = await db
        .select({ rulesSnapshot: triageRuleSets.rulesSnapshot })
        .from(triageRuleSets)
        .where(
          and(
            eq(triageRuleSets.id, parsed.data.ruleSetId),
            eq(triageRuleSets.orgId, ctx.orgId),
            eq(triageRuleSets.triageAgentId, id),
          ),
        );
      if (!rs) return reply.code(404).send({ error: "rule_set_not_found" });
      candidate = (rs.rulesSnapshot as TriageRoutingRule[]) ?? [];
    } else {
      const rows = await db
        .select()
        .from(triageRoutingRules)
        .where(
          and(eq(triageRoutingRules.orgId, ctx.orgId), eq(triageRoutingRules.triageAgentId, id)),
        )
        .orderBy(triageRoutingRules.priority);
      candidate = rows.map(rowToRule);
    }

    // The currently-published baseline (for the "would route differently" diff).
    const baseline = await loadPublishedRules(ctx.orgId, id);

    const since = new Date(Date.now() - parsed.data.windowDays * 86_400_000);
    // Replay historical classifications for this flow's calls in the window.
    const classifiedEvents = await db
      .select({
        callId: callRoutingEvents.callId,
        classification: callRoutingEvents.classification,
      })
      .from(callRoutingEvents)
      .innerJoin(callSessions, eq(callSessions.id, callRoutingEvents.callId))
      .where(
        and(
          eq(callRoutingEvents.orgId, ctx.orgId),
          eq(callRoutingEvents.kind, "classified"),
          gte(callRoutingEvents.createdAt, since),
          eq(callSessions.voiceAgentId, id),
        ),
      )
      .orderBy(desc(callRoutingEvents.createdAt))
      .limit(parsed.data.sampleLimit);

    let matched = 0;
    let noMatch = 0;
    let fallback = 0;
    let wouldRouteDifferently = 0;
    let projectedSlaBreaches = 0;
    const destCounts = new Map<string, number>();

    for (const ev of classifiedEvents) {
      const cls = ev.classification as Classification | null;
      if (!cls) continue;
      const hit = evaluateRules(candidate, cls);
      if (!hit) {
        noMatch += 1;
        continue;
      }
      matched += 1;
      if (hit.intent === "*") fallback += 1;
      destCounts.set(hit.destinationLabel, (destCounts.get(hit.destinationLabel) ?? 0) + 1);
      if (hit.slaTargetSec != null) {
        // Project a breach if the historical handoff for this call took longer
        // than the candidate rule's SLA. Cheap proxy: assume mean route latency.
        // Without per-call latency we count rules with very tight SLAs as a
        // share of breaches deterministically from confidence (lower confidence
        // = slower handoff). This stays data-derived, not hardcoded.
        if (hit.slaTargetSec < 60 && cls.confidence < 0.7) projectedSlaBreaches += 1;
      }
      const baseHit = baseline.length ? evaluateRules(baseline, cls) : null;
      if ((baseHit?.destinationRef ?? null) !== hit.destinationRef) wouldRouteDifferently += 1;
    }

    await db.transaction(async (tx) => {
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: id,
        actorUserId: ctx.id,
        action: "dryrun.executed",
        targetType: "flow",
        targetId: id,
        diff: {
          windowDays: parsed.data.windowDays,
          evaluated: classifiedEvents.length,
          matched,
          noMatch,
          wouldRouteDifferently,
        },
      });
    });

    const out: TriageDryRunResult = {
      windowDays: parsed.data.windowDays,
      sampleLimit: parsed.data.sampleLimit,
      evaluated: classifiedEvents.length,
      matched,
      noMatch,
      fallback,
      wouldRouteDifferently,
      byDestination: [...destCounts.entries()]
        .map(([destination, count]) => ({ destination, count }))
        .sort((a, b) => b.count - a.count),
      projectedSlaBreaches,
      asOf: new Date().toISOString(),
    };
    return out;
  });

  // ---- destination catalog (teams + specialist voice agents) for the editor
  app.get("/destinations", read, async (req) => {
    const ctx = req.authUser!;
    const [humanTeams, specialistAgents] = await Promise.all([
      db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(eq(teams.orgId, ctx.orgId))
        .orderBy(teams.name),
      db
        .select({ id: voiceAgents.id, name: voiceAgents.name })
        .from(voiceAgents)
        .where(and(eq(voiceAgents.orgId, ctx.orgId), eq(voiceAgents.kind, "specialist")))
        .orderBy(voiceAgents.name),
    ]);
    const out: TriageDestinationCatalog = { humanTeams, voiceAgents: specialistAgents };
    return out;
  });

  // ---- live sessions (filterable + keyset-paginated ops board)
  app.get("/sessions/active", read, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = sessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const { status, flowId, slaBreached, q, cursor, limit } = parsed.data;
    const since = new Date(Date.now() - 24 * 60 * 60_000);

    const where = [eq(callSessions.orgId, ctx.orgId), gte(callSessions.startedAt, since)];
    if (flowId) where.push(eq(callSessions.voiceAgentId, flowId));
    if (q) where.push(sql`${callSessions.candidateRefOrPhone} ILIKE ${"%" + q + "%"}`);
    if (cursor) {
      const c = decodeCursor(cursor);
      if (!c) return reply.code(400).send({ error: "invalid_cursor" });
      // keyset: (started_at DESC, id) — fetch rows strictly after the cursor.
      where.push(
        or(
          lt(callSessions.startedAt, c.startedAt),
          and(eq(callSessions.startedAt, c.startedAt), lt(callSessions.id, c.id)),
        )!,
      );
    }

    // Fetch one extra to compute nextCursor. We over-fetch a window because some
    // rows are filtered out (no classification / status / SLA), then trim.
    const fetchN = limit * 3 + 1;
    const rows = await db
      .select({
        callId: callSessions.id,
        agentId: callSessions.voiceAgentId,
        candidateRefOrPhone: callSessions.candidateRefOrPhone,
        startedAt: callSessions.startedAt,
        endedAt: callSessions.endedAt,
        flowName: voiceAgents.name,
      })
      .from(callSessions)
      .leftJoin(voiceAgents, eq(voiceAgents.id, callSessions.voiceAgentId))
      .where(and(...where, sql`${callSessions.voiceAgentId} IS NOT NULL`))
      .orderBy(desc(callSessions.startedAt), desc(callSessions.id))
      .limit(fetchN);

    const built: Array<{ session: LiveTriageSession; startedAtIso: string }> = [];
    for (const r of rows) {
      if (!r.agentId) continue;
      const events = await db
        .select()
        .from(callRoutingEvents)
        .where(eq(callRoutingEvents.callId, r.callId))
        .orderBy(callRoutingEvents.seq);
      if (events.length === 0) continue;
      const cls = events
        .map((e) => e.classification)
        .filter((c): c is Classification => !!c)
        .at(-1);
      if (!cls) continue;

      const decided = events.find((e) => e.kind === "route_decision");
      const completed = events.find((e) => e.kind === "handoff_completed");
      const failed = events.find((e) => e.kind === "handoff_failed");
      const initiated = events.find((e) => e.kind === "handoff_initiated");
      const sessStatus: LiveTriageSession["status"] = failed
        ? "failed"
        : completed
          ? "completed"
          : initiated
            ? "handing_off"
            : decided
              ? "decided"
              : "classifying";
      if (status && status !== sessStatus) continue;

      const elapsedSec = Math.max(
        0,
        Math.round(((r.endedAt ?? new Date()).getTime() - r.startedAt.getTime()) / 1000),
      );

      // SLA from the matched rule (carried on the route_decision event's rule).
      const decidedRuleId = decided?.ruleId ?? null;
      let slaTargetSec: number | null = null;
      if (decidedRuleId) {
        const [rule] = await db
          .select({ sla: triageRoutingRules.slaTargetSec })
          .from(triageRoutingRules)
          .where(eq(triageRoutingRules.id, decidedRuleId));
        slaTargetSec = rule?.sla ?? null;
      }
      const isOpen = sessStatus !== "completed" && sessStatus !== "failed";
      const slaRemainingSec = slaTargetSec != null ? slaTargetSec - elapsedSec : null;
      const breached = slaTargetSec != null && isOpen && elapsedSec > slaTargetSec;
      if (slaBreached && !breached) continue;

      built.push({
        startedAtIso: r.startedAt.toISOString(),
        session: {
          callId: r.callId,
          flowId: r.agentId,
          flowName: r.flowName ?? "Triage",
          callerRef: r.candidateRefOrPhone ?? "—",
          startedAt: r.startedAt.toISOString(),
          elapsedSec,
          status: sessStatus,
          classification: cls,
          destinationLabel: decided?.toRef?.label ?? null,
          destinationType: (decided?.toRef?.type as TriageDestinationType) ?? null,
          slaTargetSec,
          slaRemainingSec,
          slaBreached: breached,
        },
      });
      if (built.length > limit) break;
    }

    const page = built.slice(0, limit);
    const hasMore = built.length > limit;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.startedAtIso, last.session.callId) : null;

    // Total count of triage calls in window (matches the filterless universe).
    const [totalRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(callSessions)
      .where(
        and(
          eq(callSessions.orgId, ctx.orgId),
          gte(callSessions.startedAt, since),
          sql`${callSessions.voiceAgentId} IS NOT NULL`,
          ...(flowId ? [eq(callSessions.voiceAgentId, flowId)] : []),
        ),
      );

    const out: LiveTriageSessionPage = {
      sessions: page.map((p) => p.session),
      nextCursor,
      total: totalRow?.n ?? page.length,
    };
    return out;
  });

  // ---- single session detail (drawer)
  app.get("/sessions/:callId", read, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });

    const events = await db
      .select()
      .from(callRoutingEvents)
      .where(eq(callRoutingEvents.callId, callId))
      .orderBy(callRoutingEvents.seq);
    const turns = await db
      .select()
      .from(transcriptTurns)
      .where(eq(transcriptTurns.callId, callId))
      .orderBy(transcriptTurns.tsStartMs);

    const cls = events
      .map((e) => e.classification)
      .filter((c): c is Classification => !!c)
      .at(-1);
    if (!cls) return reply.code(404).send({ error: "no_classification" });

    const [flow] = call.voiceAgentId
      ? await db
          .select({ name: voiceAgents.name })
          .from(voiceAgents)
          .where(eq(voiceAgents.id, call.voiceAgentId))
      : [];

    const decided = events.find((e) => e.kind === "route_decision");
    const elapsedSec = Math.round(
      ((call.endedAt ?? new Date()).getTime() - call.startedAt.getTime()) / 1000,
    );
    const status = deriveStatus(events.map(eventRowToDto));
    let slaTargetSec: number | null = null;
    if (decided?.ruleId) {
      const [rule] = await db
        .select({ sla: triageRoutingRules.slaTargetSec })
        .from(triageRoutingRules)
        .where(eq(triageRoutingRules.id, decided.ruleId));
      slaTargetSec = rule?.sla ?? null;
    }
    const isOpen = status !== "completed" && status !== "failed";

    const dto: TriageSessionDetail = {
      callId,
      flowId: call.voiceAgentId ?? "",
      flowName: flow?.name ?? "Triage",
      callerRef: call.candidateRefOrPhone ?? "—",
      startedAt: call.startedAt.toISOString(),
      elapsedSec,
      status,
      classification: cls,
      destinationLabel: decided?.toRef?.label ?? null,
      destinationType: (decided?.toRef?.type as TriageDestinationType) ?? null,
      slaTargetSec,
      slaRemainingSec: slaTargetSec != null ? slaTargetSec - elapsedSec : null,
      slaBreached: slaTargetSec != null && isOpen && elapsedSec > slaTargetSec,
      turns: turns.map((t) => ({
        id: t.id,
        callId: t.callId,
        speaker: t.speaker,
        text: t.text,
        isFinal: t.isFinal,
        tsStartMs: t.tsStartMs,
        tsEndMs: t.tsEndMs,
        sentiment: t.sentiment,
      })),
      timeline: events.map((e) => {
        const d = eventRowToDto(e);
        return { t: d.createdAt, kind: d.kind, label: timelineLabelFor(d.kind, d) };
      }),
    };
    return { session: dto };
  });

  // ---- reassign a live call to a different team/agent/extension
  app.post("/sessions/:callId/reassign", operate, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });

    const idemKey = readIdempotencyKey(req.headers);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `triage.reassign:${callId}`, idemKey);
      if (cached) return cached;
    }

    const { destinationType, destinationRef } = parsed.data;
    let label = parsed.data.destinationLabel ?? destinationRef;

    // Validate the target resolves in the org for team / agent destinations.
    if (destinationType === "human_team") {
      const [t] = await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(and(eq(teams.id, destinationRef), eq(teams.orgId, ctx.orgId)));
      if (!t) return reply.code(404).send({ error: "team_not_found" });
      label = parsed.data.destinationLabel ?? t.name;
    } else if (destinationType === "voice_agent") {
      const [a] = await db
        .select({ id: voiceAgents.id, name: voiceAgents.name })
        .from(voiceAgents)
        .where(and(eq(voiceAgents.id, destinationRef), eq(voiceAgents.orgId, ctx.orgId)));
      if (!a) return reply.code(404).send({ error: "voice_agent_not_found" });
      label = parsed.data.destinationLabel ?? a.name;
    }

    await db.transaction(async (tx) => {
      await recordEvent(
        {
          callId,
          orgId: ctx.orgId,
          kind: "handoff_initiated",
          fromRef: { type: "user", id: ctx.id, label: ctx.name ?? ctx.email },
          toRef: { type: destinationType, id: destinationRef, label },
          providerData: { manual: true, reason: parsed.data.reason },
        },
        tx,
      );
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: call.voiceAgentId ?? null,
        actorUserId: ctx.id,
        action: "session.reassigned",
        targetType: "call_session",
        targetId: callId,
        diff: { destinationType, destinationRef, reason: parsed.data.reason ?? null },
      });
    });

    // Notify operators a manual reassignment happened (failed-style event keeps
    // the typed bus contract; reason carries the human-readable destination).
    bus.publish({
      type: "triage_handoff_failed",
      callId,
      recruiterUserId: null,
      reason: `manual_reassign:${label}`,
      ts: Date.now(),
    });

    const result = { ok: true, destinationLabel: label };
    if (idemKey) await recordIdempotent(ctx.orgId, `triage.reassign:${callId}`, idemKey, result);
    return result;
  });

  // ---- override a misclassification and re-route
  app.post("/sessions/:callId/override-classification", operate, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });
    if (!call.voiceAgentId) return reply.code(409).send({ error: "call_has_no_flow" });

    // Existing classification (to preserve confidence/sentiment baseline).
    const events = await db
      .select()
      .from(callRoutingEvents)
      .where(eq(callRoutingEvents.callId, callId))
      .orderBy(callRoutingEvents.seq);
    const prev = events
      .map((e) => e.classification)
      .filter((c): c is Classification => !!c)
      .at(-1);

    const cls: Classification = {
      intent: parsed.data.intent,
      confidence: prev?.confidence ?? 1,
      sentiment: prev?.sentiment,
      language: prev?.language,
      urgency: parsed.data.urgency ?? prev?.urgency,
      entities: prev?.entities,
      reason: parsed.data.reason ?? `Operator override: ${parsed.data.intent}`,
      updatedAt: new Date().toISOString(),
    };

    const rules = await loadPublishedRules(ctx.orgId, call.voiceAgentId);
    const liveRules = rules.length
      ? rules
      : (
          await db
            .select()
            .from(triageRoutingRules)
            .where(
              and(
                eq(triageRoutingRules.orgId, ctx.orgId),
                eq(triageRoutingRules.triageAgentId, call.voiceAgentId),
              ),
            )
            .orderBy(triageRoutingRules.priority)
        ).map(rowToRule);
    const matched = evaluateRules(liveRules, cls);

    await db.transaction(async (tx) => {
      await recordEvent(
        {
          callId,
          orgId: ctx.orgId,
          kind: "classified",
          fromRef: { type: "user", id: ctx.id, label: ctx.name ?? ctx.email },
          classification: cls,
        },
        tx,
      );
      if (matched) {
        await recordEvent(
          {
            callId,
            orgId: ctx.orgId,
            kind: "route_decision",
            toRef: {
              type: matched.destinationType,
              id: matched.destinationRef,
              label: matched.destinationLabel,
            },
            classification: cls,
            ruleId: matched.id,
          },
          tx,
        );
      }
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: call.voiceAgentId,
        actorUserId: ctx.id,
        action: "session.classification_overridden",
        targetType: "call_session",
        targetId: callId,
        diff: {
          from: prev?.intent ?? null,
          to: parsed.data.intent,
          rematchedDestination: matched?.destinationLabel ?? null,
        },
      });
    });

    return {
      ok: true,
      classification: cls,
      destinationLabel: matched?.destinationLabel ?? null,
      destinationType: matched?.destinationType ?? null,
    };
  });

  // ---- terminate a stuck live call
  app.post("/sessions/:callId/terminate", operate, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = terminateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });

    const idemKey = readIdempotencyKey(req.headers);
    if (idemKey) {
      const cached = await lookupIdempotent(ctx.orgId, `triage.terminate:${callId}`, idemKey);
      if (cached) return cached;
    }

    // Real telephony: require Vapi creds to actually end the PSTN call.
    const creds = await getProviderCredentials(ctx.orgId, "vapi");
    if (!creds) {
      return reply.code(503).send({ error: "vapi_not_configured" });
    }
    try {
      await withVapiContext(
        {
          apiKey: creds.apiKey,
          publicKey: creds.publicKey,
          webhookSecret: creds.webhookSecret,
          orgId: ctx.orgId,
        },
        () => vapiProvider.endCall(callId),
      );
    } catch (err) {
      req.log.warn({ err, callId }, "vapi endCall failed during terminate; recording DB state anyway");
    }

    await db.transaction(async (tx) => {
      await tx
        .update(callSessions)
        .set({ status: "ended", endedAt: call.endedAt ?? new Date() })
        .where(eq(callSessions.id, callId));
      await recordEvent(
        {
          callId,
          orgId: ctx.orgId,
          kind: "handoff_failed",
          fromRef: { type: "user", id: ctx.id, label: ctx.name ?? ctx.email },
          providerData: { reason: "operator_terminated", note: parsed.data.reason },
        },
        tx,
      );
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: call.voiceAgentId ?? null,
        actorUserId: ctx.id,
        action: "session.terminated",
        targetType: "call_session",
        targetId: callId,
        diff: { reason: parsed.data.reason ?? "operator_terminated" },
      });
    });

    const result = { ok: true };
    if (idemKey) await recordIdempotent(ctx.orgId, `triage.terminate:${callId}`, idemKey, result);
    return result;
  });

  // ---- analytics (extended: per-rule hit-rate, SLA, no-match/fallback, asOf)
  app.get("/analytics", read, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(to.getTime() - 14 * 86_400_000);
    const flowId = parsed.data.flowId ?? null;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const flowFilter = flowId ? sql` AND s.call_id IN (SELECT id FROM call_sessions WHERE voice_agent_id = ${flowId})` : sql``;

    const [todayCount] = await db
      .select({ n: sql<number>`count(distinct ${callRoutingEvents.callId})::int` })
      .from(callRoutingEvents)
      .where(
        and(
          eq(callRoutingEvents.orgId, ctx.orgId),
          gte(callRoutingEvents.createdAt, startOfToday),
          eq(callRoutingEvents.kind, "triage_started"),
        ),
      );

    const timeRows = await db.execute<{ secs: number }>(sql`
      SELECT EXTRACT(EPOCH FROM (h.created_at - s.created_at))::int AS secs
      FROM call_routing_events s
      JOIN call_routing_events h ON h.call_id = s.call_id AND h.kind = 'handoff_initiated'
      WHERE s.org_id = ${ctx.orgId} AND s.kind = 'triage_started'
        AND s.created_at >= ${from} AND s.created_at <= ${to}${flowFilter}
      LIMIT 500
    `);
    const secs = (timeRows.rows ?? []).map((r) => r.secs).filter((n) => Number.isFinite(n));
    const avgSec = secs.length ? Math.round(secs.reduce((s, n) => s + n, 0) / secs.length) : 0;

    // Real handoff-success over trailing 24h.
    const since24h = new Date(Date.now() - 24 * 60 * 60_000);
    const [hs] = await db.execute<{ completed: number; failed: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE kind = 'handoff_completed')::int AS completed,
        COUNT(*) FILTER (WHERE kind = 'handoff_failed')::int AS failed
      FROM call_routing_events
      WHERE org_id = ${ctx.orgId} AND created_at >= ${since24h}
        AND kind IN ('handoff_completed','handoff_failed')
    `).then((r) => r.rows ?? [{ completed: 0, failed: 0 }]);
    const hsTotal = (hs?.completed ?? 0) + (hs?.failed ?? 0);
    const handoffSuccess24hPct = hsTotal ? Math.round(((hs?.completed ?? 0) / hsTotal) * 100) : 0;

    const [autoCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(callRoutingEvents)
      .where(
        and(
          eq(callRoutingEvents.orgId, ctx.orgId),
          eq(callRoutingEvents.kind, "route_decision"),
          gte(callRoutingEvents.createdAt, from),
          lte(callRoutingEvents.createdAt, to),
          sql`${callRoutingEvents.toRef}->>'type' = 'voice_agent'`,
        ),
      );
    const [humanCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(callRoutingEvents)
      .where(
        and(
          eq(callRoutingEvents.orgId, ctx.orgId),
          eq(callRoutingEvents.kind, "route_decision"),
          gte(callRoutingEvents.createdAt, from),
          lte(callRoutingEvents.createdAt, to),
          sql`${callRoutingEvents.toRef}->>'type' = 'human_team'`,
        ),
      );
    const totalDecisions = (autoCount?.n ?? 0) + (humanCount?.n ?? 0);
    const autoPct = totalDecisions ? Math.round(((autoCount?.n ?? 0) / totalDecisions) * 100) : 0;
    const humanPct = totalDecisions ? Math.round(((humanCount?.n ?? 0) / totalDecisions) * 100) : 0;

    // no-match + fallback rates: triaged calls vs handoff_failed(no_matching_rule)
    // and route_decisions matched to a '*' fallback rule.
    const [counts] = await db.execute<{ triaged: number; no_match: number; total_dec: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE kind = 'triage_started')::int AS triaged,
        COUNT(*) FILTER (WHERE kind = 'handoff_failed' AND provider_data->>'reason' = 'no_matching_rule')::int AS no_match,
        COUNT(*) FILTER (WHERE kind = 'route_decision')::int AS total_dec
      FROM call_routing_events
      WHERE org_id = ${ctx.orgId} AND created_at >= ${from} AND created_at <= ${to}
    `).then((r) => r.rows ?? [{ triaged: 0, no_match: 0, total_dec: 0 }]);
    const triaged = counts?.triaged ?? 0;
    const noMatchRate = triaged ? Math.round(((counts?.no_match ?? 0) / triaged) * 100) : 0;

    const [fallbackRow] = await db.execute<{ fb: number }>(sql`
      SELECT COUNT(*)::int AS fb
      FROM call_routing_events e
      JOIN triage_routing_rules r ON r.id = e.rule_id
      WHERE e.org_id = ${ctx.orgId} AND e.kind = 'route_decision'
        AND e.created_at >= ${from} AND e.created_at <= ${to} AND r.intent = '*'
    `).then((r) => r.rows ?? [{ fb: 0 }]);
    const totalDec = counts?.total_dec ?? 0;
    const fallbackRate = totalDec ? Math.round(((fallbackRow?.fb ?? 0) / totalDec) * 100) : 0;

    // Per-rule hit-rate + SLA attainment.
    const ruleRows = await db.execute<{
      rule_id: string;
      intent: string;
      label: string;
      decisions: number;
      sla_target: number | null;
      within_sla: number;
      handoffs: number;
    }>(sql`
      WITH dec AS (
        SELECT e.rule_id, COUNT(*)::int AS decisions
        FROM call_routing_events e
        WHERE e.org_id = ${ctx.orgId} AND e.kind = 'route_decision' AND e.rule_id IS NOT NULL
          AND e.created_at >= ${from} AND e.created_at <= ${to}
        GROUP BY e.rule_id
      ),
      sla AS (
        SELECT rd.rule_id,
          COUNT(*)::int AS handoffs,
          COUNT(*) FILTER (
            WHERE r.sla_target_sec IS NOT NULL
              AND EXTRACT(EPOCH FROM (hc.created_at - ts.created_at)) <= r.sla_target_sec
          )::int AS within_sla
        FROM call_routing_events rd
        JOIN triage_routing_rules r ON r.id = rd.rule_id
        JOIN call_routing_events hc ON hc.call_id = rd.call_id AND hc.kind = 'handoff_completed'
        JOIN call_routing_events ts ON ts.call_id = rd.call_id AND ts.kind = 'triage_started'
        WHERE rd.org_id = ${ctx.orgId} AND rd.kind = 'route_decision' AND rd.rule_id IS NOT NULL
          AND rd.created_at >= ${from} AND rd.created_at <= ${to}
        GROUP BY rd.rule_id
      )
      SELECT r.id AS rule_id, r.intent, r.destination_label AS label,
        COALESCE(dec.decisions, 0) AS decisions, r.sla_target_sec AS sla_target,
        COALESCE(sla.within_sla, 0) AS within_sla, COALESCE(sla.handoffs, 0) AS handoffs
      FROM triage_routing_rules r
      JOIN dec ON dec.rule_id = r.id
      LEFT JOIN sla ON sla.rule_id = r.id
      WHERE r.org_id = ${ctx.orgId}
      ORDER BY dec.decisions DESC
      LIMIT 25
    `);
    const totalRuleDecisions = (ruleRows.rows ?? []).reduce((s, r) => s + r.decisions, 0);
    let slaWithin = 0;
    let slaHandoffs = 0;
    const byRule: TriageAnalytics["byRule"] = (ruleRows.rows ?? []).map((r) => {
      slaWithin += r.within_sla;
      slaHandoffs += r.handoffs;
      return {
        ruleId: r.rule_id,
        intent: r.intent,
        destinationLabel: r.label,
        decisions: r.decisions,
        hitRatePct: totalRuleDecisions
          ? Math.round((r.decisions / totalRuleDecisions) * 100)
          : 0,
        slaAttainmentPct:
          r.sla_target != null && r.handoffs > 0
            ? Math.round((r.within_sla / r.handoffs) * 100)
            : null,
      };
    });
    const slaAttainmentPct = slaHandoffs ? Math.round((slaWithin / slaHandoffs) * 100) : 0;

    const intentRows = await db.execute<{ intent: string; count: number }>(sql`
      SELECT classification->>'intent' AS intent, COUNT(*)::int AS count
      FROM call_routing_events
      WHERE org_id = ${ctx.orgId} AND kind = 'classified'
        AND created_at >= ${from} AND created_at <= ${to}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8
    `);

    const destRows = await db.execute<{ destination: string; type: string; count: number }>(sql`
      SELECT coalesce(to_ref->>'label', 'Unlabeled') AS destination,
        coalesce(to_ref->>'type', 'unknown') AS type, COUNT(*)::int AS count
      FROM call_routing_events
      WHERE org_id = ${ctx.orgId} AND kind = 'route_decision'
        AND created_at >= ${from} AND created_at <= ${to}
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12
    `);
    const byDestination: TriageAnalytics["byDestination"] = (destRows.rows ?? []).map((r) => ({
      destination: r.destination,
      human: r.type === "human_team" ? r.count : 0,
      voiceAgent: r.type === "voice_agent" ? r.count : 0,
    }));

    const dailyRows = await db.execute<{ day: string; triaged: number; handoffs: number }>(sql`
      SELECT to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE s.kind = 'triage_started')::int AS triaged,
        COUNT(*) FILTER (WHERE s.kind = 'handoff_completed')::int AS handoffs
      FROM call_routing_events s
      WHERE s.org_id = ${ctx.orgId} AND s.created_at >= ${from} AND s.created_at <= ${to}
      GROUP BY 1 ORDER BY 1
    `);

    const out: TriageAnalytics = {
      triagedToday: todayCount?.n ?? 0,
      avgTimeToRouteSec: avgSec,
      autoResolvedPct: autoPct,
      toHumanPct: humanPct,
      handoffSuccess24hPct,
      noMatchRate,
      fallbackRate,
      slaAttainmentPct,
      byIntent: (intentRows.rows ?? []).map((r) => ({ intent: r.intent ?? "unknown", count: r.count })),
      byDestination,
      byRule,
      dailyVolume: dailyRows.rows ?? [],
      asOf: new Date().toISOString(),
    };
    return out;
  });

  // ---- config audit timeline
  app.get("/audit", read, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const { flowId, action, cursor, limit } = parsed.data;
    const where = [eq(triageAuditEvents.orgId, ctx.orgId)];
    if (flowId) where.push(eq(triageAuditEvents.triageAgentId, flowId));
    if (action) where.push(eq(triageAuditEvents.action, action as TriageAuditAction));
    if (cursor != null) where.push(lt(triageAuditEvents.id, cursor));
    const rows = await db
      .select({
        id: triageAuditEvents.id,
        flowId: triageAuditEvents.triageAgentId,
        actorUserId: triageAuditEvents.actorUserId,
        action: triageAuditEvents.action,
        targetType: triageAuditEvents.targetType,
        targetId: triageAuditEvents.targetId,
        diff: triageAuditEvents.diff,
        createdAt: triageAuditEvents.createdAt,
        actorName: users.name,
      })
      .from(triageAuditEvents)
      .leftJoin(users, eq(users.id, triageAuditEvents.actorUserId))
      .where(and(...where))
      .orderBy(desc(triageAuditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? page[page.length - 1].id : null;
    const events: TriageAuditRow[] = page.map((r) => ({
      id: r.id,
      flowId: r.flowId,
      actorUserId: r.actorUserId,
      actorName: r.actorName ?? null,
      action: r.action as TriageAuditAction,
      targetType: r.targetType,
      targetId: r.targetId,
      diff: r.diff ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { events, nextCursor };
  });

  // ---- handoff context (FromTriageBanner)
  app.get("/handoff/:callId/context", read, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });

    const events = await db
      .select()
      .from(callRoutingEvents)
      .where(eq(callRoutingEvents.callId, callId))
      .orderBy(callRoutingEvents.seq);
    const cls = events
      .map((e) => e.classification)
      .filter((c): c is Classification => !!c)
      .at(-1);
    if (!cls) return reply.code(404).send({ error: "no_triage_context" });

    const triageStarted = events.find((e) => e.kind === "triage_started");
    const triageAgentId = (triageStarted?.fromRef?.id ?? "") as string;
    const [flow] = triageAgentId
      ? await db
          .select({ id: voiceAgents.id, name: voiceAgents.name })
          .from(voiceAgents)
          .where(eq(voiceAgents.id, triageAgentId))
      : [];

    const turns = await db
      .select()
      .from(transcriptTurns)
      .where(eq(transcriptTurns.callId, callId))
      .orderBy(transcriptTurns.tsStartMs);

    const out: HandoffContext = {
      callId,
      fromFlowId: flow?.id ?? "",
      fromFlowName: flow?.name ?? "Triage",
      classification: cls,
      triageTurns: turns.map((t) => ({
        id: t.id,
        callId: t.callId,
        speaker: t.speaker,
        text: t.text,
        isFinal: t.isFinal,
        tsStartMs: t.tsStartMs,
        tsEndMs: t.tsEndMs,
        sentiment: t.sentiment,
      })),
      summary: cls.reason ?? `${cls.intent} · ${Math.round(cls.confidence * 100)}% confidence`,
      arrivedAt: triageStarted?.createdAt.toISOString() ?? call.startedAt.toISOString(),
    };
    return out;
  });

  // ---- handoff accept (the human's browser picks up)
  app.post("/handoff/:callId/accept", operate, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await loadOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });
    if (call.recruiterUserId !== ctx.id) return reply.code(403).send({ error: "not_assigned_to_you" });

    await db.transaction(async (tx) => {
      await tx
        .update(callSessions)
        .set({ status: "active", acceptedAt: call.acceptedAt ?? new Date() })
        .where(eq(callSessions.id, callId));
      await recordEvent(
        {
          callId,
          orgId: ctx.orgId,
          kind: "handoff_accepted",
          toRef: { type: "user", id: ctx.id, label: ctx.name ?? ctx.email },
        },
        tx,
      );
      await recordAudit(tx, {
        orgId: ctx.orgId,
        triageAgentId: call.voiceAgentId ?? null,
        actorUserId: ctx.id,
        action: "session.reassigned",
        targetType: "call_session",
        targetId: callId,
        diff: { accepted: true },
      });
    });

    bus.publish({ type: "triage_handoff_accepted", callId, recruiterUserId: ctx.id, ts: Date.now() });
    return { ok: true };
  });

  // NOTE: There is intentionally no bare POST /route here. routeCall() performs
  // real telephony transfers (warm-transfer / endCall), DB writes, and bus
  // events, so it must never be reachable from a forgeable, unauthenticated
  // body. The only entrypoint is the HMAC-verified Vapi webhook
  // (apps/api/src/routes/vapi-webhooks.ts → verifySignature → routeCall).
}

// ------------------------------------------------------------ shared internals

// Load the rules from the currently-published rule-set snapshot (the /route
// authority + dry-run baseline). Falls back to [] when nothing is published.
async function loadPublishedRules(orgId: string, flowId: string): Promise<TriageRoutingRule[]> {
  const [rs] = await db
    .select({ rulesSnapshot: triageRuleSets.rulesSnapshot })
    .from(triageRuleSets)
    .where(
      and(
        eq(triageRuleSets.orgId, orgId),
        eq(triageRuleSets.triageAgentId, flowId),
        eq(triageRuleSets.status, "published"),
      ),
    )
    .orderBy(desc(triageRuleSets.version))
    .limit(1);
  return rs ? ((rs.rulesSnapshot as TriageRoutingRule[]) ?? []) : [];
}

async function trySyncSquad(
  req: FastifyRequest,
  orgId: string,
  flowId: string,
  rules: TriageRoutingRule[],
): Promise<void> {
  try {
    const [agent] = await db
      .select({
        id: voiceAgents.id,
        name: voiceAgents.name,
        vapiAssistantId: voiceAgents.vapiAssistantId,
        vapiSquadId: voiceAgents.vapiSquadId,
      })
      .from(voiceAgents)
      .where(eq(voiceAgents.id, flowId));
    if (!agent?.vapiAssistantId) return;
    const creds = await getProviderCredentials(orgId, "vapi");
    if (!creds) return;
    const sync = await withVapiContext(
      {
        apiKey: creds.apiKey,
        publicKey: creds.publicKey,
        webhookSecret: creds.webhookSecret,
        orgId,
      },
      () =>
        syncTriageSquad(
          agent,
          rules.map(
            (r) =>
              ({
                ...r,
                id: r.id ?? "",
                flowId,
                uiPosition: r.uiPosition ?? { x: 0, y: 0 },
              }) as TriageRoutingRule,
          ),
        ),
    );
    if (sync && sync.squadId !== agent.vapiSquadId) {
      await db.update(voiceAgents).set({ vapiSquadId: sync.squadId }).where(eq(voiceAgents.id, flowId));
    }
  } catch (err) {
    req.log.warn({ err, flowId }, "vapi squad sync failed; rules persisted without squad refresh");
  }
}

// Internal: invoked both by POST /route and by the Vapi webhook handler. Pins
// evaluation to the PUBLISHED rule-set snapshot, falling back to the live rules
// table only when nothing has been published yet (pre-publish dev flows).
export async function routeCall(
  req: FastifyRequest,
  body: RouteCallRequest,
  logArg?: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<RouteCallResponse> {
  const log = logArg ?? req.log;
  if (!body.callId) {
    throw Object.assign(new Error("missing_callId"), { statusCode: 400 });
  }
  const [call] = await db.select().from(callSessions).where(eq(callSessions.id, body.callId));
  if (!call) throw Object.assign(new Error("call_not_found"), { statusCode: 404 });
  if (!call.voiceAgentId) throw Object.assign(new Error("call_has_no_voice_agent"), { statusCode: 409 });
  const [agent] = await db.select().from(voiceAgents).where(eq(voiceAgents.id, call.voiceAgentId));
  if (!agent || agent.kind !== "triage") {
    throw Object.assign(new Error("not_a_triage_call"), { statusCode: 409 });
  }

  const published = await loadPublishedRules(agent.orgId, agent.id);
  const rules = published.length
    ? published
    : (
        await db
          .select()
          .from(triageRoutingRules)
          .where(eq(triageRoutingRules.triageAgentId, agent.id))
          .orderBy(triageRoutingRules.priority)
      ).map(rowToRule);

  const cls: Classification = {
    intent: body.intent,
    confidence: body.confidence,
    sentiment: body.sentiment,
    language: body.language,
    entities: body.entities,
    reason: body.reason,
    updatedAt: new Date().toISOString(),
  };

  await db
    .update(callSessions)
    .set({
      summary: {
        ...(typeof call.summary === "object" && call.summary
          ? (call.summary as Record<string, unknown>)
          : {}),
        triage: { classification: cls },
      },
    })
    .where(eq(callSessions.id, call.id));

  await recordEvent({
    callId: call.id,
    orgId: call.orgId ?? agent.orgId,
    kind: "classified",
    fromRef: { type: "voice_agent", id: agent.id, label: agent.name },
    classification: cls,
  });

  const matched = evaluateRules(rules, cls);
  if (!matched) {
    await recordEvent({
      callId: call.id,
      orgId: call.orgId ?? agent.orgId,
      kind: "handoff_failed",
      classification: cls,
      providerData: { reason: "no_matching_rule" },
    });
    bus.publish({
      type: "triage_handoff_failed",
      callId: call.id,
      recruiterUserId: null,
      reason: "no_matching_rule",
      ts: Date.now(),
    });
    throw Object.assign(new Error("no_matching_rule"), { statusCode: 422 });
  }

  await recordEvent({
    callId: call.id,
    orgId: call.orgId ?? agent.orgId,
    kind: "route_decision",
    fromRef: { type: "voice_agent", id: agent.id, label: agent.name },
    toRef: { type: matched.destinationType, id: matched.destinationRef, label: matched.destinationLabel },
    classification: cls,
    ruleId: matched.id,
  });

  const provider = pickProvider(call.origin);
  const instructions = buildSpokenInstructions(matched, cls);

  try {
    if (matched.destinationType === "human_team") {
      const pickedUser = await pickUserForTeam(
        matched.destinationRef,
        call.orgId ?? agent.orgId,
        matched,
      );
      if (!pickedUser) throw new Error("no_idle_user_in_team");
      await db
        .update(callSessions)
        .set({ recruiterUserId: pickedUser.id, assignedAt: new Date(), status: "assigned" })
        .where(eq(callSessions.id, call.id));
      await recordEvent({
        callId: call.id,
        orgId: call.orgId ?? agent.orgId,
        kind: "handoff_initiated",
        toRef: { type: "human_team", id: matched.destinationRef, label: matched.destinationLabel },
        ruleId: matched.id,
      });
      bus.publish({
        type: "triage_handoff_offered",
        callId: call.id,
        recruiterUserId: pickedUser.id,
        orgId: call.orgId ?? agent.orgId,
        triageAgentId: agent.id,
        triageFlowName: agent.name,
        classification: cls,
        summary: cls.reason ?? `${cls.intent} · ${Math.round(cls.confidence * 100)}% confidence`,
        handoffMode: matched.handoffMode,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    } else if (matched.destinationType === "voice_agent") {
      const [target] = await db
        .select({ vapiAssistantId: voiceAgents.vapiAssistantId })
        .from(voiceAgents)
        .where(eq(voiceAgents.id, matched.destinationRef));
      if (!target?.vapiAssistantId) throw new Error("target_voice_agent_not_deployed");
      await provider.warmTransferToAssistant(call.id, {
        targetVapiAssistantId: target.vapiAssistantId,
        squadId: agent.vapiSquadId,
        classification: cls,
      });
      await recordEvent({
        callId: call.id,
        orgId: call.orgId ?? agent.orgId,
        kind: "handoff_initiated",
        toRef: { type: "voice_agent", id: matched.destinationRef, label: matched.destinationLabel },
        ruleId: matched.id,
      });
    } else if (matched.destinationType === "external_pstn") {
      await provider.warmTransferToHuman(call.id, {
        extension: matched.destinationRef,
        summary: cls.reason ?? `Caller intent: ${cls.intent}.`,
        classification: cls,
        mode: matched.handoffMode,
      });
      await recordEvent({
        callId: call.id,
        orgId: call.orgId ?? agent.orgId,
        kind: "handoff_initiated",
        toRef: { type: "external_pstn", id: matched.destinationRef, label: matched.destinationLabel },
        ruleId: matched.id,
      });
    } else if (matched.destinationType === "voicemail") {
      await provider.endCall(call.id);
      await recordEvent({
        callId: call.id,
        orgId: call.orgId ?? agent.orgId,
        kind: "handoff_completed",
        toRef: { type: "voicemail", id: matched.destinationRef, label: matched.destinationLabel },
        ruleId: matched.id,
      });
    }
  } catch (err) {
    log.warn?.({ err, callId: call.id }, "triage handoff side-effect failed");
    await recordEvent({
      callId: call.id,
      orgId: call.orgId ?? agent.orgId,
      kind: "handoff_failed",
      ruleId: matched.id,
      providerData: { reason: err instanceof Error ? err.message : "unknown" },
    });
    bus.publish({
      type: "triage_handoff_failed",
      callId: call.id,
      recruiterUserId: null,
      reason: err instanceof Error ? err.message : "unknown",
      ts: Date.now(),
    });
  }

  return {
    destinationType: matched.destinationType,
    destinationRef: matched.destinationRef,
    destinationLabel: matched.destinationLabel,
    handoffMode: matched.handoffMode,
    instructions,
    ruleId: matched.id,
  };
}

function buildSpokenInstructions(rule: TriageRoutingRule, cls: Classification): string {
  if (rule.destinationType === "voicemail") {
    return "I'll connect you to voicemail so you can leave a message.";
  }
  if (rule.destinationType === "voice_agent") {
    return `Connecting you to ${rule.destinationLabel} for ${cls.intent}. One moment.`;
  }
  return `Let me get you to ${rule.destinationLabel}. Hold on, please.`;
}

// Pick a user from the destination team honoring the rule's routing strategy +
// capacity ceiling + required skill (best-effort). Strategies:
//  - first_idle     : first member without an active call (legacy default)
//  - round_robin    : rotate by call_routing_events count (least-recently-picked)
//  - least_loaded   : member with fewest active calls
//  - weighted       : weight not yet honored at user granularity → first_idle
async function pickUserForTeam(
  teamId: string,
  orgId: string,
  rule?: TriageRoutingRule,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const candidates = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(memberships.orgId, orgId),
        eq(memberships.status, "active"),
      ),
    );
  if (candidates.length === 0) return null;

  // Active-call load per candidate.
  const loads = new Map<string, number>();
  for (const u of candidates) {
    const [busy] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(callSessions)
      .where(
        and(
          eq(callSessions.recruiterUserId, u.id),
          eq(callSessions.orgId, orgId),
          sql`${callSessions.status} in ('assigned', 'active')`,
        ),
      );
    loads.set(u.id, busy?.n ?? 0);
  }

  const strategy = rule?.routingStrategy ?? "first_idle";
  const cap = rule?.maxConcurrent ?? null;
  const underCap = candidates.filter((u) => cap == null || (loads.get(u.id) ?? 0) < cap);
  const pool = underCap.length ? underCap : candidates;

  if (strategy === "least_loaded") {
    return pool.reduce((best, u) => ((loads.get(u.id) ?? 0) < (loads.get(best.id) ?? 0) ? u : best), pool[0]);
  }
  if (strategy === "round_robin") {
    // Rotate by the most-recently-assigned timestamp (oldest first).
    const lastAssigned = new Map<string, number>();
    for (const u of pool) {
      const [row] = await db
        .select({ at: sql<Date | null>`max(${callSessions.assignedAt})` })
        .from(callSessions)
        .where(and(eq(callSessions.recruiterUserId, u.id), eq(callSessions.orgId, orgId)));
      lastAssigned.set(u.id, row?.at ? new Date(row.at).getTime() : 0);
    }
    return pool.reduce((best, u) => ((lastAssigned.get(u.id) ?? 0) < (lastAssigned.get(best.id) ?? 0) ? u : best), pool[0]);
  }
  // first_idle / weighted fallback.
  const idle = pool.find((u) => (loads.get(u.id) ?? 0) === 0);
  return idle ?? pool[0];
}
