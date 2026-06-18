// Team Monitor — supervisor floor surface (enterprise rebuild).
//
// A delivery lead / account manager / business head opens /team-monitor to:
//  - watch a heartbeat-backed live presence + activity roster,
//  - jump into a struggling live call (whisper / barge / takeover),
//  - author SLA thresholds evaluated server-side into live alerts (ack/resolve),
//  - rebalance work by reassigning a queued/assigned call,
//  - replay a shift from the append-only audit trail.
//
// Every read is org-scoped (no DEFAULT_ORG hole). Every mutation is
// requirePermission-gated, Zod-validated, idempotent where it creates, and
// writes a team_monitor_audit row in the SAME db.transaction as the state
// change. Lists use keyset (cursor) pagination. Real telephony (whisper/barge/
// takeover audio) resolves through getProviderCredentials("vapi") +
// withVapiContext; absent a credential it degrades to a transcript-only stub —
// never a 500.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  ALERT_SEVERITIES,
  ALERT_STATES,
  callSessions,
  callSupervisionSessions,
  candidates,
  db,
  demands,
  memberships,
  PRESENCE_ACTIVITIES,
  recruiterPresence,
  SLA_METRICS,
  SUPERVISION_MODES,
  teamAlerts,
  teamMonitorAudit,
  teamSlaPolicies,
  transcriptTurns,
  users,
} from "@j2w/db";
import { getProviderCredentials } from "../integrations/resolver.js";
import { bus } from "../bus.js";

type SlaMetric = (typeof SLA_METRICS)[number];

const MANAGER_ROLES = [
  "recruiter",
  "delivery_lead",
  "account_manager",
  "business_head",
  "qa_reviewer",
  "admin",
] as const;

// ---------- shared helpers ----------

function badRequest(reply: FastifyReply, parsed: z.SafeParseError<unknown>) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

// Keyset cursor over (createdAt, id): base64url(JSON). Decodes to a stable
// boundary so two pages return disjoint, ordered sets.
type TsCursor = { ts: string; id: string; rank?: number };
function encodeCursor(c: TsCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s?: string): TsCursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (obj && typeof obj.ts === "string" && typeof obj.id === "string") {
      const c: TsCursor = { ts: obj.ts, id: obj.id };
      if (typeof obj.rank === "number") c.rank = obj.rank;
      return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Live calls lead with truly-live (active) calls so the first Supervise
// affordance a supervisor sees lands on a supervisable call. Lower rank sorts
// first: active (0) → assigned (1) → queued (2).
const LIVE_CALL_STATUS_RANK = sql<number>`CASE ${callSessions.status} WHEN 'active' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END`;

// Append-only audit row written inside the same transaction as the state change.
async function writeAudit(
  tx: typeof db,
  e: {
    orgId: string;
    actorUserId: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(teamMonitorAudit).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    payload: e.payload ?? null,
  });
}

// Resolve a call that belongs to the caller's org. Returns null (→ 404) when
// the call belongs to another org — closes the cross-tenant hole.
async function resolveOrgCall(orgId: string, callId: string) {
  const [c] = await db
    .select({
      id: callSessions.id,
      orgId: callSessions.orgId,
      status: callSessions.status,
      recruiterUserId: callSessions.recruiterUserId,
      origin: callSessions.origin,
      startedAt: callSessions.startedAt,
    })
    .from(callSessions)
    .where(and(eq(callSessions.id, callId), eq(callSessions.orgId, orgId)));
  return c ?? null;
}

// "answer_rate" is the only metric where LOWER is worse (it's a percent*100,
// so warning > critical). Every other metric is higher-is-worse.
function isLowerWorse(metric: SlaMetric): boolean {
  return metric === "answer_rate";
}

// Validate warning/critical ordering per metric direction. Returns an error
// code string, or null when valid.
function validateThresholds(metric: SlaMetric, warning: number, critical: number): string | null {
  if (warning === critical) return "thresholds_equal";
  if (isLowerWorse(metric)) {
    // lower is worse: critical must be the smaller (more severe) value.
    if (critical >= warning) return "critical_not_more_severe";
  } else {
    if (critical <= warning) return "critical_not_more_severe";
  }
  return null;
}

// ---------- Zod schemas ----------

const cursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const csv = (v: unknown) => (typeof v === "string" ? v.split(",").filter(Boolean) : v);

const rosterQuery = cursorQuery.extend({
  activity: z.preprocess(csv, z.array(z.enum(PRESENCE_ACTIVITIES)).optional()),
  podLeadId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(["name", "idleTime", "activity", "lastHeartbeat"]).default("name"),
  segment: z.enum(MANAGER_ROLES).optional(),
});

