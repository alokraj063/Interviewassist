// Question Bank detail — bank header + paginated/filtered/sorted question
// table (URL-synced) + bulk actions + import/export/recalibrate + activity feed.
// Replaces the old inline hardcoded-stub "Add question". Permission-gated.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  Upload,
  Download,
  RefreshCw,
  AlertCircle,
  RotateCcw,
  X,
  Loader2,
  Lock,
  ChevronRight,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useBank,
  useBankQuestions,
  useBankActivity,
  useRecalibrate,
  useGenerateAi,
  bankExportPath,
  STATUS_LABELS,
  QUESTION_STATUSES,
  QUESTION_TYPE_LABELS,
  QUESTION_TYPES,
  LANGUAGE_LABELS,
  QUESTION_LANGUAGES,
  QUESTION_LEVELS,
  type QuestionRow,
} from "@/hooks/useQuestionBanks";
import {
  filtersFromParams,
  activeFilterCount,
  clearFilters,
  SORT_LABELS,
  QUESTION_SORTS,
  type QuestionSort,
} from "@/lib/questionBankFilters";
import { getApiBase, getAccessToken } from "@/lib/api";
import { StatusBadge } from "@/components/question-bank/StatusBadge";
import { CalibrationBadge } from "@/components/question-bank/CalibrationBadge";
import { QuestionEditorDialog } from "@/components/question-bank/QuestionEditorDialog";
import { ImportDialog } from "@/components/question-bank/ImportDialog";
import { BulkActionBar } from "@/components/question-bank/BulkActionBar";

const PAGE_LIMIT = 25;

