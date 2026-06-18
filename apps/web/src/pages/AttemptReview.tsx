import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, AlertTriangle, Loader2, Sparkles, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useCan } from "@/auth/AuthContext";
import {
  useAttemptDetail,
  useReviewAttempt,
  ITEM_TYPE_LABELS,
  AUTO_GRADABLE,
  type Item,
  type ItemType,
} from "@/hooks/useAssessments";

interface ItemResult {
  itemId: string;
  type: string;
  awarded: number;
  max: number;
  correct: boolean | null;
  autoGraded: boolean;
  selectedOptionIds?: string[];
  codeRun?: { passed: number; total: number; stderr?: string };
}

interface Response {
  itemId: string;
  selectedOptionIds?: string[];
  boolValue?: boolean;
  textValue?: string;
  codeValue?: string;
}

export default function AttemptReview() {
  const { id } = useParams<{ id: string }>();
  const canReview = useCan("assessments.review");
  const { data, isLoading, isError, error, refetch } = useAttemptDetail(id);
  const review = useReviewAttempt(id ?? "");

  const [manualScores, setManualScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, { suggested: number | null; rationale: string | null }>>({});
  const [aiLoading, setAiLoading] = useState(false);

  const snapshotItems: Item[] = useMemo(() => data?.version?.snapshot.items ?? [], [data]);
  const itemResults: ItemResult[] = useMemo(() => data?.attempt.itemResults ?? [], [data]);
  const responses: Response[] = useMemo(() => (data?.attempt.responses as Response[]) ?? [], [data]);
  const subjective = useMemo(
    () => snapshotItems.filter((it) => !AUTO_GRADABLE.includes(it.type)),
    [snapshotItems],
  );

  const respById = useMemo(() => new Map(responses.map((r) => [r.itemId, r])), [responses]);
  const resultById = useMemo(() => new Map(itemResults.map((r) => [r.itemId, r])), [itemResults]);

  const runAiAssist = async () => {
    if (!id) return;
    setAiLoading(true);
    try {
      const res = await apiFetch<{ suggestions: Array<{ itemId: string; suggested: number | null; rationale: string | null }> }>(
        `/api/assessments/attempts/${id}/ai-assist`,
        { method: "POST" },
      );
      const map: Record<string, { suggested: number | null; rationale: string | null }> = {};
      for (const s of res.suggestions) map[s.itemId] = { suggested: s.suggested, rationale: s.rationale };
      setAiSuggestions(map);
      toast.success("AI suggestions ready — review before applying");
    } catch (err) {
      const code = (err as { body?: { error?: string } })?.body?.error;
      if (code === "openai_key_missing") {
        toast.warning("AI assist unavailable — score manually.", { description: "OPENAI_API_KEY is not configured." });
      } else {
        toast.error("Couldn't fetch AI suggestions", { description: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setAiLoading(false);
    }
  };

  const submitReview = async () => {
    const itemScores = Object.entries(manualScores)
      .filter(([, v]) => v.trim() !== "")
      .map(([itemId, v]) => ({ itemId, awarded: Number(v) }));
    try {
      await review.mutateAsync({ itemScores, reviewerNotes: notes || undefined });
      toast.success("Review saved");
      await refetch();
    } catch (err) {
      toast.error("Couldn't save review", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10 flex flex-col items-center gap-3 text-sm">
        <AlertTriangle className="w-7 h-7 text-destructive" />
        <div className="text-destructive">
          {(error as { body?: { error?: string } })?.body?.error ?? "Attempt not found."}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { attempt } = data;
  const candidateName = data.candidate?.displayName ?? "Candidate";

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/assessments?tab=attempts" className="text-muted-foreground hover:text-foreground" aria-label="Back to attempts">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            Review · {candidateName}
          </span>
        }
        subtitle={data.template ? `${data.template.title} · status ${attempt.status}` : undefined}
        actions={
          canReview && subjective.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => void runAiAssist()} disabled={aiLoading}>
              {aiLoading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
              AI score assist
            </Button>
          ) : undefined
        }
      />

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <Metric label="Auto score" value={attempt.autoScore == null ? "—" : attempt.autoScore} />
          <Metric label="Manual score" value={attempt.manualScore == null ? "—" : attempt.manualScore} />
          <Metric label="Total %" value={attempt.totalScore == null ? "—" : `${attempt.totalScore}%`} />
          <Metric
            label="Result"
            value={
              attempt.pass == null ? (
                "—"
              ) : attempt.pass ? (
                <span className="text-success inline-flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Pass{attempt.passBand ? ` · ${attempt.passBand}` : ""}</span>
              ) : (
                <span className="text-destructive inline-flex items-center gap-1"><XCircle className="w-4 h-4" /> Fail</span>
              )
            }
          />
        </div>

        <Card title="Responses">
          {snapshotItems.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No pinned version snapshot for this attempt.</div>
          ) : (
            <ul className="divide-y divide-border">
              {snapshotItems.map((it, i) => {
                const r = resultById.get(it.id);
                const resp = respById.get(it.id);
                const manual = !AUTO_GRADABLE.includes(it.type);
                const suggestion = aiSuggestions[it.id];
                return (
                  <li key={it.id} className="px-4 py-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        Q{i + 1} · {ITEM_TYPE_LABELS[it.type as ItemType]} · {r ? `${r.awarded}/${r.max}` : `0/${it.points}`} pt
                      </span>
                      {r?.autoGraded ? (
                        <span className={cn("pill text-[10px]", r.correct ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")}>
                          {r.correct ? "correct" : "incorrect"} · auto
                        </span>
                      ) : (
                        <span className="pill text-[10px] bg-muted text-muted-foreground">manual</span>
                      )}
                    </div>
                    <div className="text-sm font-medium">{it.prompt}</div>
                    <ResponseView item={it} response={resp} result={r} />

                    {manual && canReview && attempt.status !== "revoked" && (
                      <div className="flex items-end gap-3 pt-1">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`score-${it.id}`}>
                            Award (max {it.points})
                          </Label>
                          <Input
                            id={`score-${it.id}`}
                            type="number"
                            min={0}
                            max={it.points}
                            className="w-28 h-8"
                            value={manualScores[it.id] ?? (r ? String(r.awarded) : "")}
                            onChange={(e) => setManualScores((s) => ({ ...s, [it.id]: e.target.value }))}
                          />
                        </div>
                        {suggestion && (
                          <div className="text-xs text-muted-foreground pb-1">
                            <span className="font-medium text-foreground">AI suggestion (review required):</span>{" "}
                            {suggestion.suggested == null ? "unavailable" : `${suggestion.suggested}/${it.points}`}
                            {suggestion.rationale ? ` — ${suggestion.rationale}` : ""}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {canReview && attempt.status !== "revoked" && (
          <Card title="Reviewer decision">
            <div className="p-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="reviewer-notes">Notes</Label>
                <Textarea
                  id="reviewer-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Summary, follow-up, or rationale…"
                  rows={3}
                />
              </div>
              <Button onClick={() => void submitReview()} disabled={review.isPending}>
                {review.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
                Save review & recompute score
              </Button>
            </div>
          </Card>
        )}
        {!canReview && (
          <p className="text-xs text-muted-foreground">Read-only — reviewing requires assessments.review.</p>
        )}
      </div>
    </div>
  );
}

function ResponseView({ item, response, result }: { item: Item; response: Response | undefined; result: ItemResult | undefined }) {
  if (!response) return <div className="text-xs text-muted-foreground italic">No response.</div>;
  if (item.type === "mcq_single" || item.type === "mcq_multi") {
    const options = (item.config.options as Array<{ id: string; label: string; correct: boolean }>) ?? [];
    const selected = new Set(response.selectedOptionIds ?? []);
    return (
      <div className="space-y-1">
        {options.map((o) => (
          <div key={o.id} className={cn("text-sm flex items-center gap-2", selected.has(o.id) && "font-medium")}>
            <span className={cn("w-3 h-3 rounded-full border", selected.has(o.id) ? "bg-primary border-primary" : "border-muted-foreground/40")} />
            <span className={cn(o.correct && "text-success")}>{o.label}</span>
            {o.correct && <span className="text-[10px] text-success">key</span>}
          </div>
        ))}
      </div>
    );
  }
  if (item.type === "true_false") {
    return <div className="text-sm">Answered: <span className="font-medium">{response.boolValue == null ? "—" : response.boolValue ? "True" : "False"}</span></div>;
  }
  if (item.type === "coding") {
    return (
      <div className="space-y-1.5">
        <pre className="rounded border border-border bg-muted/30 px-2 py-2 text-xs font-mono overflow-x-auto max-h-48">{response.codeValue || "(no code)"}</pre>
        {result?.codeRun && (
          <div className="text-xs text-muted-foreground">
            Tests: {result.codeRun.passed}/{result.codeRun.total} passed
            {result.codeRun.stderr ? ` · ${result.codeRun.stderr.slice(0, 120)}` : ""}
          </div>
        )}
      </div>
    );
  }
  // short / long / file / video → text
  return <div className="text-sm whitespace-pre-wrap rounded border border-border bg-muted/20 px-2 py-2">{response.textValue || "(empty)"}</div>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