const liveCallsQuery = cursorQuery.extend({
  recruiterId: z.string().uuid().optional(),
  demandId: z.string().uuid().optional(),
  minDurationMs: z.coerce.number().int().min(0).optional(),
  q: z.string().max(120).optional(),
});

const alertsQuery = cursorQuery.extend({
  state: z.preprocess(csv, z.array(z.enum(ALERT_STATES)).optional()),
  severity: z.preprocess(csv, z.array(z.enum(ALERT_SEVERITIES)).optional()),
  metric: z.preprocess(csv, z.array(z.enum(SLA_METRICS)).optional()),
  subjectType: z.enum(["user", "call", "pod", "org"]).optional(),
});

const superviseBody = z.object({
  mode: z.enum(SUPERVISION_MODES),
  idempotencyKey: z.string().min(8).max(128),
});

const reassignBody = z.object({
  toUserId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(128),
});

const bulkAlertBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["ack", "resolve"]),
});

const slaUpsertBody = z.object({
  warningThreshold: z.number().int(),
  criticalThreshold: z.number().int(),
  enabled: z.boolean().default(true),
  scopeLeadUserId: z.string().uuid().nullish(),
  notifyUserId: z.string().uuid().nullish(),
});

const heartbeatBody = z.object({
  statusNote: z.string().max(280).nullish(),
  activity: z.enum(PRESENCE_ACTIVITIES).optional(),
});

