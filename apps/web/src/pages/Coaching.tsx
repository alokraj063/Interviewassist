// Coaching — a real learning-and-development surface.
// Tabs: Library · Assigned to me · Runs · Curricula · Progress (+ Team, gated by
// coaching.read.all). Server-side filter/search/sort/keyset pagination reflected
// in the URL; bulk select + assign; permission-aware rendering. No mock data;
// the primary CTA opens a real authoring dialog (POST /api/coaching/scenarios).
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Plus,
  Search,
  Lock,
  AlertCircle,
  RotateCcw,
  X,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCan } from "@/auth/AuthContext";
import {
  useScenarios,
  useScenarioVerb,
  useAssignments,
  useRuns,
  useCurricula,
  useProgress,
  useTeamSummary,
  useStartRun,
  DIFFICULTIES,
  SCENARIO_SORTS,
  SORT_LABELS,
  type ScenarioFilters,
  type ScenarioSort,
  type Difficulty,
  type ScenarioRow,
} from "@/hooks/useCoaching";
import { ScenarioForm } from "@/components/coaching/ScenarioForm";
import { AssignDialog } from "@/components/coaching/AssignDialog";

const PAGE_LIMIT = 25;
const ALL = "__all__";
type Tab = "library" | "assigned" | "runs" | "curricula" | "progress" | "team";
const VALID_TABS: Tab[] = ["library", "assigned", "runs", "curricula", "progress", "team"];

