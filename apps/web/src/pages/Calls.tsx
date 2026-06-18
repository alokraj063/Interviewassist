import { Link } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { useCalls } from "@/hooks/useCalls";
import { Loader2, MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

const STATUS_PILL: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  assigned: "bg-warning/15 text-warning",
  active: "bg-success/15 text-success",
  ended: "bg-muted text-muted-foreground",
};

export default function Calls() {
  const { data: calls = [], isLoading } = useCalls();

  const live = calls.filter((c) => c.status === "active" || c.status === "assigned").length;
  const today = calls.filter((c) => Date.now() - new Date(c.startedAt).getTime() < 24 * 60 * 60_000).length;

  return (
    <div>
      <PageHeader
        title="Calls"
        subtitle="Recruiter-candidate calls. Click any row for replay, transcript, summary, and rubric."
      />
      <div className="p-6 space-y-5">
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Total in view" value={calls.length} />
          <MetricCard label="Live now" value={live} accent={live > 0 ? "success" : undefined} />
          <MetricCard label="Last 24 h" value={today} />
        </div>
        <Card>
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading calls…
            </div>
          ) : calls.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <MessagesSquare className="w-6 h-6 mx-auto mb-2 opacity-40" />
              No calls yet. Start one from <Link to="/live-assist" className="text-primary hover:underline">Live Assist</Link>.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Recruiter</th>
                  <th>Candidate</th>
                  <th>Mode</th>
                  <th>Origin</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/40">
                    <td>
                      <Link to={`/calls/${c.id}`} className="text-primary hover:underline font-mono text-xs">
                        {c.id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="text-sm">{c.recruiterName ?? c.recruiterEmail ?? "—"}</td>
                    <td className="text-sm">{c.candidateRefOrPhone ?? "—"}</td>
                    <td className="text-xs"><span className="pill bg-muted text-muted-foreground">{c.mode}</span></td>
                    <td className="text-xs">{c.origin ?? "—"}</td>
                    <td><span className={cn("pill", STATUS_PILL[c.status] ?? "bg-muted text-muted-foreground")}>{c.status}</span></td>
                    <td className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(c.startedAt), { addSuffix: true })}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {c.endedAt ? formatDistanceToNow(new Date(c.endedAt), { addSuffix: true }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