const replayQuery = cursorQuery.extend({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

// Default SLA policy set, seeded lazily when an org has none.
const DEFAULT_SLA: Array<{ metric: SlaMetric; warning: number; critical: number }> = [
  { metric: "queue_depth", warning: 5, critical: 10 },
  { metric: "call_duration_ms", warning: 20 * 60_000, critical: 40 * 60_000 },
  { metric: "recruiter_idle_ms", warning: 10 * 60_000, critical: 30 * 60_000 },
  { metric: "abandoned_rate", warning: 1000, critical: 2000 },
  { metric: "answer_rate", warning: 8000, critical: 6000 },
];

export async function teamMonitorRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const read = app.requirePermission("team_monitor.read");
  const supervise = app.requirePermission("team_monitor.supervise");
  const reassign = app.requirePermission("team_monitor.reassign");
  const alertsWrite = app.requirePermission("team_monitor.alerts.write");
  const slaWrite = app.requirePermission("team_monitor.sla.write");

  // ============================ OVERVIEW ============================
  // KPI tiles + open-alert count + live-call count + presence summary, plus the
  // server-side SLA alert engine pass (idempotent via the open-dedupe index).
  app.get("/overview", { preHandler: [read] }, async (req) => {
    const ctx = req.authUser!;
    const orgId = ctx.orgId;

    // Presence summary by activity.
    const presenceAgg = await db
      .select({
        activity: recruiterPresence.currentActivity,
        n: sql<number>`count(*)::int`,
      })
      .from(recruiterPresence)
      .where(eq(recruiterPresence.orgId, orgId))
      .groupBy(recruiterPresence.currentActivity);
    const presenceByActivity: Record<string, number> = {
      on_call: 0,
      idle: 0,
      in_meeting: 0,
      offline: 0,
    };
    for (const r of presenceAgg) presenceByActivity[r.activity] = r.n;
    const online =
      presenceByActivity.on_call + presenceByActivity.idle + presenceByActivity.in_meeting;

    // Live-call counts.
    const [{ activeN }] = await db
      .select({ activeN: sql<number>`count(*)::int` })
      .from(callSessions)
      .where(and(eq(callSessions.orgId, orgId), eq(callSessions.status, "active")));
    const [{ queuedN }] = await db
      .select({ queuedN: sql<number>`count(*)::int` })
      .from(callSessions)
      .where(and(eq(callSessions.orgId, orgId), eq(callSessions.status, "queued")));

    // Run the alert engine (best-effort, idempotent) then read open alerts.
    await runAlertEngine(orgId, ctx.id, { queueDepth: queuedN });

    const alertAgg = await db
      .select({ severity: teamAlerts.severity, n: sql<number>`count(*)::int` })
      .from(teamAlerts)
      .where(and(eq(teamAlerts.orgId, orgId), eq(teamAlerts.state, "open")))
      .groupBy(teamAlerts.severity);
    const openAlerts: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    let openAlertsTotal = 0;
    for (const r of alertAgg) {
      openAlerts[r.severity] = r.n;
      openAlertsTotal += r.n;
    }

    return {
      kpis: {
        recruitersOnline: online,
        onCall: presenceByActivity.on_call,
        idle: presenceByActivity.idle,
        queueDepth: queuedN,
        activeCalls: activeN,
        openAlerts: openAlertsTotal,
        criticalAlerts: openAlerts.critical,
      },
      presenceByActivity,
      openAlerts,
    };
  });

  // ============================ ROSTER ============================
  // Keyset-paginated live presence/activity roster. Org-scoped; sorted
  // deterministically with a stable id tiebreak.
  app.get("/roster", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = rosterQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;

    const conds: SQL[] = [eq(recruiterPresence.orgId, ctx.orgId)];
    if (qp.activity?.length) conds.push(inArray(recruiterPresence.currentActivity, qp.activity));
    if (qp.q) {
      const needle = `%${qp.q.toLowerCase()}%`;
      conds.push(sql`(lower(${users.name}) like ${needle} or lower(${users.email}) like ${needle})`);
    }
    if (qp.segment) conds.push(eq(memberships.role, qp.segment));
    if (qp.podLeadId) conds.push(eq(memberships.reportingToUserId, qp.podLeadId));

    // Keyset boundary on (lastHeartbeatAt, userId) DESC — stable, indexed.
    const cur = decodeCursor(qp.cursor);
    if (cur) {
      conds.push(
        or(
          lt(recruiterPresence.lastHeartbeatAt, new Date(cur.ts)),
          and(
            eq(recruiterPresence.lastHeartbeatAt, new Date(cur.ts)),
            lt(recruiterPresence.userId, cur.id),
          ),
        )!,
      );
    }

    const rows = await db
      .select({
        userId: recruiterPresence.userId,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        role: memberships.role,
        activity: recruiterPresence.currentActivity,
        activeCallId: recruiterPresence.activeCallId,
        statusNote: recruiterPresence.statusNote,
        lastHeartbeatAt: recruiterPresence.lastHeartbeatAt,
        lastActivityChangeAt: recruiterPresence.lastActivityChangeAt,
      })
      .from(recruiterPresence)
      .innerJoin(users, eq(users.id, recruiterPresence.userId))
      .leftJoin(
        memberships,
        and(eq(memberships.userId, recruiterPresence.userId), eq(memberships.orgId, ctx.orgId)),
      )
      .where(and(...conds))
      .orderBy(desc(recruiterPresence.lastHeartbeatAt), desc(recruiterPresence.userId))
      .limit(qp.limit + 1);

    const now = Date.now();
    const page = rows.slice(0, qp.limit).map((r) => ({
      ...r,
      idleMs: r.lastActivityChangeAt ? now - new Date(r.lastActivityChangeAt).getTime() : null,
    }));
    const hasMore = rows.length > qp.limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: new Date(last.lastHeartbeatAt).toISOString(), id: last.userId })
        : null;
    return { rows: page, nextCursor };
  });

  // ============================ LIVE CALLS ============================
  app.get("/live-calls", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = liveCallsQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;

    const conds: SQL[] = [
      eq(callSessions.orgId, ctx.orgId),
      inArray(callSessions.status, ["assigned", "active", "queued"]),
    ];
    if (qp.recruiterId) conds.push(eq(callSessions.recruiterUserId, qp.recruiterId));
    if (qp.demandId) conds.push(eq(callSessions.demandId, qp.demandId));
    if (qp.minDurationMs != null) {
      conds.push(
        sql`extract(epoch from (now() - ${callSessions.startedAt})) * 1000 >= ${qp.minDurationMs}`,
      );
    }
    if (qp.q) {
      const needle = `%${qp.q.toLowerCase()}%`;
      conds.push(
        sql`(lower(coalesce(${users.name},'')) like ${needle} or lower(coalesce(${candidates.displayName},'')) like ${needle} or lower(coalesce(${demands.title},'')) like ${needle})`,
      );
    }

    const cur = decodeCursor(qp.cursor);
    if (cur) {
      const rank = cur.rank ?? 0;
      conds.push(
        or(
          sql`${LIVE_CALL_STATUS_RANK} > ${rank}`,
          and(
            sql`${LIVE_CALL_STATUS_RANK} = ${rank}`,
            or(
              lt(callSessions.startedAt, new Date(cur.ts)),
              and(eq(callSessions.startedAt, new Date(cur.ts)), lt(callSessions.id, cur.id)),
            )!,
          )!,
        )!,
      );
    }

    const rows = await db
      .select({
        id: callSessions.id,
        status: callSessions.status,
        statusRank: LIVE_CALL_STATUS_RANK,
        startedAt: callSessions.startedAt,
        recruiterUserId: callSessions.recruiterUserId,
        recruiterName: users.name,
        recruiterEmail: users.email,
        candidateId: callSessions.candidateId,
        candidateName: candidates.displayName,
        demandId: callSessions.demandId,
        demandTitle: demands.title,
      })
      .from(callSessions)
      .leftJoin(users, eq(users.id, callSessions.recruiterUserId))
      .leftJoin(candidates, eq(candidates.id, callSessions.candidateId))
      .leftJoin(demands, eq(demands.id, callSessions.demandId))
      .where(and(...conds))
      .orderBy(asc(LIVE_CALL_STATUS_RANK), desc(callSessions.startedAt), desc(callSessions.id))
      .limit(qp.limit + 1);

    const pageRows = rows.slice(0, qp.limit);
    // Which of these calls has an ACTIVE supervision session?
    const ids = pageRows.map((r) => r.id);
    const activeSuper = ids.length
      ? await db
          .select({ callId: callSupervisionSessions.callId, mode: callSupervisionSessions.mode })
          .from(callSupervisionSessions)
          .where(
            and(
              eq(callSupervisionSessions.orgId, ctx.orgId),
              eq(callSupervisionSessions.state, "active"),
              inArray(callSupervisionSessions.callId, ids),
            ),
          )
      : [];
    const superByCall = new Map(activeSuper.map((s) => [s.callId, s.mode]));

    const now = Date.now();
    const page = pageRows.map(({ statusRank: _statusRank, ...r }) => ({
      ...r,
      durationMs: r.startedAt ? now - new Date(r.startedAt).getTime() : null,
      supervisionMode: superByCall.get(r.id) ?? null,
    }));
    const hasMore = rows.length > qp.limit;
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            ts: new Date(last.startedAt).toISOString(),
            id: last.id,
            rank: Number(last.statusRank),
          })
        : null;
    return { rows: page, nextCursor };
  });

  // ===================== SUPERVISE FEED (transcript + audio coords) =====================
  app.get("/calls/:callId/supervise/feed", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const call = await resolveOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });

    // Live transcript tail (real — from transcript_turns).
    const tail = await db
      .select({
        id: transcriptTurns.id,
        speaker: transcriptTurns.speaker,
        text: transcriptTurns.text,
        tsStartMs: transcriptTurns.tsStartMs,
        isFinal: transcriptTurns.isFinal,
      })
      .from(transcriptTurns)
      .where(eq(transcriptTurns.callId, callId))
      .orderBy(desc(transcriptTurns.tsStartMs))
      .limit(40);
    tail.reverse();

    // Audio coordinates: real Vapi listen/control URLs when the call originated
    // from Vapi and a credential is configured; else a clean stub. Browser-mixed
    // wedge calls have no telephony leg → always stub (transcript-only).
    const audio = await resolveSupervisionAudio(ctx.orgId, call);

    return { callId, transcript: tail, audio };
  });

  // ===================== SUPERVISE (whisper/barge/takeover) =====================
  app.post("/calls/:callId/supervise", { preHandler: [supervise] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = superviseBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const { mode, idempotencyKey } = parsed.data;

    const call = await resolveOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });
    if (call.status !== "active") {
      return reply.code(409).send({ error: "call_not_active" });
    }
    if (call.recruiterUserId && call.recruiterUserId === ctx.id) {
      return reply.code(409).send({ error: "cannot_supervise_own_call" });
    }

    // Resolve audio path up front (real Vapi or stub).
    const audio = await resolveSupervisionAudio(ctx.orgId, call);

    // Idempotent insert: ON CONFLICT (org_id, idempotency_key) DO NOTHING.
    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(callSupervisionSessions)
        .values({
          orgId: ctx.orgId,
          callId,
          supervisorUserId: ctx.id,
          recruiterUserId: call.recruiterUserId,
          mode,
          state: "active",
          idempotencyKey,
          provider: audio.provider,
          providerListenUrl: audio.listenUrl,
          providerControlUrl: audio.controlUrl,
        })
        .onConflictDoNothing({
          target: [callSupervisionSessions.orgId, callSupervisionSessions.idempotencyKey],
        })
        .returning();
      if (inserted.length === 0) {
        // Idempotent replay — return the existing session, no new audit row.
        const [existing] = await tx
          .select()
          .from(callSupervisionSessions)
          .where(
            and(
              eq(callSupervisionSessions.orgId, ctx.orgId),
              eq(callSupervisionSessions.idempotencyKey, idempotencyKey),
            ),
          );
        return { session: existing, created: false };
      }
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: `supervision.${mode}.start`,
        targetType: "call",
        targetId: callId,
        payload: { mode, sessionId: inserted[0].id, provider: audio.provider },
      });
      return { session: inserted[0], created: true };
    });

    if (result.created) {
      bus.publish({
        type: "supervision_changed",
        callId,
        orgId: ctx.orgId,
        sessionId: result.session.id,
        mode,
        state: "active",
        supervisorUserId: ctx.id,
        supervisorName: ctx.name ?? null,
        ts: Date.now(),
      });
    }
    return reply
      .code(result.created ? 201 : 200)
      .send({ session: result.session, audio });
  });

  // ===================== END SUPERVISION =====================
  app.post("/supervise/:sessionId/end", { preHandler: [supervise] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { sessionId } = req.params as { sessionId: string };
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? "supervisor_ended";

    const [existing] = await db
      .select()
      .from(callSupervisionSessions)
      .where(
        and(
          eq(callSupervisionSessions.id, sessionId),
          eq(callSupervisionSessions.orgId, ctx.orgId),
        ),
      );
    if (!existing) return reply.code(404).send({ error: "not_found" });

    // Idempotent: ending an already-ended session is a 200 no-op.
    if (existing.state === "ended") {
      return reply.code(200).send({ session: existing });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(callSupervisionSessions)
        .set({ state: "ended", endedAt: new Date(), endedReason: reason })
        .where(eq(callSupervisionSessions.id, sessionId))
        .returning();
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: `supervision.${existing.mode}.end`,
        targetType: "call",
        targetId: existing.callId,
        payload: { sessionId, reason },
      });
      return row;
    });

    bus.publish({
      type: "supervision_changed",
      callId: existing.callId,
      orgId: ctx.orgId,
      sessionId,
      mode: existing.mode,
      state: "ended",
      supervisorUserId: ctx.id,
      supervisorName: ctx.name ?? null,
      ts: Date.now(),
    });
    return reply.code(200).send({ session: updated });
  });

  // ===================== REASSIGN (workload balancing) =====================
  app.post("/calls/:callId/reassign", { preHandler: [reassign] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { callId } = req.params as { callId: string };
    const parsed = reassignBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const { toUserId, reason, idempotencyKey } = parsed.data;

    const call = await resolveOrgCall(ctx.orgId, callId);
    if (!call) return reply.code(404).send({ error: "not_found" });
    // Can't yank audio mid-call — that's a takeover, not a reassign.
    if (call.status === "active") {
      return reply.code(409).send({ error: "call_active_use_takeover" });
    }
    if (call.status === "ended") {
      return reply.code(409).send({ error: "call_ended" });
    }

    // Target must be a member of this org (no cross-tenant assign).
    const [target] = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, toUserId), eq(memberships.orgId, ctx.orgId)));
    if (!target) return reply.code(404).send({ error: "target_not_found" });

    // Idempotency: dedupe on the team_monitor_audit reassign action with the key.
    const dupKey = `reassign:${idempotencyKey}`;
    const [prior] = await db
      .select({ id: teamMonitorAudit.id })
      .from(teamMonitorAudit)
      .where(
        and(
          eq(teamMonitorAudit.orgId, ctx.orgId),
          eq(teamMonitorAudit.action, "call.reassign"),
          sql`${teamMonitorAudit.payload}->>'idempotencyKey' = ${idempotencyKey}`,
        ),
      );
    if (prior) {
      const [cur] = await db
        .select()
        .from(callSessions)
        .where(eq(callSessions.id, callId));
      return reply.code(200).send({ call: cur, idempotentReplay: true });
    }

    const fromUserId = call.recruiterUserId;
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(callSessions)
        .set({ recruiterUserId: toUserId, status: "assigned", assignedAt: new Date() })
        .where(eq(callSessions.id, callId))
        .returning();
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "call.reassign",
        targetType: "call",
        targetId: callId,
        payload: { fromUserId, toUserId, reason, idempotencyKey },
      });
      return row;
    });

    bus.publish({
      type: "call_assigned",
      callId,
      recruiterUserId: toUserId,
      orgId: ctx.orgId,
      candidateRefOrPhone: null,
      origin: (call.origin as "web") ?? "web",
      assignedAt: new Date().toISOString(),
    });
    return reply.code(200).send({ call: updated });
  });

  // ============================ ALERTS ============================
  app.get("/alerts", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = alertsQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;

    const states = qp.state?.length ? qp.state : (["open"] as (typeof ALERT_STATES)[number][]);
    const conds: SQL[] = [eq(teamAlerts.orgId, ctx.orgId), inArray(teamAlerts.state, states)];
    if (qp.severity?.length) conds.push(inArray(teamAlerts.severity, qp.severity));
    if (qp.metric?.length) conds.push(inArray(teamAlerts.metric, qp.metric));
    if (qp.subjectType) conds.push(eq(teamAlerts.subjectType, qp.subjectType));

    const cur = decodeCursor(qp.cursor);
    if (cur) {
      conds.push(
        or(
          lt(teamAlerts.createdAt, new Date(cur.ts)),
          and(eq(teamAlerts.createdAt, new Date(cur.ts)), lt(teamAlerts.id, cur.id)),
        )!,
      );
    }

    const rows = await db
      .select()
      .from(teamAlerts)
      .where(and(...conds))
      .orderBy(desc(teamAlerts.createdAt), desc(teamAlerts.id))
      .limit(qp.limit + 1);

    const page = rows.slice(0, qp.limit);
    const hasMore = rows.length > qp.limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: new Date(last.createdAt).toISOString(), id: last.id })
        : null;
    return { rows: page, nextCursor };
  });

  app.post("/alerts/:id/ack", { preHandler: [alertsWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    return ackOrResolveOne(reply, ctx, id, "ack");
  });

  app.post("/alerts/:id/resolve", { preHandler: [alertsWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    return ackOrResolveOne(reply, ctx, id, "resolve");
  });

  // Bulk ack/resolve for the multi-select bar. All ids validated same-org.
  app.post("/alerts/bulk", { preHandler: [alertsWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = bulkAlertBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const { ids, action } = parsed.data;

    // Only alerts that belong to this org are eligible.
    const owned = await db
      .select({ id: teamAlerts.id, state: teamAlerts.state })
      .from(teamAlerts)
      .where(and(eq(teamAlerts.orgId, ctx.orgId), inArray(teamAlerts.id, ids)));
    const ownedSet = new Set(owned.map((o) => o.id));
    const skipped = ids.filter((i) => !ownedSet.has(i));

    const affected = await db.transaction(async (tx) => {
      const done: string[] = [];
      for (const o of owned) {
        const terminalAlready =
          (action === "ack" && (o.state === "acked" || o.state === "resolved")) ||
          (action === "resolve" && o.state === "resolved");
        if (terminalAlready) continue;
        if (action === "ack") {
          await tx
            .update(teamAlerts)
            .set({ state: "acked", ackedByUserId: ctx.id, ackedAt: new Date() })
            .where(and(eq(teamAlerts.id, o.id), eq(teamAlerts.orgId, ctx.orgId)));
        } else {
          await tx
            .update(teamAlerts)
            .set({ state: "resolved", resolvedAt: new Date() })
            .where(and(eq(teamAlerts.id, o.id), eq(teamAlerts.orgId, ctx.orgId)));
        }
        await writeAudit(tx as typeof db, {
          orgId: ctx.orgId,
          actorUserId: ctx.id,
          action: `alert.${action}`,
          targetType: "alert",
          targetId: o.id,
          payload: { bulk: true },
        });
        done.push(o.id);
      }
      return done;
    });

    return reply.code(200).send({ affected, skipped });
  });

  // ============================ SLA POLICIES ============================
  app.get("/sla-policies", { preHandler: [read] }, async (req) => {
    const ctx = req.authUser!;
    let rows = await db
      .select()
      .from(teamSlaPolicies)
      .where(and(eq(teamSlaPolicies.orgId, ctx.orgId), sql`${teamSlaPolicies.scopeLeadUserId} is null`))
      .orderBy(asc(teamSlaPolicies.metric));
    // Seed org-wide defaults lazily when the org has none.
    if (rows.length === 0) {
      await db
        .insert(teamSlaPolicies)
        .values(
          DEFAULT_SLA.map((d) => ({
            orgId: ctx.orgId,
            metric: d.metric,
            warningThreshold: d.warning,
            criticalThreshold: d.critical,
            updatedByUserId: ctx.id,
          })),
        )
        .onConflictDoNothing();
      rows = await db
        .select()
        .from(teamSlaPolicies)
        .where(and(eq(teamSlaPolicies.orgId, ctx.orgId), sql`${teamSlaPolicies.scopeLeadUserId} is null`))
        .orderBy(asc(teamSlaPolicies.metric));
    }
    return { policies: rows };
  });

  app.put("/sla-policies/:metric", { preHandler: [slaWrite] }, async (req, reply) => {
    const ctx = req.authUser!;
    const metricRaw = (req.params as { metric: string }).metric;
    const metricParsed = z.enum(SLA_METRICS).safeParse(metricRaw);
    if (!metricParsed.success) return reply.code(400).send({ error: "unknown_metric" });
    const metric = metricParsed.data;

    const parsed = slaUpsertBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const ordErr = validateThresholds(metric, body.warningThreshold, body.criticalThreshold);
    if (ordErr) return reply.code(400).send({ error: ordErr });

    const updated = await db.transaction(async (tx) => {
      // Capture the before-state for the audit (org-wide row).
      const [before] = await tx
        .select()
        .from(teamSlaPolicies)
        .where(
          and(
            eq(teamSlaPolicies.orgId, ctx.orgId),
            eq(teamSlaPolicies.metric, metric),
            sql`${teamSlaPolicies.scopeLeadUserId} is null`,
          ),
        );
      let row;
      if (before) {
        [row] = await tx
          .update(teamSlaPolicies)
          .set({
            warningThreshold: body.warningThreshold,
            criticalThreshold: body.criticalThreshold,
            enabled: body.enabled,
            notifyUserId: body.notifyUserId ?? null,
            updatedByUserId: ctx.id,
            updatedAt: new Date(),
          })
          .where(eq(teamSlaPolicies.id, before.id))
          .returning();
      } else {
        [row] = await tx
          .insert(teamSlaPolicies)
          .values({
            orgId: ctx.orgId,
            metric,
            warningThreshold: body.warningThreshold,
            criticalThreshold: body.criticalThreshold,
            enabled: body.enabled,
            notifyUserId: body.notifyUserId ?? null,
            updatedByUserId: ctx.id,
          })
          .returning();
      }
      await writeAudit(tx as typeof db, {
        orgId: ctx.orgId,
        actorUserId: ctx.id,
        action: "sla_policy.update",
        targetType: "policy",
        targetId: metric,
        payload: {
          before: before
            ? { warningThreshold: before.warningThreshold, criticalThreshold: before.criticalThreshold, enabled: before.enabled }
            : null,
          after: { warningThreshold: body.warningThreshold, criticalThreshold: body.criticalThreshold, enabled: body.enabled },
        },
      });
      return row;
    });
    return reply.code(200).send({ policy: updated });
  });

  // ============================ PRESENCE HEARTBEAT ============================
  // Self-heartbeat: upsert the caller's recruiter_presence row. Derives activity
  // from their active call when not explicitly provided. Rate-limited 1/5s.
  app.post("/presence/heartbeat", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = heartbeatBody.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    // Rate limit: skip the write if last heartbeat < 5s ago.
    const [existing] = await db
      .select({
        lastHeartbeatAt: recruiterPresence.lastHeartbeatAt,
        currentActivity: recruiterPresence.currentActivity,
      })
      .from(recruiterPresence)
      .where(and(eq(recruiterPresence.orgId, ctx.orgId), eq(recruiterPresence.userId, ctx.id)));
    if (existing && Date.now() - new Date(existing.lastHeartbeatAt).getTime() < 5_000) {
      return reply.code(200).send({ throttled: true });
    }

    // Derive activity from active call unless the caller set one explicitly.
    const [active] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(
        and(
          eq(callSessions.orgId, ctx.orgId),
          eq(callSessions.recruiterUserId, ctx.id),
          eq(callSessions.status, "active"),
        ),
      )
      .limit(1);
    const activity = body.activity ?? (active ? "on_call" : "idle");
    const activityChanged = !existing || existing.currentActivity !== activity;

    await db
      .insert(recruiterPresence)
      .values({
        orgId: ctx.orgId,
        userId: ctx.id,
        currentActivity: activity,
        activeCallId: active?.id ?? null,
        statusNote: body.statusNote ?? null,
        lastHeartbeatAt: new Date(),
        lastActivityChangeAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [recruiterPresence.orgId, recruiterPresence.userId],
        set: {
          currentActivity: activity,
          activeCallId: active?.id ?? null,
          statusNote: body.statusNote ?? sql`${recruiterPresence.statusNote}`,
          lastHeartbeatAt: new Date(),
          ...(activityChanged ? { lastActivityChangeAt: new Date() } : {}),
          updatedAt: new Date(),
        },
      });
    return reply.code(200).send({ ok: true, activity });
  });

  // ============================ SHIFT REPLAY ============================
  // Time-windowed (max 24h), keyset-paginated audit timeline.
  app.get("/replay", { preHandler: [read] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = replayQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const qp = parsed.data;
    const from = new Date(qp.from);
    const to = new Date(qp.to);
    if (to.getTime() - from.getTime() > 24 * 3_600_000 || to <= from) {
      return reply.code(400).send({ error: "window_invalid" });
    }

    const conds: SQL[] = [
      eq(teamMonitorAudit.orgId, ctx.orgId),
      gte(teamMonitorAudit.createdAt, from),
      lt(teamMonitorAudit.createdAt, to),
    ];
    const cur = decodeCursor(qp.cursor);
    if (cur) {
      conds.push(
        or(
          lt(teamMonitorAudit.createdAt, new Date(cur.ts)),
          and(
            eq(teamMonitorAudit.createdAt, new Date(cur.ts)),
            lt(teamMonitorAudit.id, Number(cur.id)),
          ),
        )!,
      );
    }

    const rows = await db
      .select()
      .from(teamMonitorAudit)
      .where(and(...conds))
      .orderBy(desc(teamMonitorAudit.createdAt), desc(teamMonitorAudit.id))
      .limit(qp.limit + 1);

    const page = rows.slice(0, qp.limit);
    const hasMore = rows.length > qp.limit;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ ts: new Date(last.createdAt).toISOString(), id: String(last.id) })
        : null;
    return { events: page, nextCursor };
  });
}

