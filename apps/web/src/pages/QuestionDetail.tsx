// Question drill-down: editor entry, version history (+revert), usage &
// calibration (real p-value), review history, and review actions (submit /
// approve / reject) gated by permission + self-approval guard.
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Send,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Pencil,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useQuestion,
  useSubmitReview,
  useApproveQuestion,
  useRejectQuestion,
  useRevertQuestion,
} from "@/hooks/useQuestionBanks";
import { StatusBadge } from "@/components/question-bank/StatusBadge";
import { CalibrationBadge } from "@/components/question-bank/CalibrationBadge";
import { QuestionEditorDialog } from "@/components/question-bank/QuestionEditorDialog";

export default function QuestionDetail() {
  const { id: bankId, qid } = useParams<{ id: string; qid: string }>();
  const nav = useNavigate();
  const canWrite = useCan("question_banks.write");
  const canApprove = useCan("question_banks.approve");

  const { data, isLoading, isError, error, refetch } = useQuestion(qid);
  const submit = useSubmitReview(bankId ?? "");
  const approve = useApproveQuestion();
  const reject = useRejectQuestion();
  const revert = useRevertQuestion();

  const [editorOpen, setEditorOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10">
        <EmptyState
          title="Question not found"
          body={(error as { body?: { error?: string } })?.body?.error ?? "It may have been deleted."}
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => nav(`/question-banks/${bankId}`)}>
                Back to bank
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const { question: q, versions, reviews, usage } = data;

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: "Question Banks", href: "/question-banks" },
          { label: "Bank", href: `/question-banks/${bankId}` },
          { label: "Question" },
        ]}
        title={q.prompt.length > 70 ? `${q.prompt.slice(0, 70)}…` : q.prompt}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <Button variant="outline" size="sm" onClick={() => setEditorOpen(true)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            )}
            {canWrite && (q.status === "draft" || q.status === "rejected") && (
              <Button
                size="sm"
                disabled={submit.isPending}
                onClick={() =>
                  submit.mutate(
                    { questionId: q.id },
                    {
                      onSuccess: () => toast.success("Submitted for review"),
                      onError: (e: Error) => toast.error(e.message),
                    },
                  )
                }
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Submit for review
              </Button>
            )}
            {canApprove && q.status === "in_review" && (
              <>
                <Button
                  size="sm"
                  disabled={approve.isPending}
                  onClick={() =>
                    approve.mutate(
                      { questionId: q.id },
                      {
                        onSuccess: () => toast.success("Approved"),
                        onError: (e: Error) => {
                          const code = (e as { body?: { error?: string } }).body?.error;
                          toast.error(
                            code === "self_approval"
                              ? "You can't approve your own question"
                              : (code ?? e.message),
                          );
                        },
                      },
                    )
                  }
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejectOpen(true)}>
                  <XCircle className="mr-1.5 h-3.5 w-3.5" />
                  Reject
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="space-y-5 p-6">
        <div className="flex items-center gap-2">
          <StatusBadge status={q.status} />
          <span className="text-xs text-muted-foreground">v{q.currentVersion}</span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Exposure" value={usage.liveExposureCount} />
          <MetricCard label="Scored attempts" value={usage.scored} />
          <MetricCard
            label="Observed p-value"
            value={usage.observedPValue != null ? usage.observedPValue.toFixed(2) : "—"}
            accent={usage.overUsed ? "warning" : "default"}
          />
          <MetricCard label="Authored difficulty" value={q.difficulty} />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Card title="Prompt">
              <div className="space-y-3 p-4">
                <p className="text-sm">{q.prompt}</p>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Tag>{q.level}</Tag>
                  <Tag>{q.language}</Tag>
                  {q.roleFamily && <Tag>{q.roleFamily}</Tag>}
                </div>
                <CalibrationBadge
                  calibratedDifficulty={q.calibratedDifficulty}
                  authoredDifficulty={q.difficulty}
                  exposureCount={q.exposureCount}
                  overUsed={q.overUsed}
                />
                {q.expectedAnswerHints && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Expected answer hints</div>
                    <p className="text-sm">{q.expectedAnswerHints}</p>
                  </div>
                )}
                {q.options.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Options</div>
                    {q.options.map((o) => (
                      <div key={o.id} className="text-sm">
                        {o.correct ? "✓ " : "• "}
                        {o.text}
                      </div>
                    ))}
                  </div>
                )}
                <ListBlock title="Evaluation rubric" items={q.evaluationRubric} />
                <ListBlock title="Follow-up questions" items={q.followUpQuestions} />
                <ListBlock title="Common mistakes" items={q.commonMistakes} />
              </div>
            </Card>

            <Card title="Review history">
              {reviews.length === 0 ? (
                <EmptyState title="No reviews yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {reviews.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                      <div>
                        <span className="font-medium capitalize">{r.decision.replace("_", " ")}</span>
                        {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Version history">
            {versions.length === 0 ? (
              <EmptyState title="No versions" />
            ) : (
              <ul className="divide-y divide-border">
                {versions.map((v) => (
                  <li key={v.version} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div>
                      <span className="font-medium">v{v.version}</span>{" "}
                      <span className="text-xs capitalize text-muted-foreground">{v.reason}</span>
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}
                      </div>
                    </div>
                    {canWrite && v.version !== q.currentVersion && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={revert.isPending}
                        onClick={() =>
                          revert.mutate(
                            { questionId: q.id, version: v.version },
                            {
                              onSuccess: () => toast.success(`Reverted to v${v.version}`),
                              onError: (e: Error) => toast.error(e.message),
                            },
                          )
                        }
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        Revert
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {usage.liveExposureCount === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5" />
            No usage recorded yet — calibration updates after attempts accrue and Recalibrate runs.
          </div>
        )}
      </div>

      {bankId && (
        <QuestionEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          bankId={bankId}
          editing={q}
        />
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject question</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="Reason for rejection (required)…"
            maxLength={2000}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectNote.trim() || reject.isPending}
              onClick={() =>
                reject.mutate(
                  { questionId: q.id, note: rejectNote.trim() },
                  {
                    onSuccess: () => {
                      toast.success("Rejected");
                      setRejectOpen(false);
                      setRejectNote("");
                    },
                    onError: (e: Error) => toast.error(e.message),
                  },
                )
              }
            >
              {reject.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-muted px-1.5 py-0.5">{children}</span>;
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="ml-4 list-disc text-sm">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
