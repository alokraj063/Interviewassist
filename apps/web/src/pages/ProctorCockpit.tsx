import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldCheck, Loader2, Settings, ClipboardList, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import {
  useProctorSummary,
  useProctorSessions,
  errMessage,
  type SessionFilters,
  type SessionRow,
} from "@/hooks/useProctor";
import { SessionFilters as SessionFiltersBar } from "@/components/proctor/SessionFilters";
import { RiskMeter } from "@/components/proctor/RiskMeter";
import { BulkActionBar } from "@/components/proctor/BulkActionBar";

const STATUS_PILL: Record<string, string> = {
  live: "bg-info/15 text-info",
  completed: "bg-success/15 text-success",
  abandoned: "bg-destructive/15 text-destructive",
};
const LIVE_PILL: Record<string, string> = {
  active: "bg-info/15 text-info",
  paused: "bg-warning/15 text-warning",
  ended: "bg-muted text-muted-foreground",
};
const DECISION_PILL: Record<string, string> = {
  clean: "bg-success/15 text-success",
  flagged: "bg-warning/15 text-warning",
  invalidated: "bg-destructive/15 text-destructive",
};

function slaCountdown(due: string | null): { text: string; breached: boolean } | null {
  if (!due) return null;
  const ms = new Date(due).getTime() - Date.now();
  if (ms <= 0) return { text: `overdue ${formatDistanceToNow(new Date(due))}`, breached: true };
  return { text: `due in ${formatDistanceToNow(new Date(due))}`, breached: false };
}