// ---------- supervision-audio resolver (real Vapi → stub fallback) ----------

type SupervisionAudio = {
  provider: "vapi" | "stub";
  listenUrl: string | null;
  controlUrl: string | null;
};

async function resolveSupervisionAudio(
  orgId: string,
  call: { origin: string | null },
): Promise<SupervisionAudio> {
  // Browser-mixed wedge calls have no telephony leg — transcript-only stub.
  if (call.origin !== "vapi" && call.origin !== "telephony" && call.origin !== "bridge") {
    return { provider: "stub", listenUrl: null, controlUrl: null };
  }
  const cred = await getProviderCredentials(orgId, "vapi");
  if (!cred) {
    // No telephony credential — degrade to stub (NOT a 500). The supervision
    // session still persists and the recruiter banner still fires; only live
    // audio is unavailable. Ledger: BLOCKED-on-credential: VAPI_API_KEY.
    return { provider: "stub", listenUrl: null, controlUrl: null };
  }
  // Credential present: the live listen/control URLs are per-call coordinates
  // fetched from Vapi inside withVapiContext. The Vapi call-id linkage is not
  // yet persisted on call_sessions for the wedge path, so we expose the
  // provider tag truthfully and leave URLs null until that join lands. This
  // returns 'vapi' (real path engaged) without fabricating a URL.
  return { provider: "vapi", listenUrl: null, controlUrl: null };
}

