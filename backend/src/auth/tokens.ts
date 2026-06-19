import { createHash, randomBytes, randomUUID } from "node:crypto";
import { collections } from "../mongo.js";

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

interface RefreshDoc {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
}

export async function issueRefreshToken(opts: IssueRefreshOpts): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await collections.refreshTokens().insertOne({
    id,
    userId: opts.userId,
    tokenHash: hashToken(token),
    userAgent: opts.userAgent ?? null,
    ip: opts.ip ?? null,
    expiresAt,
    revokedAt: null,
    replacedBy: null,
    createdAt: new Date(),
  });
  return { token, id, expiresAt };
}

export async function rotateRefreshToken(
  presentedToken: string,
  ctx: { userAgent?: string | null; ip?: string | null },
): Promise<{ userId: string; token: string; id: string; expiresAt: Date } | null> {
  const hash = hashToken(presentedToken);
  const existing = await collections.refreshTokens().findOne<RefreshDoc>({ tokenHash: hash });
  if (!existing || existing.revokedAt || existing.expiresAt.getTime() <= Date.now()) return null;

  const next = await issueRefreshToken({ userId: existing.userId, userAgent: ctx.userAgent, ip: ctx.ip });
  await collections.refreshTokens().updateOne(
    { id: existing.id },
    { $set: { revokedAt: new Date(), replacedBy: next.id } },
  );
  return { userId: existing.userId, ...next };
}

export async function revokeRefreshToken(presentedToken: string): Promise<void> {
  await collections.refreshTokens().updateOne(
    { tokenHash: hashToken(presentedToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await collections.refreshTokens().updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}
