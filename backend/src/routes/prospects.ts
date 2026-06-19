// Prospects API (MongoDB) — pre-submission workspace.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";

export async function prospectsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const q = req.query as { demandId?: string };
    const filter: Record<string, unknown> = { orgId: req.authUser!.orgId };
    if (q.demandId) filter.demandId = q.demandId;
    const rows = await collections.prospects().find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
    return { prospects: rows };
  });

  app.post("/", async (req, reply) => {
    const body = z.object({
      demandId: z.string().uuid(),
      candidateId: z.string().uuid(),
      status: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload" });
    const id = randomUUID();
    await collections.prospects().insertOne({
      id, orgId: req.authUser!.orgId, demandId: body.data.demandId, candidateId: body.data.candidateId,
      status: body.data.status ?? "evaluating", createdAt: new Date(),
    });
    return { id };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await collections.prospects().updateOne({ id: req.params.id, orgId: req.authUser!.orgId }, { $set: body });
    return { ok: true };
  });
}
