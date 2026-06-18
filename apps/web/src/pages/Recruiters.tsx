// Recruiters — enterprise manager leaderboard.
//
// A delivery lead / AM / BH ranks recruiters by the KPI that matters this week
// (throughput, conversion, SLA breach, goal attainment, capacity load), spots
// over-allocated recruiters via explicit warnings, applies bulk goals/nudges,
// saves configurable fairness-guarded leaderboard views, exports the board, and
// drills into any recruiter's detail. All state is URL-synced; all KPIs are live
// aggregates; every write is permission-gated server-side.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Search,
  X,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Users,
  Download,
  Target,
  Send,
  Save,
  ArrowUpDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import { getApiBase, getAccessToken } from "@/lib/api";
import {
  useRecruiterList,
  useLeaderboards,
  exportUrl,
  type ListParams,
} from "@/hooks/useRecruiters";
import {
  ROLE_LABEL,
  ROLE_PILL,
  fmtBps,
  GoalAttainmentRing,
  LoadCell,
  SlaBreachBadge,
  TrendSpark,
} from "@/components/recruiters/RecruiterKpiCells";
import { BulkActionDialog } from "@/components/recruiters/BulkActionDialog";
import { LeaderboardConfigDialog } from "@/components/recruiters/LeaderboardConfigDialog";

type Window = "7d" | "30d" | "90d" | "qtd";

const WINDOW_LABEL: Record<Window, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  qtd: "Quarter to date",
};

const SORT_COLUMNS: Array<{ key: string; label: string; numeric: boolean; align?: "right" }> = [
  { key: "name", label: "Recruiter", numeric: false },
  { key: "submissions", label: "Subs", numeric: true, align: "right" },
  { key: "client_submits", label: "Client", numeric: true, align: "right" },
  { key: "selects", label: "Selects", numeric: true, align: "right" },
  { key: "offers", label: "Offers", numeric: true, align: "right" },
  { key: "joins", label: "Joins", numeric: true, align: "right" },
  { key: "conversion", label: "Conv", numeric: true, align: "right" },
  { key: "calls", label: "Calls", numeric: true, align: "right" },
  { key: "sla_breaches", label: "SLA", numeric: true, align: "right" },
  { key: "goal_attainment", label: "Goal", numeric: true, align: "right" },
  { key: "load", label: "Load", numeric: true },
];

