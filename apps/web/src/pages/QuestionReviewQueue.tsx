// Org-wide review/approval queue: all in_review questions across banks.
// Permission-gated on question_banks.approve; approvers act inline. A user
// without .approve who reaches the route sees a read-only "view only" banner
// (the API would 403, so we guard at the page level).
import { useNavigate } from "react-router-dom";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, AlertCircle, RotateCcw, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useReviewQueue,
  useApproveQuestion,
  QUESTION_TYPE_LABELS,
} from "@/hooks/useQuestionBanks";
import { StatusBadge } from "@/components/question-bank/StatusBadge";

export default function QuestionReviewQueue() {
  const nav = useNavigate();
  const canApprove = useCan("question_banks.approve");

  const { data, isLoading, isError, error, refetch } = useReviewQueue({ limit: 50 }, canApprove);
  const approve = useApproveQuestion();

  if (!canApprove) {
    return (
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Question Banks", href: "/question-banks" }, { label: "Review queue" }]}
          title="Review queue"
        />
        <div className="p-6">
          <Card>
            <div className="flex flex-col items-center gap-3 p-12 text-center">
              <ShieldAlert className="h-7 w-7 text-amber-500" />
              <div className="text-sm font-semibold">View only</div>
              <div className="max-w-md text-sm text-muted-foreground">
                You need the question_banks.approve permission to review and approve questions.
              </div>
              <Button size="sm" variant="outline" onClick={() => nav("/question-banks")}>
                Back to banks
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const questions = data?.questions ?? [];

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Question Banks", href: "/question-banks" }, { label: "Review queue" }]}
        title="Review queue"
        subtitle="Questions awaiting approval across every bank in your org."
      />
      <div className="p-6">
        <Card>
          {isError ? (
            <div className="flex flex-col items-center gap-3 p-12 text-center">
              <AlertCircle className="h-7 w-7 text-destructive" />
              <div className="text-sm font-semibold">Couldn't load the review queue</div>
              <div className="max-w-md text-sm text-muted-foreground">
                {(error as { body?: { error?: string } })?.body?.error ?? (error as Error)?.message}
              </div>
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : isLoading ? (
            <div className="divide-y divide-border">
              {[0, 1, 2].map((i) => (
                <div key={i} className="p-4">
                  <Skeleton className="h-5 w-3/4" />
                </div>
              ))}
            </div>
          ) : questions.length === 0 ? (
            <EmptyState
              title="Nothing to review"
              body="When a question is submitted for review it appears here."
            />
          ) : (
            <div className="divide-y divide-border">
              {questions.map((q) => (
                <div key={q.id} className="flex items-start gap-3 p-4 hover:bg-muted/20">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => nav(`/question-banks/${q.bankId}/questions/${q.id}`)}
                  >
                    <div className="flex items-center gap-2">
                      <StatusBadge status={q.status} />
                      <span className="text-xs text-muted-foreground">
                        {q.level} · {QUESTION_TYPE_LABELS[q.questionType]} · diff {q.difficulty}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm font-medium">{q.prompt}</div>
                  </button>
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
                    {approve.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Approve
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
