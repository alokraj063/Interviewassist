// QA Review console — quality-management surface.
// Tabs: Queue · Policies · Calibration · Disputes · Agreement. The Queue is a
// real server-driven, URL-synced, keyset-paginated list with filters, sort,
// multi-select bulk actions, and explicit empty/loading/error/permission states.
// Authoring (sampling policies, disputes) lives in dialogs. No mock coupling.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Plus,
  Lock,
  AlertCircle,
  RotateCcw,
  X,
  Loader2,
  Play,
  Archive,
  Pencil,
  Gavel,
  ClipboardCheck,
  ChevronRight,
  Download,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { getApiBase, getAccessToken } from "@/lib/api";
import {
  useQAStats,
  useQAQueue,
  useQAPolicies,
  useQADisputes,
  useQACalibration,
  useRunPolicy,
  useArchivePolicy,
  apiErrorMessage,
  queueQueryString,
  QA_SORTS,
  QA_SORT_LABELS,
  QA_DECISIONS,
  QA_STRATEGY_LABELS,
  type QaTab,
  type QaSort,
  type QaDecision,
  type QueueFilters,
  type QueueRow,
  type SamplingPolicy,
} from "@/hooks/useQAReview";
import { SamplingPolicyDialog } from "@/components/qa-review/SamplingPolicyDialog";
import { DisputeDialog } from "@/components/qa-review/DisputeDialog";
import { QueueBulkBar } from "@/components/qa-review/QueueBulkBar";
import { AgreementPanel } from "@/components/qa-review/AgreementPanel";

const PAGE_LIMIT = 25;
const CONSOLE_TABS = ["queue", "policies", "calibration", "disputes", "agreement"] as const;
type ConsoleTab = (typeof CONSOLE_TABS)[number];
const CONSOLE_TAB_LABELS: Record<ConsoleTab, string> = {
  queue: "Queue",
  policies: "Policies",
  calibration: "Calibration",
  disputes: "Disputes",
  agreement: "Agreement",
};

const QUEUE_TABS: { id: QaTab; label: string }[] = [
  { id: "needs", label: "Needs review" },
  { id: "reviewed", label: "Reviewed" },
  { id: "mine", label: "Assigned to me" },
  { id: "disputed", label: "Disputed" },
  { id: "all", label: "All" },
];

const DECISION_PILL: Record<string, string> = {
  accept: "bg-success/15 text-success",
  override: "bg-warning/15 text-warning",
  escalate: "bg-destructive/15 text-destructive",
};

