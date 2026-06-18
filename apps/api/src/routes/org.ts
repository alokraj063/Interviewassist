import type { FastifyInstance } from "fastify";
import { db, organizations } from "@j2w/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

export async function orgRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: [app.requirePermission("workspace.read")] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) return reply.code(404).send({ error: "not_found" });
    return { org };
  });

  const patchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    subdomain: z.string().min(1).max(100).optional().nullable(),
    defaultLocale: z.string().max(20).optional().nullable(),
    defaultTimezone: z.string().max(100).optional().nullable(),
    fiscalYearStart: z.string().max(20).optional().nullable(),
    businessHours: z.unknown().optional(),
  });

  app.patch("/", { preHandler: [app.requirePermission("workspace.write")] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    await db.update(organizations).set(parsed.data as Record<string, unknown>).where(eq(organizations.id, orgId));
    return { ok: true };
  });
}
