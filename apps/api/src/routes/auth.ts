import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
// Clients that can't hold cookies (Electron main process, native SDKs) send
// `X-Client: desktop` to opt out of the refresh cookie. Their refresh token
// round-trips via the JSON body instead.
function isHeadlessClient(req: FastifyRequest): boolean {
  const h = req.headers["x-client"];
  return typeof h === "string" && h.toLowerCase() === "desktop";
}

function readPresentedRefreshToken(req: FastifyRequest): string | null {
  const cookie = req.cookies[REFRESH_COOKIE_NAME];
  if (cookie) return cookie;
  const header = req.headers["x-refresh-token"];
  if (typeof header === "string" && header) return header;
  const body = req.body as { refreshToken?: unknown } | undefined;
  if (body && typeof body.refreshToken === "string" && body.refreshToken) return body.refreshToken;
  return null;
}
import { db, invitations, memberships, organizations, rolePermissions, teamMembers, users } from "@j2w/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { loadAuthUser } from "../auth/context.js";
import {
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_MS,
  hashToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../auth/tokens.js";
import {
  consumePasswordResetCodeForUser,
  consumeVerificationCodeForUser,
  createPasswordResetCode,
  createVerificationCode,
} from "../auth/one_time_tokens.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "../email/send.js";
import { env } from "../env.js";

const emailSchema = z.string().email().trim().toLowerCase();
const passwordSchema = z.string().min(8).max(128);

const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(200),
  workspaceName: z.string().min(1).max(200),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const [existing] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    if (!existing) return slug;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  throw new Error("could_not_generate_slug");
}

async function seedDefaultPermissions(orgId: string): Promise<void> {
  // Copy the default org's permission matrix into the new org so each role
  // starts with a sensible baseline. Admins can then edit via Settings.
  await db.execute(sql`
    INSERT INTO role_permissions (org_id, role, permission)
    SELECT ${orgId}, role, permission FROM role_permissions
     WHERE org_id = '00000000-0000-0000-0000-000000000000'
    ON CONFLICT DO NOTHING
  `);
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
    signed: false,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
}