export default function QAReview() {
  const nav = useNavigate();
  const canRead = useCan("qa.read");
  const canWrite = useCan("qa.write");
  const canSampling = useCan("qa.sampling");
  const canDispute = useCan("qa.dispute");
  const canExport = useCan("qa.export");
  const [params, setParams] = useSearchParams();

  const consoleTab = (params.get("view") as ConsoleTab) ?? "queue";
  const setConsoleTab = (v: ConsoleTab) => patchParam("view", v === "queue" ? undefined : v);

  // Queue dialogs / selection
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<SamplingPolicy | null>(null);
  const [disputeFor, setDisputeFor] = useState<QueueRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursors, setCursors] = useState<string[]>([]);

  // Search box mirrors ?q with a 300ms debounce.
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
  useEffect(() => {
    const t = setTimeout(() => patchParam("q", searchInput || undefined), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const filters: QueueFilters = useMemo(
    () => ({
      tab: (params.get("tab") as QaTab) ?? "needs",
      q: params.get("q") ?? undefined,
      recruiterId: params.get("recruiterId") ?? undefined,
      demandId: params.get("demandId") ?? undefined,
      decision: (params.get("decision") as QaDecision) ?? undefined,
      policyId: params.get("policyId") ?? undefined,
      endedFrom: params.get("endedFrom") ?? undefined,
      endedTo: params.get("endedTo") ?? undefined,
      sort: (params.get("sort") as QaSort) ?? "ended_desc",
    }),
    [params],
  );

  const stats = useQAStats();
  const cursor = cursors[cursors.length - 1];
  const queueQ = useQAQueue(filters, { cursor, limit: PAGE_LIMIT });

  // Reset pagination + selection whenever the queue query changes.
  const queueKey = queueQueryString(filters, { limit: PAGE_LIMIT });
  useEffect(() => {
    setCursors([]);
    setSelected(new Set());
  }, [queueKey]);

  const hasFilters =
    !!filters.q ||
    !!filters.recruiterId ||
    !!filters.demandId ||
    !!filters.decision ||
    !!filters.policyId ||
    !!filters.endedFrom ||
    !!filters.endedTo;

  function patchParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (!value || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function clearQueueFilters() {
    const next = new URLSearchParams(params);
    for (const k of ["q", "recruiterId", "demandId", "decision", "policyId", "endedFrom", "endedTo"]) {
      next.delete(k);
    }
    setSearchInput("");
    setParams(next, { replace: true });
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function exportCsv() {
    const qs = queueQueryString(filters, { limit: PAGE_LIMIT });
    const url = `${getApiBase()}/api/qa/export?${qs}`;
    const token = getAccessToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`Export failed (${r.status})`);
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "qa-queue.csv";
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success("Export downloaded");
      })
      .catch((e: Error) => toast.error(e.message));
  }

  if (!canRead) {
    return (
      <div className="p-10">
        <EmptyState
          title="You don't have access to QA Review"
          body="Ask an admin to grant the qa.read permission for your role."
        />
      </div>
    );
  }

  const rows = queueQ.data?.rows ?? [];
  const total = queueQ.data?.total ?? 0;
  const nextCursor = queueQ.data?.nextCursor ?? null;

  return (
    <div>
      <PageHeader
        title="QA review"
        subtitle="Calibrate AI scoring against human review — sample, grade, calibrate, and resolve."
        actions={
          consoleTab === "queue" ? (
            <div className="flex items-center gap-2">
              {canExport && (
                <Button variant="outline" size="sm" onClick={exportCsv}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Export
                </Button>
              )}
              {canSampling ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingPolicy(null);
                    setPolicyDialogOpen(true);
                  }}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Create policy
                </Button>
              ) : (
                <Button size="sm" disabled title="Requires qa.sampling">
                  <Lock className="mr-1.5 h-3.5 w-3.5" />
                  Create policy
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {/* Console tabs */}
      <div
        role="tablist"
        aria-label="QA console sections"
        className="flex gap-1 border-b border-border bg-background px-6 pt-4"
      >
        {CONSOLE_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={consoleTab === t}
            onClick={() => setConsoleTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              consoleTab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {CONSOLE_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <MetricCard
            label="In queue"
            value={stats.data?.inQueue ?? 0}
            accent={(stats.data?.inQueue ?? 0) > 0 ? "warning" : "default"}
          />
          <MetricCard label="Reviewed today" value={stats.data?.reviewedToday ?? 0} />
          <MetricCard
            label="Disputes open"
            value={stats.data?.disputesOpen ?? 0}
            accent={(stats.data?.disputesOpen ?? 0) > 0 ? "danger" : "default"}
          />
          <MetricCard
            label="SLA breaches"
            value={stats.data?.slaBreaches ?? 0}
            accent={(stats.data?.slaBreaches ?? 0) > 0 ? "danger" : "default"}
          />
          <MetricCard
            label="Reviewer agreement"
            value={stats.data?.reviewerAgreementPct == null ? "—" : `${stats.data.reviewerAgreementPct}%`}
            accent={(stats.data?.reviewerAgreementPct ?? 0) >= 90 ? "success" : "default"}
          />
        </div>

        {consoleTab === "queue" && (
          <QueueSection
            filters={filters}
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            patchParam={patchParam}
            hasFilters={hasFilters}
            clearQueueFilters={clearQueueFilters}
            queueQ={queueQ}
            rows={rows}
            total={total}
            nextCursor={nextCursor}
            cursors={cursors}
            setCursors={setCursors}
            selected={selected}
            toggleSelect={toggleSelect}
            canWrite={canWrite}
            canDispute={canDispute}
            canSampling={canSampling}
            onCreatePolicy={() => {
              setEditingPolicy(null);
              setPolicyDialogOpen(true);
            }}
            onGrade={(r) => nav(`/calls/${r.id}?qa=1`)}
            onDispute={(r) => setDisputeFor(r)}
          />
        )}

        {consoleTab === "policies" && (
          <PoliciesSection
            canSampling={canSampling}
            onCreate={() => {
              setEditingPolicy(null);
              setPolicyDialogOpen(true);
            }}
            onEdit={(p) => {
              setEditingPolicy(p);
              setPolicyDialogOpen(true);
            }}
          />
        )}

        {consoleTab === "calibration" && <CalibrationSection />}

        {consoleTab === "disputes" && <DisputesSection onOpen={(id) => nav(`/qa-review/disputes/${id}`)} />}

        {consoleTab === "agreement" && <AgreementPanel />}
      </div>

      {selected.size > 0 && canWrite && (
        <QueueBulkBar itemIds={[...selected]} onClear={() => setSelected(new Set())} />
      )}

      <SamplingPolicyDialog open={policyDialogOpen} onOpenChange={setPolicyDialogOpen} editing={editingPolicy} />
      <DisputeDialog
        open={!!disputeFor}
        onOpenChange={(v) => !v && setDisputeFor(null)}
        callId={disputeFor?.id ?? null}
        candidateName={disputeFor?.candidateName}
      />
    </div>
  );
}

// ───────────────────────────── Queue section ─────────────────────────────

function QueueSection(props: {
  filters: QueueFilters;
  searchInput: string;
  setSearchInput: (v: string) => void;
  patchParam: (k: string, v: string | undefined) => void;
  hasFilters: boolean;
  clearQueueFilters: () => void;
  queueQ: ReturnType<typeof useQAQueue>;
  rows: QueueRow[];
  total: number;
  nextCursor: string | null;
  cursors: string[];
  setCursors: React.Dispatch<React.SetStateAction<string[]>>;
  selected: Set<string>;
  toggleSelect: (id: string) => void;
  canWrite: boolean;
  canDispute: boolean;
  canSampling: boolean;
  onCreatePolicy: () => void;
  onGrade: (r: QueueRow) => void;
  onDispute: (r: QueueRow) => void;
}) {
  const {
    filters,
    searchInput,
    setSearchInput,
    patchParam,
    hasFilters,
    clearQueueFilters,
    queueQ,
    rows,
    total,
    nextCursor,
    setCursors,
    selected,
    toggleSelect,
    canWrite,
    canDispute,
    canSampling,
    onCreatePolicy,
    onGrade,
    onDispute,
  } = props;

  return (
    <>
      {/* Queue tabs */}
      <div role="tablist" aria-label="Queue filters" className="flex flex-wrap gap-1">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={filters.tab === t.id}
            onClick={() => patchParam("tab", t.id === "needs" ? undefined : t.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium",
              filters.tab === t.id
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter / search / sort row */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search candidate / demand / recruiter…"
            className="pl-8"
            aria-label="Search queue"
          />
        </div>
        <FilterSelect
          label="Decision"
          value={filters.decision}
          onChange={(v) => patchParam("decision", v)}
          options={QA_DECISIONS.map((d) => ({ value: d, label: d }))}
        />
        <Select value={filters.sort} onValueChange={(v) => patchParam("sort", v)}>
          <SelectTrigger className="w-[200px]" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QA_SORTS.map((s) => (
              <SelectItem key={s} value={s}>
                {QA_SORT_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Filters active</span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={clearQueueFilters}>
            <X className="mr-1 h-3 w-3" />
            Clear all
          </Button>
        </div>
      )}

      <Card>
        {queueQ.isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
            <div className="text-sm font-semibold">Couldn't load the queue</div>
            <div className="max-w-md text-sm text-muted-foreground">{apiErrorMessage(queueQ.error)}</div>
            <Button size="sm" variant="outline" onClick={() => queueQ.refetch()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : queueQ.isLoading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="mt-2 h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 && hasFilters ? (
          <EmptyState
            title="No calls match these filters"
            body="Adjust or clear the filters to see more."
            action={
              <Button size="sm" variant="outline" onClick={clearQueueFilters}>
                Clear filters
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No calls sampled for review yet"
            body="Create a sampling policy and run it to populate the queue with ended calls."
            action={
              canSampling ? (
                <Button size="sm" onClick={onCreatePolicy}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Create policy
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
              {queueQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  {canWrite && <th className="w-8" />}
                  <th>Candidate</th>
                  <th>Demand</th>
                  <th>Recruiter</th>
                  <th className="text-right">AI</th>
                  <th className="text-right">Reviewer</th>
                  <th>Decision</th>
                  <th>Status</th>
                  <th>Ended</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/20">
                    {canWrite && (
                      <td>
                        <Checkbox
                          checked={selected.has(r.id)}
                          onCheckedChange={() => toggleSelect(r.id)}
                          aria-label={`Select ${r.candidateName ?? "call"}`}
                        />
                      </td>
                    )}
                    <td>
                      <a
                        href={`/calls/${r.id}?qa=1`}
                        onClick={(e) => {
                          e.preventDefault();
                          onGrade(r);
                        }}
                        className="font-medium hover:underline"
                      >
                        {r.candidateName ?? r.id.slice(0, 8)}
                      </a>
                    </td>
                    <td className="text-xs">{r.demandTitle ?? "—"}</td>
                    <td className="text-xs">{r.recruiterName ?? "—"}</td>
                    <td className="text-right tabular-nums">{r.aiScore == null ? "—" : Math.round(r.aiScore)}</td>
                    <td className="text-right tabular-nums">
                      {r.reviewerScore == null ? "—" : Math.round(r.reviewerScore)}
                    </td>
                    <td>
                      {r.latestDecision ? (
                        <span
                          className={cn(
                            "pill text-[11px] capitalize",
                            DECISION_PILL[r.latestDecision] ?? "bg-muted text-muted-foreground",
                          )}
                        >
                          {r.latestDecision}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td>
                      <StatusCell row={r} />
                    </td>
                    <td className="text-xs text-muted-foreground">
                      {r.endedAt ? formatDistanceToNow(new Date(r.endedAt), { addSuffix: true }) : "—"}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        {canWrite && (
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => onGrade(r)}>
                            <ClipboardCheck className="mr-1 h-3.5 w-3.5" />
                            Grade
                          </Button>
                        )}
                        {canDispute && r.reviewCount > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7"
                            onClick={() => onDispute(r)}
                            title="Raise a dispute"
                          >
                            <Gavel className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor && (
              <div className="flex justify-center border-t border-border p-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={queueQ.isFetching}
                  onClick={() => setCursors((c) => [...c, nextCursor])}
                >
                  {queueQ.isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function StatusCell({ row }: { row: QueueRow }) {
  if (row.disputeStatus && ["open", "under_review"].includes(row.disputeStatus)) {
    return <Badge variant="destructive">Disputed</Badge>;
  }
  if (row.slaBreached) return <Badge variant="destructive">SLA breached</Badge>;
  if (row.assignedReviewerName) return <Badge variant="secondary">Assigned</Badge>;
  if (row.reviewCount > 0) return <Badge variant="outline">Reviewed</Badge>;
  return <Badge variant="outline">Pending</Badge>;
}

// ───────────────────────────── Policies section ─────────────────────────────

function PoliciesSection({
  canSampling,
  onCreate,
  onEdit,
}: {
  canSampling: boolean;
  onCreate: () => void;
  onEdit: (p: SamplingPolicy) => void;
}) {
  const { data, isLoading, isError, error, refetch } = useQAPolicies();
  const run = useRunPolicy();
  const archive = useArchivePolicy();

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load policies</div>
          <div className="max-w-md text-sm text-muted-foreground">{apiErrorMessage(error)}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  const policies = (data?.policies ?? []).filter((p) => p.isActive);
  if (policies.length === 0) {
    return (
      <EmptyState
        title="No sampling policies yet"
        body="A sampling policy decides which ended calls land in the QA queue."
        action={
          canSampling ? (
            <Button size="sm" onClick={onCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create policy
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Card>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Strategy</th>
            <th>Double / Blind</th>
            <th>SLA</th>
            {canSampling && <th className="text-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="font-medium">{p.name}</div>
                {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
              </td>
              <td className="text-xs">
                {QA_STRATEGY_LABELS[p.strategy]}
                {p.samplePercent != null && ` · ${p.samplePercent}%`}
                {p.everyN != null && ` · 1/${p.everyN}`}
                {p.minAiScore != null && ` · <${p.minAiScore}`}
              </td>
              <td className="text-xs">
                {p.requireDoubleReview ? "Double" : "Single"} · {p.blindReview ? "Blind" : "Open"}
              </td>
              <td className="text-xs">{p.slaHours != null ? `${p.slaHours}h` : "—"}</td>
              {canSampling && (
                <td>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={run.isPending}
                      onClick={() =>
                        run.mutate(p.id, {
                          onSuccess: (r) =>
                            toast.success(`Ran policy — ${r.inserted} new, ${r.skipped} already queued`),
                          onError: (e) => toast.error(apiErrorMessage(e)),
                        })
                      }
                    >
                      <Play className="mr-1 h-3.5 w-3.5" />
                      Run
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7" onClick={() => onEdit(p)} aria-label="Edit policy">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Archive policy"
                      disabled={archive.isPending}
                      onClick={() =>
                        archive.mutate(p.id, {
                          onSuccess: () => toast.success("Policy archived"),
                          onError: (e) => toast.error(apiErrorMessage(e)),
                        })
                      }
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ───────────────────────────── Calibration section ─────────────────────────────

function CalibrationSection() {
  const { data, isLoading, isError, error, refetch } = useQACalibration();
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load calibration sessions</div>
          <div className="max-w-md text-sm text-muted-foreground">{apiErrorMessage(error)}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </Card>
    );
  }
  const sessions = data?.sessions ?? [];
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No calibration sessions"
        body="Calibration sessions measure each reviewer's variance from gold answers."
      />
    );
  }
  return (
    <Card>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th className="text-right">Calls</th>
            <th className="text-right">Reviewers</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td className="font-medium">{s.name}</td>
              <td>
                <Badge variant={s.status === "closed" ? "secondary" : s.status === "open" ? "default" : "outline"}>
                  {s.status}
                </Badge>
              </td>
              <td className="text-right tabular-nums">{s.callIds.length}</td>
              <td className="text-right tabular-nums">{s.reviewerIds.length}</td>
              <td className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ───────────────────────────── Disputes section ─────────────────────────────

function DisputesSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading, isError, error, refetch } = useQADisputes();
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load disputes</div>
          <div className="max-w-md text-sm text-muted-foreground">{apiErrorMessage(error)}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </Card>
    );
  }
  const disputes = data?.disputes ?? [];
  if (disputes.length === 0) {
    return <EmptyState title="No disputes" body="Appeals raised on QA reviews appear here for resolution." />;
  }
  return (
    <Card>
      <table className="data-table">
        <thead>
          <tr>
            <th>Reason</th>
            <th>Status</th>
            <th>Raised</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {disputes.map((d) => (
            <tr key={d.id} className="cursor-pointer hover:bg-muted/20" onClick={() => onOpen(d.id)}>
              <td className="max-w-md truncate text-sm">{d.reason}</td>
              <td>
                <Badge
                  variant={
                    d.status === "open" || d.status === "under_review"
                      ? "destructive"
                      : d.status === "overturned"
                        ? "default"
                        : "secondary"
                  }
                >
                  {d.status.replace(/_/g, " ")}
                </Badge>
              </td>
              <td className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
              </td>
              <td>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ───────────────────────────── shared ─────────────────────────────

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
  const ALL = "__all__";
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="w-[150px] capitalize" aria-label={`Filter by ${label}`}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="capitalize">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
