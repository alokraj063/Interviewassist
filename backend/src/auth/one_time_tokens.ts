import { randomInt } from "node:crypto";
import { db, emailVerificationTokens, passwordResetTokens } from "@j2w/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken, randomToken } from "./tokens.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// 6-digit numeric codes for email verification and password reset — short
// enough for users to hand-type, long enough to be unguessable over the 1h/24h
// validity window combined with per-email rate limiting.
function randomSixDigit(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// -------- Email verification --------
export async function createVerificationCode(userId: string): Promise<string> {
  const code = randomSixDigit();
  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash: hashToken(code),
    expiresAt: new Date(Date.now() + ONE_DAY_MS),
  });
  return code;
}

export async function consumeVerificationCodeForUser(userId: string, code: string): Promise<boolean> {
  const hash = hashToken(code);
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.userId, userId),
        eq(emailVerificationTokens.tokenHash, hash),
        isNull(emailVerificationTokens.consumedAt),
        gt(emailVerificationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(eq(emailVerificationTokens.id, row.id));
  return true;
}

// Legacy token-based consume (for any still-outstanding link-style tokens).
export async function consumeVerificationToken(token: string): Promise<string | null> {
  const hash = hashToken(token);
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, hash));
  if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
  await db
    .update(emailVerificationTokens)
    .set({ consumedAt: new Date() })
    .where(eq(emailVerificationTokens.id, row.id));
  return row.userId;
}

// -------- Password reset --------
export async function createPasswordResetCode(userId: string): Promise<string> {
  const code = randomSixDigit();
  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash: hashToken(code),
    expiresAt: new Date(Date.now() + ONE_HOUR_MS),
  });
  return code;
}

export async function consumePasswordResetCodeForUser(userId: string, code: string): Promise<boolean> {
  const hash = hashToken(code);
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, userId),
        eq(passwordResetTokens.tokenHash, hash),
        isNull(passwordResetTokens.consumedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return false;
  await db
    .update(passwordResetTokens)
    .set({ consumedAt: new Date() })
    .where(eq(passwordResetTokens.id, row.id));
  return true;
}

// Re-exports kept for the invitation flow which still uses long tokens.
export { randomToken, hashToken };
