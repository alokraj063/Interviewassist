// OfferLetter single sign-on for the Interview Assist service.
//
// We do not run a second login here. Instead we verify the exact same JWT the
// OfferLetter app sets in the `authToken` cookie, using the shared
// OL_JWT_KEY secret, and resolve the recruiter from OL's own `users` /
// `sessions` collections.
//
// Verification logic mirrors OL's `backend/middleware/jwtMiddleware.js`:
//   1. Read cookie `authToken` or `Authorization: Bearer <token>` header,
//      or `?token=<jwt>` for WebSocket clients that can't set headers.
//   2. `jwt.verify(token, OL_JWT_KEY)` — fails fast on bad sig / expiry.
//   3. If `jti` is present, look up `sessions.findOne({ jti })` and 401 if
//      the row is missing or has `revokedAt` set.
//   4. Resolve the user via `users.findOne({ uid: decoded.uid })` and
//      reject if `isActive === false` or no row.
//
// Output shape — `OlAuthUser` — is what every route handler reads off
// `req.authUser`. It is intentionally NOT compatible with the old multi-
// tenant `AuthUser` (no orgId, no permissions); the rest of the code has
// been ported to use this directly.

import jwt from "jsonwebtoken";
import type { FastifyRequest } from "fastify";
import { ObjectId } from "mongodb";
import { collections } from "../mongo.js";
import { env } from "../env.js";

export type OlRole = string; // e.g. "UserRecruiter", "UserBusinessHead"…

/** Resolved actor for an Interview Assist request. */
export interface OlAuthUser {
  /** OL's business UID string (`users.uid`). */
  uid: string;
  /** OL's Mongo `_id` as a hex string — used to filter `jobAssignMappings`. */
  mongoId: string;
  email: string;
  name: string;
  /** OL `User.type` — e.g. "UserRecruiter". */
  role: OlRole;
  /** The session jti from the OL JWT, if present. */
  jti: string | null;
}

interface OlJwtPayload {
  uid: string;
  role: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

/** Read the OL token from cookie / Authorization header / ?token=. */
export function extractOlToken(req: FastifyRequest): string | null {
  const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[env.OL_AUTH_COOKIE_NAME];
  if (cookie) return cookie;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const queryToken = (req.query as { token?: string } | undefined)?.token;
  if (queryToken) return queryToken;
  return null;
}

interface OlUserDoc {
  _id: ObjectId;
  uid: string;
  email: string;
  firstName?: string;
  lastName?: string;
  type: string;
  isActive?: boolean;
}
interface OlSessionDoc {
  jti: string;
  revokedAt: Date | null;
}

/** Verify an OL JWT and resolve the user. Returns null on any failure. */
export async function verifyOlToken(token: string): Promise<OlAuthUser | null> {
  let decoded: OlJwtPayload;
  try {
    decoded = jwt.verify(token, env.OL_JWT_KEY) as OlJwtPayload;
  } catch {
    return null;
  }

  if (env.OL_VERIFY_SESSION_REVOCATION && decoded.jti) {
    const session = await collections.olSessions().findOne<OlSessionDoc>({ jti: decoded.jti });
    if (!session || session.revokedAt) return null;
  }

  const user = await collections.olUsers().findOne<OlUserDoc>({ uid: decoded.uid });
  if (!user) return null;
  if (user.isActive === false) return null;

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email;
  return {
    uid: user.uid,
    mongoId: user._id.toHexString(),
    email: user.email,
    name,
    role: user.type ?? decoded.role,
    jti: decoded.jti ?? null,
  };
}

/** Convenience: try to authenticate `req` and return the actor, or null. */
export async function authenticateOl(req: FastifyRequest): Promise<OlAuthUser | null> {
  const token = extractOlToken(req);
  if (!token) return null;
  return verifyOlToken(token);
}
