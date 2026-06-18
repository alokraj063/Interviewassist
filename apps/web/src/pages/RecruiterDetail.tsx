// Recruiter detail — the manager's drill-down + action surface.
//
// KPI header (each card drills into the underlying reqs/candidates), a real
// trend chart, the goals panel (set/edit/archive with a named confirm — no
// window.confirm), a capacity editor with the over-allocation warning, the
// nudge + reassign actions (permission-gated), and an attributable activity
// timeline off recruiter_admin_events. 404 (recruiter_not_found) renders a
// distinct "not found" state; other failures render an error card + Retry.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  AlertTriangle,
  Target,
  Gauge,
  Send,
  Shuffle,
  Pencil,
  Archive,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import type { ApiError } from "@/lib/api";
import { useCan } from "@/auth/AuthContext";
import {
  useRecruiterDetail,
  useRecruiterTrend,
  useArchiveGoal,
  type Goal,
} from "@/hooks/useRecruiters";
import {
  ROLE_LABEL,
  ROLE_PILL,
  fmtBps,
  GoalAttainmentRing,
} from "@/components/recruiters/RecruiterKpiCells";
import { GoalDialog } from "@/components/recruiters/GoalDialog";
import { CapacityDialog } from "@/components/recruiters/CapacityDialog";
import { NudgeDialog } from "@/components/recruiters/NudgeDialog";
import { ReassignDemandDialog } from "@/components/recruiters/ReassignDemandDialog";
import { Sparkline } from "@/components/Sparkline";

const GOAL_METRIC_LABEL: Record<string, string> = {
  submissions: "Submissions",
  client_submits: "Client submits",
  selects: "Selects",
  offers: "Offers",
  joins: "Joins",
  calls: "Calls",
  conversion_rate: "Conversion rate",
};

const ACTION_LABEL: Record<string, string> = {
  "goal.set": "set a goal",
  "goal.update": "updated a goal",
  "goal.archive": "archived a goal",
  "capacity.set": "updated capacity",
  "nudge.send": "sent a nudge",
  "demand.reassign": "reassigned a demand",
  "leaderboard.save": "saved a leaderboard",
};

