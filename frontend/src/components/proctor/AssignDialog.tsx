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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errMessage, useAssignReviewer, useReviewers } from "@/hooks/useProctor";

/**
 * Assign one OR many sessions to a reviewer. When sessionIds has >1 the calls
 * are fired sequentially with a per-item progress toast (bulk path).
 */
export function AssignDialog({
  open,
  onOpenChange,
  sessionIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionIds: string[];
  onDone?: () => void;
}) {
  const assign = useAssignReviewer();
  const { data } = useReviewers(open);
  const [reviewerId, setReviewerId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const reviewers = data?.reviewers ?? [];
  const canSubmit = !!reviewerId && sessionIds.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const id of sessionIds) {
        try {
          await assign.mutateAsync({ sessionId: id, reviewerUserId: reviewerId });
          ok += 1;
        } catch (e) {
          toast.error("Assign failed", { description: errMessage(e) });
        }
      }
      toast.success(`Assigned ${ok}/${sessionIds.length} session${sessionIds.length > 1 ? "s" : ""}`);
      onOpenChange(false);
      setReviewerId("");
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign reviewer</DialogTitle>
          <DialogDescription>
            Route {sessionIds.length} session{sessionIds.length > 1 ? "s" : ""} to a reviewer for adjudication.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Reviewer</Label>
          <Select value={reviewerId} onValueChange={setReviewerId}>
            <SelectTrigger aria-label="Reviewer">
              <SelectValue placeholder={reviewers.length ? "Pick a reviewer" : "No reviewers available"} />
            </SelectTrigger>
            <SelectContent>
              {reviewers.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name ?? r.email} · {r.role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {busy ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
