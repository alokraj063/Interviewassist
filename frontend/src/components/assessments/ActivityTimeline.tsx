import { formatDistanceToNow } from "date-fns";
import { Loader2, History } from "lucide-react";
import type { AuditEntry } from "@/hooks/useAssessments";

// Renders the append-only /audit timeline for a template. Newest-first; every
// row is attributable (actorName) or candidate-side (token action). This is the
// durable A9 observability trace.
const ACTION_LABEL: Record<string, string> = {
  "template.created": "Created assessment",
  "template.updated": "Updated settings",
  "template.published": "Published a version",
  "template.unpublished": "Unpublished",
  "template.duplicated": "Duplicated",
  "template.archived": "Archived",
  "item.created": "Added an item",
  "item.updated": "Edited an item",
  "item.deleted": "Removed an item",
  "item.reordered": "Reordered items",
  "invite.created": "Invited a candidate",
  "invite.resent": "Resent invite / reminder",
  "invite.revoked": "Revoked an invite",
  "attempt.started": "Candidate started",
  "attempt.submitted": "Candidate submitted",
  "attempt.autograded": "Auto-graded",
  "attempt.reviewed": "Reviewed an attempt",
  "attempt.reopened": "Reopened an attempt",
};

export function ActivityTimeline({
  entries,
  loading,
}: {
  entries: AuditEntry[] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading activity…
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex flex-col items-center gap-2">
        <History className="w-7 h-7 opacity-30" />
        No activity recorded yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {entries.map((e) => (
        <li key={e.id} className="px-4 py-2.5 flex items-start justify-between gap-3 text-sm">
          <div className="flex-1">
            <div className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</div>
            <div className="text-xs text-muted-foreground">
              {e.actorName ?? "Candidate (token)"}
              {typeof e.detail?.version === "number" ? ` · v${e.detail.version}` : ""}
              {typeof e.detail?.percent === "number" ? ` · ${e.detail.percent}%` : ""}
            </div>
          </div>
          <time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={e.createdAt}>
            {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
          </time>
        </li>
      ))}
    </ul>
  );
}
