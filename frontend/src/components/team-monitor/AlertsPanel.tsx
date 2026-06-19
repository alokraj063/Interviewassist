// SLA alert feed: severity badge (icon+text), filter chips (state/severity),
// multi-select bulk ack/resolve bar, per-row ack/resolve, keyset pagination.
// Writes are permission-gated (team_monitor.alerts.write).
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, CheckCheck, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useAlerts,
  useAckAlert,
  useResolveAlert,
  useBulkAlerts,
  ALERT_STATES,
  ALERT_SEVERITIES,
  type AlertState,
  type AlertSeverity,
} from "@/hooks/useTeamMonitor";
import { SEVERITY_META, SLA_METRIC_META } from "./labels";
import { SkeletonRows, ErrorState, EmptyFirstRun, EmptyFiltered, Pager } from "./states";

export function AlertsPanel({
  state,
  severity,
  onPatch,
}: {
  state: AlertState | "";
  severity: AlertSeverity | "";
  onPatch: (next: { astate?: string; asev?: string }) => void;
}) {
  const canWrite = useCan("team_monitor.alerts.write");
  const ackOne = useAckAlert();
  const resolveOne = useResolveAlert();
  const bulk = useBulkAlerts();

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [stack, setStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setCursor(undefined);
    setStack([]);
    setSelected(new Set());
  }, [state, severity]);

  const { data, isLoading, isError, error, refetch } = useAlerts({
    state: state ? [state] : undefined,
    severity: severity ? [severity] : undefined,
    cursor,
    limit: 25,
  });

  const rows = data?.rows ?? [];
  const hasFilters = !!state || !!severity;
  const errMsg = useMemo(() => {
    const e = error as { body?: { error?: string }; message?: string } | undefined;
    return e?.body?.error ?? e?.message ?? "Request failed";
  }, [error]);

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function runBulk(action: "ack" | "resolve") {
    if (selected.size === 0) return;
    try {
      const res = await bulk.mutateAsync({ ids: [...selected], action });
      toast.success(`${res.affected.length} alert${res.affected.length === 1 ? "" : "s"} ${action}ed`);
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk action failed");
    }
  }

  function clearFilters() {
    onPatch({ astate: "", asev: "" });
  }

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4" /> SLA alerts
        </div>
      }
      action={
        <div className="flex items-center gap-2">
          <Select value={state || "open"} onValueChange={(v) => onPatch({ astate: v })}>
            <SelectTrigger className="h-8 w-32" aria-label="Filter by state">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALERT_STATES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={severity || "all"} onValueChange={(v) => onPatch({ asev: v === "all" ? "" : v })}>
            <SelectTrigger className="h-8 w-32" aria-label="Filter by severity">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severity</SelectItem>
              {ALERT_SEVERITIES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      {/* Bulk action bar */}
      {canWrite && selected.size > 0 && (
        <div
          className="flex items-center gap-3 px-4 py-2 bg-primary/5 border-b border-border text-xs"
          data-testid="bulk-bar"
        >
          <span className="font-medium">{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={bulk.isPending}
            onClick={() => runBulk("ack")}
            data-testid="bulk-ack"
          >
            <Check className="w-3.5 h-3.5 mr-1" /> Ack selected
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={bulk.isPending}
            onClick={() => runBulk("resolve")}
            data-testid="bulk-resolve"
          >
            <CheckCheck className="w-3.5 h-3.5 mr-1" /> Resolve selected
          </Button>
          <Button size="sm" variant="ghost" className="h-7 ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={5} cols={4} />
      ) : isError ? (
        <ErrorState message={errMsg} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        hasFilters ? (
          <EmptyFiltered onClear={clearFilters} />
        ) : (
          <EmptyFirstRun
            title="No alerts right now"
            body="When a recruiter or the queue breaches an SLA policy, alerts appear here for you to acknowledge or resolve."
          />
        )
      ) : (
        <>
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const sev = SEVERITY_META[a.severity];
              const SevIcon = sev.icon;
              const terminal = a.state === "resolved" || a.state === "expired";
              return (
                <li key={a.id} className="px-4 py-3 flex items-start gap-3" data-testid="alert-row">
                  {canWrite && !terminal && (
                    <Checkbox
                      className="mt-0.5"
                      aria-label={`Select alert ${a.message}`}
                      checked={selected.has(a.id)}
                      onCheckedChange={() => toggle(a.id)}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn(
                          "pill text-[10px] inline-flex items-center gap-1 border",
                          sev.cls,
                        )}
                      >
                        <SevIcon className="w-3 h-3" aria-hidden /> {sev.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {SLA_METRIC_META[a.metric].label}
                      </span>
                      <span
                        className={cn(
                          "pill text-[10px] capitalize border",
                          a.state === "open"
                            ? "bg-rose-50 text-rose-700 border-rose-200"
                            : a.state === "acked"
                              ? "bg-amber-50 text-amber-700 border-amber-200"
                              : "bg-muted text-muted-foreground border-border",
                        )}
                        data-testid={`alert-state-${a.id}`}
                      >
                        {a.state}
                      </span>
                    </div>
                    <div className="text-sm mt-1">{a.message}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })} · observed{" "}
                      {a.observedValue} / threshold {a.thresholdValue}
                    </div>
                  </div>
                  {canWrite && !terminal && (
                    <div className="flex flex-col gap-1">
                      {a.state === "open" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={ackOne.isPending}
                          onClick={() =>
                            ackOne.mutate(a.id, {
                              onSuccess: () => toast.success("Alert acknowledged"),
                              onError: (e) => toast.error((e as Error).message),
                            })
                          }
                          data-testid={`ack-${a.id}`}
                        >
                          Ack
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={resolveOne.isPending}
                        onClick={() =>
                          resolveOne.mutate(a.id, {
                            onSuccess: () => toast.success("Alert resolved"),
                            onError: (e) => toast.error((e as Error).message),
                          })
                        }
                        data-testid={`resolve-${a.id}`}
                      >
                        Resolve
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager
            label={`${rows.length} shown`}
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
