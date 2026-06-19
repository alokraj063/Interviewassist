// Append-only audit chokepoint for the Assessment Authoring page. Every state
// change on a template/item/attempt/invite routes through recordAudit so the
// activity timeline + chain-of-custody is durable and attributable. The DB
// enforces append-only via the assessment_audit_log_no_mutate trigger.
import { assessmentAuditLog, db, type AssessmentAuditAction } from "@j2w/db";

export interface AuditInput {
  orgId: string;
  action: AssessmentAuditAction;
  targetKind: "template" | "item" | "attempt" | "version" | "section";
  targetId?: string | null;
  templateId?: string | null;
  // null actor = candidate-side (token) action
  actorUserId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Insert an append-only audit row. Accepts the shared `db` or a transaction
 * handle so callers can record inside the same txn as the state change.
 */
export async function recordAudit(exec: typeof db, input: AuditInput): Promise<void> {
  await exec.insert(assessmentAuditLog).values({
    orgId: input.orgId,
    action: input.action,
    targetKind: input.targetKind,
    targetId: input.targetId ?? null,
    templateId: input.templateId ?? null,
    actorUserId: input.actorUserId ?? null,
    detail: input.detail ?? {},
  });
}
