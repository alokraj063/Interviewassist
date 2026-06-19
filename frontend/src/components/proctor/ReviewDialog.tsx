import { useState } from "react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errMessage, useReviewSession, type ReviewerDecision } from "@/hooks/useProctor";

const DECISIONS: { value: ReviewerDecision; label: string; needsJustification: boolean }[] = [
  { value: "clean", label: "Clean — no integrity concern", needsJustification: false },
  { value: "flagged", label: "Flagged — needs follow-up", needsJustification: true },
  { value: "invalidated", label: "Invalidated — void this attempt", needsJustification: true },
];

export function ReviewDialog({
  open,
  onOpenChange,
  sessionId,
  candidateName,
  alreadyDecided,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionId: string;
  candidateName?: string | null;
  alreadyDecided?: boolean;
  onDone?: () => void;
}) {
  const review = useReviewSession();
  const [decision, setDecision] = useState<ReviewerDecision>("clean");
  const [justification, setJustification] = useState("");

  const needsJustification = DECISIONS.find((d) => d.value === decision)?.needsJustification ?? false;
  const justInvalid = needsJustification && justification.trim().length < 10;
  const canSubmit = !justInvalid && !review.isPending;

  const submit = () => {
    if (!canSubmit) return;
    review.mutate(
      {
        sessionId,
        decision,
        justification: needsJustification ? justification.trim() : undefined,
        force: alreadyDecided,
      },
      {
        onSuccess: () => {
          toast.success(`Marked ${decision}`);
          onOpenChange(false);
          setJustification("");
          onDone?.();
        },
        onError: (e) => toast.error("Review failed", { description: errMessage(e) }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Adjudicate session</DialogTitle>
          <DialogDescription>
            {candidateName ? `Decision for ${candidateName}. ` : ""}
            Flagged or invalidated decisions require a justification (min 10 chars).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Decision</Label>
            <Select value={decision} onValueChange={(v) => setDecision(v as ReviewerDecision)}>
              <SelectTrigger aria-label="Decision">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DECISIONS.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsJustification && (
            <div className="space-y-1.5">
              <Label htmlFor="review-justification">Justification</Label>
              <Textarea
                id="review-justification"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                rows={3}
                placeholder="Cite the integrity signals supporting this decision."
              />
              <p className="text-xs text-muted-foreground">{justification.trim().length}/10 minimum</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {review.isPending ? "Saving…" : "Submit decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