export default function QuestionBankDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("question_banks.write");
  const canApprove = useCan("question_banks.approve");
  const [params, setParams] = useSearchParams();

  const [tab, setTab] = useState<"questions" | "activity">("questions");
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<QuestionRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursors, setCursors] = useState<string[]>([]);
  const [accumulated, setAccumulated] = useState<QuestionRow[]>([]);

  // Local search box mirrors ?q with a 300ms debounce into the URL.
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
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

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const sort = (params.get("sort") as QuestionSort) ?? "created_desc";
  const cursor = cursors[cursors.length - 1];

  const bankQ = useBank(id);
  const { data, isLoading, isError, error, refetch, isFetching } = useBankQuestions(id, {
    ...filters,
    limit: PAGE_LIMIT,
    cursor,
  });
  const activityQ = useBankActivity(tab === "activity" ? id : undefined);
  const recalibrate = useRecalibrate();
  const generate = useGenerateAi(id ?? "");

  // Reset pagination + selection whenever filters/sort change.
  const paramsKey = params.toString();
  useEffect(() => {
    setCursors([]);
    setAccumulated([]);
    setSelected(new Set());
  }, [paramsKey]);

  // Accumulate keyset pages (only on the created_desc path which yields a cursor).
  useEffect(() => {
    if (!data) return;
    setAccumulated((prev) => {
      if (cursors.length === 0) return data.questions;
      const seen = new Set(prev.map((q) => q.id));
      return [...prev, ...data.questions.filter((q) => !seen.has(q.id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const rows = accumulated;
  const total = data?.totalApprox ?? 0;
  const nextCursor = data?.nextCursor ?? null;
  const filterCount = activeFilterCount(filters);

  function patchParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (!value || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function toggleSelect(qid: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(qid)) n.delete(qid);
      else n.add(qid);
      return n;
    });
  }

  function exportCsv() {
    const url = `${getApiBase()}${bankExportPath(id!)}`;
    const token = getAccessToken();
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`Export failed (${r.status})`);
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `question-bank-${id}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success("Export downloaded");
      })
      .catch((e: Error) => toast.error(e.message));
  }

  if (bankQ.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (bankQ.isError || !bankQ.data) {
    return (
      <div className="p-10">
        <EmptyState
          title="Question bank not found"
          body="It may have been deleted or you don't have access."
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/question-banks")}>
              Back to banks
            </Button>
          }
        />
      </div>
    );
  }

  const bank = bankQ.data;

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Question Banks", href: "/question-banks" }, { label: bank.name }]}
        title={bank.name}
        subtitle={bank.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={recalibrate.isPending}
              onClick={() =>
                recalibrate.mutate(undefined, {
                  onSuccess: (r) => toast.success(`Recalibrated ${r.recalibrated} questions`),
                  onError: (e: Error) => toast.error(e.message),
                })
              }
            >
              {recalibrate.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Recalibrate
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export
            </Button>
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Import
              </Button>
            )}
            {canWrite ? (
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add question
              </Button>
            ) : (
              <Button size="sm" disabled title="Requires question_banks.write">
                <Lock className="mr-1.5 h-3.5 w-3.5" />
                Add question
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Total" value={bank.counts.total} />
          <MetricCard label="Approved" value={bank.counts.approved} accent="success" />
          <MetricCard
            label="In review"
            value={bank.counts.inReview}
            accent={bank.counts.inReview > 0 ? "warning" : "default"}
          />
          <MetricCard label="Drafts" value={bank.counts.draft} />
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "questions" | "activity")}>
          <TabsList>
            <TabsTrigger value="questions">Questions</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="questions" className="space-y-4">
            {/* Filter / search / sort row */}
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search prompts…"
                  className="pl-8"
                  aria-label="Search questions"
                />
              </div>
              <FilterSelect
                label="Status"
                value={filters.status}
                onChange={(v) => patchParam("status", v)}
                options={QUESTION_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
              />
              <FilterSelect
                label="Level"
                value={filters.level}
                onChange={(v) => patchParam("level", v)}
                options={QUESTION_LEVELS.map((l) => ({ value: l, label: l }))}
              />
              <FilterSelect
                label="Type"
                value={filters.questionType}
                onChange={(v) => patchParam("questionType", v)}
                options={QUESTION_TYPES.map((t) => ({ value: t, label: QUESTION_TYPE_LABELS[t] }))}
              />
              <FilterSelect
                label="Language"
                value={filters.language}
                onChange={(v) => patchParam("language", v)}
                options={QUESTION_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))}
              />
              <Select value={sort} onValueChange={(v) => patchParam("sort", v)}>
                <SelectTrigger className="w-[170px]" aria-label="Sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_SORTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SORT_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(filterCount > 0 || filters.q) && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  {filterCount + (filters.q ? 1 : 0)} filter(s) active
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  onClick={() => {
                    setSearchInput("");
                    setParams(clearFilters(params), { replace: true });
                  }}
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear all
                </Button>
              </div>
            )}

            <Card>
              {isError ? (
                <div className="flex flex-col items-center gap-3 p-12 text-center">
                  <AlertCircle className="h-7 w-7 text-destructive" />
                  <div className="text-sm font-semibold">Couldn't load questions</div>
                  <div className="max-w-md text-sm text-muted-foreground">
                    {(error as { body?: { error?: string } })?.body?.error ??
                      (error as Error)?.message}
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
              ) : rows.length === 0 && (filterCount > 0 || filters.q) ? (
                <EmptyState
                  title="No questions match these filters"
                  body="Adjust or clear the filters to see more."
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSearchInput("");
                        setParams(clearFilters(params), { replace: true });
                      }}
                    >
                      Clear all filters
                    </Button>
                  }
                />
              ) : rows.length === 0 ? (
                <EmptyState
                  title="No questions yet"
                  body="Author your first question, or import a CSV, to seed this bank."
                  action={
                    canWrite ? (
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditing(null);
                          setEditorOpen(true);
                        }}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add question
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
                    {rows.map((q) => (
                      <QuestionRowItem
                        key={q.id}
                        q={q}
                        selectable={canWrite}
                        selected={selected.has(q.id)}
                        onToggle={() => toggleSelect(q.id)}
                        onOpen={() => nav(`/question-banks/${id}/questions/${q.id}`)}
                        onEdit={
                          canWrite
                            ? () => {
                                setEditing(q);
                                setEditorOpen(true);
                              }
                            : undefined
                        }
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

            {!env_has_openai() && canWrite && (
              <button
                className="text-xs text-muted-foreground underline"
                onClick={() =>
                  generate.mutate(undefined, {
                    onError: (e: Error) => {
                      const code = (e as { body?: { error?: string } }).body?.error;
                      toast.error(
                        code === "openai_api_key_missing"
                          ? "AI generation needs OPENAI_API_KEY — not configured."
                          : e.message,
                      );
                    },
                    onSuccess: () => toast.success("AI draft requested"),
                  })
                }
              >
                Generate similar question with AI (beta)
              </button>
            )}
          </TabsContent>

          <TabsContent value="activity">
            <Card title="Activity">
              {activityQ.isLoading ? (
                <div className="space-y-2 p-4">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : (activityQ.data?.events.length ?? 0) === 0 ? (
                <EmptyState title="No activity yet" body="Bank and question changes appear here." />
              ) : (
                <ul className="divide-y divide-border">
                  {activityQ.data!.events.map((ev) => (
                    <li key={ev.id} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="font-medium">{ev.action.replace(/[._]/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(ev.createdAt), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {selected.size > 0 && (
        <BulkActionBar
          bankId={id!}
          selectedIds={[...selected]}
          canApprove={canApprove}
          onClear={() => setSelected(new Set())}
        />
      )}

      <QuestionEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        bankId={id!}
        bankDefaultLanguage={bank.defaultLanguage}
        editing={editing}
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} bankId={id!} />
    </div>
  );
}

// Whether the build embeds an OpenAI key is not exposed to the SPA; we always
// render the affordance and rely on the route's 503 to message degradation.
function env_has_openai(): boolean {
  return false;
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
      <SelectTrigger className="w-[140px]" aria-label={`Filter by ${label}`}>
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

function QuestionRowItem({
  q,
  selectable,
  selected,
  onToggle,
  onOpen,
  onEdit,
}: {
  q: QuestionRow;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onEdit?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 p-4 hover:bg-muted/20">
      {selectable && (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label="Select question"
          className="mt-1"
        />
      )}
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="flex items-center gap-2">
          <StatusBadge status={q.status} />
          <span className="text-xs text-muted-foreground">
            {q.level} · {QUESTION_TYPE_LABELS[q.questionType]} · diff {q.difficulty}
          </span>
          {q.roleFamily && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {q.roleFamily}
            </span>
          )}
        </div>
        <div className="mt-1 line-clamp-2 text-sm font-medium">{q.prompt}</div>
        <div className="mt-1.5">
          <CalibrationBadge
            calibratedDifficulty={q.calibratedDifficulty}
            authoredDifficulty={q.difficulty}
            exposureCount={q.exposureCount}
            overUsed={q.overUsed}
          />
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {onEdit && (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
        )}
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onOpen} aria-label="Open question">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
