import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, RefreshCw, Loader2, Database } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface SyncStatus {
  configured: boolean;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  lastSuccessfulQuery?: string;
  latencyMs?: number;
  reason?: string;
}
interface SyncHeartbeat {
  id: string;
  queueName: string;
  lastRunAt: string;
  rowsUpserted: number;
  durationMs: number | null;
  lastError: string | null;
}
interface SyncMappingRow {
  id: string;
  label: string;
  externalId: number | null;
  updatedAt: string;
}
interface SyncMappings {
  demands: SyncMappingRow[];
  candidates: SyncMappingRow[];
}

export default function OfferLetterSync() {
  const qc = useQueryClient();

  const { data: status, isLoading: loadingStatus } = useQuery<SyncStatus>({
    queryKey: ["offer-letter-sync", "status"],
    queryFn: () => apiFetch<SyncStatus>("/api/admin/offer-letter-sync/status"),
  });

  const { data: heartbeats } = useQuery<{ heartbeats: SyncHeartbeat[] }>({
    queryKey: ["offer-letter-sync", "heartbeats"],
    queryFn: () => apiFetch("/api/admin/offer-letter-sync/heartbeats"),
  });

  const { data: mappings } = useQuery<SyncMappings>({
    queryKey: ["offer-letter-sync", "mappings"],
    queryFn: () => apiFetch("/api/admin/offer-letter-sync/mappings"),
  });

  const triggerDemands = useMutation({
    mutationFn: () => apiFetch("/api/admin/offer-letter-sync/demands", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["offer-letter-sync"] });
      toast.success("Demand sync queued");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const triggerFunnel = useMutation({
    mutationFn: () => apiFetch("/api/admin/offer-letter-sync/funnel", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["offer-letter-sync"] });
      toast.success("Funnel poll queued");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div>
      <PageHeader
        title="Offer Letter Sync"
        subtitle="Bridge between RecruitAssist and the J2W Offer Letter MySQL production database"
      />
      <div className="p-6 space-y-5">
        {loadingStatus ? (
          <Card>
            <div className="p-10 text-sm text-muted-foreground flex items-center gap-2 justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Probing connection…
            </div>
          </Card>
        ) : !status?.configured ? (
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-warning">Not configured</div>
              <div className="text-xs text-muted-foreground mt-1">
                Set <code className="text-foreground">OFFER_LETTER_MYSQL_HOST</code>, <code className="text-foreground">_USER</code>, <code className="text-foreground">_PASSWORD</code>, <code className="text-foreground">_DATABASE</code> in the API <code className="text-foreground">.env</code> and restart the worker. {status?.reason ? `Reason: ${status.reason}` : ""}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-success/5 border border-success/30 rounded-lg p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-success">Connected</div>
              <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                <span>Host: <code className="text-foreground">{status.host}</code></span>
                <span>Database: <code className="text-foreground">{status.database}</code></span>
                <span>User: <code className="text-foreground">{status.user}</code></span>
                {status.latencyMs != null && <span>Latency: <span className="tabular-nums text-foreground">{status.latencyMs}ms</span></span>}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-4 gap-4">
          <MetricCard
            label="Demand sync"
            value={heartbeatBadge(heartbeats?.heartbeats, "offer-letter-demand-sync")}
            hint={lastRunHint(heartbeats?.heartbeats, "offer-letter-demand-sync")}
          />
          <MetricCard
            label="Funnel poll"
            value={heartbeatBadge(heartbeats?.heartbeats, "offer-letter-funnel-poll")}
            hint={lastRunHint(heartbeats?.heartbeats, "offer-letter-funnel-poll")}
          />
          <MetricCard label="Demands synced" value={mappings?.demands.filter((d) => d.externalId != null).length ?? "—"} hint={`${mappings?.demands.length ?? 0} total`} />
          <MetricCard label="Candidates linked" value={mappings?.candidates.filter((c) => c.externalId != null).length ?? "—"} hint={`${mappings?.candidates.length ?? 0} total`} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Card title="Sync heartbeats" action={
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={!status?.configured || triggerDemands.isPending} onClick={() => triggerDemands.mutate()}>
                {triggerDemands.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                Re-sync demands
              </Button>
              <Button variant="outline" size="sm" disabled={!status?.configured || triggerFunnel.isPending} onClick={() => triggerFunnel.mutate()}>
                {triggerFunnel.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                Re-poll funnel
              </Button>
            </div>
          }>
            {heartbeats?.heartbeats?.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Queue</th>
                    <th>Last run</th>
                    <th>Rows</th>
                    <th>Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {heartbeats.heartbeats.map((h) => (
                    <tr key={h.id}>
                      <td className="text-sm font-mono">{h.queueName}</td>
                      <td className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(h.lastRunAt), { addSuffix: true })}</td>
                      <td className="text-sm tabular-nums">{h.rowsUpserted}</td>
                      <td className="text-xs tabular-nums">{h.durationMs ? `${h.durationMs}ms` : "—"}</td>
                      <td>
                        {h.lastError ? (
                          <span className="pill bg-destructive/15 text-destructive text-[11px]" title={h.lastError}>Error</span>
                        ) : (
                          <span className="pill bg-success/15 text-success text-[11px]">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="No heartbeats yet" body="The first sync run will appear here once the worker has dispatched a job." />
            )}
          </Card>

          <Card title="External ID mapping (recent)">
            {mappings ? (
              <div className="p-4 space-y-4">
                <MappingSection title="Demands" rows={mappings.demands.slice(0, 8)} />
                <MappingSection title="Candidates" rows={mappings.candidates.slice(0, 8)} />
              </div>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">Loading mappings…</div>
            )}
          </Card>
        </div>

        <Card title="What this page shows">
          <div className="p-5 text-sm space-y-2 text-muted-foreground">
            <p>
              The J2W Offer Letter MySQL database is the source of truth for clients, demands, recruiter assignments, and downstream
              hiring funnel state. RecruitAssist pulls from it read-only via the <code className="text-foreground">@j2w/offer-letter-db</code> workspace package.
            </p>
            <p>
              The two background queues run every few minutes:
              <code className="ml-1 text-foreground">offer-letter-demand-sync</code> (clients + demands + assignments) and
              <code className="ml-1 text-foreground">offer-letter-funnel-poll</code> (active submission stage transitions).
            </p>
            <p>
              Submission write-back to <code className="text-foreground">applied_jobs</code> is staged via the
              <code className="ml-1 text-foreground">offer_letter_outbox</code> table; the drain worker is deferred pending INSERT
              grants. See <a href="/docs/offer-letter-db.md" className="text-primary hover:underline">docs/offer-letter-db.md</a> for the
              full integration reference.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function heartbeatBadge(rows: SyncHeartbeat[] | undefined, queue: string): React.ReactNode {
  const r = rows?.find((h) => h.queueName === queue);
  if (!r) return <span className="text-sm text-muted-foreground">Never run</span>;
  if (r.lastError) return <span className="text-base font-semibold text-destructive">Error</span>;
  return <span className="text-base font-semibold text-success">Healthy</span>;
}

function lastRunHint(rows: SyncHeartbeat[] | undefined, queue: string): string {
  const r = rows?.find((h) => h.queueName === queue);
  if (!r) return "Awaiting first run";
  return `Last run ${formatDistanceToNow(new Date(r.lastRunAt), { addSuffix: true })}`;
}

function MappingSection({ title, rows }: { title: string; rows: SyncMappingRow[] }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-2">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">No rows yet.</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <Database className="w-3 h-3 text-muted-foreground/60 shrink-0" />
              <span className="flex-1 truncate">{r.label}</span>
              <span className={cn("pill text-[10px]", r.externalId ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                {r.externalId ? `OL #${r.externalId}` : "Not synced"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
