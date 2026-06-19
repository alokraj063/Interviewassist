import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";

export async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Update own profile (name).
  app.patch("/me", async (req) => {
    const body = z.object({ name: z.string().min(1).max(200).optional() }).safeParse(req.body);
    if (body.success && body.data.name) {
      await collections.users().updateOne({ id: req.authUser!.id }, { $set: { name: body.data.name } });
    }
    return { ok: true };
  });
}