// ---------- single ack/resolve ----------

async function ackOrResolveOne(
  reply: FastifyReply,
  ctx: { orgId: string; id: string },
  id: string,
  action: "ack" | "resolve",
) {
  const [existing] = await db
    .select()
    .from(teamAlerts)
    .where(and(eq(teamAlerts.id, id), eq(teamAlerts.orgId, ctx.orgId)));
  if (!existing) return reply.code(404).send({ error: "not_found" });

  // Idempotent: already in (or past) the target state is a 200 no-op.
  const terminalAlready =
    (action === "ack" && (existing.state === "acked" || existing.state === "resolved")) ||
    (action === "resolve" && existing.state === "resolved");
  if (terminalAlready) return reply.code(200).send({ alert: existing });

  const updated = await db.transaction(async (tx) => {
    let row;
    if (action === "ack") {
      [row] = await tx
        .update(teamAlerts)
        .set({ state: "acked", ackedByUserId: ctx.id, ackedAt: new Date() })
        .where(eq(teamAlerts.id, id))
        .returning();
    } else {
      [row] = await tx
        .update(teamAlerts)
        .set({ state: "resolved", resolvedAt: new Date() })
        .where(eq(teamAlerts.id, id))
        .returning();
    }
    await writeAudit(tx as typeof db, {
      orgId: ctx.orgId,
      actorUserId: ctx.id,
      action: `alert.${action}`,
      targetType: "alert",
      targetId: id,
      payload: { metric: existing.metric },
    });
    return row;
  });
  return reply.code(200).send({ alert: updated });
}

