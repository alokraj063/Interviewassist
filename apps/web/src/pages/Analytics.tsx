// Analytics — filter-driven, server-aggregated dashboard. Every chart traces to
// a live report endpoint (every series is server-aggregated), reacts to the
// URL-synced date-range + segment filter envelope, carries an "as of" timestamp,
// supports per-chart CSV export, drill-down to the underlying candidate list,
// and saved-view / scheduled-report authoring. Permission-gated throughout.
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { Loader2, Sparkles, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useCan } from "@/auth/AuthContext";
import {
  useFunnel,
  useVelocity,
  useSourceEffectiveness,
  useQualityDistribution,
  useVoiceScreener,
  useCallVolume,
  useRecruiterProductivity,
  useDiversity,
  useReportSummary,
  type AnalyticsFilters,
  type SavedView,
  type ReportKey,
  type DrillParams,
} from "@/hooks/useAnalyticsReports";
import {
  filtersFromParams,
  tabFromParams,
  hasActiveSegments,
  ANALYTICS_TABS,
  TAB_LABELS,
  type AnalyticsTab,
} from "@/lib/analyticsFilters";
import { ChartFrame } from "@/components/analytics/ChartFrame";
import { ExportButton } from "@/components/analytics/ExportButton";
import { AnalyticsFilterBar } from "@/components/analytics/AnalyticsFilterBar";
import { SavedViewMenu } from "@/components/analytics/SavedViewMenu";
import { DrillDrawer } from "@/components/analytics/DrillDrawer";
import { ScheduleReportDialog, ScheduleButton } from "@/components/analytics/ScheduleReportDialog";