export default function Coaching() {
  const canWrite = useCan("coaching.write");
  const canAssign = useCan("coaching.assign");
  const canReadAll = useCan("coaching.read.all");
  const [params, setParams] = useSearchParams();

  const tabParam = (params.get("tab") as Tab) ?? "library";
  const tab: Tab =
    VALID_TABS.includes(tabParam) && (tabParam !== "team" || canReadAll) ? tabParam : "library";

  const [formOpen, setFormOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<{ id: string; title: string } | null>(null);

  function setTab(t: string) {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    ["q", "difficulty", "published", "sort", "dir", "cursor"].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Coaching"
        subtitle="Author candidate roleplays, assign practice, and track learning over time."
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New scenario
            </Button>
          ) : (
            <Button size="sm" disabled title="Requires coaching.write">
              <Lock className="mr-1.5 h-3.5 w-3.5" />
              New scenario
            </Button>
          )
        }
      />

      <div className="space-y-5 p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="assigned">Assigned to me</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="curricula">Curricula</TabsTrigger>
            <TabsTrigger value="progress">Progress</TabsTrigger>
            {canReadAll && <TabsTrigger value="team">Team</TabsTrigger>}
          </TabsList>

          <TabsContent value="library">
            <LibraryTab
              params={params}
              setParams={setParams}
              canWrite={canWrite}
              canAssign={canAssign}
              onNew={() => setFormOpen(true)}
              onAssign={(s) => setAssignTarget({ id: s.id, title: s.title })}
            />
          </TabsContent>
          <TabsContent value="assigned">
            <AssignedTab />
          </TabsContent>
          <TabsContent value="runs">
            <RunsTab canReadAll={canReadAll} />
          </TabsContent>
          <TabsContent value="curricula">
            <CurriculaTab />
          </TabsContent>
          <TabsContent value="progress">
            <ProgressTab />
          </TabsContent>
          {canReadAll && (
            <TabsContent value="team">
              <TeamTab />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <ScenarioForm open={formOpen} onOpenChange={setFormOpen} />
      <AssignDialog
        open={!!assignTarget}
        onOpenChange={(v) => !v && setAssignTarget(null)}
        scenarioId={assignTarget?.id}
        scenarioTitle={assignTarget?.title}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library tab — the scenario list with filter/search/sort/pagination + bulk
// ---------------------------------------------------------------------------

function LibraryTab({
  params,
  setParams,
  canWrite,
  canAssign,
  onNew,
  onAssign,
}: {
  params: URLSearchParams;
  setParams: (p: URLSearchParams, o?: { replace?: boolean }) => void;
  canWrite: boolean;
  canAssign: boolean;
  onNew: () => void;
  onAssign: (s: ScenarioRow) => void;
}) {
  const nav = useNavigate();
  const archive = useScenarioVerb("archive");
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
  const [cursors, setCursors] = useState<string[]>([]);
  const [accumulated, setAccumulated] = useState<ScenarioRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (searchInput) next.set("q", searchInput);
      else next.delete("q");
      setParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const filters: ScenarioFilters = useMemo(() => {
    const f: ScenarioFilters = {
      q: params.get("q") ?? undefined,
      difficulty: (params.get("difficulty") as Difficulty) ?? undefined,
      sort: (params.get("sort") as ScenarioSort) ?? "created_at",
      dir: (params.get("dir") as "asc" | "desc") ?? "desc",
    };
    const pub = params.get("published");
    if (pub === "true") f.published = true;
    else if (pub === "false") f.published = false;
    return f;
  }, [params]);

  const cursor = cursors[cursors.length - 1];
  const { data, isLoading, isError, error, refetch, isFetching } = useScenarios(filters, {
    cursor,
    limit: PAGE_LIMIT,
  });

  const paramsKey = params.toString();
  useEffect(() => {
    setCursors([]);
    setAccumulated([]);
    setSelected(new Set());
  }, [paramsKey]);

  useEffect(() => {
    if (!data) return;
    setAccumulated((prev) => {
      if (cursors.length === 0) return data.scenarios;
      const seen = new Set(prev.map((s) => s.id));
      return [...prev, ...data.scenarios.filter((s) => !seen.has(s.id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows = accumulated;
  const total = data?.total ?? 0;
  const nextCursor = data?.nextCursor ?? null;
  const filterActive = !!filters.q || !!filters.difficulty || filters.published !== undefined;

  function patch(key: string, value?: string) {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }
  function clearAll() {
    setSearchInput("");
    const next = new URLSearchParams(params);
    ["q", "difficulty", "published"].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
  }
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search scenarios…"
            className="pl-8"
            aria-label="Search scenarios"
          />
        </div>
        <FilterSelect
          label="Difficulty"
          value={filters.difficulty}
          onChange={(v) => patch("difficulty", v)}
          options={DIFFICULTIES.map((d) => ({ value: d, label: d }))}
        />
        <FilterSelect
          label="Status"
          value={params.get("published") ?? undefined}
          onChange={(v) => patch("published", v)}
          options={[
            { value: "true", label: "Published" },
            { value: "false", label: "Draft" },
          ]}
        />
        <Select value={filters.sort} onValueChange={(v) => patch("sort", v)}>
          <SelectTrigger className="w-[170px]" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCENARIO_SORTS.map((s) => (
              <SelectItem key={s} value={s}>
                {SORT_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filterActive && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Filters active</span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={clearAll}>
            <X className="mr-1 h-3 w-3" /> Clear all
          </Button>
        </div>
      )}

      {selected.size > 0 && canAssign && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-4 py-2 text-sm">
          <span>{selected.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const first = rows.find((r) => selected.has(r.id));
              if (first) onAssign(first);
            }}
          >
            Assign…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={archive.isPending}
            onClick={() => {
              [...selected].forEach((id) =>
                archive.mutate(id, { onError: (e: Error) => toast.error(e.message) }),
              );
              toast.success(`Archiving ${selected.size} scenario(s)`);
              setSelected(new Set());
            }}
          >
            Archive
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <Card>
        {isError ? (
          <ErrorBlock error={error} onRetry={refetch} />
        ) : isLoading && rows.length === 0 ? (
          <SkeletonRows />
        ) : rows.length === 0 && filterActive ? (
          <EmptyState
            title="No scenarios match these filters"
            body="Adjust or clear the filters to see more."
            action={
              <Button size="sm" variant="outline" onClick={clearAll}>
                Clear all filters
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No coaching scenarios yet"
            body="Author your first AI candidate roleplay to start practising."
            action={
              canWrite ? (
                <Button size="sm" onClick={onNew}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> New scenario
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
              <span>
                Showing {rows.length} of {total}
              </span>
              {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
            <div className="divide-y divide-border">
              {rows.map((s) => (
                <ScenarioRowItem
                  key={s.id}
                  s={s}
                  selectable={canWrite}
                  selected={selected.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  onOpen={() => nav(`/coaching/${s.id}`)}
                />
              ))}
            </div>
            {nextCursor && (
              <div className="flex justify-center border-t border-border p-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isFetching}
                  onClick={() => setCursors((c) => [...c, nextCursor])}
                >
                  {isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function ScenarioRowItem({
  s,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  s: ScenarioRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-start gap-3 p-4 hover:bg-muted/20">
      {selectable && (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${s.title}`}
          className="mt-1"
        />
      )}
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{s.title}</span>
          <Badge variant={s.isPublished ? "default" : "secondary"}>
            {s.isPublished ? "Published" : "Draft"}
          </Badge>
          <span className="text-xs text-muted-foreground">{s.difficulty}</span>
          {s.targetRubricName && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {s.targetRubricName}
            </span>
          )}
        </div>
        {s.description && (
          <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{s.description}</p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>{s.runCount} run(s)</span>
          <span>avg {s.avgScore != null ? Math.round(s.avgScore) : "—"}</span>
          <span>{s.estimatedMinutes} min</span>
          {s.tags.slice(0, 3).map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5">
              {t}
            </span>
          ))}
        </div>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8"
        onClick={onOpen}
        aria-label={`Open ${s.title}`}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assigned to me
// ---------------------------------------------------------------------------

function AssignedTab() {
  const nav = useNavigate();
  const { data, isLoading, isError, error, refetch } = useAssignments({ scope: "mine" });
  const startRun = useStartRun();

  if (isError)
    return (
      <Card>
        <ErrorBlock error={error} onRetry={refetch} />
      </Card>
    );
  if (isLoading)
    return (
      <Card>
        <SkeletonRows />
      </Card>
    );
  const rows = data?.assignments ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title="Nothing assigned" body="Your manager hasn't assigned any practice yet." />
      </Card>
    );
  }
  return (
    <Card>
      <div className="divide-y divide-border">
        {rows.map((a) => (
          <div key={a.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{a.scenarioTitle ?? "Curriculum"}</span>
                <Badge
                  variant={
                    a.status === "completed"
                      ? "default"
                      : a.status === "overdue"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {a.status}
                </Badge>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {a.dueAt
                  ? `Due ${formatDistanceToNow(new Date(a.dueAt), { addSuffix: true })}`
                  : "No due date"}
                {a.minPassScore && ` · pass ≥ ${Math.round(Number(a.minPassScore))}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {a.scenarioId && a.status !== "completed" && a.status !== "waived" && (
                <Button
                  size="sm"
                  disabled={startRun.isPending}
                  onClick={() =>
                    startRun.mutate(
                      { scenarioId: a.scenarioId!, assignmentId: a.id, mode: "ai_roleplay" },
                      {
                        onSuccess: (r) => nav(`/coaching/${a.scenarioId}/simulate?runId=${r.run.id}`),
                        onError: (e: Error) => toast.error(e.message),
                      },
                    )
                  }
                >
                  {startRun.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Practice
                </Button>
              )}
              {a.scenarioId && (
                <Button size="sm" variant="ghost" onClick={() => nav(`/coaching/${a.scenarioId}`)}>
                  View
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function RunsTab({ canReadAll }: { canReadAll: boolean }) {
  const nav = useNavigate();
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const { data, isLoading, isError, error, refetch } = useRuns(
    { scope: canReadAll ? scope : "mine" },
    { limit: PAGE_LIMIT },
  );

  if (isError)
    return (
      <Card>
        <ErrorBlock error={error} onRetry={refetch} />
      </Card>
    );
  return (
    <div className="space-y-3">
      {canReadAll && (
        <Select value={scope} onValueChange={(v) => setScope(v as "mine" | "team")}>
          <SelectTrigger className="w-[160px]" aria-label="Run scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mine">My runs</SelectItem>
            <SelectItem value="team">Team runs</SelectItem>
          </SelectContent>
        </Select>
      )}
      <Card>
        {isLoading ? (
          <SkeletonRows />
        ) : (data?.runs.length ?? 0) === 0 ? (
          <EmptyState
            title="No practice runs yet"
            body="Completed roleplay attempts appear here with their scores."
          />
        ) : (
          <div className="divide-y divide-border">
            {data!.runs.map((r) => (
              <button
                key={r.id}
                className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/20"
                onClick={() => nav(`/coaching/${r.scenarioId}/results?runId=${r.id}`)}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{r.scenarioTitle ?? "Scenario"}</span>
                    <Badge variant="secondary">{r.status}</Badge>
                    {r.scoringStatus !== "scored" && (
                      <span className="text-xs text-muted-foreground">{r.scoringStatus}</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {r.recruiterName ?? r.recruiterEmail} ·{" "}
                    {formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums">
                    {r.cachedOverallScore != null ? Math.round(Number(r.cachedOverallScore)) : "—"}
                  </div>
                  <div className="text-xs text-muted-foreground">overall</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curricula
// ---------------------------------------------------------------------------

function CurriculaTab() {
  const { data, isLoading, isError, error, refetch } = useCurricula();
  if (isError)
    return (
      <Card>
        <ErrorBlock error={error} onRetry={refetch} />
      </Card>
    );
  if (isLoading)
    return (
      <Card>
        <SkeletonRows />
      </Card>
    );
  const rows = data?.curricula ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No curricula yet"
          body="Group ordered scenarios into an onboarding curriculum to assign as a set."
        />
      </Card>
    );
  }
  return (
    <Card>
      <div className="divide-y divide-border">
        {rows.map((c) => (
          <div key={c.id} className="flex items-center justify-between p-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{c.name}</span>
                <Badge variant={c.isPublished ? "default" : "secondary"}>
                  {c.isPublished ? "Published" : "Draft"}
                </Badge>
              </div>
              {c.description && <p className="mt-1 text-sm text-muted-foreground">{c.description}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{c.scenarioIds.length} scenario(s)</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Progress (self)
// ---------------------------------------------------------------------------

function ProgressTab() {
  const { data, isLoading, isError, error, refetch } = useProgress();
  if (isError)
    return (
      <Card>
        <ErrorBlock error={error} onRetry={refetch} />
      </Card>
    );
  if (isLoading)
    return (
      <Card>
        <SkeletonRows />
      </Card>
    );
  const points = data?.points ?? [];
  const bySkill = data?.bySkill ?? [];
  if (points.length === 0 && bySkill.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No progress data yet"
          body="Complete a scored practice run and your trend will appear here."
        />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Card title="Score trend">
        <div className="space-y-2 p-4">
          {points.map((p) => (
            <div key={p.period} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">
                {new Date(p.period).toLocaleDateString()}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary" style={{ width: `${Math.round(p.avgScore ?? 0)}%` }} />
              </div>
              <span className="w-10 text-right text-sm font-medium tabular-nums">
                {p.avgScore != null ? Math.round(p.avgScore) : "—"}
              </span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="By skill">
        <div className="space-y-2 p-4">
          {bySkill.map((s) => (
            <div key={s.criterion} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-xs">{s.criterion}</span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${Math.round(s.avgScore ?? 0)}%` }}
                />
              </div>
              <span className="w-10 text-right text-sm font-medium tabular-nums">
                {s.avgScore != null ? Math.round(s.avgScore) : "—"}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team rollup (manager)
// ---------------------------------------------------------------------------

function TeamTab() {
  const { data, isLoading, isError, error, refetch } = useTeamSummary(true);
  if (isError)
    return (
      <Card>
        <ErrorBlock error={error} onRetry={refetch} />
      </Card>
    );
  if (isLoading)
    return (
      <Card>
        <SkeletonRows />
      </Card>
    );
  const team = data?.team ?? [];
  if (team.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No team activity"
          body="Once your recruiters complete practice, their rollup appears here."
        />
      </Card>
    );
  }
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="p-3">Recruiter</th>
              <th className="p-3">Runs</th>
              <th className="p-3">Avg</th>
              <th className="p-3">Assigned</th>
              <th className="p-3">Completed</th>
              <th className="p-3">Overdue</th>
              <th className="p-3">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {team.map((m) => (
              <tr key={m.userId} className="border-b border-border last:border-0">
                <td className="p-3 font-medium">{m.name ?? m.email}</td>
                <td className="p-3 tabular-nums">{m.runCount}</td>
                <td className="p-3 tabular-nums">{m.avgScore != null ? Math.round(m.avgScore) : "—"}</td>
                <td className="p-3 tabular-nums">{m.assigned}</td>
                <td className="p-3 tabular-nums">{m.completed}</td>
                <td className="p-3 tabular-nums">{m.overdue}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {m.lastActivity
                    ? formatDistanceToNow(new Date(m.lastActivity), { addSuffix: true })
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared small pieces
// ---------------------------------------------------------------------------

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="w-[150px]" aria-label={`Filter by ${label}`}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ErrorBlock({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const msg =
    (error as { body?: { error?: string } })?.body?.error ??
    (error as Error)?.message ??
    "Something went wrong";
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center">
      <AlertCircle className="h-7 w-7 text-destructive" />
      <div className="text-sm font-semibold">Couldn't load</div>
      <div className="max-w-md text-sm text-muted-foreground">{msg}</div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
      </Button>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="p-4">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="mt-2 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}