export default function Recruiters() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const canManage = useCan("recruiters.manage");

  const q = params.get("q") ?? "";
  const role = params.get("role") ?? "";
  const status = params.get("status") ?? "";
  const windowParam = (params.get("window") as Window) ?? "30d";
  const sort = params.get("sort") ?? "submissions";
  const dir = (params.get("dir") as "asc" | "desc") ?? "desc";
  const cursor = params.get("cursor") ?? undefined;

  const [searchInput, setSearchInput] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState<null | "goal" | "nudge">(null);
  const [lbDialogOpen, setLbDialogOpen] = useState(false);

  const leaderboardsQ = useLeaderboards();

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== q) patch({ q: searchInput.trim() || undefined, cursor: undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function patch(next: Record<string, string | undefined>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
    setSelected(new Set());
  }

  const listParams: ListParams = {
    q: q || undefined,
    role: role || undefined,
    status: status || undefined,
    window: windowParam,
    sort,
    dir,
    cursor,
  };
  const listQ = useRecruiterList(listParams);

  const rows = listQ.data?.rows ?? [];
  const total = listQ.data?.total ?? 0;
  const nextCursor = listQ.data?.nextCursor ?? null;
  const asOf = listQ.data?.asOf;
  const hasFilters = !!(q || role || status);

  const showingStart = total === 0 ? 0 : cursorStack.length * 25 + 1;
  const showingEnd = cursorStack.length * 25 + rows.length;

  function onSort(key: string) {
    // Always serialize sort on a header click so the active column is reflected
    // in the URL (the view must be self-describing / shareable) — even when the
    // clicked column is already the implicit default sort.
    const nextDir = sort === key ? (dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc";
    patch({ sort: key, dir: nextDir, cursor: undefined });
    setCursorStack([]);
  }

  function goNext() {
    if (!nextCursor) return;
    setCursorStack((s) => [...s, cursor ?? ""]);
    patch({ cursor: nextCursor });
  }
  function goPrev() {
    setCursorStack((s) => {
      const copy = [...s];
      const prev = copy.pop();
      patch({ cursor: prev || undefined });
      return copy;
    });
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (allOnPage) rows.forEach((r) => n.delete(r.id));
      else rows.forEach((r) => n.add(r.id));
      return n;
    });

  const overAllocatedCount = useMemo(() => rows.filter((r) => r.overAllocated).length, [rows]);

  async function exportCsv(ids?: string[]) {
    try {
      const token = getAccessToken();
      const path = exportUrl(listParams);
      const sep = path.includes("?") ? "&" : "?";
      const url = `${getApiBase()}${path}${token ? `${sep}token=${encodeURIComponent(token)}` : ""}`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      let text = await res.text();
      if (ids && ids.length) {
        // Filter the CSV to selected rows client-side (header + matching emails).
        const selectedRows = new Set(rows.filter((r) => ids.includes(r.id)).map((r) => r.email));
        const lines = text.split("\n");
        text = [lines[0], ...lines.slice(1).filter((l) => [...selectedRows].some((e) => l.includes(e)))].join("\n");
      }
      const blob = new Blob([text], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `recruiters-${windowParam}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("Export ready");
    } catch (err) {
      toast.error("Couldn't export", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  const ManageButton = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) =>
    canManage ? (
      <Button size="sm" variant="outline" onClick={onClick}>
        {children}
      </Button>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" variant="outline" disabled>
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
          title="Recruiters"
          subtitle="Rank the team by the KPI that matters this week, spot over-allocation, set goals, and rebalance load."
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => void exportCsv()}>
                <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
              </Button>
              <ManageButton onClick={() => setLbDialogOpen(true)}>
                <Save className="w-3.5 h-3.5 mr-1.5" /> Save view
              </ManageButton>
            </>
          }
        />

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="Recruiters" value={total} />
            <MetricCard label="Showing" value={rows.length} />
            <MetricCard
              label="Over capacity"
              value={overAllocatedCount}
              accent={overAllocatedCount > 0 ? "warning" : "default"}
            />
            <MetricCard label="Window" value={WINDOW_LABEL[windowParam]} hint={asOf ? `as of ${new Date(asOf).toLocaleTimeString()}` : undefined} />
          </div>

          {/* filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by name or email…"
                className="pl-8 h-9"
                aria-label="Search"
              />
            </div>
            <Select value={role || "all"} onValueChange={(v) => patch({ role: v === "all" ? undefined : v, cursor: undefined })}>
              <SelectTrigger className="w-40 h-9" aria-label="Role filter">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="recruiter">Recruiter</SelectItem>
                <SelectItem value="delivery_lead">Delivery Lead</SelectItem>
                <SelectItem value="account_manager">Account Manager</SelectItem>
                <SelectItem value="business_head">Business Head</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status || "all"} onValueChange={(v) => patch({ status: v === "all" ? undefined : v, cursor: undefined })}>
              <SelectTrigger className="w-36 h-9" aria-label="Status filter">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="invited">Invited</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
            <Select value={windowParam} onValueChange={(v) => patch({ window: v, cursor: undefined })}>
              <SelectTrigger className="w-40 h-9" aria-label="Window">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="qtd">Quarter to date</SelectItem>
              </SelectContent>
            </Select>
            {(leaderboardsQ.data?.leaderboards.length ?? 0) > 0 && (
              <Select
                value="__none"
                onValueChange={(v) => {
                  if (v === "__none") return;
                  const lb = leaderboardsQ.data!.leaderboards.find((l) => l.id === v);
                  if (lb) {
                    const top = [...lb.config.weights].sort((a, b) => b.weight - a.weight)[0];
                    patch({ window: lb.config.window, sort: top?.metric === "conversion" ? "conversion" : top?.metric ?? "submissions", dir: "desc", cursor: undefined });
                    toast.success(`Applied "${lb.name}"`);
                  }
                }}
              >
                <SelectTrigger className="w-44 h-9" aria-label="Saved views">
                  <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
                  <SelectValue placeholder="Saved views" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Saved views…</SelectItem>
                  {leaderboardsQ.data!.leaderboards.map((lb) => (
                    <SelectItem key={lb.id} value={lb.id}>
                      {lb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchInput("");
                  patch({ q: undefined, role: undefined, status: undefined, cursor: undefined });
                }}
              >
                <X className="w-3.5 h-3.5 mr-1" /> Clear all
              </Button>
            )}
          </div>

          {/* active filter chips */}
          {hasFilters && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              {q && <Chip label={`Search: ${q}`} onRemove={() => { setSearchInput(""); patch({ q: undefined, cursor: undefined }); }} />}
              {role && <Chip label={ROLE_LABEL[role] ?? role} onRemove={() => patch({ role: undefined, cursor: undefined })} />}
              {status && <Chip label={`Status: ${status}`} onRemove={() => patch({ status: undefined, cursor: undefined })} />}
            </div>
          )}

          {/* bulk bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <ManageButton onClick={() => setBulkMode("goal")}>
                <Target className="w-3.5 h-3.5 mr-1" /> Bulk set goal
              </ManageButton>
              <ManageButton onClick={() => setBulkMode("nudge")}>
                <Send className="w-3.5 h-3.5 mr-1" /> Bulk nudge
              </ManageButton>
              <Button size="sm" variant="outline" onClick={() => void exportCsv([...selected])}>
                <Download className="w-3.5 h-3.5 mr-1" /> Export selected
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* table / states */}
          {listQ.isLoading ? (
            <Card>
              <div className="p-4 space-y-3" data-testid="recruiters-skeleton">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </Card>
          ) : listQ.isError ? (
            <Card>
              <div className="p-6 flex flex-col items-center gap-3 text-sm">
                <AlertTriangle className="w-7 h-7 text-destructive" />
                <div className="text-destructive">
                  {(listQ.error as { body?: { error?: string } })?.body?.error ??
                    (listQ.error instanceof Error ? listQ.error.message : "Failed to load recruiters")}
                </div>
                <Button size="sm" variant="outline" onClick={() => void listQ.refetch()}>
                  Retry
                </Button>
              </div>
            </Card>
          ) : rows.length === 0 ? (
            hasFilters ? (
              <Card>
                <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
                  <Search className="w-8 h-8 opacity-30" />
                  <div>No recruiters match these filters.</div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearchInput("");
                      patch({ q: undefined, role: undefined, status: undefined, cursor: undefined });
                    }}
                  >
                    <X className="w-3.5 h-3.5 mr-1" /> Clear all
                  </Button>
                </div>
              </Card>
            ) : (
              <Card>
                <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
                  <Users className="w-8 h-8 opacity-30" />
                  <div>No recruiters yet — invite your team to start tracking performance.</div>
                  <Button size="sm" onClick={() => nav("/settings/team")}>
                    Invite team
                  </Button>
                </div>
              </Card>
            )
          ) : (
            <Card>
              <table className="data-table">
                <caption className="sr-only">Recruiter performance leaderboard ranked by {sort}</caption>
                <thead>
                  <tr>
                    {SORT_COLUMNS.map((col) => (
                      <th key={col.key} className={col.align === "right" ? "text-right" : undefined} aria-sort={sort === col.key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
                            col.align === "right" && "flex-row-reverse",
                          )}
                          onClick={() => onSort(col.key)}
                        >
                          {col.label}
                          {sort === col.key ? (
                            dir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                          ) : null}
                        </button>
                      </th>
                    ))}
                    <th>Trend</th>
                    <th className="w-8 text-right">
                      <Checkbox checked={allOnPage} onCheckedChange={toggleAll} aria-label="Select all on page" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td>
                        <button
                          className="text-left hover:underline"
                          onClick={() => nav(`/recruiters/${r.id}`)}
                        >
                          <div className="text-sm font-medium">{r.name ?? r.email}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                            {r.email}
                            <span className={cn("pill text-[10px]", ROLE_PILL[r.role])}>{ROLE_LABEL[r.role] ?? r.role}</span>
                          </div>
                        </button>
                      </td>
                      <td className="text-right tabular-nums">{r.submissions}</td>
                      <td className="text-right tabular-nums">{r.clientSubmits}</td>
                      <td className="text-right tabular-nums">{r.selects}</td>
                      <td className="text-right tabular-nums">{r.offers}</td>
                      <td className="text-right tabular-nums">{r.joins}</td>
                      <td className="text-right tabular-nums">{fmtBps(r.conversion)}</td>
                      <td className="text-right tabular-nums">{r.calls}</td>
                      <td className="text-right"><SlaBreachBadge count={r.slaBreaches} /></td>
                      <td className="text-right"><GoalAttainmentRing pct={r.goalAttainmentPct} /></td>
                      <td>
                        <LoadCell active={r.activeDemands} max={r.maxActiveDemands} pct={r.loadPct} overAllocated={r.overAllocated} />
                      </td>
                      <td><TrendSpark data={r.trendSpark} /></td>
                      <td className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(r.id)}
                          onCheckedChange={() => toggle(r.id)}
                          aria-label={`Select ${r.name ?? r.email}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* pagination */}
          {listQ.data && !listQ.isError && rows.length > 0 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {showingStart}–{showingEnd} of {total}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={cursorStack.length === 0} onClick={goPrev}>
                  <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
                </Button>
                <Button size="sm" variant="outline" disabled={!nextCursor} onClick={goNext}>
                  Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {bulkMode && (
          <BulkActionDialog
            open={!!bulkMode}
            onOpenChange={(v) => !v && setBulkMode(null)}
            mode={bulkMode}
            recruiterIds={[...selected]}
            onDone={() => setSelected(new Set())}
          />
        )}
        <LeaderboardConfigDialog open={lbDialogOpen} onOpenChange={setLbDialogOpen} window={windowParam} />
      </div>
    </TooltipProvider>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
      {label}
      <button onClick={onRemove} aria-label={`Remove ${label}`} className="hover:text-foreground">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
