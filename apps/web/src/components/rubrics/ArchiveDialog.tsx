// Named-confirmation archive dialog (replaces window.confirm). Shows usage refs
// (in-use warning) and requires the user to type the rubric name to enable the
// Archive button. Force-archive proceeds even when the rubric is in use.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { RubricUsage } from "@/hooks/useRubrics";

export function ArchiveDialog({
  open,
  onOpenChange,
  rubricName,
  usage,
  submitting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rubricName: string;
  usage?: RubricUsage;
  submitting: boolean;
  onConfirm: (force: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const inUse = !!usage && (usage.voiceAgents > 0 || usage.coachingScenarios > 0 || usage.timesScored > 0);
  const match = typed.trim() === rubricName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive rubric</DialogTitle>
          <DialogDescription>
            Archiving hides this rubric from the default list and clears its default flag. You can restore it later.
          </DialogDescription>
        </DialogHeader>

        {inUse && usage && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
            <div>
              This rubric is in use:{" "}
              {[
                usage.timesScored > 0 ? `${usage.timesScored} scored criteria` : null,
                usage.voiceAgents > 0 ? `${usage.voiceAgents} voice agent(s)` : null,
                usage.coachingScenarios > 0 ? `${usage.coachingScenarios} coaching scenario(s)` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              . Historical scores stay pinned to their frozen version.
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="archive-confirm">
            Type <span className="font-semibold">{rubricName}</span> to confirm
          </Label>
          <Input
            id="archive-confirm"
            value={typed}
            autoFocus
            placeholder={rubricName}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!match || submitting}
            onClick={() => onConfirm(inUse)}
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
