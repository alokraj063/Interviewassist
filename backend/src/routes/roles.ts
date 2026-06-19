import type { FastifyInstance } from "fastify";
import { db, rolePermissions, ROLES } from "@j2w/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

// The canonical permission set — a superset UI for the Roles matrix.
// Kept in-code (not DB) so the column list on the matrix is always complete
// even for orgs that don't have rows seeded yet.
export const ALL_PERMISSIONS = [
  "conversations.read",
  "conversations.write",
  "qa.read",
  "qa.write",
  "qa.override",
  "qa.acoustic",
  "coaching.read",
  "coaching.write",
  "scorecards.read",
  "scorecards.write",
  "voice_agents.read",
  "voice_agents.write",
  "knowledge.read",
  "knowledge.write",
  "live_assist.read",
  "analytics.read",
  "calls.read",
  "calls.assign",
  "calls.end",
  "users.read",
  "users.invite",
  "users.write",
  "teams.read",
  "teams.write",
  "roles.read",
  "roles.write",
  "workspace.read",
  "workspace.write",
  "security.read",
  "security.write",
  "billing.read",
  "billing.write",
  "integrations.read",
  "integrations.write",
  "api_keys.read",
  "api_keys.write",
  "audit.read",
  "notifications.read",
  "notifications.write",
] as const;

export async function rolesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/permissions",
    { preHandler: [app.requirePermission("roles.read")] },
    async (req) => {
      const orgId = req.authUser!.orgId;
      const rows = await db
        .select({ role: rolePermissions.role, permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(eq(rolePermissions.orgId, orgId));
      const matrix: Record<string, string[]> = Object.fromEntries(ROLES.map((r) => [r, [] as string[]]));
      for (const row of rows) {
        matrix[row.role]?.push(row.permission);
      }
      return { roles: ROLES, permissions: ALL_PERMISSIONS, matrix };
    },
  );

  const updateSchema = z.object({
    matrix: z.record(z.enum(ROLES), z.array(z.string())),
  });

  app.patch(
    "/permissions",
    { preHandler: [app.requirePermission("roles.write")] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
      const rolesToUpdate = Object.keys(parsed.data.matrix) as (typeof ROLES)[number][];

      // Validate permissions are known.
      const known = new Set(ALL_PERMISSIONS as readonly string[]);
      for (const role of rolesToUpdate) {
        for (const p of parsed.data.matrix[role] ?? []) {
          if (!known.has(p)) return reply.code(400).send({ error: "unknown_permission", permission: p });
        }
      }

      // Replace the permissions for each updated role. We do this in a transaction
      // so readers never see a partial matrix.
      await db.transaction(async (tx) => {
        for (const role of rolesToUpdate) {
          await tx
            .delete(rolePermissions)
            .where(and(eq(rolePermissions.orgId, orgId), eq(rolePermissions.role, role)));
          const perms = parsed.data.matrix[role] ?? [];
          if (perms.length) {
            await tx
              .insert(rolePermissions)
              .values(perms.map((permission) => ({ orgId, role, permission })));
          }
        }
      });

      // If the caller's own role just lost roles.read, they'll get 403 on the next refresh — that's fine.
      return { ok: true };
    },
  );

  // Unused but convenient: bulk-check permissions for arbitrary roles.
  app.get("/check", async (req, reply) => {
    const q = z
      .object({ roles: z.string().optional(), permissions: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_payload" });
    const reqRoles = (q.data.roles ?? "").split(",").filter(Boolean) as (typeof ROLES)[number][];
    const reqPerms = (q.data.permissions ?? "").split(",").filter(Boolean);
    const rows = await db
      .select({ role: rolePermissions.role, permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.orgId, req.authUser!.orgId),
          reqRoles.length ? inArray(rolePermissions.role, reqRoles) : undefined,
          reqPerms.length ? inArray(rolePermissions.permission, reqPerms) : undefined,
        ),
      );
    return { rows };
  });
}
