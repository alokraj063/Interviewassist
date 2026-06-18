import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ChevronLeft, Star, Send, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth, useCan } from "@/auth/AuthContext";
import {
  useSubmission,
  useComments,
  useSubmissionAudit,
  useShortlist,
  useAddComment,
  type Scorecard,
} from "@/hooks/useAsyncVideo";
import { VideoPlayer } from "@/components/async-video/VideoPlayer";
import { ScorecardForm } from "@/components/async-video/ScorecardForm";
import { AgreementPanel } from "@/components/async-video/AgreementPanel";
import { ShareLinkPanel } from "@/components/async-video/ShareLinkPanel";
import { AiPanel } from "@/components/async-video/AiPanel";

export default function AsyncVideoReview() {
  const { campaignId, submissionId } = useParams<{ campaignId: string; submissionId: string }>();
  const { user } = useAuth();
  const canReview = useCan("async_video.review");
  const canShare = useCan("async_video.share");

  const { data, isLoading, isError, error, refetch } = useSubmission(submissionId);
  const commentsQ = useComments(submissionId);
  const auditQ = useSubmissionAudit(submissionId);
  const shortlist = useShortlist(submissionId ?? "");
  const addComment = useAddComment(submissionId ?? "");

  const videoRef = useRef<HTMLVideoElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [commentBody, setCommentBody] = useState("");

  const myCard: Scorecard | null = useMemo(() => {
    if (!data || !user) return null;
    return data.scorecards.find((s) => s.reviewerUserId === user.id) ?? null;
  }, [data, user]);

  const otherCards = useMemo(() => {
    if (!data) return [];
    return data.scorecards.filter((s) => s.reviewerUserId !== user?.id && s.submitted);
  }, [data, user]);

  if (isLoading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading submission…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="p-10 flex flex-col items-start gap-3 text-sm">
        <div className="text-destructive">
          {(error as { body?: { error?: string } })?.body?.error ?? (error instanceof Error ? error.message : "Failed to load")}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }
  if (!data) return <div className="p-10 text-sm text-destructive">Submission not found.</div>;

  const { submission, campaign, candidate, questions, videos } = data;
  const blind = campaign?.blindReview ?? false;
  const candidateLabel = blind ? "Candidate (blinded)" : candidate?.displayName ?? "Unlinked candidate";
  const myCardSubmitted = !!myCard?.submitted;

  // captions from the per-question AI transcript (when ready)
  const transcriptFor = (questionId: string) => {
    const art = data.ai.find((a) => a.kind === "transcript" && a.questionId === questionId && a.status === "ready");
    const text = art?.content ? (art.content as { text?: string }).text : null;
    if (!text) return null;
    // Minimal single-cue VTT so the captions track renders.
    return `WEBVTT\n\n00:00:00.000 --> 00:30:00.000\n${text.replace(/\n/g, " ").slice(0, 1000)}`;
  };

  const activeQuestion = questions[activeIdx];
  const hasClip = videos.some((v) => v.promptIndex === activeIdx);

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: "Async video", href: "/async-video" },
          { label: "Campaign", href: `/async-video/${campaignId}` },
          { label: "Review" },
        ]}
        title={
          <span className="flex items-center gap-2">
            <Link to={`/async-video/${campaignId}`} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            {candidateLabel}
            {submission.shortlisted && <Star className="w-4 h-4 text-amber-500 fill-amber-500" />}
          </span>
        }
        subtitle={campaign ? campaign.title : undefined}
        actions={
          canReview ? (
            <Button
              size="sm"
              variant={submission.shortlisted ? "default" : "outline"}
              onClick={() => shortlist.mutate(!submission.shortlisted, { onSuccess: () => toast.success(submission.shortlisted ? "Removed from shortlist" : "Shortlisted") })}
              disabled={shortlist.isPending}
            >
              <Star className={cn("w-3.5 h-3.5 mr-1.5", submission.shortlisted && "fill-current")} />
              {submission.shortlisted ? "Shortlisted" : "Shortlist"}
            </Button>
          ) : undefined
        }
      />

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Status" value={<span className="capitalize">{submission.status}</span>} />
          <MetricCard label="Clips" value={videos.length} />
          <MetricCard label="Reviewers" value={data.scorecards.filter((s) => s.submitted).length} />
          <MetricCard label="Submitted" value={submission.submittedAt ? formatDistanceToNow(new Date(submission.submittedAt), { addSuffix: true }) : "—"} />
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: player + transcript + AI */}
          <div className="col-span-7 space-y-4">
            <Card title="Recorded answers">
              <div className="p-4 space-y-3">
                <div className="flex gap-1.5 flex-wrap">
                  {questions.map((qn, i) => (
                    <button
                      key={qn.id}
                      onClick={() => setActiveIdx(i)}
                      className={cn(
                        "px-2.5 py-1 rounded text-xs border",
                        activeIdx === i ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-muted",
                      )}
                    >
                      Q{i + 1}
                    </button>
                  ))}
                </div>
                {activeQuestion ? (
                  <>
                    <div className="text-sm font-medium">{activeQuestion.text}</div>
                    {hasClip ? (
                      <VideoPlayer
                        ref={videoRef}
                        submissionId={submissionId!}
                        promptIndex={activeIdx}
                        captionsVtt={transcriptFor(activeQuestion.id)}
                      />
                    ) : (
                      <div className="aspect-video rounded bg-muted flex items-center justify-center text-sm text-muted-foreground">
                        No clip recorded for this question
                        {submission.dropOffPromptIndex != null && submission.dropOffPromptIndex === activeIdx ? " (candidate dropped off here)" : ""}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">No questions on this campaign.</div>
                )}
              </div>
            </Card>

            <AiPanel submissionId={submissionId!} canReview={canReview} />
          </div>

          {/* RIGHT: scorecard + agreement + comments + share + timeline */}
          <div className="col-span-5 space-y-4">
            <Card title="My scorecard">
              {!canReview ? (
                <div className="p-4 text-sm text-muted-foreground">You don't have permission to score (async_video.review).</div>
              ) : (
                <div className="p-4">
                  <ScorecardForm submissionId={submissionId!} questions={questions} existing={myCard} />
                </div>
              )}
            </Card>

            {/* Other reviewers — hidden until my scorecard is submitted (blind review) */}
            {myCardSubmitted ? (
              <>
                <AgreementPanel submissionId={submissionId!} questions={questions} scorecards={data.scorecards} />
                {otherCards.length > 0 && (
                  <Card title={`Other reviewers (${otherCards.length})`}>
                    <ul className="divide-y divide-border">
                      {otherCards.map((c) => (
                        <li key={c.id} className="px-4 py-3 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium">{c.reviewerName ?? c.externalReviewerLabel ?? "Reviewer"}</span>
                            <span className="tabular-nums">{c.overallScore == null ? "—" : `${c.overallScore}/100`}</span>
                          </div>
                          {c.recommendation && <div className="text-xs text-muted-foreground capitalize">{c.recommendation.replace("_", " ")}</div>}
                          {c.summaryNote && <div className="text-xs mt-1">{c.summaryNote}</div>}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            ) : (
              <Card title="Other reviewers">
                <div className="p-4 text-sm text-muted-foreground">
                  Submit your own scorecard first to see other reviewers and the agreement panel (blind review).
                </div>
              </Card>
            )}

            <AiCommentThread
              comments={commentsQ.data?.comments ?? []}
              loading={commentsQ.isLoading}
              canReview={canReview}
              value={commentBody}
              onChange={setCommentBody}
              onSubmit={() => {
                const body = commentBody.trim();
                if (!body) return;
                const tsSec = videoRef.current ? Math.floor(videoRef.current.currentTime) : null;
                addComment.mutate(
                  { body, questionId: activeQuestion?.id ?? null, timestampSec: tsSec },
                  { onSuccess: () => { setCommentBody(""); toast.success("Comment added"); } },
                );
              }}
              pending={addComment.isPending}
            />

            <ShareLinkPanel submissionId={submissionId!} canShare={canShare} />

            <Card title="Activity timeline">
              {auditQ.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
              ) : (auditQ.data?.entries.length ?? 0) === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No activity yet.</div>
              ) : (
                <ul className="divide-y divide-border max-h-72 overflow-y-auto">
                  {auditQ.data!.entries.map((e) => (
                    <li key={e.id} className="px-4 py-2 text-xs flex items-start gap-2">
                      <Clock className="w-3 h-3 mt-0.5 text-muted-foreground shrink-0" />
                      <div>
                        <span className="font-medium">{e.action}</span>
                        <span className="text-muted-foreground"> · {e.actorName ?? e.actorLabel ?? "system"}</span>
                        <div className="text-muted-foreground">{formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function AiCommentThread({
  comments,
  loading,
  canReview,
  value,
  onChange,
  onSubmit,
  pending,
}: {
  comments: Array<{ id: string; body: string; authorName: string | null; timestampSec: number | null; createdAt: string }>;
  loading: boolean;
  canReview: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  return (
    <Card title={`Discussion (${comments.length})`}>
      <div className="p-4 space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : comments.length === 0 ? (
          <div className="text-sm text-muted-foreground">No comments yet.</div>
        ) : (
          <ul className="space-y-2 max-h-56 overflow-y-auto">
            {comments.map((c) => (
              <li key={c.id} className="text-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{c.authorName ?? "Reviewer"}</span>
                  {c.timestampSec != null && <span>@ {Math.floor(c.timestampSec / 60)}:{String(c.timestampSec % 60).padStart(2, "0")}</span>}
                  <span>{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
                </div>
                <div>{c.body}</div>
              </li>
            ))}
          </ul>
        )}
        {canReview && (
          <div className="space-y-2">
            <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder="Add a comment (anchored to the current video moment)…" aria-label="New comment" />
            <Button size="sm" onClick={onSubmit} disabled={pending || !value.trim()}>
              <Send className="w-3.5 h-3.5 mr-1.5" /> Comment
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
