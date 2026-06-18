import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, RefreshCw, UserPlus, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { useReviewQueue, errMessage, type ReviewQueueRow } from "@/hooks/useProctor";
import { RiskMeter } from "@/components/proctor/RiskMeter";
import { AssignDialog } from "@/components/proctor/AssignDialog";

function sla(due: string | null): { text: string; breached: boolean } {
  if (!due) return { text: "no SLA", breached: false };
  const ms = new Date(due).getTime() - Date.now();
  if (ms <= 0) return { text: `overdue ${formatDistanceToNow(new Date(due))}`, breached: true };
  return { text: `due in ${formatDistanceToNow(new Date(due))}`, breached: false };
}

export default function ProctorReviewQueue() {
  const navigate = useNavigate();
  const canReview = useCan("proctoring.review");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);

  const queueQ = useReviewQueue(assignedToMe);
  const rows: ReviewQueueRow[] = useMemo(
    () => queueQ.data?.pages.flatMap((p) => p.queue) ?? [],
    [queueQ.data],
  );
  const total = queueQ.data?.pages[0]?.total ?? 0;

  if (!canReview) {
    return (
      <div className="p-10">
        <EmptyState
          title="Review queue is restricted"
          body="You need the proctoring.review permission to adjudicate sessions."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/proctor")}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to roster
            </Button>
          }
        />
      </div>
    );
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Proctor", href: "/proctor" }, { label: "Review queue" }]}
        title="Review queue"
        subtitle="Completed, un-adjudicated sessions ordered by SLA due time."
        actions={
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={assignedToMe} onCheckedChange={setAssignedToMe} aria-label="Assigned to me" />
            Assigned to me
          </label>
        }
      />
      <div className="p-6 space-y-4">
        <Card>
          {queueQ.isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 rounded-md bg-muted animate-pulse" />
              ))}
            </div>
          ) : queueQ.isError ? (
            <div className="p-6 text-sm">
              <p className="text-destructive mb-3">{errMessage(queueQ.error)}</p>
              <Button variant="outline" size="sm" onClick={() => queueQ.refetch()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={assignedToMe ? "Nothing assigned to you" : "Review queue is clear"}
              body={
                assignedToMe
                  ? "No sessions are currently routed to you for review."
                  : "Every completed session has been adjudicated. New ones appear here automatically."
              }
            />
          ) : (
            <>
              <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground border-b border-border">
                <span>
                  Showing {rows.length} of {total.toLocaleString()} pending
                </span>
              </div>
              <ul className="divide-y divide-border">
                {rows.map((r) => {
                  const s = sla(r.reviewSlaDueAt);
                  const display = r.candidateName ?? "Unlinked candidate";
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30">
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggle(r.id)}
                        aria-label={`Select ${display}`}
                      />
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(`/proctor/sessions/${r.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/proctor/sessions/${r.id}`);
                          }
                        }}
                        className="flex-1 min-w-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring rounded"
                      >
                        <div className="text-sm font-medium">{display}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {r.flagCount} flag{r.flagCount === 1 ? "" : "s"}
                          {r.assignedReviewerName ? ` · ${r.assignedReviewerName}` : " · unassigned"}
                        </div>
                      </div>
                      <div className="w-32 hidden sm:block">
                        <RiskMeter score={r.riskScore} label={r.riskLabel} />
                      </div>
                      <span className={cn("text-xs whitespace-nowrap", s.breached ? "text-destructive font-medium" : "text-muted-foreground")}>
                        {s.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {queueQ.hasNextPage && (
                <div className="p-4 flex justify-center">
                  <Button variant="outline" size="sm" onClick={() => queueQ.fetchNextPage()} disabled={queueQ.isFetchingNextPage}>
                    {queueQ.isFetchingNextPage ? (
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
          <div className="pointer-events-auto sticky bottom-4 z-20 mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
              <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Assign reviewer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        sessionIds={Array.from(selected)}
        onDone={() => {
          setSelected(new Set());
          queueQ.refetch();
        }}
      />
    </div>
  );
}
