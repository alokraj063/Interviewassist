// Append-only audit chokepoint for the Async Video Interview page. Every state
// change on a campaign / submission / scorecard / share-link / invite routes
// through recordAudit so the activity timeline + chain-of-custody is durable
// and attributable. The DB enforces append-only via the
// async_video_audit_log_no_mutate trigger.
import { asyncVideoAuditLog, db, type AsyncVideoAuditTargetType } from "@j2w/db";

export interface AsyncVideoAuditInput {
  orgId: string;
  action: string; // e.g. "campaign.publish", "submission.review", "share_link.revoke"
  targetType: AsyncVideoAuditTargetType;
  targetId: string;
  // null actor = candidate-side (token) action or external share-link reviewer.
  actorUserId?: string | null;
  actorLabel?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Insert an append-only audit row. Accepts the shared `db` or a transaction
 * handle so callers can record inside the same txn as the state change.
 */
export async function recordAudit(
  exec: typeof db,
  input: AsyncVideoAuditInput,
): Promise<void> {
  await exec.insert(asyncVideoAuditLog).values({
    orgId: input.orgId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    actorUserId: input.actorUserId ?? null,
    actorLabel: input.actorLabel ?? null,
    payload: input.payload ?? null,
  });
}
