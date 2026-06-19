// Idempotency helper for create/invite/send on the Assessment Authoring page.
//
// Backed by the shared `idempotency_keys` table keyed by (org_id, scope, key).
// On a mutation the client MAY send an `Idempotency-Key` header. We cache the
// full response body so a retried request with the same key replays the
// original result instead of inserting a duplicate row. Keys older than 24h are
// ignored (and opportunistically purged) so a key can be safely reused after a
// day. When the header is absent, callers skip this entirely.
import { and, eq, lt, sql } from "drizzle-orm";
import { db, idempotencyKeys } from "@j2w/db";

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Read the Idempotency-Key header (case-insensitive), normalized/trimmed. */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers["idempotency-key"] ?? headers["Idempotency-Key"];
  if (typeof raw !== "string") return null;
  const k = raw.trim();
  return k.length > 0 && k.length <= 200 ? k : null;
}

/**
 * If a still-fresh row exists for (orgId, scope, key), return its cached
 * response body. Otherwise null. Opportunistically purges expired keys.
 */
export async function lookupIdempotent(
  orgId: string,
  scope: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const cutoff = new Date(Date.now() - KEY_TTL_MS);
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.orgId, orgId), lt(idempotencyKeys.createdAt, cutoff)));
  const [row] = await db
    .select({ response: idempotencyKeys.response })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.orgId, orgId),
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.key, key),
      ),
    )
    .limit(1);
  return row ? (row.response ?? null) : null;
}

/**
 * Record (orgId, scope, key) → response. ON CONFLICT DO NOTHING — if a
 * concurrent request already claimed the key, this is a no-op and the caller's
 * original work still stands (the cached body wins on the next replay).
 */
export async function recordIdempotent(
  orgId: string,
  scope: string,
  key: string,
  response: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(idempotencyKeys)
    .values({ orgId, scope, key, response: response as Record<string, unknown> })
    .onConflictDoNothing();
}

export { sql };
