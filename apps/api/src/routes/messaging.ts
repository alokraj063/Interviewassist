// Outbound messaging — WhatsApp / SMS / email log + send. The actual
// provider call is a stub that flips to mock when no credentials are
// configured; real delivery via Exotel / WhatsApp Business / Twilio
// plugs in here behind a per-provider branch.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  db,
  messagingEvents,
  MESSAGING_CHANNELS,
  MESSAGING_PROVIDERS,
} from "@j2w/db";

const sendSchema = z.object({
  channel: z.enum(MESSAGING_CHANNELS),
  to: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  candidateId: z.string().uuid().optional().nullable(),
  templateId: z.string().max(120).optional(),
  provider: z.enum(MESSAGING_PROVIDERS).optional(),
});

function pickProvider(channel: string, requested?: string): string {
  if (requested) return requested;
  if (channel === "whatsapp") return process.env.WHATSAPP_API_TOKEN ? "whatsapp_business" : "mock";
  if (channel === "sms") return process.env.EXOTEL_API_KEY ? "exotel" : "mock";
  return "mock";
}

export async function messagingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post(
    "/send",
    { preHandler: [app.requirePermission("messaging.send")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
      }
      const provider = pickProvider(parsed.data.channel, parsed.data.provider);
      const isMock = provider === "mock";
      const remoteId = isMock ? `mock-${randomUUID().slice(0, 8)}` : null;

      const [row] = await db
        .insert(messagingEvents)
        .values({
          orgId: ctx.orgId,
          candidateId: parsed.data.candidateId ?? null,
          recruiterUserId: ctx.id,
          channel: parsed.data.channel,
          provider: provider as "mock",
          direction: "outbound",
          toAddress: parsed.data.to,
          templateId: parsed.data.templateId ?? null,
          body: parsed.data.body,
          status: isMock ? "delivered" : "queued",
          remoteId,
          deliveredAt: isMock ? new Date() : null,
        })
        .returning();
      return reply.code(201).send({ event: row, mock: isMock });
    },
  );

  app.get("/events", async (req) => {
    const ctx = req.authUser!;
    const candidateId = (req.query as { candidateId?: string }).candidateId;
    const wheres = [eq(messagingEvents.orgId, ctx.orgId)];
    if (candidateId) wheres.push(eq(messagingEvents.candidateId, candidateId));
    const rows = await db
      .select()
      .from(messagingEvents)
      .where(and(...wheres))
      .orderBy(desc(messagingEvents.createdAt))
      .limit(200);
    return { events: rows };
  });

  // Per-candidate timeline (used by CandidateDetail timeline tab).
  app.get("/candidates/:id/timeline", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [c] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, id), eq(candidates.orgId, ctx.orgId)))
      .limit(1);
    if (!c) return reply.code(404).send({ error: "candidate_not_found" });
    const rows = await db
      .select()
      .from(messagingEvents)
      .where(eq(messagingEvents.candidateId, id))
      .orderBy(desc(messagingEvents.createdAt))
      .limit(50);
    return { events: rows };
  });
}
