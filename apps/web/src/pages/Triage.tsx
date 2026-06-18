import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Download,
  GitBranch,
  ListChecks,
  Lock,
  Phone,
  Plus,
  RefreshCw,
} from "lucide-react";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import {
  useLiveTriageSessions,
  useTriageAnalytics,
  useTriageFlows,
} from "@/hooks/useTriage";
import { TriageSessionDrawer } from "@/components/triage/TriageSessionDrawer";
import { RoutingFlowBuilder } from "@/components/triage/RoutingFlowBuilder";
import { RuleSetVersionBar } from "@/components/triage/RuleSetVersionBar";
import { SlaBadge } from "@/components/triage/SlaBadge";
import { LiveSessionActions } from "@/components/triage/LiveSessionActions";
import { LiveBoardFilters, type LiveFilters } from "@/components/triage/LiveBoardFilters";
import { BulkSessionBar } from "@/components/triage/BulkSessionBar";
import {
  DestinationsChart,
  IntentsChart,
  VolumeChart,
} from "@/components/triage/TriageAnalyticsCharts";
import type { LiveTriageSession, TriageAnalytics, TriageFlow } from "@j2w/shared-types";

const TABS = ["Live", "Flows", "Routing Rules", "Analytics"] as const;
type Tab = (typeof TABS)[number];
const CREATE_ROUTE = "/voice-agents/new?kind=triage";

function setOrDelete(p: URLSearchParams, key: string, value: string) {
  if (value) p.set(key, value);
  else p.delete(key);
}

export default function Triage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const canWrite = useCan("triage.write");
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "Live";

  function setTab(t: Tab) {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Triage"
        subtitle="AI-powered routing — classify inbound calls, then warm-hand to a human team or autonomous agent."
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => nav(CREATE_ROUTE)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Create triage flow
            </Button>
          ) : (
            <span className="pill bg-muted text-muted-foreground text-[11px] inline-flex items-center gap-1">
              <Lock className="w-3 h-3" />
              Read-only
            </span>
          )
        }
      />
      <div className="px-6 pt-4 border-b border-border bg-background flex gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            aria-current={tab === t ? "page" : undefined}
          >
            {tabIcon(t)}
            {t}
          </button>
        ))}
      </div>
      <div className="p-6 space-y-4">
        {tab === "Live" && <LiveTab canWrite={canWrite} />}
        {tab === "Flows" && <FlowsTab canWrite={canWrite} />}
        {tab === "Routing Rules" && <RulesTab canWrite={canWrite} />}
        {tab === "Analytics" && <AnalyticsTab />}
      </div>
    </div>
  );
}

function tabIcon(t: Tab) {
  const cls = "w-3.5 h-3.5";
  if (t === "Live") return <Activity className={cls} />;
  if (t === "Flows") return <GitBranch className={cls} />;
  if (t === "Routing Rules") return <ListChecks className={cls} />;
  return <BarChart3 className={cls} />;
}

// ----- shared error block -----
function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const msg =
    (error as { body?: { error?: string } })?.body?.error?.replace(/_/g, " ") ??
    (error instanceof Error ? error.message : "Something went wrong");
  return (
    <Card>
      <div className="p-8 text-center">
        <div className="text-sm font-medium text-destructive mb-1">Couldn’t load this view</div>
        <div className="text-xs text-muted-foreground mb-4">{msg}</div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    </Card>
  );
}

// ---------------- Live ----------------

