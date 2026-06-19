// Floating bulk-action bar for the queue. Assign-to-reviewer + Escalate.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X, Loader2, UserPlus, ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { useBulkAssign, useBulkEscalate, apiErrorMessage } from "@/hooks/useQAReview";

export function QueueBulkBar({
  itemIds,
  onClear,
}: {
  itemIds: string[];
  onClear: () => void;
}) {
  const assign = useBulkAssign();
  const escalate = useBulkEscalate();
  const [assignOpen, setAssignOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [note, setNote] = useState("");

  const reviewerValid = /^[0-9a-f-]{36}$/i.test(reviewerId.trim());

  function doAssign() {
    assign.mutate(
      { itemIds, reviewerId: reviewerId.trim() },
      {
        onSuccess: () => {
          toast.success(`Assigned ${itemIds.length} item(s)`);
          setAssignOpen(false);
          setReviewerId("");
          onClear();
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  }

  function doEscalate() {
    escalate.mutate(
      { itemIds, note: note.trim() },
      {
        onSuccess: () => {
          toast.success(`Escalated ${itemIds.length} item(s)`);
          setEscalateOpen(false);
          setNote("");
          onClear();
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  }

  return (
    <>
      <div
        role="region"
        aria-label="Bulk actions"
        className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-background px-4 py-2.5 shadow-lg"
      >
        <span className="text-sm font-medium">{itemIds.length} selected</span>
        <div className="h-5 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
          <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          Assign
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEscalateOpen(true)}>
          <ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />
          Escalate
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClear} aria-label="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign {itemIds.length} item(s) to a reviewer</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="bulk-reviewer">Reviewer user ID</Label>
            <Input
              id="bulk-reviewer"
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
              placeholder="UUID of the QA reviewer"
            />
            {!reviewerValid && reviewerId.trim() !== "" && (
              <p className="text-xs text-destructive">Enter a valid reviewer UUID</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button onClick={doAssign} disabled={!reviewerValid || assign.isPending}>
              {assign.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={escalateOpen} onOpenChange={setEscalateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Escalate {itemIds.length} item(s)</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="bulk-note">Note</Label>
            <Textarea
              id="bulk-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Why are these being escalated?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEscalateOpen(false)} disabled={escalate.isPending}>
              Cancel
            </Button>
            <Button onClick={doEscalate} disabled={note.trim().length < 1 || escalate.isPending}>
              {escalate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Escalate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
