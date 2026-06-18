// Publish dialog: change-note input + a diff-since-last-version summary, then
// confirm. Freezing creates an immutable snapshot downstream scorers pin to.
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import type { RubricCriterionV2, RubricVersion } from "@/hooks/useRubrics";

function diffSummary(current: RubricCriterionV2[], previous?: RubricVersion): string[] {
  if (!previous) return ["First published version."];
  const prevById = new Map(previous.criteria.map((c) => [c.id, c]));
  const curById = new Map(current.map((c) => [c.id, c]));
  const lines: string[] = [];
  for (const c of current) {
    const p = prevById.get(c.id);
    if (!p) lines.push(`Added "${c.name}".`);
    else if (p.weight !== c.weight) lines.push(`"${c.name}" weight ${p.weight} → ${c.weight}.`);
    else if (p.name !== c.name) lines.push(`Renamed "${p.name}" → "${c.name}".`);
  }
  for (const p of previous.criteria) {
    if (!curById.has(p.id)) lines.push(`Removed "${p.name}".`);
  }
  return lines.length ? lines : ["No criteria changes since last version (metadata-only publish)."];
}

export function PublishDialog({
  open,
  onOpenChange,
  criteria,
  previousVersion,
  nextVersion,
  submitting,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  criteria: RubricCriterionV2[];
  previousVersion?: RubricVersion;
  nextVersion: number;
  submitting: boolean;
  onConfirm: (changeNote: string) => void;
}) {
  const [note, setNote] = useState("");
  const diff = diffSummary(criteria, previousVersion);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish v{nextVersion}</DialogTitle>
          <DialogDescription>
            Freezes the current criteria into an immutable version. Existing scores keep pointing at the version they were graded with.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1">
            <div className="font-medium text-foreground mb-1">Changes since last version</div>
            {diff.map((d, i) => (
              <div key={i} className="text-muted-foreground">• {d}</div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-note">Change note (optional)</Label>
            <Textarea
              id="publish-note"
              value={note}
              placeholder="What changed and why…"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={submitting}>
            {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Publish v{nextVersion}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
