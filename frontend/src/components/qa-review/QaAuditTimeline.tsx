// Durable, attributable QA activity trace (A9). Reads qa_audit_events for a target.
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-kit";
import { formatDistanceToNow } from "date-fns";
import { useQAAudit } from "@/hooks/useQAReview";

export function QaAuditTimeline({
  targetType,
  targetId,
  callId,
}: {
  targetType?: string;
  targetId?: string;
  callId?: string;
}) {
  const { data, isLoading } = useQAAudit({ targetType, targetId, callId });

  if (isLoading) {
    return (
      <div className="space-y-2 p-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  const events = data?.events ?? [];
  if (events.length === 0) {
    return <EmptyState title="No activity yet" body="State changes on this item appear here." />;
  }
  return (
    <ul className="divide-y divide-border">
      {events.map((ev) => (
        <li key={ev.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium">{ev.action.replace(/^qa\./, "").replace(/[._]/g, " ")}</div>
            <div className="text-xs text-muted-foreground">{ev.actorName ?? "system"}</div>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
          </span>
        </li>
      ))}
    </ul>
  );
}
