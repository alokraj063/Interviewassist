// Dispute detail — /qa-review/disputes/:id. Thread + resolve (permission-gated)
// + audit timeline. Reads the dispute from the list query, falls back gracefully.
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useQADisputes,
  useCommentDispute,
  useResolveDispute,
  apiErrorMessage,
} from "@/hooks/useQAReview";
import { QaAuditTimeline } from "@/components/qa-review/QaAuditTimeline";

export default function QADisputeDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canResolve = useCan("qa.write");
  const canComment = useCan("qa.dispute");
  const { data, isLoading } = useQADisputes();
  const comment = useCommentDispute();
  const resolve = useResolveDispute();

  const [commentBody, setCommentBody] = useState("");
  const [resolveStatus, setResolveStatus] = useState<"upheld" | "overturned">("upheld");
  const [resolutionNote, setResolutionNote] = useState("");

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const dispute = data?.disputes.find((d) => d.id === id);
  if (!dispute) {
    return (
      <div className="p-10">
        <EmptyState
          title="Dispute not found"
          body="It may have been resolved or you don't have access."
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/qa-review?view=disputes")}>
              Back to disputes
            </Button>
          }
        />
      </div>
    );
  }

  const resolved = dispute.status === "upheld" || dispute.status === "overturned";

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "QA Review", href: "/qa-review?view=disputes" }, { label: "Dispute" }]}
        title="Dispute"
        subtitle={dispute.reason}
        actions={<Badge variant={resolved ? "secondary" : "destructive"}>{dispute.status.replace(/_/g, " ")}</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Reason">
            <div className="space-y-2 p-4 text-sm">
              <p>{dispute.reason}</p>
              {Object.keys(dispute.requestedScores).length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Requested scores: {JSON.stringify(dispute.requestedScores)}
                </div>
              )}
            </div>
          </Card>

          <Card title="Discussion">
            {dispute.thread.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No comments yet.</div>
            ) : (
              <ul className="divide-y divide-border">
                {dispute.thread.map((t, i) => (
                  <li key={i} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{t.name ?? t.userId.slice(0, 8)}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(t.at), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">{t.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {canComment && !resolved && (
              <div className="space-y-2 border-t border-border p-4">
                <Label htmlFor="dispute-comment">Add a comment</Label>
                <Textarea
                  id="dispute-comment"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  rows={2}
                />
                <Button
                  size="sm"
                  disabled={commentBody.trim().length < 1 || comment.isPending}
                  onClick={() =>
                    comment.mutate(
                      { id: dispute.id, body: commentBody.trim() },
                      {
                        onSuccess: () => {
                          toast.success("Comment added");
                          setCommentBody("");
                        },
                        onError: (e) => toast.error(apiErrorMessage(e)),
                      },
                    )
                  }
                >
                  {comment.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Comment
                </Button>
              </div>
            )}
          </Card>

          {canResolve && !resolved && (
            <Card title="Resolve dispute">
              <div className="space-y-3 p-4">
                <div className="space-y-1.5">
                  <Label htmlFor="resolve-status">Outcome</Label>
                  <Select value={resolveStatus} onValueChange={(v) => setResolveStatus(v as "upheld" | "overturned")}>
                    <SelectTrigger id="resolve-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="upheld">Upheld — original review stands</SelectItem>
                      <SelectItem value="overturned">Overturned — review corrected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resolution-note">Resolution note (min 10 chars)</Label>
                  <Textarea
                    id="resolution-note"
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    rows={3}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={resolutionNote.trim().length < 10 || resolve.isPending}
                  onClick={() =>
                    resolve.mutate(
                      { id: dispute.id, status: resolveStatus, resolutionNote: resolutionNote.trim() },
                      {
                        onSuccess: () => toast.success("Dispute resolved"),
                        onError: (e) => toast.error(apiErrorMessage(e)),
                      },
                    )
                  }
                >
                  {resolve.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Resolve
                </Button>
              </div>
            </Card>
          )}

          {resolved && dispute.resolutionNote && (
            <Card title="Resolution">
              <div className="p-4 text-sm">{dispute.resolutionNote}</div>
            </Card>
          )}
        </div>

        <div>
          <Card title="Activity">
            <QaAuditTimeline targetType="dispute" targetId={dispute.id} />
          </Card>
        </div>
      </div>
    </div>
  );
}
