// Page-private idempotency helper for the Rubrics route.
//
// On create/publish/duplicate/import the client MAY send an `Idempotency-Key`
// header. We record (org_id, key) → created_rubric_id in rubric_idempotency_keys
// so a retried request with the same key returns the originally-created
// resource instead of inserting a duplicate. Keys older than 24h are ignored
// (and opportunistically deleted) so a key can be safely reused after a day.
//
// When the header is absent, callers skip this entirely and behavior is
// unchanged. Kept page-private (its own table) per the spec; the integration
// coordinator can later promote it to a shared idempotency_keys table.
import { and, eq, lt, sql } from "drizzle-orm";
import { db, rubricIdempotencyKeys } from "@j2w/db";

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Read the Idempotency-Key header (case-insensitive), normalized/trimmed. */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers["idempotency-key"] ?? headers["Idempotency-Key"];
  if (typeof raw !== "string") return null;
  const k = raw.trim();
  return k.length > 0 && k.length <= 200 ? k : null;
}

/**
 * If a still-fresh row exists for (orgId, key), return the previously-created
 * rubric id. Otherwise null. Opportunistically purges expired keys for the org.
 */
export async function lookupIdempotentRubric(
  orgId: string,
  key: string,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - KEY_TTL_MS);
  // Opportunistic cleanup of this org's expired keys (cheap, indexed).
  await db
    .delete(rubricIdempotencyKeys)
    .where(and(eq(rubricIdempotencyKeys.orgId, orgId), lt(rubricIdempotencyKeys.createdAt, cutoff)));
  const [row] = await db
    .select({ createdRubricId: rubricIdempotencyKeys.createdRubricId })
    .from(rubricIdempotencyKeys)
    .where(and(eq(rubricIdempotencyKeys.orgId, orgId), eq(rubricIdempotencyKeys.key, key)))
    .limit(1);
  return row?.createdRubricId ?? null;
}

/**
 * Record (orgId, key) → createdRubricId. ON CONFLICT DO NOTHING — if a
 * concurrent request already claimed the key, the caller should re-lookup.
 */
export async function recordIdempotentRubric(
  orgId: string,
  key: string,
  createdRubricId: string,
): Promise<void> {
  await db
    .insert(rubricIdempotencyKeys)
    .values({ orgId, key, createdRubricId })
    .onConflictDoNothing();
}

// Re-export sql so callers needn't import drizzle directly for raw fragments.
export { sql };
