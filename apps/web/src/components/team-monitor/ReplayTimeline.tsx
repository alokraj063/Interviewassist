// Shift replay: a date-windowed (max 24h) merged audit timeline of supervisor
// actions — who whispered/barged/took over, who reassigned, who acked which
// alert, and when. Keyset-paginated from the append-only team_monitor_audit.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, ArrowRight } from "lucide-react";
import { useReplay, type ReplayEvent } from "@/hooks/useTeamMonitor";
import { SkeletonRows, ErrorState, EmptyFirstRun, Pager } from "./states";

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const ACTION_LABEL: Record<string, string> = {
  "supervision.whisper.start": "Whisper started",
  "supervision.whisper.end": "Whisper ended",
  "supervision.barge.start": "Barge started",
  "supervision.barge.end": "Barge ended",
  "supervision.takeover.start": "Takeover started",
  "supervision.takeover.end": "Takeover ended",
  "call.reassign": "Call reassigned",
  "alert.ack": "Alert acknowledged",
  "alert.resolve": "Alert resolved",
  "alert.raise": "Alert raised",
  "sla_policy.update": "SLA policy updated",
};

export function ReplayTimeline() {
  const now = useMemo(() => new Date(), []);
  const defFrom = useMemo(() => new Date(now.getTime() - 8 * 3600_000), [now]);

  const [fromStr, setFromStr] = useState(toLocalInput(defFrom));
  const [toStr, setToStr] = useState(toLocalInput(now));
  const [applied, setApplied] = useState<{ from: string; to: string } | null>({
    from: defFrom.toISOString(),
    to: now.toISOString(),
  });
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [stack, setStack] = useState<string[]>([]);
  const [windowErr, setWindowErr] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useReplay(
    {
      from: applied?.from ?? defFrom.toISOString(),
      to: applied?.to ?? now.toISOString(),
      cursor,
      limit: 50,
    },
    !!applied,
  );

  const events = data?.events ?? [];
  const errMsg =
    (error as { body?: { error?: string }; message?: string } | undefined)?.body?.error ??
    (error as Error | undefined)?.message ??
    "Request failed";

  function apply() {
    const from = new Date(fromStr);
    const to = new Date(toStr);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      setWindowErr("Enter a valid window where the end is after the start.");
      return;
    }
    if (to.getTime() - from.getTime() > 24 * 3600_000) {
      setWindowErr("The replay window can be at most 24 hours.");
      return;
    }
    setWindowErr(null);
    setCursor(undefined);
    setStack([]);
    setApplied({ from: from.toISOString(), to: to.toISOString() });
  }

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4" /> Shift replay
        </div>
      }
      action={
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label htmlFor="replay-from" className="text-[10px] block text-muted-foreground">
              From
            </label>
            <Input
              id="replay-from"
              type="datetime-local"
              className="h-8 w-48"
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="replay-to" className="text-[10px] block text-muted-foreground">
              To
            </label>
            <Input
              id="replay-to"
              type="datetime-local"
              className="h-8 w-48"
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
            />
          </div>
          <Button size="sm" className="h-8" onClick={apply} data-testid="replay-apply">
            Apply
          </Button>
        </div>
      }
    >
      {windowErr && (
        <p className="px-4 pt-3 text-xs text-destructive" data-testid="replay-window-error">
          {windowErr}
        </p>
      )}
      {isLoading ? (
        <SkeletonRows rows={6} cols={3} />
      ) : isError ? (
        <ErrorState message={errMsg} onRetry={() => refetch()} />
      ) : events.length === 0 ? (
        <EmptyFirstRun
          title="No supervisor activity in this window"
          body="Whispers, barges, takeovers, reassignments, alert acks and SLA edits within the selected window appear here as an attributable timeline."
        />
      ) : (
        <>
          <ol className="divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 flex items-start gap-3" data-testid="replay-event">
                <div className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap mt-0.5 w-28">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{ACTION_LABEL[e.action] ?? e.action}</div>
                  <ReplayDetail event={e} />
                </div>
              </li>
            ))}
          </ol>
          <Pager
            label={`${events.length} events`}
            canPrev={stack.length > 0}
            canNext={!!data?.nextCursor}
            onPrev={() => {
              const next = [...stack];
              next.pop();
              setStack(next);
              setCursor(next[next.length - 1]);
            }}
            onNext={() => {
              if (!data?.nextCursor) return;
              setStack((s) => [...s, data.nextCursor!]);
              setCursor(data.nextCursor);
            }}
          />
        </>
      )}
    </Card>
  );
}

function ReplayDetail({ event }: { event: ReplayEvent }) {
  const p = event.payload ?? {};
  if (event.targetType === "call" && event.targetId) {
    const reason = typeof p.reason === "string" ? ` — ${p.reason}` : "";
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        <Link to={`/calls/${event.targetId}`} className="text-primary hover:underline">
          Open call
        </Link>
        {("fromUserId" in p || "toUserId" in p) && <ArrowRight className="w-3 h-3" />}
        <span>{reason}</span>
      </div>
    );
  }
  if (event.targetType === "policy") {
    return <div className="text-xs text-muted-foreground">Metric: {event.targetId}</div>;
  }
  return null;
}