function LiveTab({ canWrite }: { canWrite: boolean }) {
  const canOperate = useCan("triage.operate");
  const [params, setParams] = useSearchParams();
  const flowsQuery = useTriageFlows();

  const filters: LiveFilters = {
    status: params.get("status") ?? "",
    flowId: params.get("flowId") ?? "",
    slaBreached: params.get("slaBreached") === "true",
    q: params.get("q") ?? "",
  };

  function setFilters(next: LiveFilters) {
    const p = new URLSearchParams(params);
    setOrDelete(p, "status", next.status);
    setOrDelete(p, "flowId", next.flowId);
    setOrDelete(p, "slaBreached", next.slaBreached ? "true" : "");
    setOrDelete(p, "q", next.q);
    p.delete("cursor");
    setParams(p, { replace: true });
  }

  // Cursor-paginated: accumulate pages client-side as the operator clicks
  // "Load more" but each page is a server keyset request.
  const [pages, setPages] = useState<string[]>([]); // cursors after first
  const cursor = pages.length ? pages[pages.length - 1] : undefined;
  const liveQuery = useLiveTriageSessions({
    status: filters.status || undefined,
    flowId: filters.flowId || undefined,
    slaBreached: filters.slaBreached || undefined,
    q: filters.q || undefined,
    cursor,
    limit: 25,
  });

  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const sessions = liveQuery.data?.sessions ?? [];
  const total = liveQuery.data?.total ?? 0;
  const nextCursor = liveQuery.data?.nextCursor ?? null;
  const flowsData = flowsQuery.data;
  const flows = useMemo(() => flowsData ?? [], [flowsData]);
  const flowVocab = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const f of flows) map.set(f.id, f.intentVocabulary);
    return map;
  }, [flows]);

  const hasFilters = !!(filters.status || filters.flowId || filters.slaBreached || filters.q);

  const counts = {
    total,
    classifying: sessions.filter((s) => s.status === "classifying").length,
    handingOff: sessions.filter((s) => s.status === "handing_off").length,
    breached: sessions.filter((s) => s.slaBreached).length,
  };

  function toggleSel(callId: string) {
    setSelected((cur) =>
      cur.includes(callId) ? cur.filter((x) => x !== callId) : [...cur, callId],
    );
  }
  const allSelected = sessions.length > 0 && sessions.every((s) => selected.includes(s.callId));

  return (
    <>
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Triage calls (24h)" value={counts.total} accent="success" />
        <MetricCard label="Classifying" value={counts.classifying} />
        <MetricCard label="Handing off" value={counts.handingOff} accent="warning" />
        <MetricCard
          label="SLA breached"
          value={counts.breached}
          accent={counts.breached ? "danger" : "default"}
        />
      </div>

      <LiveBoardFilters
        filters={filters}
        flows={flows}
        onChange={(f) => {
          setFilters(f);
          setPages([]);
          setSelected([]);
        }}
      />

      {canOperate && (
        <BulkSessionBar selectedIds={selected} onClear={() => setSelected([])} />
      )}

      <Card title="Active triage sessions">
        {liveQuery.isError ? (
          <div className="p-2">
            <ErrorState error={liveQuery.error} onRetry={() => liveQuery.refetch()} />
          </div>
        ) : liveQuery.isLoading && !liveQuery.data ? (
          <div className="p-4 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded bg-muted animate-pulse" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          hasFilters ? (
            <div className="p-10 text-center">
              <div className="text-sm font-medium">No calls match these filters</div>
              <div className="text-xs text-muted-foreground mt-1 mb-3">
                Try widening or clearing the filters.
              </div>
              <Button variant="outline" size="sm" onClick={() => setFilters({ status: "", flowId: "", slaBreached: false, q: "" })}>
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <Phone className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
              No triage calls in the last 24 hours. Incoming calls appear here in real time.
            </div>
          )
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  {canOperate && (
                    <th className="w-8">
                      <Checkbox
                        checked={allSelected}
                        aria-label="Select all"
                        onCheckedChange={(c) =>
                          setSelected(c ? sessions.map((s) => s.callId) : [])
                        }
                      />
                    </th>
                  )}
                  <th>Caller</th>
                  <th>Flow</th>
                  <th>Detected intent</th>
                  <th>Confidence</th>
                  <th>Elapsed</th>
                  <th>Status</th>
                  <th>SLA</th>
                  <th>Destination</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <LiveSessionRow
                    key={s.callId}
                    session={s}
                    canOperate={canOperate}
                    selected={selected.includes(s.callId)}
                    onToggleSel={() => toggleSel(s.callId)}
                    intentVocabulary={flowVocab.get(s.flowId) ?? []}
                    onOpen={() => setOpenCallId(s.callId)}
                  />
                ))}
              </tbody>
            </table>
            <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing {sessions.length} of {total} call{total === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-2">
                {pages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setPages((p) => p.slice(0, -1))}
                  >
                    Previous
                  </Button>
                )}
                {nextCursor && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setPages((p) => [...p, nextCursor]);
                      setSelected([]);
                    }}
                  >
                    Load more
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </Card>

      <TriageSessionDrawer
        callId={openCallId}
        open={!!openCallId}
        onOpenChange={(o) => !o && setOpenCallId(null)}
      />
    </>
  );
}

