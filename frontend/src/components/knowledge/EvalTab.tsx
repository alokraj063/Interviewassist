import { useState } from "react";
import { Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Play, AlertCircle, RotateCcw, Loader2, Lock, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import {
  useEvalSuites,
  useCreateSuite,
  useAddEvalCase,
  useRunEval,
  useEvalRun,
  KB_CORPORA,
  CORPUS_LABELS,
  type KbEvalSuite,
  type KbCorpus,
} from "@/hooks/useKnowledge";

function pct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export function EvalTab({ canEval }: { canEval: boolean }) {
  const { data, isLoading, isError, error, refetch } = useEvalSuites();
  const [createOpen, setCreateOpen] = useState(false);
  const [activeSuite, setActiveSuite] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  const suites = data?.suites ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Golden test queries with an expected source. Runs compute hit-rate, MRR and citation
          accuracy against the live retriever.
        </p>
        {canEval ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New suite
          </Button>
        ) : (
          <Button size="sm" disabled title="Requires knowledge.eval">
            <Lock className="mr-1.5 h-3.5 w-3.5" /> New suite
          </Button>
        )}
      </div>

      <Card>
        {isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
            <div className="text-sm font-semibold">Couldn't load eval suites</div>
            <div className="max-w-md text-sm text-muted-foreground">{(error as Error)?.message}</div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : isLoading ? (
          <div className="divide-y divide-border">
            {[0, 1].map((i) => (
              <div key={i} className="p-4">
                <Skeleton className="h-5 w-1/2" />
              </div>
            ))}
          </div>
        ) : suites.length === 0 ? (
          <EmptyState
            title="No eval suites yet"
            body="Create a suite of golden queries to measure retrieval quality over time."
            action={
              canEval ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> New suite
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {suites.map((s) => (
              <SuiteRow
                key={s.id}
                suite={s}
                canEval={canEval}
                onOpen={() => setActiveSuite(s.id)}
                onRan={(runId) => {
                  setLastRunId(runId);
                  setActiveSuite(null);
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      {lastRunId && <RunResult runId={lastRunId} />}

      <CreateSuiteDialog open={createOpen} onOpenChange={setCreateOpen} />
      {activeSuite && (
        <AddCaseDialog suiteId={activeSuite} open onOpenChange={() => setActiveSuite(null)} />
      )}
    </div>
  );
}

function SuiteRow({
  suite,
  canEval,
  onOpen,
  onRan,
}: {
  suite: KbEvalSuite;
  canEval: boolean;
  onOpen: () => void;
  onRan: (runId: string) => void;
}) {
  const run = useRunEval(suite.id);
  return (
    <li className="flex items-center justify-between gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{suite.name}</span>
          {suite.corpus && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {CORPUS_LABELS[suite.corpus]}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {suite.caseCount} case{suite.caseCount === 1 ? "" : "s"} · last hit-rate{" "}
          <span className="font-medium tabular-nums">{pct(suite.lastHitRate)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canEval && (
          <Button size="sm" variant="ghost" onClick={onOpen}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Case
          </Button>
        )}
        {canEval ? (
          <Button
            size="sm"
            variant="outline"
            disabled={run.isPending || suite.caseCount === 0}
            title={suite.caseCount === 0 ? "Add at least one case first" : undefined}
            onClick={() =>
              run.mutate(undefined, {
                onSuccess: (r) => {
                  toast.success(
                    r.usedRealEmbeddings
                      ? `Run complete — hit-rate ${pct(r.hitRate)}`
                      : `Run complete (stub embeddings) — hit-rate ${pct(r.hitRate)}`,
                  );
                  onRan(r.id);
                },
                onError: (e: Error) => {
                  const code = (e as { body?: { error?: string } }).body?.error;
                  toast.error(
                    code === "openai_key_missing"
                      ? "Live retrieval needs OPENAI_API_KEY — not configured."
                      : e.message,
                  );
                },
              })
            }
          >
            {run.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Run
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled title="Requires knowledge.eval">
            <Play className="mr-1.5 h-3.5 w-3.5" /> Run
          </Button>
        )}
      </div>
    </li>
  );
}

function RunResult({ runId }: { runId: string }) {
  const { data, isLoading } = useEvalRun(runId);
  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data) return null;
  const r = data.run;
  return (
    <Card title="Latest run">
      <div className="space-y-3 p-4">
        {!r.usedRealEmbeddings && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            Ran with stub embeddings — OPENAI_API_KEY not configured. Hit-rate is a lexical
            approximation; flagged for human verification.
          </div>
        )}
        <div className="grid grid-cols-3 gap-4">
          <Metric label="Hit-rate" value={pct(r.hitRate)} />
          <Metric label="MRR" value={r.mrr == null ? "—" : r.mrr.toFixed(2)} />
          <Metric label="Citation accuracy" value={pct(r.citationAccuracy)} />
        </div>
        <div className="divide-y divide-border rounded border border-border">
          {data.cases.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 truncate">{c.query}</span>
              <span
                className={c.hit ? "font-medium text-success" : "font-medium text-destructive"}
              >
                {c.hit ? `hit (rank ${c.rankOfExpected})` : "miss"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function CreateSuiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [corpus, setCorpus] = useState<KbCorpus | "any">("any");
  const create = useCreateSuite();
  const valid = name.trim().length >= 2;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New eval suite</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="suite-name" className="mb-1 block text-xs text-muted-foreground">
              Name
            </label>
            <Input id="suite-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. JD retrieval smoke" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Corpus (optional)</label>
            <Select value={corpus} onValueChange={(v) => setCorpus(v as KbCorpus | "any")}>
              <SelectTrigger aria-label="Corpus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {KB_CORPORA.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CORPUS_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), corpus: corpus === "any" ? undefined : corpus },
                {
                  onSuccess: () => {
                    toast.success("Suite created");
                    setName("");
                    onOpenChange(false);
                  },
                  onError: (e: Error) => toast.error(e.message),
                },
              )
            }
          >
            {create.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Create suite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddCaseDialog({
  suiteId,
  open,
  onOpenChange,
}: {
  suiteId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [snippet, setSnippet] = useState("");
  const add = useAddEvalCase(suiteId);
  const valid = query.trim().length >= 2;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add test case</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="case-query" className="mb-1 block text-xs text-muted-foreground">
              Query
            </label>
            <Input
              id="case-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. What is the notice period policy?"
            />
          </div>
          <div>
            <label htmlFor="case-snippet" className="mb-1 block text-xs text-muted-foreground">
              Expected snippet contains (optional)
            </label>
            <Input id="case-snippet" value={snippet} onChange={(e) => setSnippet(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || add.isPending}
            onClick={() =>
              add.mutate(
                { query: query.trim(), expectedSnippetContains: snippet.trim() || undefined },
                {
                  onSuccess: () => {
                    toast.success("Case added");
                    setQuery("");
                    setSnippet("");
                    onOpenChange(false);
                  },
                  onError: (e: Error) => toast.error(e.message),
                },
              )
            }
          >
            {add.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Add case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
