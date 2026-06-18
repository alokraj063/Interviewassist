// Coaching run results — overall + per-criterion score bars (from
// coaching_run_scores), strengths/gaps, coach note, AI-labelled badge, manager
// override control (coaching.manage), call-detail link, and live scoring-status
// states (pending/scoring/failed-retry). The page polls while scoring is pending.
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  ChevronLeft,
  Loader2,
  Sparkles,
  AlertCircle,
  RotateCcw,
  CheckCircle2,
  FileText,
} from "lucide-react";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useCan } from "@/auth/AuthContext";
import { useRun, useScoreRun, useOverrideScore, type RunScore } from "@/hooks/useCoaching";
import { ScoreBars } from "@/components/coaching/ScoreBars";
import { ActivityTimeline } from "@/components/coaching/ActivityTimeline";

export default function SimulationResults() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const runId = search.get("runId");
  const nav = useNavigate();
  const canManage = useCan("coaching.manage");

  const poll = true;
  const { data, isLoading, isError, refetch } = useRun(runId ?? undefined, { poll });
  const rescore = useScoreRun();
  const [override, setOverride] = useState<RunScore | null>(null);

  // Stop polling once scored/failed by disabling refetchInterval via a guard.
  const scoringStatus = data?.run.scoringStatus;
  const stillScoring = scoringStatus === "pending" || scoringStatus === "scoring";

  if (!runId) {
    return (
      <div className="p-10">
        <EmptyState title="Missing run" body="Open a run from the Runs tab." />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10">
        <EmptyState title="Run not found" body="This result is unavailable." />
      </div>
    );
  }

  const { run, scenario, scores, feedback, call, auditEvents } = {
    run: data.run,
    scenario: data.scenario,
    scores: data.scores,
    feedback: data.run.feedback,
    call: data.call,
    auditEvents: data.auditEvents,
  };

  const overall = run.cachedOverallScore != null ? Math.round(Number(run.cachedOverallScore)) : null;
  const generatedBy = feedback?.generatedBy;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={`/coaching/${id}`} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            Results: {scenario?.title ?? "Practice run"}
          </span>
        }
        subtitle={`Attempt ${formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}`}
        actions={
          call ? (
            <Button size="sm" variant="outline" onClick={() => nav(`/calls/${call.id}`)}>
              <FileText className="mr-1.5 h-3.5 w-3.5" /> Call detail
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-5 p-6 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {/* Scoring status */}
          {stillScoring ? (
            <Card>
              <div className="flex flex-col items-center gap-3 p-10 text-center">
                <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
                <div className="text-sm font-semibold">Scoring this attempt…</div>
                <p className="text-sm text-muted-foreground">
                  The transcript is being graded against the linked rubric. This updates
                  automatically.
                </p>
              </div>
            </Card>
          ) : scoringStatus === "failed" ? (
            <Card>
              <div className="flex flex-col items-center gap-3 p-10 text-center">
                <AlertCircle className="h-7 w-7 text-destructive" />
                <div className="text-sm font-semibold">Scoring failed</div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rescore.isPending}
                  onClick={() =>
                    rescore.mutate(
                      { id: runId },
                      {
                        onSuccess: () => {
                          toast.success("Re-scoring…");
                          refetch();
                        },
                        onError: (e: Error) => toast.error(e.message),
                      },
                    )
                  }
                >
                  {rescore.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Retry scoring
                </Button>
              </div>
            </Card>
          ) : (
            <Card title="Overall">
              <div className="flex items-center gap-6 p-6">
                <div>
                  <div className="text-4xl font-bold tabular-nums">{overall ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">out of 100</div>
                </div>
                <div className="flex flex-col gap-1.5">
                  {generatedBy && (
                    <Badge variant="secondary" className="w-fit">
                      <Sparkles className="mr-1 h-3 w-3" />
                      {generatedBy === "stub"
                        ? "AI-scored (stub)"
                        : generatedBy === "manual"
                          ? "Manually scored"
                          : "AI-scored"}
                    </Badge>
                  )}
                  {run.scoreSource === "ai_overridden" && (
                    <Badge variant="outline" className="w-fit">
                      Includes manager override
                    </Badge>
                  )}
                  {scoringStatus === "scored" && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Scored
                    </span>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* Per-criterion */}
          {!stillScoring && scoringStatus !== "failed" && (
            <Card title="Per-criterion">
              <div className="p-4">
                <ScoreBars scores={scores} />
                {canManage && scores.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {scores.map((sc) => (
                      <Button
                        key={sc.criterionId}
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setOverride(sc)}
                      >
                        Override “{sc.criterionName}”
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Strengths / improvements */}
          {feedback && (feedback.strengths?.length || feedback.improvements?.length) ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card title="Strengths">
                <ul className="list-disc space-y-1 p-4 pl-8 text-sm">
                  {(feedback.strengths ?? []).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </Card>
              <Card title="Areas to improve">
                <ul className="list-disc space-y-1 p-4 pl-8 text-sm">
                  {(feedback.improvements ?? []).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : null}

          {feedback?.coachNote && (
            <Card title="Coach note">
              <p className="p-4 text-sm">{feedback.coachNote}</p>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Activity">
            <div className="p-4">
              <ActivityTimeline events={auditEvents} />
            </div>
          </Card>
        </div>
      </div>

      <OverrideDialog
        runId={runId}
        score={override}
        onClose={() => setOverride(null)}
        canManage={canManage}
      />
    </div>
  );
}

function OverrideDialog({
  runId,
  score,
  onClose,
  canManage,
}: {
  runId: string;
  score: RunScore | null;
  onClose: () => void;
  canManage: boolean;
}) {
  const override = useOverrideScore(runId);
  const [value, setValue] = useState("");
  const [justification, setJustification] = useState("");

  const open = !!score && canManage;

  function submit() {
    if (!score) return;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      toast.error("Score must be 0–100");
      return;
    }
    if (justification.trim().length === 0) {
      toast.error("Justification is required");
      return;
    }
    override.mutate(
      { criterionId: score.criterionId, score: num, justification: justification.trim() },
      {
        onSuccess: () => {
          toast.success("Score overridden");
          setValue("");
          setJustification("");
          onClose();
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Override “{score?.criterionName}”</DialogTitle>
          <DialogDescription>
            Manager override is audited. Current score: {score ? Math.round(Number(score.score)) : "—"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ov-score">New score (0–100)</Label>
            <Input
              id="ov-score"
              type="number"
              min={0}
              max={100}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={score ? String(Math.round(Number(score.score))) : ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ov-just">Justification</Label>
            <Textarea
              id="ov-just"
              rows={3}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="Why is the AI score being adjusted?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={override.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={override.isPending}>
            {override.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