async function signAccessToken(
  app: FastifyInstance,
  opts: {
    userId: string;
    email: string;
    orgId: string;
    role: string;
    mfaVerified: boolean;
    isPlatformAdmin?: boolean;
  },
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
  const tightRate = {
    rateLimit: { max: 10, timeWindow: "1 minute" },
  };

  // -------- Signup is disabled — tenants are provisioned by platform admins
  // via POST /api/platform/orgs (which sends a normal invitation email). --------
  app.post("/signup", { config: tightRate }, async (_req, reply) => {
    return reply.code(410).send({
      error: "signup_disabled",
      message: "Self-serve signup is closed. Contact your platform admin for an invite.",
    });
  });

  // -------- Login --------
  app.post("/login", { config: tightRate }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user || !user.passwordHash) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (user.suspendedAt) return reply.code(403).send({ error: "account_suspended" });

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return reply.code(401).send({ error: "invalid_credentials" });

    // Platform admins log in without a membership.
    const member = user.isPlatformAdmin
      ? null
      : (await db
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"))))[0];
    if (!user.isPlatformAdmin && !member) {
      return reply.code(403).send({ error: "no_active_membership" });
    }

    // Phase 5 will intercept here with MFA challenge when enabled.
    const refresh = await issueRefreshToken({
      userId: user.id,
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip,
    });
    const headless = isHeadlessClient(req);
    if (!headless) setRefreshCookie(reply, refresh.token);

    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));

    const ctx = await loadAuthUser(user.id, member?.orgId);
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });

    const accessToken = await signAccessToken(app, {
      userId: user.id,
      email: user.email,
      orgId: ctx.orgId,
      role: ctx.role,
      mfaVerified: false,
      isPlatformAdmin: ctx.isPlatformAdmin,
    });
    return {
      accessToken,
      user: meShape(ctx),
      ...(headless ? { refreshToken: refresh.token } : {}),
    };
  });

  // -------- Refresh --------
  app.post("/refresh", async (req, reply) => {
    const presented = readPresentedRefreshToken(req);
    if (!presented) return reply.code(401).send({ error: "no_refresh_token" });

    const rotated = await rotateRefreshToken(presented, {
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip,
    });
    if (!rotated) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }

    const ctx = await loadAuthUser(rotated.userId);
    if (!ctx) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: "unauthorized" });
    }

    const headless = isHeadlessClient(req);
    if (!headless) setRefreshCookie(reply, rotated.token);
    const accessToken = await signAccessToken(app, {
      userId: ctx.id,
      email: ctx.email,
      orgId: ctx.orgId,
      role: ctx.role,
      mfaVerified: false,
      isPlatformAdmin: ctx.isPlatformAdmin,
    });
    return {
      accessToken,
      user: meShape(ctx),
      ...(headless ? { refreshToken: rotated.token } : {}),
    };
  });

  // -------- Logout --------
  app.post("/logout", async (req, reply) => {
    const presented = readPresentedRefreshToken(req);
    if (presented) await revokeRefreshToken(presented);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  // -------- Me --------
  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    return { user: meShape(req.authUser ?? null) };
  });

  // -------- Email verification (6-digit code) --------
  const codeSchema = z.string().regex(/^\d{6}$/, "code must be 6 digits");
  const verifySchema = z.object({
    code: codeSchema,
    email: emailSchema.optional(),
  });

  app.post("/verify-email", async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

    // Two paths: if the caller is authed, verify for req.user. If they're
    // unauthenticated, require {email, code} and look the user up.
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        await req.jwtVerify();
        userId = (req.user as { sub: string }).sub;
      } catch {
        // fall through to email-based path
      }
    }
    if (!userId) {
      if (!parsed.data.email) return reply.code(400).send({ error: "email_required" });
      const [u] = await db.select().from(users).where(eq(users.email, parsed.data.email));
      if (!u) return reply.code(400).send({ error: "invalid_code" });
      userId = u.id;
    }

    const ok = await consumeVerificationCodeForUser(userId, parsed.data.code);
    if (!ok) return reply.code(400).send({ error: "invalid_code" });
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
    return { ok: true };
  });

  const resendSchema = z.object({ email: emailSchema.optional() });
  app.post(
    "/resend-verification",
    { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (req) => {
      const parsed = resendSchema.safeParse(req.body ?? {});
      // Try authed path first, fall back to email lookup.
      let user: { id: string; email: string; name: string | null; emailVerifiedAt: Date | null } | null = null;
      try {
        await req.jwtVerify();
        const sub = (req.user as { sub: string }).sub;
        const [row] = await db
          .select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(eq(users.id, sub));
        if (row) user = row;
      } catch {
        // Unauthed path — pick user by email if provided.
        if (parsed.success && parsed.data.email) {
          const [row] = await db
            .select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
            .from(users)
            .where(eq(users.email, parsed.data.email));
          if (row) user = row;
        }
      }
      // Respond 200 regardless to avoid account enumeration.
      if (user && !user.emailVerifiedAt) {
        const code = await createVerificationCode(user.id);
        await sendVerificationEmail({ to: user.email, name: user.name, code }, req.log);
      }
      return { ok: true };
    },
  );

  // -------- Password reset (6-digit code) --------
  const forgotSchema = z.object({ email: emailSchema });
  const resetSchema = z.object({
    email: emailSchema,
    code: codeSchema,
    password: passwordSchema,
  });

  app.post(
    "/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const parsed = forgotSchema.safeParse(req.body);
      // Always 200 to prevent account enumeration.
      if (!parsed.success) return { ok: true };
      const { email } = parsed.data;
      const [user] = await db.select().from(users).where(eq(users.email, email));
      if (user && !user.suspendedAt) {
        try {
          const code = await createPasswordResetCode(user.id);
          await sendPasswordResetEmail({ to: user.email, name: user.name, code }, req.log);
        } catch (err) {
          req.log.error({ err }, "failed to send password reset email");
        }
      }
      return reply.send({ ok: true });
    },
  );

  app.post("/reset-password", async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email));
    if (!user) return reply.code(400).send({ error: "invalid_code" });
    const ok = await consumePasswordResetCodeForUser(user.id, parsed.data.code);
    if (!ok) return reply.code(400).send({ error: "invalid_code" });
    const passwordHash = await hashPassword(parsed.data.password);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    // Revoke all existing refresh tokens so other sessions log out.
    await revokeAllForUser(user.id);
    return { ok: true };
  });

  // -------- Invitation preview --------
  app.get("/invitations/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const [inv] = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        orgId: invitations.orgId,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(token)));
    if (!inv || inv.acceptedAt || inv.expiresAt.getTime() <= Date.now()) {
      return reply.code(400).send({ error: "invalid_or_expired_token" });
    }
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.orgId));
    return {
      invitation: {
        email: inv.email,
        role: inv.role,
        orgName: org?.name ?? "",
      },
    };
  });

  // -------- Accept invitation --------
  const acceptSchema = z.object({
    token: z.string().min(10),
    password: passwordSchema,
    name: z.string().min(1).max(200),
  });
  app.post("/invitations/accept", async (req, reply) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

    const [inv] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(parsed.data.token)));
    if (!inv || inv.acceptedAt || inv.expiresAt.getTime() <= Date.now()) {
      return reply.code(400).send({ error: "invalid_or_expired_token" });
    }

    const passwordHash = await hashPassword(parsed.data.password);

    // Upsert the user (invitations may target an email that already has an
    // account if they've been invited to another org previously).
    let userId: string;
    const [existing] = await db.select().from(users).where(eq(users.email, inv.email));
    if (existing) {
      userId = existing.id;
      await db
        .update(users)
        .set({ passwordHash, name: parsed.data.name, emailVerifiedAt: new Date() })
        .where(eq(users.id, existing.id));
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email: inv.email,
          passwordHash,
          name: parsed.data.name,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: users.id });
      userId = created.id;
    }

    // Upsert the membership for this org.
    const [existingMember] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, inv.orgId)));
    if (existingMember) {
      await db
        .update(memberships)
        .set({ role: inv.role, status: "active", joinedAt: new Date() })
        .where(eq(memberships.id, existingMember.id));
    } else {
      await db.insert(memberships).values({
        userId,
        orgId: inv.orgId,
        role: inv.role,
        status: "active",
        invitedBy: inv.invitedBy,
        invitedAt: inv.createdAt,
        joinedAt: new Date(),
      });
    }

    // Optional team assignment from the invitation.
    if (inv.teamId) {
      await db.insert(teamMembers).values({ teamId: inv.teamId, userId }).onConflictDoNothing();
    }

    await db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, inv.id));

    const refresh = await issueRefreshToken({
      userId,
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip,
    });
    const headless = isHeadlessClient(req);
    if (!headless) setRefreshCookie(reply, refresh.token);

    const accessToken = await signAccessToken(app, {
      userId,
      email: inv.email,
      orgId: inv.orgId,
      role: inv.role,
      mfaVerified: false,
    });
    const ctx = await loadAuthUser(userId, inv.orgId);
    return {
      accessToken,
      user: meShape(ctx),
      ...(headless ? { refreshToken: refresh.token } : {}),
    };
  });
}