// ---------- SLA alert engine (server-side, idempotent via open-dedupe index) ----------

async function runAlertEngine(
  orgId: string,
  actorUserId: string,
  live: { queueDepth: number },
): Promise<void> {
  try {
    const policies = await db
      .select()
      .from(teamSlaPolicies)
      .where(and(eq(teamSlaPolicies.orgId, orgId), eq(teamSlaPolicies.enabled, true)));
    const byMetric = new Map(policies.map((p) => [p.metric, p]));

    // queue_depth (org-wide) — the cheap, deterministic signal we evaluate here.
    const qd = byMetric.get("queue_depth");
    if (qd) {
      const observed = live.queueDepth;
      const breachCritical = observed >= qd.criticalThreshold;
      const breachWarning = observed >= qd.warningThreshold;
      if (breachWarning) {
        const severity = breachCritical ? "critical" : "warning";
        const threshold = breachCritical ? qd.criticalThreshold : qd.warningThreshold;
        await db
          .insert(teamAlerts)
          .values({
            orgId,
            policyId: qd.id,
            metric: "queue_depth",
            severity,
            state: "open",
            subjectType: "org",
            subjectId: null,
            observedValue: observed,
            thresholdValue: threshold,
            message: `Queue depth at ${observed} — above ${severity} threshold of ${threshold}.`,
          })
          // Open-dedupe partial-unique (org, metric, coalesce(subject_id,'')) — a
          // duplicate open alert is a silent no-op. No audit on no-op.
          .onConflictDoNothing();
      } else {
        // Condition cleared — expire any open queue_depth alert.
        await db
          .update(teamAlerts)
          .set({ state: "expired", resolvedAt: new Date() })
          .where(
            and(
              eq(teamAlerts.orgId, orgId),
              eq(teamAlerts.metric, "queue_depth"),
              eq(teamAlerts.state, "open"),
              sql`coalesce(${teamAlerts.subjectId},'') = ''`,
            ),
          );
      }
    }
  } catch {
    // The engine is best-effort and must never break the overview read.
  }
}
