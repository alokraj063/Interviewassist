import { Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, RotateCcw, TrendingDown } from "lucide-react";
import { useKbAnalytics } from "@/hooks/useKnowledge";

export function AnalyticsTab() {
  const { data, isLoading, isError, error, refetch } = useKbAnalytics(30);

  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load analytics</div>
          <div className="max-w-md text-sm text-muted-foreground">{(error as Error)?.message}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const maxDay = Math.max(1, ...data.byDay.map((d) => d.retrievals + d.zeroResult));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={`Retrievals (${data.days}d)`} value={data.totals.retrievals.toLocaleString()} accent="success" />
        <MetricCard
          label="Zero-result queries"
          value={data.totals.zeroResult.toLocaleString()}
          accent={data.totals.zeroResult > 0 ? "warning" : "default"}
        />
        <MetricCard
          label="Avg latency"
          value={data.totals.avgLatencyMs == null ? "—" : `${data.totals.avgLatencyMs} ms`}
        />
        <MetricCard label="Stale sources" value={data.staleness.stale} accent={data.staleness.stale > 0 ? "warning" : "default"} />
      </div>

      <Card title="Retrievals by day">
        {data.byDay.length === 0 ? (
          <EmptyState title="No retrieval activity yet" body="Run a search or a live call to populate this." />
        ) : (
          <div className="flex items-end gap-1 p-4" style={{ height: 140 }}>
            {data.byDay.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${d.retrievals} hits, ${d.zeroResult} misses`}>
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${(d.retrievals / maxDay) * 100}%` }}
                />
                {d.zeroResult > 0 && (
                  <div
                    className="w-full bg-warning/70"
                    style={{ height: `${(d.zeroResult / maxDay) * 100}%` }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Top sources">
          {data.topSources.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No retrievals in range.</div>
          ) : (
            <ul className="divide-y divide-border">
              {data.topSources.map((s) => (
                <li key={s.sourceId ?? s.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate">{s.name}</span>
                  <span className="tabular-nums text-muted-foreground">{s.retrievals.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Content gaps">
          {data.contentGaps.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No zero-result or low-confidence queries detected — good coverage.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.contentGaps.map((g) => (
                <li key={g.queryHash} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <TrendingDown className="h-3.5 w-3.5 text-warning" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">{g.queryHash.slice(0, 12)}…</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {g.misses} miss{g.misses === 1 ? "" : "es"} · avg score{" "}
                    {g.avgScore == null ? "—" : g.avgScore.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
