// SLA policy table — current thresholds per metric with an Edit button that
// opens SlaPolicyDialog. Edit is gated on team_monitor.sla.write.
import { useState } from "react";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Pencil, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { useSlaPolicies, type SlaPolicy } from "@/hooks/useTeamMonitor";
import { SLA_METRIC_META, fmtThreshold } from "./labels";
import { SkeletonRows, ErrorState } from "./states";
import { SlaPolicyDialog } from "./SlaPolicyDialog";

export function SlaPanel() {
  const canWrite = useCan("team_monitor.sla.write");
  const { data, isLoading, isError, error, refetch } = useSlaPolicies();
  const [editing, setEditing] = useState<SlaPolicy | null>(null);

  const errMsg =
    (error as { body?: { error?: string }; message?: string } | undefined)?.body?.error ??
    (error as Error | undefined)?.message ??
    "Request failed";

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" /> SLA policies
        </div>
      }
    >
      {isLoading ? (
        <SkeletonRows rows={5} cols={4} />
      ) : isError ? (
        <ErrorState message={errMsg} onRetry={() => refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table text-sm w-full">
            <caption className="sr-only">SLA threshold policies</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="text-right">
                  Warning
                </th>
                <th scope="col" className="text-right">
                  Critical
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.policies ?? []).map((p) => {
                const meta = SLA_METRIC_META[p.metric];
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="font-medium">{meta.label}</div>
                      <div className="text-xs text-muted-foreground">{meta.help}</div>
                    </td>
                    <td className="text-right tabular-nums">{fmtThreshold(p.metric, p.warningThreshold)}</td>
                    <td className="text-right tabular-nums">{fmtThreshold(p.metric, p.criticalThreshold)}</td>
                    <td>
                      <span
                        className={cn(
                          "pill text-[10px] border",
                          p.enabled
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-muted text-muted-foreground border-border",
                        )}
                      >
                        {p.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td className="text-right">
                      <TooltipProvider>
                        {canWrite ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => setEditing(p)}
                            data-testid={`edit-sla-${p.metric}`}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                          </Button>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-block">
                                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled>
                                  <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>Requires SLA-edit permission</TooltipContent>
                          </Tooltip>
                        )}
                      </TooltipProvider>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <SlaPolicyDialog policy={editing} open={!!editing} onOpenChange={(v) => !v && setEditing(null)} />
    </Card>
  );
}
