// Live KPI tiles for the Team Monitor floor — every figure from /overview.
// Responsive grid (A8): 2 cols mobile → 5 cols xl. Loading shows shimmer, not 0.
import { Skeleton } from "@/components/ui/skeleton";
import { MetricCard } from "@/components/ui-kit";
import { useOverview } from "@/hooks/useTeamMonitor";

export function KpiTiles() {
  const { data, isLoading, isError } = useOverview();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" data-testid="kpi-skeleton" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <MetricCard key={i} label="—" value="—" />
        ))}
      </div>
    );
  }

  const k = data.kpis;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
      <MetricCard label="Recruiters online" value={k.recruitersOnline} />
      <MetricCard label="On call" value={k.onCall} accent={k.onCall > 0 ? "success" : "default"} />
      <MetricCard label="Idle" value={k.idle} accent={k.idle > 0 ? "warning" : "default"} />
      <MetricCard
        label="Queue depth"
        value={k.queueDepth}
        accent={k.queueDepth > 0 ? "warning" : "default"}
      />
      <MetricCard
        label="Open alerts"
        value={k.openAlerts}
        hint={k.criticalAlerts > 0 ? `${k.criticalAlerts} critical` : undefined}
        accent={k.criticalAlerts > 0 ? "danger" : k.openAlerts > 0 ? "warning" : "default"}
      />
    </div>
  );
}
