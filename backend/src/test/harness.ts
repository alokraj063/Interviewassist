// Shared harness for API integration tests (*.itest.ts).
//
// Page-build agents import from here to:
//   - getApp()        → a single booted Fastify instance (memoized, no socket;
//                       requests go through app.inject()).
//   - tokenFor(email) → a signed 15-min JWT for any seeded user, with the real
//                       JwtPayload shape (sub/email/orgId/role/mfaVerified/
//                       isPlatformAdmin) looked up from the DB.
//   - authedInject()  → app.inject() with the Authorization header pre-filled.
//   - assertion helpers for the common response checks.
//
// The disposable DB is created/migrated/seeded by src/test/globalSetup.ts
// before any of this runs; DATABASE_URL is already pointed at it.
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { expect } from "vitest";
import { db, memberships, users } from "@j2w/db";
import { buildServer } from "../server.js";
import type { JwtPayload } from "../server.js";

let _app: Promise<FastifyInstance> | null = null;

/**
 * The booted Fastify app, memoized across the whole test run. Registers every
 * route but never calls `.listen()` — exercise it via `app.inject()` so there's
 * no real socket and no port contention.
 */
export function getApp(): Promise<FastifyInstance> {
  if (!_app) _app = buildServer();
  return _app;
}

const _tokenCache = new Map<string, string>();

/**
 * Mint a real access token for a seeded user, by email.
 *
 * Looks up the user's id + (for non-platform-admins) their active membership's
 * orgId/role from the disposable DB, then signs with `app.jwt.sign` so the
 * token is identical to what `POST /api/auth/login` would issue. Works for any
 * seeded persona — e.g.:
 *
 *   const admin     = await tokenFor("admin@recruitassist.local");
 *   const recruiter = await tokenFor("recruiter1@recruitassist.local");
 *   const qa        = await tokenFor("qa1@recruitassist.local");
 *
 * Throws if the email isn't seeded (so a typo fails loudly rather than minting
 * a token for a non-existent user).
 */
export async function tokenFor(email: string): Promise<string> {
  const key = email.toLowerCase();
  const cached = _tokenCache.get(key);
  if (cached) return cached;

  const app = await getApp();
  const [user] = await db.select().from(users).where(eq(users.email, key));
  if (!user) {
    throw new Error(`tokenFor: no seeded user with email "${email}"`);
  }

  let payload: JwtPayload;
  if (user.isPlatformAdmin) {
    // Platform admins have no membership; loadAuthUser maps them onto the
    // PLATFORM_ORG_ID sentinel. Mirror what signAccessToken does on login.
    payload = {
      sub: user.id,
      email: user.email,
      orgId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      role: "admin",
      mfaVerified: false,
      isPlatformAdmin: true,
    };
  } else {
    const [member] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active")));
    if (!member) {
      throw new Error(`tokenFor: user "${email}" has no active membership`);
    }
    payload = {
      sub: user.id,
      email: user.email,
      orgId: member.orgId,
      role: member.role,
      mfaVerified: false,
      isPlatformAdmin: false,
    };
  }

  const token = app.jwt.sign(payload);
  _tokenCache.set(key, token);
  return token;
}

/**
 * `app.inject()` with the Authorization header pre-filled for `email`. Any
 * `opts.headers` you pass win over the injected token, so you can still test
 * malformed-auth paths explicitly.
 */
export async function authedInject(email: string, opts: InjectOptions) {
  const app = await getApp();
  const token = await tokenFor(email);
  return app.inject({
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.headers ?? {}),
    },
  });
}

// ---------- assertion helpers ----------

/** Assert a response status and return the parsed JSON body, typed by caller. */
export function expectJson<T = unknown>(
  res: { statusCode: number; body: string; payload: string },
  status = 200,
): T {
  expect(
    res.statusCode,
    `expected ${status}, got ${res.statusCode}: ${res.body ?? res.payload}`,
  ).toBe(status);
  return JSON.parse(res.payload) as T;
}

/** Assert a request was rejected as unauthenticated (401). */
export function expectUnauthorized(res: { statusCode: number }): void {
  expect(res.statusCode).toBe(401);
}

/** Assert a request was rejected as forbidden (403). */
export function expectForbidden(res: { statusCode: number }): void {
  expect(res.statusCode).toBe(403);
}
