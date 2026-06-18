import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { PageHeader, MetricCard, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVoiceAgentsList } from "@/hooks/useVoiceAgents";

export default function VoiceAgents() {
  const nav = useNavigate();
  const { data: agents, isLoading, error } = useVoiceAgentsList();

  const total = agents?.length ?? 0;
  const active = agents?.filter((a) => a.status === "active").length ?? 0;

  return (
    <div>
      <PageHeader
        title="Voice Agents"
        subtitle="Autonomous AI voice agents for routine calls"
        actions={
          <Button size="sm" onClick={() => nav("/voice-agents/new")}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Create voice agent
          </Button>
        }
      />
      <div className="p-6 space-y-5">
        <div className="grid grid-cols-5 gap-4">
          <MetricCard label="Total agents" value={total} />
          <MetricCard label="Active" value={active} accent="success" />
          <MetricCard label="Draft" value={agents?.filter((a) => a.status === "draft").length ?? 0} />
          <MetricCard label="Paused" value={agents?.filter((a) => a.status === "paused").length ?? 0} />
          <MetricCard label="Archived" value={agents?.filter((a) => a.status === "archived").length ?? 0} />
        </div>
        <Card title="All voice agents">
          {isLoading ? (
            <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
          ) : error ? (
            <div className="p-8 text-sm text-destructive text-center">Failed to load voice agents.</div>
          ) : !agents || agents.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground text-center">
              No voice agents yet.{" "}
              <button className="text-primary underline" onClick={() => nav("/voice-agents/new")}>
                Create your first one
              </button>
              .
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Purpose</th>
                  <th>Phone</th>
                  <th>Language</th>
                  <th>Voice</th>
                  <th>Last deployed</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((v) => (
                  <tr key={v.id} className="cursor-pointer" onClick={() => nav(`/voice-agents/${v.id}`)}>
                    <td className="font-medium">{v.name}</td>
                    <td>
                      <span
                        className={cn(
                          "pill",
                          v.status === "active"
                            ? "bg-success/15 text-success"
                            : v.status === "paused"
                              ? "bg-warning/15 text-warning"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {v.status}
                      </span>
                    </td>
                    <td className="text-xs text-muted-foreground max-w-[280px]">{v.purpose || "—"}</td>
                    <td className="font-mono text-xs">{v.phoneNumber ?? "—"}</td>
                    <td className="text-xs">{v.language === "multi" ? "Hinglish" : v.language}</td>
                    <td className="text-xs text-muted-foreground">
                      {v.voiceId ? `${v.voiceProvider}:${v.voiceId.slice(0, 10)}` : "—"}
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {v.lastDeployedAt ? new Date(v.lastDeployedAt).toLocaleString() : "never"}
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
