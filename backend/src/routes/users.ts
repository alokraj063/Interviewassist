import type { FastifyInstance } from "fastify";
import {
  db,
  invitations,
  memberships,
  ROLES,
  teamMembers,
  teams,
  users,
} from "@j2w/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { hashToken, randomToken } from "../auth/tokens.js";
import { sendInvitationEmail } from "../email/send.js";

const roleEnum = z.enum(ROLES);

export async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // List all org members: role, status, team, last active.
  app.get(
    "/",
    { preHandler: [app.requirePermission("users.read")] },
    async (req) => {
      const orgId = req.authUser!.orgId;
      const rows = await db
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          avatarUrl: users.avatarUrl,
          lastActiveAt: users.lastActiveAt,
          role: memberships.role,
          status: memberships.status,
          invitedAt: memberships.invitedAt,
          joinedAt: memberships.joinedAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, orgId))
        .orderBy(desc(memberships.joinedAt));

      const userIds = rows.map((r) => r.userId);
      const teamRows = userIds.length
        ? await db
            .select({
              userId: teamMembers.userId,
              teamId: teams.id,
              teamName: teams.name,
            })
            .from(teamMembers)
            .innerJoin(teams, eq(teams.id, teamMembers.teamId))
            .where(and(eq(teams.orgId, orgId), inArray(teamMembers.userId, userIds)))
        : [];
      const byUser = new Map<string, { id: string; name: string }[]>();
      for (const t of teamRows) {
        const arr = byUser.get(t.userId) ?? [];
        arr.push({ id: t.teamId, name: t.teamName });
        byUser.set(t.userId, arr);
      }

      return {
        users: rows.map((r) => ({
          id: r.userId,
          email: r.email,
          name: r.name,
          avatarUrl: r.avatarUrl,
          lastActiveAt: r.lastActiveAt,
          role: r.role,
          status: r.status,
          invitedAt: r.invitedAt,
          joinedAt: r.joinedAt,
          teams: byUser.get(r.userId) ?? [],
        })),
      };
    },
  );

  // Invite a new user (or re-invite an existing-but-pending one).
  const inviteSchema = z.object({
    email: z.string().email().trim().toLowerCase(),
    role: roleEnum,
    teamId: z.string().uuid().optional(),
  });
  app.post(
    "/invite",
    { preHandler: [app.requirePermission("users.invite")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
      const { email, role, teamId } = parsed.data;

      // If the email already has an active membership in this org, bail.
      const [existingUser] = await db.select().from(users).where(eq(users.email, email));
      if (existingUser) {
        const [existingMember] = await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, existingUser.id), eq(memberships.orgId, ctx.orgId)));
        if (existingMember && existingMember.status === "active") {
          return reply.code(409).send({ error: "already_member" });
        }
      }

      const token = randomToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [inv] = await db
        .insert(invitations)
        .values({
          orgId: ctx.orgId,
          email,
          role,
          teamId: teamId ?? null,
          tokenHash: hashToken(token),
          invitedBy: ctx.id,
          expiresAt,
        })
        .returning({ id: invitations.id });

      try {
        await sendInvitationEmail(
          {
            to: email,
            inviterName: ctx.name ?? ctx.email,
            orgName: ctx.orgName,
            role,
            token,
          },
          req.log,
        );
      } catch (err) {
        req.log.error({ err }, "failed to send invitation email");
      }

      return { invitationId: inv.id, expiresAt };
    },
  );

  // Update a member's role or team assignments.
  const patchSchema = z.object({
    role: roleEnum.optional(),
    teamIds: z.array(z.string().uuid()).optional(),
    name: z.string().min(1).max(200).optional(),
  });
  app.patch(
    "/:id",
    { preHandler: [app.requirePermission("users.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

      const [member] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, id), eq(memberships.orgId, ctx.orgId)));
      if (!member) return reply.code(404).send({ error: "not_a_member" });

      if (parsed.data.role && parsed.data.role !== member.role) {
        await db.update(memberships).set({ role: parsed.data.role }).where(eq(memberships.id, member.id));
      }
      if (parsed.data.name) {
        await db.update(users).set({ name: parsed.data.name }).where(eq(users.id, id));
      }
      if (parsed.data.teamIds) {
        // Replace team set for this user, scoped to the current org's teams.
        await db
          .delete(teamMembers)
          .where(
            and(
              eq(teamMembers.userId, id),
              inArray(
                teamMembers.teamId,
                db.select({ id: teams.id }).from(teams).where(eq(teams.orgId, ctx.orgId)),
              ),
            ),
          );
        if (parsed.data.teamIds.length) {
          await db
            .insert(teamMembers)
            .values(parsed.data.teamIds.map((teamId) => ({ teamId, userId: id })))
            .onConflictDoNothing();
        }
      }

      return { ok: true };
    },
  );

  // Suspend a member (soft-delete at the membership level).
  app.delete(
    "/:id",
    { preHandler: [app.requirePermission("users.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      if (id === ctx.id) return reply.code(400).send({ error: "cannot_suspend_self" });
      const [member] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, id), eq(memberships.orgId, ctx.orgId)));
      if (!member) return reply.code(404).send({ error: "not_a_member" });
      await db
        .update(memberships)
        .set({ status: "suspended" })
        .where(eq(memberships.id, member.id));
      return { ok: true };
    },
  );

  // Self-profile update.
  const profileSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    jobTitle: z.string().max(200).optional().nullable(),
    timezone: z.string().max(100).optional().nullable(),
    locale: z.string().max(20).optional().nullable(),
    avatarUrl: z.string().url().optional().nullable(),
  });
  app.patch("/me", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    await db.update(users).set({ ...parsed.data, lastActiveAt: new Date() }).where(eq(users.id, ctx.id));
    return { ok: true };
  });

  // Pending invitations list (for the Team UI).
  app.get(
    "/invitations",
    { preHandler: [app.requirePermission("users.read")] },
    async (req) => {
      const orgId = req.authUser!.orgId;
      const rows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          teamId: invitations.teamId,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(and(eq(invitations.orgId, orgId), sql`${invitations.acceptedAt} IS NULL`))
        .orderBy(desc(invitations.createdAt));
      return { invitations: rows };
    },
  );

  // Revoke a pending invitation.
  app.delete(
    "/invitations/:id",
    { preHandler: [app.requirePermission("users.invite")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const result = await db
        .delete(invitations)
        .where(and(eq(invitations.id, id), eq(invitations.orgId, ctx.orgId)))
        .returning({ id: invitations.id });
      if (result.length === 0) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
}
