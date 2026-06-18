import type { FastifyInstance } from "fastify";
import { db, memberships, teamMembers, teams, users } from "@j2w/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

export async function teamsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: [app.requirePermission("teams.read")] }, async (req) => {
    const orgId = req.authUser!.orgId;
    const teamRows = await db
      .select({
        id: teams.id,
        name: teams.name,
        managerUserId: teams.managerUserId,
        createdAt: teams.createdAt,
      })
      .from(teams)
      .where(eq(teams.orgId, orgId))
      .orderBy(desc(teams.createdAt));
    if (teamRows.length === 0) return { teams: [] };

    const members = await db
      .select({
        teamId: teamMembers.teamId,
        userId: teamMembers.userId,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(inArray(teamMembers.teamId, teamRows.map((t) => t.id)));

    const byTeam = new Map<string, typeof members>();
    for (const m of members) {
      const arr = byTeam.get(m.teamId) ?? [];
      arr.push(m);
      byTeam.set(m.teamId, arr);
    }

    return {
      teams: teamRows.map((t) => ({
        ...t,
        members: (byTeam.get(t.id) ?? []).map((m) => ({
          id: m.userId,
          name: m.name,
          email: m.email,
          avatarUrl: m.avatarUrl,
        })),
      })),
    };
  });

  const upsertSchema = z.object({
    name: z.string().min(1).max(200),
    managerUserId: z.string().uuid().nullable().optional(),
  });

  app.post("/", { preHandler: [app.requirePermission("teams.write")] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    if (parsed.data.managerUserId) {
      const [m] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, parsed.data.managerUserId), eq(memberships.orgId, orgId)));
      if (!m) return reply.code(400).send({ error: "manager_not_in_org" });
    }
    const [row] = await db
      .insert(teams)
      .values({ orgId, name: parsed.data.name, managerUserId: parsed.data.managerUserId ?? null })
      .returning({ id: teams.id });
    return { id: row.id };
  });

  app.patch("/:id", { preHandler: [app.requirePermission("teams.write")] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { id } = req.params as { id: string };
    const parsed = upsertSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    const result = await db
      .update(teams)
      .set(parsed.data)
      .where(and(eq(teams.id, id), eq(teams.orgId, orgId)))
      .returning({ id: teams.id });
    if (result.length === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  app.delete("/:id", { preHandler: [app.requirePermission("teams.write")] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { id } = req.params as { id: string };
    const result = await db
      .delete(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, orgId)))
      .returning({ id: teams.id });
    if (result.length === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  const memberSchema = z.object({ userId: z.string().uuid() });

  app.post(
    "/:id/members",
    { preHandler: [app.requirePermission("teams.write")] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const { id } = req.params as { id: string };
      const parsed = memberSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
      const [team] = await db
        .select()
        .from(teams)
        .where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
      if (!team) return reply.code(404).send({ error: "team_not_found" });
      const [member] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, parsed.data.userId), eq(memberships.orgId, orgId)));
      if (!member) return reply.code(400).send({ error: "user_not_in_org" });
      await db.insert(teamMembers).values({ teamId: id, userId: parsed.data.userId }).onConflictDoNothing();
      return { ok: true };
    },
  );

  app.delete(
    "/:id/members/:userId",
    { preHandler: [app.requirePermission("teams.write")] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const { id, userId } = req.params as { id: string; userId: string };
      const [team] = await db
        .select()
        .from(teams)
        .where(and(eq(teams.id, id), eq(teams.orgId, orgId)));
      if (!team) return reply.code(404).send({ error: "team_not_found" });
      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
      return { ok: true };
    },
  );
}