export default function RecruiterDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canManage = useCan("recruiters.manage");

  const detailQ = useRecruiterDetail(id);
  const [trendMetric, setTrendMetric] = useState("submissions");
  const trendQ = useRecruiterTrend(id, trendMetric);

  const [goalDialog, setGoalDialog] = useState<{ open: boolean; editing: Goal | null }>({ open: false, editing: null });
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [archiving, setArchiving] = useState<Goal | null>(null);

  const archiveGoal = useArchiveGoal(id ?? "");

  if (detailQ.isLoading) {
    return (
      <div className="p-10 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading recruiter…
      </div>
    );
  }

  if (detailQ.isError) {
    const err = detailQ.error as ApiError;
    const notFound = err?.status === 404;
    if (notFound) {
      return (
        <div className="p-10">
          <EmptyState
            title="Recruiter not found"
            body="They may have left the org or you don't have access."
            action={<Button size="sm" variant="outline" onClick={() => nav("/recruiters")}>Back to recruiters</Button>}
          />
        </div>
      );
    }
    return (
      <div className="p-10">
        <Card>
          <div className="p-6 flex flex-col items-center gap-3 text-sm">
            <AlertTriangle className="w-7 h-7 text-destructive" />
            <div className="text-destructive">
              {(err?.body as { error?: string })?.error ?? (err instanceof Error ? err.message : "Failed to load recruiter")}
            </div>
            <Button size="sm" variant="outline" onClick={() => void detailQ.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const data = detailQ.data!;
  const { recruiter, kpis, goals, capacity, recentCalls, activeProspects, timeline } = data;
  const name = recruiter.name ?? recruiter.email;
  const liveGoals = goals.filter((g) => !g.archivedAt);
  const archivedGoals = goals.filter((g) => g.archivedAt);

  const ManageBtn = ({ onClick, children, variant = "outline" as const }: { onClick: () => void; children: React.ReactNode; variant?: "outline" | "default" }) =>
    canManage ? (
      <Button size="sm" variant={variant} onClick={onClick}>
        {children}
      </Button>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" variant={variant} disabled>
              {children}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Requires recruiters.manage</TooltipContent>
      </Tooltip>
    );

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Recruiters", href: "/recruiters" }, { label: name }]}
          title={
            <span className="flex items-center gap-2">
              {name}
              <span className={cn("pill text-[11px]", ROLE_PILL[recruiter.role])}>{ROLE_LABEL[recruiter.role] ?? recruiter.role}</span>
            </span>
          }
          subtitle={recruiter.email}
          actions={
            <>
              <ManageBtn onClick={() => setNudgeOpen(true)}>
                <Send className="w-3.5 h-3.5 mr-1.5" /> Nudge
              </ManageBtn>
              <ManageBtn onClick={() => setReassignOpen(true)}>
                <Shuffle className="w-3.5 h-3.5 mr-1.5" /> Reassign demand
              </ManageBtn>
              <ManageBtn variant="default" onClick={() => setGoalDialog({ open: true, editing: null })}>
                <Target className="w-3.5 h-3.5 mr-1.5" /> Set goal
              </ManageBtn>
            </>
          }
        />

        <div className="p-6 space-y-5">
          {/* KPI header — each card drills into underlying reqs/candidates */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <DrillCard label="Submissions" value={kpis.submissions} to={`/candidates?recruiter=${recruiter.userId}`} />
            <DrillCard label="Conversion" value={fmtBps(kpis.conversion)} to={`/candidates?recruiter=${recruiter.userId}`} />
            <DrillCard label="Selects" value={kpis.selects} to={`/candidates?recruiter=${recruiter.userId}`} />
            <DrillCard label="Offers" value={kpis.offers} to={`/candidates?recruiter=${recruiter.userId}`} />
            <DrillCard label="Joins" value={kpis.joins} to={`/candidates?recruiter=${recruiter.userId}`} />
            <DrillCard
              label="SLA breaches"
              value={kpis.slaBreaches}
              accent={kpis.slaBreaches > 0 ? "danger" : "default"}
              to={`/candidates?recruiter=${recruiter.userId}&slaBreached=1`}
            />
            <DrillCard
              label="Load"
              value={`${kpis.activeDemands}/${kpis.maxActiveDemands}`}
              accent={kpis.overAllocated ? "danger" : "default"}
              to={`/demands?assignedTo=${recruiter.userId}&status=open`}
            />
          </div>

          <Tabs defaultValue="trend">
            <TabsList>
              <TabsTrigger value="trend">Trend</TabsTrigger>
              <TabsTrigger value="goals">Goals ({liveGoals.length})</TabsTrigger>
              <TabsTrigger value="capacity">Capacity</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            {/* TREND */}
            <TabsContent value="trend">
              <Card
                title="Trend"
                action={
                  <Select value={trendMetric} onValueChange={setTrendMetric}>
                    <SelectTrigger className="w-40 h-8" aria-label="Trend metric">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="submissions">Submissions</SelectItem>
                      <SelectItem value="selects">Selects</SelectItem>
                      <SelectItem value="offers">Offers</SelectItem>
                      <SelectItem value="joins">Joins</SelectItem>
                      <SelectItem value="calls">Calls</SelectItem>
                    </SelectContent>
                  </Select>
                }
              >
                <div className="p-5">
                  {trendQ.isLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading trend…
                    </div>
                  ) : (trendQ.data?.series.length ?? 0) === 0 ? (
                    <div className="text-sm text-muted-foreground">No {trendMetric} in the last 12 weeks.</div>
                  ) : (
                    <TrendChart series={trendQ.data!.series} asOf={trendQ.data!.asOf} />
                  )}
                </div>
              </Card>
            </TabsContent>

            {/* GOALS */}
            <TabsContent value="goals">
              <Card title="Goals">
                {liveGoals.length === 0 && archivedGoals.length === 0 ? (
                  <EmptyState
                    title="No goals yet"
                    body="Set a measurable target. Attainment tracks live against the funnel."
                    action={
                      canManage ? (
                        <Button size="sm" onClick={() => setGoalDialog({ open: true, editing: null })}>
                          <Target className="w-3.5 h-3.5 mr-1.5" /> Set goal
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="divide-y divide-border">
                    {[...liveGoals, ...archivedGoals].map((g) => (
                      <GoalRow
                        key={g.id}
                        goal={g}
                        attainment={g.metric === "submissions" && !g.archivedAt ? kpis.goalAttainmentPct : null}
                        canManage={canManage}
                        onEdit={() => setGoalDialog({ open: true, editing: g })}
                        onArchive={() => setArchiving(g)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            </TabsContent>

            {/* CAPACITY */}
            <TabsContent value="capacity">
              <Card
                title="Capacity"
                action={
                  <ManageBtn onClick={() => setCapacityOpen(true)}>
                    <Gauge className="w-3.5 h-3.5 mr-1.5" /> Edit capacity
                  </ManageBtn>
                }
              >
                <div className="p-5 grid grid-cols-3 gap-4">
                  <CapacityStat
                    label="Active demands"
                    value={`${kpis.activeDemands} / ${capacity?.maxActiveDemands ?? kpis.maxActiveDemands}`}
                    over={kpis.overAllocated}
                  />
                  <CapacityStat label="Max prospects" value={capacity?.maxActiveProspects ?? "—"} />
                  <CapacityStat label="Weekly call target" value={capacity?.weeklyCallTarget ?? "—"} />
                </div>
                {kpis.overAllocated && (
                  <div className="mx-5 mb-5 flex items-center gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="status">
                    <AlertTriangle className="w-4 h-4" />
                    Over capacity — {kpis.activeDemands} active demands against a cap of {capacity?.maxActiveDemands ?? kpis.maxActiveDemands}. Consider reassigning.
                  </div>
                )}
                {capacity?.notes && <p className="mx-5 mb-5 text-sm text-muted-foreground">{capacity.notes}</p>}
              </Card>
            </TabsContent>

            {/* ACTIVITY TIMELINE */}
            <TabsContent value="activity">
              <Card title="Activity">
                {timeline.length === 0 ? (
                  <EmptyState title="No activity yet" body="Goal, capacity, nudge, and reassignment changes appear here — attributable and timestamped." />
                ) : (
                  <ul className="divide-y divide-border">
                    {timeline.map((e) => (
                      <li key={e.id} className="px-4 py-3 text-sm flex items-start gap-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 shrink-0" />
                        <div className="flex-1">
                          <span className="font-medium">{e.actorName ?? "Someone"}</span>{" "}
                          {ACTION_LABEL[e.action] ?? e.action}
                          {renderEventDetail(e.after)}
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </TabsContent>
          </Tabs>

          {/* Working set */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card title={`Active prospects (${activeProspects.length})`}>
              {activeProspects.length === 0 ? (
                <EmptyState title="No live prospects" />
              ) : (
                <ul className="divide-y divide-border">
                  {activeProspects.slice(0, 10).map((p) => (
                    <li key={p.id} className="px-4 py-2.5 text-sm flex items-center justify-between">
                      <Link to={`/candidates/${p.candidateId}`} className="hover:underline font-medium">
                        {p.candidateName ?? p.candidateId.slice(0, 8)}
                      </Link>
                      <span className="text-xs text-muted-foreground">{p.demandTitle ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title={`Recent calls (${recentCalls.length})`}>
              {recentCalls.length === 0 ? (
                <EmptyState title="No recent calls" />
              ) : (
                <ul className="divide-y divide-border">
                  {recentCalls.slice(0, 10).map((c) => (
                    <li key={c.id} className="px-4 py-2.5 text-sm flex items-center justify-between">
                      <Link to={`/calls/${c.id}`} className="hover:underline font-medium">
                        {c.candidateName ?? "Call"}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(c.startedAt), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        {/* dialogs */}
        {id && (
          <>
            <GoalDialog
              open={goalDialog.open}
              onOpenChange={(v) => setGoalDialog((s) => ({ ...s, open: v }))}
              recruiterId={id}
              recruiterName={name}
              editing={goalDialog.editing}
            />
            <CapacityDialog open={capacityOpen} onOpenChange={setCapacityOpen} recruiterId={id} recruiterName={name} current={capacity} />
            <NudgeDialog open={nudgeOpen} onOpenChange={setNudgeOpen} recruiterId={id} recruiterName={name} />
            <ReassignDemandDialog open={reassignOpen} onOpenChange={setReassignOpen} recruiterId={id} recruiterName={name} detail={data} />
          </>
        )}

        {/* named archive confirm (not window.confirm) */}
        <AlertDialog open={!!archiving} onOpenChange={(v) => !v && setArchiving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive this goal?</AlertDialogTitle>
              <AlertDialogDescription>
                {archiving && `The ${GOAL_METRIC_LABEL[archiving.metric] ?? archiving.metric} goal (target ${archiving.targetValue}) will be archived. This can't be undone, but historical attainment stays in the record.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (archiving) archiveGoal.mutate(archiving.id);
                  setArchiving(null);
                }}
              >
                Archive goal
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function DrillCard({
  label,
  value,
  to,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  to: string;
  accent?: "default" | "danger";
}) {
  return (
    <Link to={to} className="block hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary rounded-lg">
      <MetricCard label={label} value={value} accent={accent} hint="View →" />
    </Link>
  );
}

function CapacityStat({ label, value, over }: { label: string; value: React.ReactNode; over?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className={cn("text-xl font-semibold tabular-nums mt-1", over && "text-destructive")}>{value}</div>
    </div>
  );
}

function GoalRow({
  goal,
  attainment,
  canManage,
  onEdit,
  onArchive,
}: {
  goal: Goal;
  attainment: number | null;
  canManage: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  return (
    <div className={cn("px-4 py-3 flex items-center gap-3", goal.archivedAt && "opacity-60")}>
      <div className="flex-1">
        <div className="text-sm font-medium flex items-center gap-2">
          {GOAL_METRIC_LABEL[goal.metric] ?? goal.metric}
          <span className="text-xs text-muted-foreground capitalize">· {goal.period}</span>
          {goal.archivedAt && <span className="pill text-[10px] bg-muted text-muted-foreground">archived</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          Target {goal.targetValue} · {goal.periodStart.slice(0, 10)} → {goal.periodEnd.slice(0, 10)}
          {goal.note ? ` · ${goal.note}` : ""}
        </div>
      </div>
      {attainment != null && <GoalAttainmentRing pct={attainment} />}
      {canManage && !goal.archivedAt && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit goal">
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onArchive} aria-label="Archive goal">
            <Archive className="w-3.5 h-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

function TrendChart({ series, asOf }: { series: Array<{ bucket: string; value: number }>; asOf: string }) {
  const max = Math.max(1, ...series.map((s) => s.value));
  return (
    <div>
      <div className="flex items-end gap-1.5 h-40">
        {series.map((s) => (
          <div key={s.bucket} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${s.bucket}: ${s.value}`}>
            <div className="w-full rounded-t bg-primary/70" style={{ height: `${(s.value / max) * 100}%`, minHeight: s.value > 0 ? 4 : 0 }} />
            <span className="text-[10px] text-muted-foreground">{s.bucket.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkline data={series.map((s) => s.value)} width={120} height={24} />
        <span>as of {new Date(asOf).toLocaleString()}</span>
      </div>
    </div>
  );
}

function renderEventDetail(after: Record<string, unknown> | null): React.ReactNode {
  if (!after) return null;
  if (typeof after.targetValue === "number") return <span className="text-muted-foreground"> to {after.targetValue}</span>;
  if (typeof after.demandTitle === "string") return <span className="text-muted-foreground"> ({after.demandTitle})</span>;
  if (typeof after.kind === "string") return <span className="text-muted-foreground"> ({after.kind})</span>;
  return null;
}
