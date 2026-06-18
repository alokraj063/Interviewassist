// Team Monitor — supervisor floor surface (enterprise rebuild).
//
// A delivery lead / account manager / business head opens /team-monitor to:
//  - watch a heartbeat-backed live presence + activity roster,
//  - jump into a struggling live call (whisper / barge / takeover),
//  - author SLA thresholds evaluated server-side into live alerts (ack/resolve),
//  - rebalance work by reassigning a queued/assigned call,
//  - replay a shift from the append-only audit trail.
//
// All view state (tab + filters + search + sort) is URL-synced so a supervisor
// can bookmark "critical alerts, today" and refresh without losing context.
// Every action button is permission-gated via useCan; the page degrades to a
// read-only view for users with only team_monitor.read (never blank).
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Clock, ShieldOff } from "lucide-react";
import { useCan } from "@/auth/AuthContext";
import { KpiTiles } from "@/components/team-monitor/KpiTiles";
import { RosterTable } from "@/components/team-monitor/RosterTable";
import { LiveCallsPanel } from "@/components/team-monitor/LiveCallsPanel";
import { AlertsPanel } from "@/components/team-monitor/AlertsPanel";
import { SlaPanel } from "@/components/team-monitor/SlaPanel";
import { useHeartbeat } from "@/hooks/useTeamMonitor";
import type { PresenceActivity, RosterSort, AlertState, AlertSeverity } from "@/hooks/useTeamMonitor";

const TABS = ["floor", "alerts", "sla"] as const;
type Tab = (typeof TABS)[number];

export default function TeamMonitor() {
  const nav = useNavigate();
  const canRead = useCan("team_monitor.read");
  const [params, setParams] = useSearchParams();
  const heartbeat = useHeartbeat();

  const tab = (TABS.includes(params.get("tab") as Tab) ? params.get("tab") : "floor") as Tab;
  const activity = (params.get("activity") ?? "") as PresenceActivity | "";
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") ?? "name") as RosterSort;
  const astate = (params.get("astate") ?? "") as AlertState | "";
  const asev = (params.get("asev") ?? "") as AlertSeverity | "";

  // The supervisor's own presence heartbeat keeps them visible on the floor.
  useEffect(() => {
    if (!canRead) return;
    heartbeat.mutate({});
    const t = setInterval(() => heartbeat.mutate({}), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead]);

  function patch(next: Record<string, string | undefined>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  }

  if (!canRead) {
    return (
      <div>
        <PageHeader title="Team monitor" subtitle="Supervisor floor view." />
        <div className="p-10 flex flex-col items-center text-center gap-3">
          <ShieldOff className="w-7 h-7 text-muted-foreground" />
          <div className="text-sm font-medium">You don't have access to the team monitor</div>
          <div className="text-xs text-muted-foreground max-w-sm">
            This view requires the <code>team_monitor.read</code> permission. Ask an admin to grant
            it for your role.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Team monitor"
        subtitle="Live supervisor floor — presence, interventions, SLA alerts. Auto-refreshes."
        actions={
          <Button variant="outline" size="sm" onClick={() => nav("/team-monitor/replay")}>
            <Clock className="w-3.5 h-3.5 mr-1.5" /> Shift replay
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        <KpiTiles />

        <Tabs value={tab} onValueChange={(v) => patch({ tab: v, cursor: undefined })}>
          <TabsList>
            <TabsTrigger value="floor">Floor</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
            <TabsTrigger value="sla">SLA</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "floor" && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <LiveCallsPanel q={q} onSearch={(v) => patch({ q: v || undefined })} />
            <RosterTable
              activity={activity}
              q={q}
              sort={sort}
              onPatch={(n) =>
                patch({
                  activity: n.activity,
                  q: n.q,
                  sort: n.sort,
                })
              }
            />
          </div>
        )}

        {tab === "alerts" && (
          <AlertsPanel
            state={astate}
            severity={asev}
            onPatch={(n) => patch({ astate: n.astate, asev: n.asev })}
          />
        )}

        {tab === "sla" && <SlaPanel />}
      </div>
    </div>
  );
}
