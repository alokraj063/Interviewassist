// Question Banks — governed item-library list (enterprise rebuild).
//
// A recruiting-ops lead lands here to create, search, filter (active/archived),
// archive/restore, and drill into banks. Metrics are derived from live API
// counts (no hardcoded/illustrative values). Write controls are permission-
// gated via useCan("question_banks.write"); the page renders read-only without
// it (never blank). States: loading (skeletons) / error (server msg + retry) /
// first-run empty (distinct + enabled CTA) / filtered-to-zero (clear chip).
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Library,
  Search,
  Archive,
  RotateCcw,
  AlertCircle,
  ClipboardCheck,
  Lock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useBanks,
  useArchiveBank,
  useRestoreBank,
  LANGUAGE_LABELS,
  type BankRow,
  type QuestionLanguage,
} from "@/hooks/useQuestionBanks";
import { CreateBankDialog } from "@/components/question-bank/CreateBankDialog";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function QuestionBanks() {
  const nav = useNavigate();
  const canWrite = useCan("question_banks.write");
  const canApprove = useCan("question_banks.approve");
  const [params, setParams] = useSearchParams();

  const status = params.get("status") ?? "active";
  const search = params.get("q") ?? "";
  const debouncedSearch = useDebounced(search, 300);

  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useBanks({
    status: status === "all" ? undefined : status,
    q: debouncedSearch || undefined,
    limit: 50,
  });

  const archive = useArchiveBank();
  const restore = useRestoreBank();

  const banks = data?.banks ?? [];
  const totalQuestions = banks.reduce((s, b) => s + b.questionCount, 0);
  const linked = banks.reduce((s, b) => s + b.linkedDemandsCount, 0);
  const skillsCovered = banks.reduce((s, b) => s + b.skillsCovered, 0);

  const filtersActive = status !== "active" || debouncedSearch.length > 0;

  function patchParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (!value || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Question Banks"
        subtitle="Curate, tag, calibrate, and govern technical screening questions — feeding Live Assist suggestions and Assessment authoring from a trusted, versioned corpus."
        actions={
          <div className="flex items-center gap-2">
            {canApprove && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/question-banks/review-queue">
                  <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
                  Review queue
                </Link>
              </Button>
            )}
            {canWrite ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New bank
              </Button>
            ) : (
              <Button size="sm" disabled title="Requires question_banks.write">
                <Lock className="mr-1.5 h-3.5 w-3.5" />
                New bank
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {isLoading ? (
            <>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
              ))}
            </>
          ) : (
            <>
              <MetricCard label="Banks (this view)" value={banks.length} />
              <MetricCard label="Questions" value={totalQuestions} />
              <MetricCard label="Linked demands" value={linked} hint="Banks attached to ≥1 demand" />
              <MetricCard
                label="Skills covered"
                value={skillsCovered}
                hint="Distinct tagged skills"
              />
            </>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => patchParam("q", e.target.value)}
              placeholder="Search banks by name…"
              className="pl-8"
              aria-label="Search question banks"
            />
          </div>
          <Select value={status} onValueChange={(v) => patchParam("status", v === "active" ? undefined : v)}>
            <SelectTrigger className="w-[150px]" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isError ? (
          <Card>
            <div className="flex flex-col items-center gap-3 p-12 text-center">
              <AlertCircle className="h-7 w-7 text-destructive" />
              <div className="text-sm font-semibold">Couldn't load question banks</div>
              <div className="max-w-md text-sm text-muted-foreground">
                {(error as { body?: { error?: string } })?.body?.error ??
                  (error as Error)?.message ??
                  "Unexpected error."}
              </div>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          </Card>
        ) : isLoading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[120px] w-full rounded-lg" />
            ))}
          </div>
        ) : banks.length === 0 && filtersActive ? (
          <Card>
            <div className="p-12 text-center">
              <Search className="mx-auto mb-3 h-7 w-7 opacity-40" />
              <div className="text-sm font-semibold">No banks match these filters</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Try a different search or status.
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => setParams(new URLSearchParams(), { replace: true })}
              >
                Clear filters
              </Button>
            </div>
          </Card>
        ) : banks.length === 0 ? (
          <Card>
            <div className="p-12 text-center">
              <Library className="mx-auto mb-3 h-7 w-7 opacity-40" />
              <div className="text-sm font-semibold">No question banks yet</div>
              <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Create your first bank of technical questions to power Live Assist suggestions and
                post-call evaluation.
              </div>
              {canWrite ? (
                <Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Create your first bank
                </Button>
              ) : (
                <div className="mt-4 text-xs text-muted-foreground">
                  You need the question_banks.write permission to create a bank.
                </div>
              )}
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {banks.map((b) => (
              <BankCard
                key={b.id}
                bank={b}
                canWrite={canWrite}
                busy={isFetching}
                onOpen={() => nav(`/question-banks/${b.id}`)}
                onArchive={() =>
                  archive.mutate(b.id, {
                    onSuccess: () => toast.success("Bank archived"),
                    onError: (e: Error) => toast.error(e.message),
                  })
                }
                onRestore={() =>
                  restore.mutate(b.id, {
                    onSuccess: () => toast.success("Bank restored"),
                    onError: (e: Error) => toast.error(e.message),
                  })
                }
              />
            ))}
          </div>
        )}
      </div>

      <CreateBankDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => nav(`/question-banks/${id}`)}
      />
    </div>
  );
}

function BankCard({
  bank,
  canWrite,
  busy,
  onOpen,
  onArchive,
  onRestore,
}: {
  bank: BankRow;
  canWrite: boolean;
  busy: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <Card>
      <div className="p-5">
        <button onClick={onOpen} className="block w-full text-left">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold">{bank.name}</span>
                {bank.status === "archived" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    <Archive className="h-3 w-3" aria-hidden /> Archived
                  </span>
                )}
              </div>
              {bank.description && (
                <div className="mt-0.5 text-sm text-muted-foreground">{bank.description}</div>
              )}
            </div>
            <Library className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              <span className="font-medium text-foreground">{bank.questionCount}</span> questions
            </span>
            <span className="tabular-nums">
              <span className="font-medium text-foreground">{bank.skillsCovered}</span> skills
            </span>
            <span className="tabular-nums">
              <span className="font-medium text-foreground">{bank.linkedDemandsCount}</span> linked
            </span>
            <span>{LANGUAGE_LABELS[bank.defaultLanguage as QuestionLanguage] ?? bank.defaultLanguage}</span>
            <span className="ml-auto">
              Updated {formatDistanceToNow(new Date(bank.updatedAt), { addSuffix: true })}
            </span>
          </div>
        </button>
        {canWrite && (
          <div className="mt-3 flex justify-end border-t border-border pt-3">
            {bank.status === "archived" ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRestore}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Restore
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={onArchive}>
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                Archive
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
