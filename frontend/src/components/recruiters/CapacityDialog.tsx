// Capacity upsert dialog. PUT /:id/capacity is an upsert keyed by recruiter,
// so the same form both creates and edits. Validates caps within sane bounds;
// submit disabled until valid + shows a saving state.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSetCapacity, type Capacity } from "@/hooks/useRecruiters";

export function CapacityDialog({
  open,
  onOpenChange,
  recruiterId,
  recruiterName,
  current,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recruiterId: string;
  recruiterName: string;
  current?: Capacity | null;
}) {
  const [maxDemands, setMaxDemands] = useState("8");
  const [maxProspects, setMaxProspects] = useState("40");
  const [weeklyCalls, setWeeklyCalls] = useState("25");
  const [notes, setNotes] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const save = useSetCapacity(recruiterId);

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    setMaxDemands(String(current?.maxActiveDemands ?? 8));
    setMaxProspects(String(current?.maxActiveProspects ?? 40));
    setWeeklyCalls(String(current?.weeklyCallTarget ?? 25));
    setNotes(current?.notes ?? "");
  }, [open, current]);

  const nd = Number(maxDemands);
  const np = Number(maxProspects);
  const nc = Number(weeklyCalls);
  const valid =
    Number.isInteger(nd) && nd >= 0 && nd <= 1000 &&
    Number.isInteger(np) && np >= 0 && np <= 10000 &&
    Number.isInteger(nc) && nc >= 0 && nc <= 10000;

  const submit = async () => {
    if (!valid || save.isPending) return;
    setServerError(null);
    try {
      await save.mutateAsync({
        maxActiveDemands: nd,
        maxActiveProspects: np,
        weeklyCallTarget: nc,
        notes: notes.trim() || null,
      });
      toast.success("Capacity updated");
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to save capacity");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="cap-desc">
        <DialogHeader>
          <DialogTitle>Edit capacity</DialogTitle>
          <DialogDescription id="cap-desc">
            Set the concurrent load caps for {recruiterName}. The leaderboard warns when active demands exceed the cap.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="cap-demands">Max active demands</Label>
            <Input
              id="cap-demands"
              type="number"
              min={0}
              max={1000}
              value={maxDemands}
              onChange={(e) => setMaxDemands(e.target.value)}
              aria-invalid={!(Number.isInteger(nd) && nd >= 0 && nd <= 1000)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-prospects">Max active prospects</Label>
            <Input
              id="cap-prospects"
              type="number"
              min={0}
              max={10000}
              value={maxProspects}
              onChange={(e) => setMaxProspects(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-calls">Weekly call target</Label>
            <Input
              id="cap-calls"
              type="number"
              min={0}
              max={10000}
              value={weeklyCalls}
              onChange={(e) => setWeeklyCalls(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cap-notes">Notes (optional)</Label>
            <Textarea id="cap-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || save.isPending}>
            {save.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {save.isPending ? "Saving…" : "Save capacity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
