// Shift-replay drill-down for the Team Monitor (/team-monitor/replay).
// Owns the windowed audit timeline; gated on team_monitor.read.
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ShieldOff } from "lucide-react";
import { useCan } from "@/auth/AuthContext";
import { ReplayTimeline } from "@/components/team-monitor/ReplayTimeline";

export default function TeamMonitorReplay() {
  const nav = useNavigate();
  const canRead = useCan("team_monitor.read");

  if (!canRead) {
    return (
      <div>
        <PageHeader title="Shift replay" subtitle="Supervisor activity timeline." />
        <div className="p-10 flex flex-col items-center text-center gap-3">
          <ShieldOff className="w-7 h-7 text-muted-foreground" />
          <div className="text-sm font-medium">You don't have access to shift replay</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Shift replay"
        subtitle="Attributable timeline of supervisor actions over a chosen window."
        breadcrumbs={[{ label: "Team monitor", href: "/team-monitor" }, { label: "Shift replay" }]}
        actions={
          <Button variant="outline" size="sm" onClick={() => nav("/team-monitor")}>
            <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Back to floor
          </Button>
        }
      />
      <div className="p-6">
        <ReplayTimeline />
      </div>
    </div>
  );
}
