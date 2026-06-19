import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import { verifyPassword } from "../auth/password.js";
import { loadAuthUser } from "../auth/context.js";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from "../auth/tokens.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

interface UserDoc {
  id: string;
  email: string;
  passwordHash: string | null;
  isPlatformAdmin?: boolean;
  suspendedAt: Date | null;
}

function isHeadlessClient(req: FastifyRequest): boolean {
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  return ua.includes("curl") || ua.includes("node") || req.headers["x-headless"] === "1";
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth",
    secure: false,
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
}
function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
}

async function signAccessToken(
  app: FastifyInstance,
  opts: { userId: string; email: string; orgId: string; role: string; mfaVerified: boolean; isPlatformAdmin?: boolean },
): Promise<string> {
  return app.jwt.sign({
    sub: opts.userId,
    email: opts.email,
    orgId: opts.orgId,
    role: opts.role as "admin",
    mfaVerified: opts.mfaVerified,
    isPlatformAdmin: opts.isPlatformAdmin ?? false,
  });
}

function meShape(ctx: Awaited<ReturnType<typeof loadAuthUser>>) {
  if (!ctx) return null;
  return {
    id: ctx.id,
    email: ctx.email,
    name: ctx.name,
    role: ctx.role,
    membershipStatus: ctx.membershipStatus,
    emailVerifiedAt: ctx.emailVerifiedAt,
    mfaEnrolledAt: ctx.mfaEnrolledAt,
    org: { id: ctx.orgId, name: ctx.orgName },
    permissions: ctx.permissions,
    isPlatformAdmin: ctx.isPlatformAdmin,
  };
}

export async function authRoutes(app: FastifyInstance) {
  // Public signup is closed.
  app.post("/signup", async (_req, reply) => reply.code(410).send({ error: "signup_closed" }));

  app.post("/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const { email, password } = parsed.data;

    const user = await collections.users().findOne<UserDoc>({ email });
    if (!user || !user.passwordHash) return reply.code(401).send({ error: "invalid_credentials" });
    if (user.suspendedAt) return reply.code(403).send({ error: "account_suspended" });
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });

    const member = user.isPlatformAdmin
      ? null
      : await collections.memberships().findOne<{ orgId: string }>({ userId: user.id, status: "active" });
    if (!user.isPlatformAdmin && !member) return reply.code(403).send({ error: "no_active_membership" });

    const refresh = await issueRefreshToken({ userId: user.id, userAgent: req.headers["user-agent"] ?? null, ip: req.ip });
    const headless = isHeadlessClient(req);
    if (!headless) setRefreshCookie(reply, refresh.token);
    await collections.users().updateOne({ id: user.id }, { $set: { lastActiveAt: new Date() } });

    const ctx = await loadAuthUser(user.id, member?.orgId);
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });
    const accessToken = await signAccessToken(app, {
      userId: user.id, email: user.email, orgId: ctx.orgId, role: ctx.role, mfaVerified: false, isPlatformAdmin: ctx.isPlatformAdmin,
    });
    return { accessToken, user: meShape(ctx), ...(headless ? { refreshToken: refresh.token } : {}) };
  });

  app.post("/refresh", async (req, reply) => {
    const cookie = req.cookies[REFRESH_COOKIE_NAME];
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const presented = cookie ?? bodyToken;
    if (!presented) return reply.code(401).send({ error: "no_refresh_token" });

    const rotated = await rotateRefreshToken(presented, { userAgent: req.headers["user-agent"] ?? null, ip: req.ip });
    if (!rotated) return reply.code(401).send({ error: "invalid_refresh_token" });
    const headless = isHeadlessClient(req);
    if (!headless) setRefreshCookie(reply, rotated.token);

    const ctx = await loadAuthUser(rotated.userId);
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });
    const accessToken = await signAccessToken(app, {
      userId: ctx.id, email: ctx.email, orgId: ctx.orgId, role: ctx.role, mfaVerified: false, isPlatformAdmin: ctx.isPlatformAdmin,
    });
    return { accessToken, user: meShape(ctx), ...(headless ? { refreshToken: rotated.token } : {}) };
  });

  app.post("/logout", async (req, reply) => {
    const presented = req.cookies[REFRESH_COOKIE_NAME] ?? (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (presented) await revokeRefreshToken(presented);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    return { user: meShape(req.authUser ?? null) };
  });
}
