import { createHash, randomBytes } from "node:crypto";
import { db, refreshTokens } from "@j2w/db";
import { and, eq, isNull } from "drizzle-orm";

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const REFRESH_COOKIE_NAME = "j2w_rt";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssueRefreshOpts {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}

export async function issueRefreshToken(opts: IssueRefreshOpts): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken();
  const hash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const [row] = await db
    .insert(refreshTokens)
    .values({
      userId: opts.userId,
      tokenHash: hash,
      userAgent: opts.userAgent ?? null,
      ip: opts.ip ?? null,
      expiresAt,
    })
    .returning({ id: refreshTokens.id });
  return { token, id: row.id, expiresAt };
}

/**
 * Rotate a refresh token: validate the presented one, mark it revoked+replaced,
 * and issue a new one in a single transaction. Returns null if the token is
 * missing, expired, revoked, or belongs to a user who was deleted/suspended.
 */
export async function rotateRefreshToken(
  presentedToken: string,
  ctx: { userAgent?: string | null; ip?: string | null },
): Promise<{ userId: string; token: string; id: string; expiresAt: Date } | null> {
  const hash = hashToken(presentedToken);
  const [existing] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
  if (!existing) return null;
  if (existing.revokedAt) return null;
  if (existing.expiresAt.getTime() <= Date.now()) return null;

  const next = await issueRefreshToken({ userId: existing.userId, userAgent: ctx.userAgent, ip: ctx.ip });
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedBy: next.id })
    .where(eq(refreshTokens.id, existing.id));

  return { userId: existing.userId, ...next };
}

export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  const hash = hashToken(presentedToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
