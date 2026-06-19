// Clients API (MongoDB) — list / create the buyer of recruiting services.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";

export async function clientsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const rows = await collections.clients().find({ orgId: req.authUser!.orgId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    return { clients: rows };
  });

  app.post("/", async (req, reply) => {
    const body = z.object({ companyName: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload" });
    const id = randomUUID();
    await collections.clients().insertOne({ id, orgId: req.authUser!.orgId, companyName: body.data.companyName, createdAt: new Date() });
    return { id, companyName: body.data.companyName };
  });
}
