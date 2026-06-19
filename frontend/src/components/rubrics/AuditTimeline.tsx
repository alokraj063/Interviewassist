// Durable, attributable activity feed from /api/rubrics/:id/audit. Satisfies
// the A9 timeline requirement: who did what, to which version, when.
import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui-kit";
import { useRubricAudit, type AuditEntry } from "@/hooks/useRubrics";

const ACTION_LABEL: Record<string, string> = {
  created: "created the rubric",
  updated: "edited the draft",
  published: "published a version",
  unpublished: "unpublished",
  archived: "archived the rubric",
  restored: "restored the rubric",
  set_default: "set as default",
  cleared_default: "cleared default",
  duplicated: "duplicated",
  imported: "imported",
  deleted: "deleted the rubric",
};

function describe(e: AuditEntry): string {
  const base = ACTION_LABEL[e.action] ?? e.action;
  if (e.action === "published" && e.toVersion) return `published v${e.toVersion}`;
  return base;
}

export function AuditTimeline({ rubricId }: { rubricId: string }) {
  const { data, isLoading, isError, error } = useRubricAudit(rubricId);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading activity…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="p-6 text-sm text-destructive">
        Couldn't load activity: {error instanceof Error ? error.message : "unknown error"}
      </div>
    );
  }
  if (!data || data.entries.length === 0) {
    return (
      <div className="p-6">
        <EmptyState title="No activity yet" body="Changes to this rubric will appear here with who and when." />
      </div>
    );
  }

  return (
    <ol className="p-4 space-y-3">
      {data.entries.map((e) => (
        <li key={e.id} className="flex items-start gap-3" data-testid="audit-entry">
          <div className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0" aria-hidden />
          <div className="text-sm">
            <span className="font-medium">{e.actorName ?? e.actorEmail ?? "Someone"}</span>{" "}
            <span className="text-muted-foreground">{describe(e)}</span>
            <div className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
