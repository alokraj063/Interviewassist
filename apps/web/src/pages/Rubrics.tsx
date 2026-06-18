// Rubrics list — server-side filter/search/sort/keyset pagination reflected in
// the URL, a multi-select bulk bar, permission-gated authoring CTA, and four
// distinct states (loading / first-run-empty / filtered-to-zero / error).
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Star,
  X,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  PURPOSE_LABELS,
  useBulkRubrics,
  useCreateRubric,
  useDuplicateRubric,
  useImportRubric,
  useRubricList,
  type RubricAppliesTo,
  type RubricListParams,
  type RubricListRow,
  type RubricPurpose,
  type RubricStatus,
} from "@/hooks/useRubrics";
import { CreateRubricDialog, type CreateRubricValues } from "@/components/rubrics/CreateRubricDialog";
import { RubricBulkBar } from "@/components/rubrics/RubricBulkBar";

const STATUS_BADGE: Record<RubricStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-emerald-100 text-emerald-700",
  archived: "bg-zinc-200 text-zinc-600",
};

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Rubrics() {
  const nav = useNavigate();
  const canWrite = useCan("rubrics.write");
  const [params, setParams] = useSearchParams();

  // ---- URL-synced filter state ----
  const q = params.get("q") ?? "";
  const status = (params.get("status") as RubricStatus | null) ?? undefined;
  const purpose = (params.get("purpose") as RubricPurpose | null) ?? undefined;
  const appliesTo = (params.get("appliesTo") as RubricAppliesTo | null) ?? undefined;
  const isDefault = params.get("isDefault") === "true" ? true : undefined;
  const sort = (params.get("sort") as RubricListParams["sort"]) ?? "updatedAt";
  const dir = (params.get("dir") as "asc" | "desc") ?? "desc";
  const cursor = params.get("cursor") ?? undefined;

  // Debounced search input mirrored to the URL.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => setSearchInput(q), [q]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onSearchChange(v: string) {
    setSearchInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setParam("q", v || null, true);
    }, 300);
  }

  function setParam(key: string, value: string | null, resetCursor = false) {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    if (resetCursor) next.delete("cursor");
    setParams(next, { replace: true });
  }

  function clearFilters() {
    const next = new URLSearchParams();
    if (sort !== "updatedAt") next.set("sort", sort);
    if (dir !== "desc") next.set("dir", dir);
    setParams(next, { replace: true });
  }

  // ---- cursor stack for prev/next ----
  const cursorStackRef = useRef<string[]>([]);

  const listParams: RubricListParams = { q: q || undefined, status, purpose, appliesTo, isDefault, sort, dir, cursor, limit: 25 };
  const { data, isLoading, isError, error, refetch, isFetching } = useRubricList(listParams);

  // ---- mutations ----
  const create = useCreateRubric();
  const duplicate = useDuplicateRubric();
  const bulk = useBulkRubrics();
  const importMut = useImportRubric();
  const [createOpen, setCreateOpen] = useState(false);

  // ---- selection ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = useMemo(() => data?.rubrics ?? [], [data]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }

  const hasFilters = !!(q || status || purpose || appliesTo || isDefault);
  const fileRef = useRef<HTMLInputElement>(null);

  const metrics = data?.metrics;
  const total = data?.total ?? 0;
  const showingFrom = total === 0 ? 0 : cursorStackRef.current.length * 25 + 1;
  const showingTo = cursorStackRef.current.length * 25 + rows.length;

  const templates = useMemo(() => rows.filter((r) => r.status !== "archived"), [rows]);

  // ---- handlers ----
  async function handleCreate(values: CreateRubricValues) {
    try {
      let criteria;
      if (values.templateId) {
        const tpl = rows.find((r) => r.id === values.templateId);
        criteria = tpl?.criteria;
      }
      const res = await create.mutateAsync({
        name: values.name,
        purpose: values.purpose,
        description: values.description,
        appliesTo: values.appliesTo,
        criteria,
        idempotencyKey: values.idempotencyKey,
      });
      setCreateOpen(false);
      toast.success("Rubric created");
      nav(`/rubrics/${res.rubric.id}`);
    } catch (err) {
      toast.error("Couldn't create rubric", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function runBulk(action: "archive" | "set_default" | "export", appliesToVal?: RubricAppliesTo) {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const res = await bulk.mutateAsync(
        appliesToVal
          ? { ids, action: "set_applies_to", payload: { appliesTo: [appliesToVal] } }
          : { ids, action },
      );
      if (action === "export" && !appliesToVal && res.exported) {
        downloadJson(`rubrics-export-${Date.now()}.json`, res.exported);
      }
      if (res.failed.length) {
        toast.warning(`${res.ok.length} updated, ${res.failed.length} skipped`, {
          description: res.failed.map((f) => `${f.id.slice(0, 8)}: ${f.reason}`).join(", "),
        });
      } else {
        toast.success(`${res.ok.length} rubric(s) updated`);
      }
      setSelected(new Set());
    } catch (err) {
      toast.error("Bulk action failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      const doc = JSON.parse(text);
      const docs = Array.isArray(doc) ? doc : [doc];
      for (const d of docs) {
        await importMut.mutateAsync({
          name: d.name ?? "Imported rubric",
          purpose: d.purpose ?? "general_screen",
          appliesTo: d.appliesTo ?? ["call"],
          description: d.description,
          criteria: d.criteria ?? [],
        });
      }
      toast.success(`Imported ${docs.length} rubric(s)`);
    } catch (err) {
      toast.error("Import failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  function goNext() {
    if (!data?.nextCursor) return;
    cursorStackRef.current.push(cursor ?? "");
    setParam("cursor", data.nextCursor);
  }
  function goPrev() {
    const prev = cursorStackRef.current.pop();
    setParam("cursor", prev && prev.length ? prev : null);
  }

  return (
    <div>
      <PageHeader
        title="Rubrics"
        subtitle="Weighted, behaviorally-anchored scoring rubrics. Publish an immutable version that downstream call, coaching, and voice-agent scorers pin to."
        actions={
          <div className="flex items-center gap-2">
            {!canWrite && (
              <Badge variant="outline" className="text-muted-foreground">
                Read-only
              </Badge>
            )}
            {canWrite && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleImportFile(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  Import
                </Button>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> New rubric
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-4">
        {/* Metrics from server aggregates */}
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Total" value={total} />
          <MetricCard label="Published" value={metrics?.published ?? "—"} />
          <MetricCard label="Defaults" value={metrics?.defaults ?? "—"} accent={(metrics?.defaults ?? 0) > 0 ? "success" : "default"} />
          <MetricCard label="Times scored" value={metrics?.timesScored ?? "—"} />
        </div>

        {/* Filter bar */}
        <Card>
          <div className="p-3 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden />
              <Input
                aria-label="Search rubrics"
                placeholder="Search by name…"
                className="pl-8"
                value={searchInput}
                onChange={(e) => onSearchChange(e.target.value)}
              />
            </div>
            <Select value={status ?? "all"} onValueChange={(v) => setParam("status", v === "all" ? null : v, true)}>
              <SelectTrigger className="w-[140px]" aria-label="Filter status"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
            <Select value={purpose ?? "all"} onValueChange={(v) => setParam("purpose", v === "all" ? null : v, true)}>
              <SelectTrigger className="w-[160px]" aria-label="Filter purpose"><SelectValue placeholder="Purpose" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All purposes</SelectItem>
                {(Object.keys(PURPOSE_LABELS) as RubricPurpose[]).map((p) => (
                  <SelectItem key={p} value={p}>{PURPOSE_LABELS[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={`${sort}:${dir}`} onValueChange={(v) => { const [s, d] = v.split(":"); setParam("sort", s, true); setParam("dir", d, true); }}>
              <SelectTrigger className="w-[170px]" aria-label="Sort">
                <ArrowUpDown className="w-3.5 h-3.5 mr-1.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updatedAt:desc">Recently updated</SelectItem>
                <SelectItem value="name:asc">Name A–Z</SelectItem>
                <SelectItem value="name:desc">Name Z–A</SelectItem>
                <SelectItem value="timesUsed:desc">Most used</SelectItem>
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="w-3.5 h-3.5 mr-1" /> Clear filters
              </Button>
            )}
          </div>
        </Card>

        {/* Bulk bar */}
        {selected.size > 0 && (
          <RubricBulkBar
            count={selected.size}
            busy={bulk.isPending}
            onClear={() => setSelected(new Set())}
            onArchive={() => void runBulk("archive")}
            onSetDefault={() => void runBulk("set_default")}
            onExport={() => void runBulk("export")}
            onSetAppliesTo={(v) => void runBulk("export", v)}
          />
        )}

        {/* States */}
        {isLoading ? (
          <Card>
            <div className="p-4 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </Card>
        ) : isError ? (
          <Card>
            <div className="p-8 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="w-8 h-8 text-destructive" aria-hidden />
              <div className="text-sm font-medium">Couldn't load rubrics</div>
              <div className="text-xs text-muted-foreground max-w-md">
                {error instanceof Error ? error.message : "Something went wrong."}
              </div>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
            </div>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <div className="p-10 flex flex-col items-center gap-3 text-center">
              {hasFilters ? (
                <>
                  <div className="text-sm font-medium">No rubrics match these filters</div>
                  <div className="text-xs text-muted-foreground">Try a different search or status.</div>
                  <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>
                </>
              ) : (
                <>
                  <div className="text-sm font-medium">No rubrics yet</div>
                  <div className="text-xs text-muted-foreground">Create your first scoring rubric to start grading calls.</div>
                  {canWrite && (
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> Create your first rubric
                    </Button>
                  )}
                </>
              )}
            </div>
          </Card>
        ) : (
          <Card>
            <table className="data-table">
              <thead>
                <tr>
                  {canWrite && (
                    <th className="w-8">
                      <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all" />
                    </th>
                  )}
                  <th>Name</th>
                  <th>Purpose</th>
                  <th>Status</th>
                  <th className="text-right">Criteria</th>
                  <th className="text-right">Times used</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <RubricListRowView
                    key={r.id}
                    rubric={r}
                    canWrite={canWrite}
                    selected={selected.has(r.id)}
                    onToggle={() => toggleSelect(r.id)}
                    onOpen={() => nav(`/rubrics/${r.id}`)}
                    onDuplicate={async () => {
                      try {
                        const res = await duplicate.mutateAsync(r.id);
                        toast.success("Duplicated");
                        nav(`/rubrics/${res.rubric.id}`);
                      } catch (err) {
                        toast.error("Duplicate failed", { description: err instanceof Error ? err.message : String(err) });
                      }
                    }}
                  />
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-border text-xs text-muted-foreground">
              <div>
                Showing <span className="tabular-nums">{showingFrom}</span>–<span className="tabular-nums">{showingTo}</span> of{" "}
                <span className="tabular-nums">{total}</span>
                {isFetching && <span className="ml-2 opacity-60">updating…</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={cursorStackRef.current.length === 0} onClick={goPrev}>
                  <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
                </Button>
                <Button size="sm" variant="outline" disabled={!data?.nextCursor} onClick={goNext}>
                  Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      <CreateRubricDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        templates={templates}
        submitting={create.isPending}
        onSubmit={(v) => void handleCreate(v)}
      />
    </div>
  );
}

function RubricListRowView({
  rubric: r,
  canWrite,
  selected,
  onToggle,
  onOpen,
  onDuplicate,
}: {
  rubric: RubricListRow;
  canWrite: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
}) {
  return (
    <tr className={selected ? "bg-primary/5" : undefined}>
      {canWrite && (
        <td onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${r.name}`} />
        </td>
      )}
      <td>
        <button
          type="button"
          className="text-left text-sm font-medium hover:underline focus:underline focus:outline-none"
          onClick={onOpen}
        >
          {r.name}
        </button>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          v{r.version}
          {r.isDefault && (
            <span className="inline-flex items-center gap-0.5 text-emerald-600">
              <Star className="w-3 h-3 fill-current" aria-hidden /> Default
            </span>
          )}
        </div>
      </td>
      <td className="text-sm capitalize">{PURPOSE_LABELS[r.purpose]}</td>
      <td>
        <Badge className={STATUS_BADGE[r.status]} variant="secondary">
          {r.status}
        </Badge>
      </td>
      <td className="text-right tabular-nums">{r.criteria.length}</td>
      <td className="text-right tabular-nums">{r.timesUsed}</td>
      <td className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(r.updatedAt), { addSuffix: true })}</td>
      <td className="text-right">
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={onDuplicate}>Duplicate</Button>
        )}
      </td>
    </tr>
  );
}
