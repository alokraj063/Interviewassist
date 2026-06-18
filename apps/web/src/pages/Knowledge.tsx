// Knowledge Base — tabbed shell (Sources / Collections / Eval / Feedback /
// Analytics). Every metric is live (from /analytics + list responses); the
// Sources tab is server-filtered/sorted/keyset-paginated with a bulk bar; the
// dead corpus picker is gone (corpus is pinned by the source's collection).
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Search,
  X,
  AlertCircle,
  RotateCcw,
  Loader2,
  Lock,
  FolderPlus,
  RefreshCw,
  Archive,
  FolderInput,
  ChevronRight,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useKbSourcesPaged,
  useKbCollections,
  useKbAnalytics,
  useBulkSources,
  SOURCE_STATUSES,
  KB_CORPORA,
  CORPUS_LABELS,
  type KbSourceRow,
  type SourceSort,
  type KbCollection,
} from "@/hooks/useKnowledge";
import {
  tabFromParams,
  sourceFiltersFromParams,
  activeSourceFilterCount,
  clearSourceFilters,
  SOURCE_SORT_LABELS,
  type KbTab,
} from "@/lib/knowledgeFilters";
import { SourcesTable } from "@/components/knowledge/SourcesTable";
import { AddSourceDialog } from "@/components/knowledge/AddSourceDialog";
import { CreateCollectionDialog } from "@/components/knowledge/CreateCollectionDialog";
import { EvalTab } from "@/components/knowledge/EvalTab";
import { FeedbackQueue } from "@/components/knowledge/FeedbackQueue";
import { AnalyticsTab } from "@/components/knowledge/AnalyticsTab";

const PAGE_LIMIT = 25;

export default function Knowledge() {
  const [params, setParams] = useSearchParams();
  const canWrite = useCan("knowledge.write");
  const canManage = useCan("knowledge.manage");
  const canEval = useCan("knowledge.eval");
  const canFeedback = useCan("knowledge.feedback");

  const tab = tabFromParams(params);
  const [addOpen, setAddOpen] = useState(false);
  const [createColOpen, setCreateColOpen] = useState(false);

  const analyticsQ = useKbAnalytics(7);

  function setTab(t: KbTab) {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: false });
  }

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        subtitle="Corpora powering Copilot, Voice Agents, and AI scoring"
        actions={
          <div className="flex items-center gap-2">
            {canManage ? (
              <Button variant="outline" size="sm" onClick={() => setCreateColOpen(true)}>
                <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                New collection
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled title="Requires knowledge.manage">
                <Lock className="mr-1.5 h-3.5 w-3.5" />
                New collection
              </Button>
            )}
            {canWrite ? (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add source
              </Button>
            ) : (
              <Button size="sm" disabled title="Requires knowledge.write">
                <Lock className="mr-1.5 h-3.5 w-3.5" />
                Add source
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <MetricRow analyticsQ={analyticsQ} />

        <Tabs value={tab} onValueChange={(v) => setTab(v as KbTab)}>
          <TabsList>
            <TabsTrigger value="sources">Sources</TabsTrigger>
            <TabsTrigger value="collections">Collections</TabsTrigger>
            <TabsTrigger value="eval">Eval</TabsTrigger>
            <TabsTrigger value="feedback">Feedback</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>

          <TabsContent value="sources" className="space-y-4">
            <SourcesTab canWrite={canWrite} canManage={canManage} onAdd={() => setAddOpen(true)} />
          </TabsContent>
          <TabsContent value="collections" className="space-y-4">
            <CollectionsTab canManage={canManage} onCreate={() => setCreateColOpen(true)} />
          </TabsContent>
          <TabsContent value="eval">
            <EvalTab canEval={canEval} />
          </TabsContent>
          <TabsContent value="feedback">
            <FeedbackQueue canResolve={canFeedback} />
          </TabsContent>
          <TabsContent value="analytics">
            <AnalyticsTab />
          </TabsContent>
        </Tabs>
      </div>

      <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} />
      <CreateCollectionDialog open={createColOpen} onOpenChange={setCreateColOpen} />
    </div>
  );
}

