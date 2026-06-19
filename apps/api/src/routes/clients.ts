// Clients API — minimal CRUD so recruiters can add a new client (the buyer of
// recruiting services) directly from Live Assist settings, instead of clients
// only existing implicitly via seeded demands.
//
// Tenant-scoped via req.authUser.orgId. Permission gating uses the existing
// `clients.*` permissions seeded in 0010_recruitassist_foundation:
//   - clients.read  : recruiters / DLs / AMs / BHs / admin
//   - clients.write : AMs / BHs / admin
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { clients, db } from "@j2w/db";

const createSchema = z.object({
  companyName: z.string().min(2).max(200),
  industry: z.string().max(120).optional(),
  tier: z.string().max(40).optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function clientsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // List clients for the caller's org (powers the client picker on the
  // "Add job" form and the new "Add client" card).
  app.get("/", { preHandler: [app.requirePermission("clients.read")] }, async (req) => {
    const ctx = req.authUser!;
    const rows = await db
      .select({
        id: clients.id,
        name: clients.companyName,
        industry: clients.industry,
        tier: clients.tier,
        status: clients.status,
      })
      .from(clients)
      .where(eq(clients.orgId, ctx.orgId))
      .orderBy(asc(clients.companyName));
    return { clients: rows };
  });

  // Create a client.
  app.post("/", { preHandler: [app.requirePermission("clients.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const companyName = parsed.data.companyName.trim();

    // Reject a duplicate name within the org so the picker stays clean.
    const [dupe] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.orgId, ctx.orgId), eq(clients.companyName, companyName)));
    if (dupe) return reply.code(409).send({ error: "client_exists", clientId: dupe.id });

    const [row] = await db
      .insert(clients)
      .values({
        orgId: ctx.orgId,
        companyName,
        slug: slugify(companyName) || null,
        industry: parsed.data.industry?.trim() || null,
        tier: parsed.data.tier?.trim() || null,
      })
      .returning({ id: clients.id, name: clients.companyName });

    return reply.code(201).send({ clientId: row.id, client: { id: row.id, name: row.name } });
  });
}
