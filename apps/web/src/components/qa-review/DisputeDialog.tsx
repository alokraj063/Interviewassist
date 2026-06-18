// Raise a dispute on a reviewed call. Reason ≥10 chars; submit disabled until valid.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRaiseDispute, apiErrorMessage } from "@/hooks/useQAReview";
import { apiFetch } from "@/lib/api";

export function DisputeDialog({
  open,
  onOpenChange,
  callId,
  candidateName,
  onRaised,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  callId: string | null;
  candidateName?: string | null;
  onRaised?: () => void;
}) {
  const raise = useRaiseDispute();
  const [reason, setReason] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);

  useEffect(() => {
    if (!open || !callId) return;
    setReason("");
    setReviewId(null);
    setLoadingReview(true);
    apiFetch<{ reviews: Array<{ id: string }> }>(`/api/qa/reviews/${callId}`)
      .then((res) => setReviewId(res.reviews[0]?.id ?? null))
      .catch(() => setReviewId(null))
      .finally(() => setLoadingReview(false));
  }, [open, callId]);

  const valid = reason.trim().length >= 10 && !!reviewId;

  function submit() {
    if (!reviewId) return;
    raise.mutate(
      { reviewId, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success("Dispute raised");
          onOpenChange(false);
          onRaised?.();
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Raise a dispute</DialogTitle>
          <DialogDescription>
            Appeal the QA decision on{" "}
            <span className="font-medium">{candidateName ?? "this call"}</span>. A QA lead will review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="dispute-reason" className="text-sm">
            Reason (min 10 characters)
          </Label>
          <Textarea
            id="dispute-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="Explain why this review should be reconsidered…"
          />
          {loadingReview ? (
            <p className="text-xs text-muted-foreground">Locating the review record…</p>
          ) : !reviewId ? (
            <p className="text-xs text-destructive">
              This call has no submitted review yet — grade it before disputing.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{reason.trim().length}/10 minimum</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={raise.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || raise.isPending}>
            {raise.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Raise dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
