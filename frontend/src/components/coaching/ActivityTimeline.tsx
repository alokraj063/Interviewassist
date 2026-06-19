// Durable, attributable activity feed for scenario/run detail (A9).
import { formatDistanceToNow } from "date-fns";
import type { AuditEvent } from "@/hooks/useCoaching";

const ACTION_LABELS: Record<string, string> = {
  "scenario.created": "Scenario created",
  "scenario.updated": "Scenario updated",
  "scenario.published": "Published",
  "scenario.unpublished": "Unpublished",
  "scenario.archived": "Archived",
  "scenario.duplicated": "Duplicated",
  "run.started": "Practice started",
  "run.linked_call": "Call linked",
  "run.completed": "Practice completed",
  "run.abandoned": "Practice abandoned",
  "run.scored": "Auto-scored",
  "run.score_overridden": "Score overridden",
  "assignment.created": "Assigned",
  "assignment.completed": "Assignment completed",
  "assignment.waived": "Assignment waived",
  "assignment.due_changed": "Due date changed",
};

function label(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

export function ActivityTimeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No activity yet.</p>;
  }
  return (
    <ol className="relative space-y-4 border-l border-border pl-4" aria-label="Activity timeline">
      {events.map((ev) => (
        <li key={ev.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{label(ev.action)}</span>
            <time className="text-xs text-muted-foreground" dateTime={ev.createdAt}>
              {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
            </time>
          </div>
          <div className="text-xs text-muted-foreground">
            {ev.actorName || ev.actorEmail || "System"}
          </div>
        </li>
      ))}
    </ol>
  );
}