function MetricRow({
  analyticsQ,
}: {
  analyticsQ: ReturnType<typeof useKbAnalytics>;
}) {
  const { data: colData } = useKbCollections();
  const collections = colData?.collections ?? [];
  const a = analyticsQ.data;
  const activeCollections = collections.filter((c) => c.status === "active").length;
  const totalSources = collections.reduce((s, c) => s + c.sourceCount, 0);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard
        label="Collections"
        value={activeCollections}
        hint={`${collections.length} total · ${totalSources} sources`}
      />
      <MetricCard
        label="Retrievals (7d)"
        value={a ? a.totals.retrievals.toLocaleString() : "…"}
        accent="success"
      />
      <MetricCard
        label="Avg latency"
        value={a ? (a.totals.avgLatencyMs == null ? "—" : `${a.totals.avgLatencyMs} ms`) : "…"}
      />
      <MetricCard
        label="Stale / deprecated"
        value={a ? `${a.staleness.stale} / ${a.staleness.deprecated}` : "…"}
        accent={a && a.staleness.stale > 0 ? "warning" : "default"}
      />
    </div>
  );
}

// ---------------- Sources tab ----------------
function SourcesTab({
  canWrite,
  canManage,
  onAdd,
}: {
  canWrite: boolean;
  canManage: boolean;
  onAdd: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const { data: colData } = useKbCollections();
  const collections = colData?.collections ?? [];

  const filters = useMemo(() => sourceFiltersFromParams(params), [params]);
  const sort: SourceSort = filters.sort ?? "created";
  const dir: "asc" | "desc" = filters.dir ?? "desc";

  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
  const [cursors, setCursors] = useState<string[]>([]);
  const [accumulated, setAccumulated] = useState<KbSourceRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Debounce search → ?q
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

  const cursor = cursors[cursors.length - 1];
  const { data, isLoading, isError, error, refetch, isFetching } = useKbSourcesPaged(
    filters,
    cursor,
    PAGE_LIMIT,
  );

  const paramsKey = params.toString();
  useEffect(() => {
    setCursors([]);
    setAccumulated([]);
    setSelected(new Set());
  }, [paramsKey]);

  useEffect(() => {
    if (!data) return;
    setAccumulated((prev) => {
      if (cursors.length === 0) return data.sources;
      const seen = new Set(prev.map((s) => s.id));
      return [...prev, ...data.sources.filter((s) => !seen.has(s.id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows = accumulated;
  const total = data?.total ?? 0;
  const nextCursor = data?.nextCursor ?? null;
  const filterCount = activeSourceFilterCount(filters);
  const hasQuery = !!filters.q;

  function patchParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function onSort(col: SourceSort) {
    const next = new URLSearchParams(params);
    if (sort === col) next.set("dir", dir === "asc" ? "desc" : "asc");
    else {
      next.set("sort", col);
      next.set("dir", "desc");
    }
    setParams(next, { replace: true });
  }

  function clearAll() {
    setSearchInput("");
    setParams(clearSourceFilters(params), { replace: true });
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll(ids: string[]) {
    setSelected((s) => {
      const allOn = ids.every((i) => s.has(i));
      const n = new Set(s);
      if (allOn) ids.forEach((i) => n.delete(i));
      else ids.forEach((i) => n.add(i));
      return n;
    });
  }

  return (
    <>
      {/* Filters */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search sources…"
            className="pl-8"
            aria-label="Search sources"
          />
        </div>
        <FilterSelect
          label="Collection"
          value={filters.collectionId}
          onChange={(v) => patchParam("collectionId", v)}
          options={collections.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          label="Corpus"
          value={filters.corpus}
          onChange={(v) => patchParam("corpus", v)}
          options={KB_CORPORA.map((c) => ({ value: c, label: CORPUS_LABELS[c] }))}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => patchParam("status", v)}
          options={SOURCE_STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <FilterSelect
          label="Staleness"
          value={filters.staleOnly ? "true" : undefined}
          onChange={(v) => patchParam("staleOnly", v)}
          options={[{ value: "true", label: "Stale only" }]}
        />
        <Select value={sort} onValueChange={(v) => patchParam("sort", v)}>
          <SelectTrigger className="w-[170px]" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SOURCE_SORT_LABELS) as SourceSort[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SOURCE_SORT_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(filterCount > 0 || hasQuery) && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {filterCount + (hasQuery ? 1 : 0)} filter(s) active
          </span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={clearAll}>
            <X className="mr-1 h-3 w-3" />
            Clear all
          </Button>
        </div>
      )}

      <Card>
        {isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
            <div className="text-sm font-semibold">Couldn't load sources</div>
            <div className="max-w-md text-sm text-muted-foreground">
              {(error as { body?: { error?: string } })?.body?.error ?? (error as Error)?.message}
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        ) : isLoading && rows.length === 0 ? (
          <div className="divide-y divide-border">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="mt-2 h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 && (filterCount > 0 || hasQuery) ? (
          <EmptyState
            title="No sources match these filters"
            body="Adjust or clear the filters to see more."
            action={
              <Button size="sm" variant="outline" onClick={clearAll}>
                Clear all filters
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No sources yet"
            body="Add a document source into a collection to start powering retrieval."
            action={
              canWrite ? (
                <Button size="sm" onClick={onAdd}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Add source
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
            <SourcesTable
              rows={rows}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
              sort={sort}
              dir={dir}
              onSort={onSort}
              selectable={canWrite}
            />
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

      {selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          collections={collections}
          canManage={canManage}
          onClear={() => setSelected(new Set())}
        />
      )}
    </>
  );
}

function BulkBar({
  ids,
  collections,
  canManage,
  onClear,
}: {
  ids: string[];
  collections: KbCollection[];
  canManage: boolean;
  onClear: () => void;
}) {
  const bulk = useBulkSources();
  const [moveTo, setMoveTo] = useState("");

  function run(action: "deprecate" | "reindex" | "move", collectionId?: string) {
    bulk.mutate(
      { action, ids, collectionId },
      {
        onSuccess: (r) => {
          toast.success(`${action} — ${r.updated} updated, ${r.skipped.length} skipped`);
          onClear();
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium">{ids.length} selected</span>
      <div className="mx-2 h-5 w-px bg-border" />
      <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => run("reindex")}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        Reindex
      </Button>
      <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => run("deprecate")}>
        <Archive className="mr-1.5 h-3.5 w-3.5" />
        Deprecate
      </Button>
      {canManage && (
        <div className="flex items-center gap-1">
          <Select
            value={moveTo}
            onValueChange={(v) => {
              setMoveTo(v);
              run("move", v);
            }}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Move to collection">
              <FolderInput className="mr-1 h-3.5 w-3.5" />
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {collections
                .filter((c) => c.status === "active")
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={onClear}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ---------------- Collections tab ----------------
function CollectionsTab({
  canManage,
  onCreate,
}: {
  canManage: boolean;
  onCreate: () => void;
}) {
  const nav = useNavigate();
  const { data, isLoading, isError, error, refetch } = useKbCollections();
  const collections = data?.collections ?? [];

  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load collections</div>
          <div className="max-w-md text-sm text-muted-foreground">{(error as Error)?.message}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </Card>
    );
  }
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }
  if (collections.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No collections yet"
          body="Create a collection to start curating knowledge — it pins the corpus that flows to Copilot and the voice agents."
          action={
            canManage ? (
              <Button size="sm" onClick={onCreate}>
                <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                Create collection
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {collections.map((c) => (
        <button
          key={c.id}
          className="flex flex-col rounded-lg border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-muted/20"
          onClick={() => nav(`/knowledge/collections/${c.id}`)}
        >
          <div className="flex items-center justify-between">
            <span className="font-semibold">{c.name}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">{CORPUS_LABELS[c.corpus]}</span>
            {c.status === "deprecated" && (
              <span className="rounded bg-muted px-1.5 py-0.5">deprecated</span>
            )}
          </div>
          {c.description && (
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>
          )}
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span className="tabular-nums">{c.sourceCount} sources</span>
            <span className="tabular-nums">{c.docCount} docs</span>
            <span className="tabular-nums">{c.retrievals7d} retr/7d</span>
          </div>
          {c.updatedAt && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Updated {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

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