export default function ProctorCockpit() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canReview = useCan("proctoring.review");
  const canExport = useCan("proctoring.export");
  const canPolicy = useCan("proctoring.policy.write");

  const filters: SessionFilters = useMemo(
    () => ({
      status: (params.get("status") as SessionFilters["status"]) || undefined,
      liveState: (params.get("liveState") as SessionFilters["liveState"]) || undefined,
      decision: (params.get("decision") as SessionFilters["decision"]) || undefined,
      minRisk: params.get("minRisk") ? Number(params.get("minRisk")) : undefined,
      assignedToMe: params.get("assignedToMe") === "true" || undefined,
      q: params.get("q") || undefined,
      sort: (params.get("sort") as SessionFilters["sort"]) || "recent",
    }),
    [params],
  );
  const hasFilters = Boolean(
    filters.status || filters.liveState || filters.decision || filters.minRisk || filters.assignedToMe || filters.q,
  );

  const patch = (next: Partial<SessionFilters & { cursor?: undefined }>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "" || v === false) sp.delete(k);
      else sp.set(k, String(v));
    }
    setSelected(new Set());
    setParams(sp, { replace: true });
  };
  const clearAll = () => {
    const sort = params.get("sort");
    const sp = new URLSearchParams();
    if (sort) sp.set("sort", sort);
    setSelected(new Set());
    setParams(sp, { replace: true });
  };

  // Live views refresh on an interval; otherwise rely on cache.
  const refetchMs = filters.liveState === "active" || filters.status === "live" ? 8000 : undefined;
  const summary = useProctorSummary(refetchMs);
  const sessionsQ = useProctorSessions(filters);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const allRows: SessionRow[] = useMemo(
    () => sessionsQ.data?.pages.flatMap((p) => p.sessions) ?? [],
    [sessionsQ.data],
  );
  const total = sessionsQ.data?.pages[0]?.total ?? 0;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const s = summary.data;

  return (
    <div>
      <PageHeader
        title="Proctor cockpit"
        subtitle="Centrally monitor live exams, intervene, and adjudicate integrity sessions."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate("/proctor/review")}>
              <ClipboardList className="w-3.5 h-3.5 mr-1.5" /> Review queue
            </Button>
            {canPolicy && (
              <Button variant="outline" size="sm" onClick={() => navigate("/proctor/settings")}>
                <Settings className="w-3.5 h-3.5 mr-1.5" /> Policies
              </Button>
            )}
          </>
        }
      />
      <div className="p-6 space-y-4">
        {/* Summary cards — server aggregates, correct at any scale. */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <MetricCard label="Live now" value={s?.live ?? "—"} accent={(s?.live ?? 0) > 0 ? "warning" : "default"} />
          <MetricCard label="Paused" value={s?.paused ?? "—"} />
          <MetricCard label="Pending review" value={s?.pendingReview ?? "—"} />
          <MetricCard label="SLA breached" value={s?.slaBreached ?? "—"} accent={(s?.slaBreached ?? 0) > 0 ? "danger" : "default"} />
          <MetricCard label="Flagged today" value={s?.flaggedToday ?? "—"} />
          <MetricCard label="Avg risk" value={s?.avgRisk ?? "—"} />
        </div>

        <Card>
          <div className="p-4 border-b border-border">
            <SessionFiltersBar
              filters={filters}
              patch={patch}
              clearAll={clearAll}
              hasFilters={hasFilters}
              showAssignedToMe={canReview}
            />
          </div>

          {sessionsQ.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
              ))}
            </div>
          ) : sessionsQ.isError ? (
            <div className="p-6 text-sm">
              <p className="text-destructive mb-3">{errMessage(sessionsQ.error)}</p>
              <Button variant="outline" size="sm" onClick={() => sessionsQ.refetch()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : allRows.length === 0 ? (
            hasFilters ? (
              <EmptyState
                title="No sessions match these filters"
                body="Try widening the risk range or clearing a filter."
                action={
                  <Button variant="outline" size="sm" onClick={clearAll}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No proctored sessions yet"
                body="Assessments and async-video flows that opt into proctoring will surface here. Arm a proctoring policy to define which signals are watched."
                action={
                  canPolicy ? (
                    <Button size="sm" onClick={() => navigate("/proctor/settings")}>
                      <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Configure a policy
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <>
              <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground border-b border-border">
                <span>
                  Showing {allRows.length} of {total.toLocaleString()} sessions
                </span>
              </div>
              <ul className="divide-y divide-border">
                {allRows.map((row) => {
                  const sla = slaCountdown(row.reviewSlaDueAt);
                  const display = row.candidateName ?? "Unlinked candidate";
                  return (
                    <li key={row.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30">
                      {canReview && (
                        <Checkbox
                          checked={selected.has(row.id)}
                          onCheckedChange={() => toggle(row.id)}
                          aria-label={`Select ${display}`}
                        />
                      )}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/proctor/sessions/${row.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/proctor/sessions/${row.id}`);
                          }
                        }}
                        className="flex-1 min-w-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring rounded"
                      >
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/proctor/sessions/${row.id}`}
                            className="text-sm font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {display}
                          </Link>
                          {row.status === "live" && row.liveState === "active" && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-info">
                              <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" /> live
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Started {formatDistanceToNow(new Date(row.startedAt), { addSuffix: true })}
                          {row.assessmentAttemptId ? " · Assessment" : row.asyncVideoSubmissionId ? " · Async video" : ""}
                          {row.assignedReviewerName ? ` · ${row.assignedReviewerName}` : ""}
                        </div>
                      </div>
                      <div className="hidden sm:block w-32">
                        <RiskMeter score={row.riskScore} label={row.riskLabel} />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {row.flagCount > 0 && (
                          <span className="pill bg-warning/15 text-warning text-[11px]">
                            {row.flagCount} flag{row.flagCount > 1 ? "s" : ""}
                          </span>
                        )}
                        <span className={cn("pill text-[11px] capitalize", LIVE_PILL[row.liveState])}>{row.liveState}</span>
                        <span className={cn("pill text-[11px] capitalize", STATUS_PILL[row.status])}>{row.status}</span>
                        {row.reviewerDecision && (
                          <span className={cn("pill text-[11px] capitalize", DECISION_PILL[row.reviewerDecision])}>
                            {row.reviewerDecision}
                          </span>
                        )}
                        {sla && (
                          <span className={cn("text-[11px] whitespace-nowrap", sla.breached ? "text-destructive font-medium" : "text-muted-foreground")}>
                            {sla.text}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {sessionsQ.hasNextPage && (
                <div className="p-4 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => sessionsQ.fetchNextPage()}
                    disabled={sessionsQ.isFetchingNextPage}
                  >
                    {sessionsQ.isFetchingNextPage ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Loading…
                      </>
                    ) : (
                      "Load more"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 px-6 pb-4 pointer-events-none">
          <div className="pointer-events-auto">
            <BulkActionBar
              selected={selected}
              rows={allRows}
              canReview={canReview}
              canExport={canExport}
              onClear={() => setSelected(new Set())}
              onDone={() => setSelected(new Set())}
            />
          </div>
        </div>
      )}
    </div>
  );
}
