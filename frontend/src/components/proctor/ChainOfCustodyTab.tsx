import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { useSessionAudit, type AuditEntry } from "@/hooks/useProctor";

const ACTION_LABEL: Record<string, string> = {
  "session.view": "viewed evidence",
  "session.review": "decided",
  "session.assign": "assigned reviewer",
  "session.terminate": "terminated",
  "session.pause": "paused",
  "session.resume": "resumed",
  "session.extend": "extended time",
  "event.ack": "acknowledged event",
  "evidence.export": "exported evidence",
  "evidence.view": "viewed evidence",
  "identity.verify": "verified identity",
  "policy.update": "updated policy",
  "intervention.send": "intervened",
};

function actorLabel(e: AuditEntry): string {
  return e.actorName ?? (e.actorUserId ? "a reviewer" : "system");
}

export function ChainOfCustodyTab({ sessionId }: { sessionId: string }) {
  const { data, isLoading, isError, error } = useSessionAudit(sessionId);

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading activity…
      </div>
    );
  }
  if (isError) {
    return <div className="p-6 text-sm text-destructive">{(error as Error)?.message ?? "Couldn't load activity."}</div>;
  }
  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    return <div className="p-6 text-sm text-muted-foreground">No activity recorded for this session yet.</div>;
  }

  return (
    <ul className="divide-y divide-border max-h-[520px] overflow-y-auto">
      {entries.map((e) => (
        <li key={e.id} className="px-4 py-2.5 text-sm flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="font-medium">{actorLabel(e)}</span>{" "}
            <span className="text-muted-foreground">{ACTION_LABEL[e.action] ?? e.action}</span>
            {(e.fromValue || e.toValue) && (
              <span className="text-muted-foreground">
                {" "}
                {e.fromValue ? `${e.fromValue} → ` : ""}
                <span className="font-medium text-foreground">{e.toValue ?? ""}</span>
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
          </span>
        </li>
      ))}
    </ul>
  );
}
