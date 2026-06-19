import type { FastifyInstance } from "fastify";

export async function rolesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Permission check against the caller's loaded permissions.
  app.get("/check", async (req) => {
    const perm = (req.query as { permission?: string }).permission;
    const allowed = !!perm && (req.authUser?.permissions.includes(perm) ?? false);
    return { allowed, permissions: req.authUser?.permissions ?? [] };
  });
}