const CHART_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const canExport = useCan("analytics.export");
  const canDiversity = useCan("analytics.diversity.read");

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const tab = tabFromParams(params);
  const filtered = hasActiveSegments(filters);

  const [drill, setDrill] = useState<{ params: DrillParams; title: string } | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);

  const patchParams = useCallback(
    (patch: Partial<Record<string, string | undefined>>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  function setTab(t: AnalyticsTab) {
    patchParams({ tab: t });
  }

  function clearSegments() {
    patchParams({ recruiterUserId: undefined, clientId: undefined, demandId: undefined, source: undefined });
  }

  // Load a saved view's config into the URL.
  function loadView(view: SavedView) {
    const cfg = view.config as Partial<AnalyticsFilters> & { tab?: string };
    const next = new URLSearchParams();
    if (cfg.range) next.set("range", String(cfg.range));
    if (cfg.from) next.set("from", String(cfg.from));
    if (cfg.to) next.set("to", String(cfg.to));
    if (cfg.compare) next.set("compare", "1");
    if (cfg.granularity) next.set("granularity", String(cfg.granularity));
    if (cfg.recruiterUserId) next.set("recruiterUserId", String(cfg.recruiterUserId));
    if (cfg.source) next.set("source", String(cfg.source));
    if (cfg.tab) next.set("tab", String(cfg.tab));
    setParams(next, { replace: false });
  }

  // Recruiter options for the segment select come from the productivity report.
  const recruiterQ = useRecruiterProductivity(filters, null);
  const recruiterOptions = useMemo(
    () =>
      (recruiterQ.data?.rows ?? [])
        .filter((r) => r.recruiterUserId)
        .map((r) => ({ id: r.recruiterUserId, label: r.name ?? r.email ?? r.recruiterUserId.slice(0, 8) })),
    [recruiterQ.data],
  );

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Funnel health, velocity, source effectiveness, and quality — all live, filtered, and exportable"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SavedViewMenu filters={filters} tab={tab} onLoad={loadView} />
            {canExport ? (
              <ScheduleButton onClick={() => setSchedulesOpen(true)} />
            ) : (
              <Button size="sm" variant="outline" disabled title="Requires analytics.export">
                Schedules
              </Button>
            )}
          </div>
        }
      />

      <AnalyticsFilterBar
        filters={filters}
        recruiterOptions={recruiterOptions}
        onPatch={patchParams}
        onClearSegments={clearSegments}
      />

      <div className="p-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as AnalyticsTab)}>
          <TabsList className="flex flex-wrap">
            {ANALYTICS_TABS.filter((t) => t !== "diversity" || canDiversity).map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="funnel" className="mt-4">
            <FunnelTab filters={filters} filtered={filtered} canExport={canExport} onDrill={setDrill} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="velocity" className="mt-4">
            <VelocityTab filters={filters} filtered={filtered} canExport={canExport} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="sources" className="mt-4">
            <SourcesTab filters={filters} filtered={filtered} canExport={canExport} onDrill={setDrill} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="quality" className="mt-4">
            <QualityTab filters={filters} filtered={filtered} canExport={canExport} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="voice" className="mt-4">
            <VoiceTab filters={filters} filtered={filtered} canExport={canExport} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="recruiters" className="mt-4">
            <RecruitersTab filters={filters} filtered={filtered} canExport={canExport} onDrill={setDrill} onClearSegments={clearSegments} />
          </TabsContent>
          <TabsContent value="trends" className="mt-4">
            <TrendsTab filters={filters} filtered={filtered} canExport={canExport} onClearSegments={clearSegments} />
          </TabsContent>
          {canDiversity && (
            <TabsContent value="diversity" className="mt-4">
              <DiversityTab filters={filters} filtered={filtered} canExport={canExport} onClearSegments={clearSegments} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <DrillDrawer
        open={!!drill}
        onOpenChange={(v) => !v && setDrill(null)}
        filters={filters}
        drill={drill?.params ?? null}
        title={drill?.title ?? "Candidates"}
      />
      <ScheduleReportDialog open={schedulesOpen} onOpenChange={setSchedulesOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// shared tab props
// ---------------------------------------------------------------------------
interface TabProps {
  filters: AnalyticsFilters;
  filtered: boolean;
  canExport: boolean;
  onClearSegments: () => void;
  onDrill?: (d: { params: DrillParams; title: string }) => void;
}

function SummaryButton({ reportKey, filters }: { reportKey: ReportKey; filters: AnalyticsFilters }) {
  const summary = useReportSummary();
  const [text, setText] = useState<string | null>(null);
  const [ai, setAi] = useState<boolean>(false);
  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={summary.isPending}
        onClick={() =>
          summary.mutate(
            { reportKey, filters },
            {
              onSuccess: (r) => {
                setText(r.summary);
                setAi(r.ai);
              },
              onError: (e) => toast.error(e.message),
            },
          )
        }
        data-testid="explain-report"
      >
        {summary.isPending ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
        )}
        Explain this report
      </Button>
      {text && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
          <Badge variant="secondary" className="mb-1.5" data-testid="summary-badge">
            {ai ? "AI-generated" : "Heuristic"}
          </Badge>
          <p>{text}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------
function FunnelTab({ filters, filtered, canExport, onDrill, onClearSegments }: TabProps) {
  const q = useFunnel(filters);
  const rows = q.data?.rows ?? [];
  const nonEmpty = rows.some((r) => r.count > 0);
  return (
    <div className="space-y-4">
      <ChartFrame
        title="Submission funnel"
        description="Stage volume across the pipeline. Click a bar to drill into the candidates."
        asOf={q.data?.asOf}
        isLoading={q.isLoading}
        isError={q.isError}
        error={q.error}
        onRetry={() => q.refetch()}
        isEmpty={!nonEmpty}
        filtered={filtered}
        onClearFilters={onClearSegments}
        ariaLabel="Submission funnel by stage"
        action={<ExportButton reportKey="funnel" filters={filters} canExport={canExport} />}
      >
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" allowDecimals={false} />
            <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              cursor="pointer"
              onClick={(d: { payload?: { bucket: string; label: string } }) => {
                if (d?.payload && onDrill)
                  onDrill({ params: { bucket: d.payload.bucket }, title: `${d.payload.label} candidates` });
              }}
            >
              {rows.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {rows.map((r) => (
            <button
              key={r.bucket}
              className="rounded-md border border-border p-2 text-left hover:bg-muted/30"
              onClick={() => onDrill?.({ params: { bucket: r.bucket }, title: `${r.label} candidates` })}
              data-testid={`funnel-bucket-${r.bucket}`}
            >
              <div className="text-xs text-muted-foreground">{r.label}</div>
              <div className="flex items-center gap-1.5">
                <span className="text-lg font-semibold" data-testid={`funnel-count-${r.bucket}`}>
                  {r.count}
                </span>
                {r.conversionPctFromPrev !== null && (
                  <span className="text-xs text-muted-foreground">{r.conversionPctFromPrev}%</span>
                )}
                <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </button>
          ))}
        </div>
      </ChartFrame>
      <SummaryButton reportKey="funnel" filters={filters} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------
function VelocityTab({ filters, filtered, canExport, onClearSegments }: TabProps) {
  const q = useVelocity(filters);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Stage velocity"
      description="Median / p90 / average days spent in each stage before moving on."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Time in stage by pipeline stage"
      action={<ExportButton reportKey="velocity" filters={filters} canExport={canExport} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Stage</th>
              <th className="py-2 pr-3 font-medium">Median days</th>
              <th className="py-2 pr-3 font-medium">p90 days</th>
              <th className="py-2 pr-3 font-medium">Avg days</th>
              <th className="py-2 pr-3 font-medium">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage} className="border-b border-border/50">
                <td className="py-2 pr-3 font-medium">{r.stage.replace(/_/g, " ")}</td>
                <td className="py-2 pr-3">{r.medianDaysInStage ?? "—"}</td>
                <td className="py-2 pr-3">{r.p90DaysInStage ?? "—"}</td>
                <td className="py-2 pr-3">{r.avgDays ?? "—"}</td>
                <td className="py-2 pr-3 text-muted-foreground">{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function SourcesTab({ filters, filtered, canExport, onDrill, onClearSegments }: TabProps) {
  const q = useSourceEffectiveness(filters);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Source effectiveness"
      description="Submitted vs onboarded by sourcing channel. Click a row to drill into candidates."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Conversion by source channel"
      action={<ExportButton reportKey="source_effectiveness" filters={filters} canExport={canExport} />}
    >
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="source" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="submitted" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} name="Submitted" />
          <Bar dataKey="onboarded" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} name="Onboarded" />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-3 divide-y divide-border rounded-md border border-border">
        {rows.map((r) => (
          <button
            key={r.source}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/30"
            onClick={() => onDrill?.({ params: { source: r.source }, title: `${r.source} candidates` })}
            data-testid={`source-row-${r.source}`}
          >
            <span className="font-medium">{r.source.replace(/_/g, " ")}</span>
            <span className="text-xs text-muted-foreground">
              {r.submitted} submitted · {r.onboarded} onboarded · {r.conversionPct}% conv
            </span>
          </button>
        ))}
      </div>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Quality distribution
// ---------------------------------------------------------------------------
function QualityTab({ filters, filtered, canExport, onClearSegments }: TabProps) {
  const q = useQualityDistribution(filters);
  const histogram = (q.data?.histogram ?? []).map((h) => ({
    bucket: `${(Number(h.bucket) - 1) * 10}-${Number(h.bucket) * 10}`,
    n: h.n,
  }));
  const criteria = q.data?.perCriterion ?? [];
  const isEmpty = histogram.length === 0 && criteria.length === 0;
  return (
    <ChartFrame
      title="Rubric score distribution"
      description="Histogram of call rubric scores (0–100) plus per-criterion percentiles."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={isEmpty}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Rubric score distribution histogram"
      action={<ExportButton reportKey="quality_distribution" filters={filters} canExport={canExport} />}
    >
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={histogram}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="n" fill={CHART_COLORS[5]} radius={[4, 4, 0, 0]} name="Calls" />
        </BarChart>
      </ResponsiveContainer>
      {criteria.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Criterion</th>
                <th className="py-2 pr-3 font-medium">Avg</th>
                <th className="py-2 pr-3 font-medium">p25</th>
                <th className="py-2 pr-3 font-medium">p50</th>
                <th className="py-2 pr-3 font-medium">p75</th>
                <th className="py-2 pr-3 font-medium">n</th>
              </tr>
            </thead>
            <tbody>
              {criteria.map((c) => (
                <tr key={c.criterionId} className="border-b border-border/50">
                  <td className="py-2 pr-3 font-mono text-xs">{c.criterionId.slice(0, 12)}</td>
                  <td className="py-2 pr-3">{round1(c.avg)}</td>
                  <td className="py-2 pr-3">{round1(c.p25)}</td>
                  <td className="py-2 pr-3">{round1(c.p50)}</td>
                  <td className="py-2 pr-3">{round1(c.p75)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartFrame>
  );
}

function round1(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return String(Math.round(v * 10) / 10);
}

// ---------------------------------------------------------------------------
// Voice screener
// ---------------------------------------------------------------------------
function VoiceTab({ filters, filtered, canExport, onClearSegments }: TabProps) {
  const q = useVoiceScreener(filters);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Voice screener performance"
      description="Calls handled and average duration per voice agent."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Voice screener calls by agent"
      action={<ExportButton reportKey="voice_screener" filters={filters} canExport={canExport} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Agent</th>
              <th className="py-2 pr-3 font-medium">Kind</th>
              <th className="py-2 pr-3 font-medium">Calls</th>
              <th className="py-2 pr-3 font-medium">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.voiceAgentId ?? r.name ?? Math.random()} className="border-b border-border/50">
                <td className="py-2 pr-3 font-medium">{r.name ?? "Unnamed agent"}</td>
                <td className="py-2 pr-3 text-muted-foreground">{r.kind ?? "—"}</td>
                <td className="py-2 pr-3">{r.calls}</td>
                <td className="py-2 pr-3">{fmtDuration(r.avgDurationSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

function fmtDuration(sec: number): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Recruiters (keyset-paginated)
// ---------------------------------------------------------------------------
function RecruitersTab({ filters, filtered, canExport, onDrill, onClearSegments }: TabProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const q = useRecruiterProductivity(filters, cursor);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Recruiter productivity"
      description="Submissions, onboarded, and conversion per recruiter. Click a row to drill in."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Recruiter productivity table"
      action={<ExportButton reportKey="recruiter_productivity" filters={filters} canExport={canExport} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Recruiter</th>
              <th className="py-2 pr-3 font-medium">Submissions</th>
              <th className="py-2 pr-3 font-medium">Onboarded</th>
              <th className="py-2 pr-3 font-medium">Conversion</th>
              <th className="py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.recruiterUserId}
                className="cursor-pointer border-b border-border/50 hover:bg-muted/30"
                onClick={() =>
                  onDrill?.({
                    params: { recruiterUserId: r.recruiterUserId },
                    title: `${r.name ?? "Recruiter"} candidates`,
                  })
                }
                data-testid={`recruiter-row-${r.recruiterUserId}`}
              >
                <td className="py-2 pr-3 font-medium">{r.name ?? r.email ?? "—"}</td>
                <td className="py-2 pr-3">{r.submissions}</td>
                <td className="py-2 pr-3">{r.onboarded}</td>
                <td className="py-2 pr-3">{r.conversionPct}%</td>
                <td className="py-2 pr-3 text-right">
                  <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data?.nextCursor && (
        <div className="mt-3 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={q.isFetching}
            onClick={() => setCursor(q.data!.nextCursor)}
          >
            {q.isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Trends (call volume time-series)
// ---------------------------------------------------------------------------
function TrendsTab({ filters, filtered, canExport, onClearSegments }: TabProps) {
  const q = useCallVolume(filters);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Call volume trend"
      description="Calls over time at the selected granularity."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Call volume over time"
      action={<ExportButton reportKey="call_volume" filters={filters} canExport={canExport} />}
    >
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={rows}>
          <defs>
            <linearGradient id="cv" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS[1]} stopOpacity={0.5} />
              <stop offset="95%" stopColor={CHART_COLORS[1]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="period" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Area type="monotone" dataKey="n" stroke={CHART_COLORS[1]} fill="url(#cv)" name="Calls" />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// Diversity (permission-gated)
// ---------------------------------------------------------------------------
function DiversityTab({ filters, filtered, canExport, onClearSegments }: TabProps) {
  const q = useDiversity(filters, true);
  const rows = q.data?.rows ?? [];
  return (
    <ChartFrame
      title="Cohort distribution"
      description="Anonymized cohort counts. Buckets below the minimum size are suppressed."
      asOf={q.data?.asOf}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error}
      onRetry={() => q.refetch()}
      isEmpty={rows.length === 0}
      filtered={filtered}
      onClearFilters={onClearSegments}
      ariaLabel="Anonymized cohort distribution"
      action={<ExportButton reportKey="diversity" filters={filters} canExport={canExport} />}
    >
      {q.data && q.data.suppressedBuckets > 0 && (
        <div className="mb-2 text-xs text-muted-foreground">
          {q.data.suppressedBuckets} bucket(s) suppressed for anonymity.
        </div>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="cohort" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="count" fill={CHART_COLORS[3]} radius={[4, 4, 0, 0]} name="Count" />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
