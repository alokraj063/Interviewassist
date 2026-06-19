import type { FastifyInstance } from "fastify";
import { collections } from "../mongo.js";

export async function orgRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req, reply) => {
    const org = await collections.organizations().findOne({ id: req.authUser!.orgId }, { projection: { _id: 0 } });
    if (!org) return reply.code(404).send({ error: "not_found" });
    return { org };
  });

  app.patch("/", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    if (typeof body.name === "string") allowed.name = body.name;
    if (Object.keys(allowed).length) {
      await collections.organizations().updateOne({ id: req.authUser!.orgId }, { $set: allowed });
    }
    return { ok: true };
  });
}
