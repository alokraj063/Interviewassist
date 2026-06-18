// Bulk-call campaigns for voice agents. Recruiter picks an agent + a list
// of candidate phone numbers, the campaign moves through draft -> scheduled
// -> running and the worker dials each target via Vapi (deferred when
// VAPI_API_KEY is missing — campaign stays in scheduled with a clear note).
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  db,
  voiceAgentCallTargets,
  voiceAgentCampaigns,
  voiceAgents,
  VOICE_AGENT_CAMPAIGN_STATUSES,
} from "@j2w/db";

const createSchema = z.object({
  voiceAgentId: z.string().uuid(),
  demandId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  ratePerMinute: z.number().int().min(1).max(120).default(10),
  scheduledFor: z.string().datetime().optional(),
  targets: z
    .array(
      z.object({
        candidateId: z.string().uuid().optional(),
        phone: z.string().min(5).max(40),
      }),
    )
    .min(1)
    .max(2000),
});

const updateStatusSchema = z.object({
  status: z.enum(VOICE_AGENT_CAMPAIGN_STATUSES),
});

export async function voiceAgentCampaignRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const ctx = req.authUser!;
    const rows = await db
      .select({
        id: voiceAgentCampaigns.id,
        name: voiceAgentCampaigns.name,
        status: voiceAgentCampaigns.status,
        voiceAgentId: voiceAgentCampaigns.voiceAgentId,
        voiceAgentName: voiceAgents.name,
        ratePerMinute: voiceAgentCampaigns.ratePerMinute,
        scheduledFor: voiceAgentCampaigns.scheduledFor,
        createdAt: voiceAgentCampaigns.createdAt,
        targetCount: sql<number>`(
          SELECT count(*)::int FROM voice_agent_call_targets
          WHERE voice_agent_call_targets.campaign_id = voice_agent_campaigns.id
        )`,
        completedCount: sql<number>`(
          SELECT count(*)::int FROM voice_agent_call_targets
          WHERE voice_agent_call_targets.campaign_id = voice_agent_campaigns.id
            AND status = 'completed'
        )`,
      })
      .from(voiceAgentCampaigns)
      .leftJoin(voiceAgents, eq(voiceAgents.id, voiceAgentCampaigns.voiceAgentId))
      .where(eq(voiceAgentCampaigns.orgId, ctx.orgId))
      .orderBy(desc(voiceAgentCampaigns.createdAt));
    return { campaigns: rows };
  });

  app.get("/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [c] = await db
      .select()
      .from(voiceAgentCampaigns)
      .where(and(eq(voiceAgentCampaigns.id, id), eq(voiceAgentCampaigns.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "campaign_not_found" });

    const targets = await db
      .select({
        id: voiceAgentCallTargets.id,
        phone: voiceAgentCallTargets.phone,
        candidateId: voiceAgentCallTargets.candidateId,
        candidateName: candidates.displayName,
        status: voiceAgentCallTargets.status,
        attemptCount: voiceAgentCallTargets.attemptCount,
        lastAttemptAt: voiceAgentCallTargets.lastAttemptAt,
        callId: voiceAgentCallTargets.callId,
        outcome: voiceAgentCallTargets.outcome,
        errorMessage: voiceAgentCallTargets.errorMessage,
      })
      .from(voiceAgentCallTargets)
      .leftJoin(candidates, eq(candidates.id, voiceAgentCallTargets.candidateId))
      .where(eq(voiceAgentCallTargets.campaignId, id))
      .orderBy(desc(voiceAgentCallTargets.createdAt));

    return { campaign: c, targets };
  });

  app.post(
    "/",
    { preHandler: [app.requirePermission("voice_agents.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
      }
      const [agent] = await db
        .select({ id: voiceAgents.id })
        .from(voiceAgents)
        .where(and(eq(voiceAgents.id, parsed.data.voiceAgentId), eq(voiceAgents.orgId, ctx.orgId)))
        .limit(1);
      if (!agent) return reply.code(404).send({ error: "voice_agent_not_found" });

      const [row] = await db
        .insert(voiceAgentCampaigns)
        .values({
          orgId: ctx.orgId,
          voiceAgentId: parsed.data.voiceAgentId,
          demandId: parsed.data.demandId ?? null,
          name: parsed.data.name,
          notes: parsed.data.notes ?? null,
          ratePerMinute: parsed.data.ratePerMinute,
          scheduledFor: parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : null,
          status: parsed.data.scheduledFor ? "scheduled" : "draft",
          createdByUserId: ctx.id,
        })
        .returning();

      if (parsed.data.targets.length > 0) {
        await db.insert(voiceAgentCallTargets).values(
          parsed.data.targets.map((t) => ({
            campaignId: row.id,
            candidateId: t.candidateId ?? null,
            phone: t.phone,
          })),
        );
      }
      return reply.code(201).send({ campaign: row, targetCount: parsed.data.targets.length });
    },
  );

  app.patch(
    "/:id/status",
    { preHandler: [app.requirePermission("voice_agents.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = updateStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
      }
      const [row] = await db
        .update(voiceAgentCampaigns)
        .set({ status: parsed.data.status, updatedAt: new Date() })
        .where(and(eq(voiceAgentCampaigns.id, id), eq(voiceAgentCampaigns.orgId, ctx.orgId)))
        .returning();
      if (!row) return reply.code(404).send({ error: "campaign_not_found" });
      return { campaign: row };
    },
  );

  app.delete(
    "/:id",
    { preHandler: [app.requirePermission("voice_agents.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const deleted = await db
        .delete(voiceAgentCampaigns)
        .where(and(eq(voiceAgentCampaigns.id, id), eq(voiceAgentCampaigns.orgId, ctx.orgId)))
        .returning({ id: voiceAgentCampaigns.id });
      if (deleted.length === 0) return reply.code(404).send({ error: "campaign_not_found" });
      return { deleted: deleted[0].id };
    },
  );
}
