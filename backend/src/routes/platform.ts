// Super-admin (platform admin) routes (MongoDB). Gated by requirePlatformAdmin.
// Minimal in the interview build — lists/creates tenant orgs. Per-tenant
// integration credential management is not exposed here.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";

export async function platformRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.requirePlatformAdmin);

  app.get("/orgs", async () => {
    const orgs = await collections.organizations().find({}, { projection: { _id: 0 } }).toArray();
    return { orgs };
  });

  app.post("/orgs", async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload" });
    const id = randomUUID();
    await collections.organizations().insertOne({ id, name: body.data.name, createdAt: new Date() });
    return { id, name: body.data.name };
  });

  app.get<{ Params: { id: string } }>("/orgs/:id", async (req, reply) => {
    const org = await collections.organizations().findOne({ id: req.params.id }, { projection: { _id: 0 } });
    if (!org) return reply.code(404).send({ error: "not_found" });
    return { org, integrations: [] };
  });
}