function LiveSessionRow({
  session,
  canOperate,
  selected,
  onToggleSel,
  intentVocabulary,
  onOpen,
}: {
  session: LiveTriageSession;
  canOperate: boolean;
  selected: boolean;
  onToggleSel: () => void;
  intentVocabulary: string[];
  onOpen: () => void;
}) {
  const confPct = Math.round(session.classification.confidence * 100);
  const confTone =
    session.classification.confidence >= 0.75
      ? "bg-success"
      : session.classification.confidence >= 0.55
        ? "bg-warning"
        : "bg-destructive";
  return (
    <tr
      className={cn("cursor-pointer", selected && "bg-primary/5")}
      onClick={onOpen}
      tabIndex={0}
      role="button"
      aria-label={`Inspect call from ${session.callerRef}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {canOperate && (
        <td onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selected}
            aria-label={`Select call from ${session.callerRef}`}
            onCheckedChange={onToggleSel}
          />
        </td>
      )}
      <td className="font-mono text-xs">
        <span className="inline-flex items-center gap-1.5">
          <Phone className="w-3 h-3 text-muted-foreground" />
          {session.callerRef}
        </span>
      </td>
      <td className="text-xs">{session.flowName}</td>
      <td>
        <span className="pill bg-primary/10 text-primary capitalize text-[11px]">
          {session.classification.intent.replace(/_/g, " ")}
        </span>
      </td>
      <td className="w-[120px]">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div className={cn("h-full", confTone)} style={{ width: `${confPct}%` }} />
          </div>
          <span className="tabular-nums text-xs w-10 text-right">{confPct}%</span>
        </div>
      </td>
      <td className="tabular-nums text-xs">
        {Math.floor(session.elapsedSec / 60)}:
        {(session.elapsedSec % 60).toString().padStart(2, "0")}
      </td>
      <td>
        <StatusPill status={session.status} />
      </td>
      <td>
        <SlaBadge
          slaTargetSec={session.slaTargetSec}
          slaRemainingSec={session.slaRemainingSec}
          slaBreached={session.slaBreached}
        />
      </td>
      <td className="text-xs">
        {session.destinationLabel ? (
          <span className="inline-flex items-center gap-1.5">
            <ArrowRight className="w-3 h-3 text-muted-foreground" />
            {session.destinationLabel}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="text-right" onClick={(e) => e.stopPropagation()}>
        <LiveSessionActions
          session={session}
          canOperate={canOperate}
          intentVocabulary={intentVocabulary}
        />
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: LiveTriageSession["status"] }) {
  const map: Record<LiveTriageSession["status"], { label: string; tone: string }> = {
    classifying: { label: "Classifying", tone: "bg-muted text-muted-foreground" },
    decided: { label: "Decided", tone: "bg-primary/15 text-primary" },
    handing_off: { label: "Handing off", tone: "bg-warning/15 text-warning" },
    completed: { label: "Complete", tone: "bg-success/15 text-success" },
    failed: { label: "Failed", tone: "bg-destructive/15 text-destructive" },
  };
  const m = map[status];
  return <span className={cn("pill text-[11px]", m.tone)}>{m.label}</span>;
}

// ---------------- Flows ----------------

function FlowsTab({ canWrite }: { canWrite: boolean }) {
  const nav = useNavigate();
  const { data: flows, isLoading, isError, error, refetch } = useTriageFlows();

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (!flows || flows.length === 0) {
    return (
      <Card>
        <div className="p-10 text-center">
          <GitBranch className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
          <div className="text-sm font-medium">No triage flows yet</div>
          <div className="text-xs text-muted-foreground mt-1 mb-4">
            Create your first triage flow to start routing inbound calls.
          </div>
          {canWrite && (
            <Button size="sm" onClick={() => nav(CREATE_ROUTE)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Create triage flow
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {flows.map((f) => (
        <FlowCard key={f.id} flow={f} onOpen={() => nav(`/triage/flows/${f.id}`)} />
      ))}
    </div>
  );
}

function FlowCard({ flow, onOpen }: { flow: TriageFlow; onOpen: () => void }) {
  const statusTone =
    flow.status === "active"
      ? "bg-success/15 text-success"
      : flow.status === "paused"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";
  return (
    <button
      onClick={onOpen}
      className="text-left bg-card border border-border rounded-lg p-4 hover:border-primary/40 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <GitBranch className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{flow.name}</div>
            <div className="text-[10px] text-muted-foreground font-mono truncate">
              {flow.phoneNumber ?? "no phone assigned"}
            </div>
          </div>
        </div>
        <span className={cn("pill text-[10px] capitalize shrink-0", statusTone)}>
          {flow.status}
        </span>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 min-h-[32px]">{flow.purpose}</p>
      <div className="mt-3 flex flex-wrap gap-1">
        {flow.intentVocabulary.slice(0, 5).map((i) => (
          <span
            key={i}
            className="pill bg-muted text-muted-foreground text-[10px] capitalize"
          >
            {i.replace(/_/g, " ")}
          </span>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Rules</div>
          <div className="font-semibold">{flow.ruleCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Language</div>
          <div className="font-semibold">
            {flow.language === "multi" ? "Hinglish" : flow.language}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">Last activity</div>
          <div className="font-semibold text-[11px]">
            {flow.lastActivityAt
              ? new Date(flow.lastActivityAt).toLocaleTimeString()
              : "—"}
          </div>
        </div>
      </div>
    </button>
  );
}

// ---------------- Routing Rules (cross-flow picker) ----------------

function RulesTab({ canWrite }: { canWrite: boolean }) {
  const [params, setParams] = useSearchParams();
  const { data: flows, isLoading, isError, error, refetch } = useTriageFlows();
  const flowParam = params.get("flowId");

  const selected = flows?.find((f) => f.id === flowParam) ?? flows?.[0];

  function selectFlow(id: string) {
    const p = new URLSearchParams(params);
    p.set("flowId", id);
    setParams(p, { replace: true });
  }

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <div className="h-[620px] rounded-lg bg-muted animate-pulse" />;
  if (!flows || flows.length === 0) {
    return (
      <Card>
        <div className="p-8 text-sm text-muted-foreground text-center">
          Create a triage flow first, then configure its routing rules here.
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium" htmlFor="rules-flow-select">
          Triage flow:
        </label>
        <Select value={selected?.id} onValueChange={selectFlow}>
          <SelectTrigger id="rules-flow-select" className="w-[300px] h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {flows.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected && (
        <>
          <RuleSetVersionBar flowId={selected.id} canWrite={canWrite} />
          <RoutingFlowBuilder flow={selected} canWrite={canWrite} />
        </>
      )}
    </>
  );
}

// ---------------- Analytics ----------------

const RANGE_PRESETS: Array<{ value: string; label: string; days: number }> = [
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "14", label: "Last 14 days", days: 14 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
];

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function AnalyticsTab() {
  const [params, setParams] = useSearchParams();
  const flowsQuery = useTriageFlows();
  const rangeDays = params.get("range") ?? "14";
  const flowId = params.get("aFlow") ?? "";

  const days = RANGE_PRESETS.find((p) => p.value === rangeDays)?.days ?? 14;
  const from = useMemo(
    () => new Date(Date.now() - days * 86400_000).toISOString(),
    [days],
  );

  const { data, isLoading, isError, error, refetch } = useTriageAnalytics({
    from,
    flowId: flowId || undefined,
  });

  function setRange(v: string) {
    const p = new URLSearchParams(params);
    p.set("range", v);
    setParams(p, { replace: true });
  }
  function setFlow(v: string) {
    const p = new URLSearchParams(params);
    setOrDelete(p, "aFlow", v);
    setParams(p, { replace: true });
  }

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Select value={rangeDays} onValueChange={setRange}>
          <SelectTrigger className="w-[160px] h-8 text-sm" aria-label="Date range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={flowId || "__all"} onValueChange={(v) => setFlow(v === "__all" ? "" : v)}>
          <SelectTrigger className="w-[200px] h-8 text-sm" aria-label="Flow segment">
            <SelectValue placeholder="All flows" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All flows</SelectItem>
            {(flowsQuery.data ?? []).map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <span className="ml-auto text-xs text-muted-foreground" data-testid="analytics-asof">
            As of {new Date(data.asOf).toLocaleString()}
          </span>
        )}
      </div>

      {isLoading && !data ? (
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : !data ? null : (
        <AnalyticsBody data={data} />
      )}
    </>
  );
}

function AnalyticsBody({ data }: { data: TriageAnalytics }) {
  return (
    <>
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Triaged today" value={data.triagedToday} accent="success" />
        <MetricCard
          label="Avg time to route"
          value={`${data.avgTimeToRouteSec}s`}
          hint="From call start to handoff"
        />
        <MetricCard
          label="Auto-resolved"
          value={`${data.autoResolvedPct}%`}
          accent="success"
          hint="Handled by voice agent"
        />
        <MetricCard
          label="Handoff success (24h)"
          value={`${data.handoffSuccess24hPct}%`}
          accent="success"
          hint="Completed / (completed + failed)"
        />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="To human" value={`${data.toHumanPct}%`} hint="Warm handoff to human" />
        <MetricCard
          label="No-match rate"
          value={`${data.noMatchRate}%`}
          accent={data.noMatchRate > 10 ? "warning" : "default"}
          hint="Calls hitting no rule"
        />
        <MetricCard label="Fallback rate" value={`${data.fallbackRate}%`} hint="Routed via '*'" />
        <MetricCard
          label="SLA attainment"
          value={`${data.slaAttainmentPct}%`}
          accent={data.slaAttainmentPct < 80 ? "warning" : "success"}
          hint="Handoffs within SLA"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card
          title="Intents detected"
          action={
            <CsvButton
              filename="triage-intents.csv"
              rows={data.byIntent as unknown as Record<string, unknown>[]}
            />
          }
        >
          <div className="p-4">
            <IntentsChart data={data} />
          </div>
        </Card>
        <Card
          title="Destinations"
          action={
            <CsvButton
              filename="triage-destinations.csv"
              rows={data.byDestination as unknown as Record<string, unknown>[]}
            />
          }
        >
          <div className="p-4">
            <DestinationsChart data={data} />
          </div>
        </Card>
      </div>

      <Card
        title="Daily volume"
        action={
          <CsvButton
            filename="triage-volume.csv"
            rows={data.dailyVolume as unknown as Record<string, unknown>[]}
          />
        }
      >
        <div className="p-4">
          <VolumeChart data={data} />
        </div>
      </Card>

      <Card
        title="Rule hit-rate & SLA"
        action={
          <CsvButton
            filename="triage-rule-hit-rate.csv"
            rows={data.byRule as unknown as Record<string, unknown>[]}
          />
        }
      >
        {data.byRule.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No routing decisions in this window yet.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Intent</th>
                <th>Destination</th>
                <th>Decisions</th>
                <th>Hit-rate</th>
                <th>SLA attainment</th>
              </tr>
            </thead>
            <tbody>
              {data.byRule.map((r) => (
                <tr key={r.ruleId}>
                  <td className="capitalize text-xs">{r.intent.replace(/_/g, " ")}</td>
                  <td className="text-xs">{r.destinationLabel}</td>
                  <td className="tabular-nums text-xs">{r.decisions}</td>
                  <td className="tabular-nums text-xs">{r.hitRatePct}%</td>
                  <td className="tabular-nums text-xs">
                    {r.slaAttainmentPct == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          r.slaAttainmentPct < 80 ? "text-warning" : "text-success",
                        )}
                      >
                        {r.slaAttainmentPct}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function CsvButton({ filename, rows }: { filename: string; rows: Record<string, unknown>[] }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs"
      disabled={rows.length === 0}
      onClick={() => downloadCsv(filename, rows)}
    >
      <Download className="w-3.5 h-3.5 mr-1.5" />
      CSV
    </Button>
  );
}
