// Multi-field goal authoring dialog — create (POST) and edit (PATCH) in one form.
// Client validation: metric/period/date-range/target required, periodEnd must be
// after periodStart, target ≥ 0. Submit is disabled until valid + shows a saving
// state. Server errors (incl. 409 goal_exists) surface inline, not as a crash.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ApiError } from "@/lib/api";
import {
  RECRUITER_GOAL_METRICS,
  RECRUITER_GOAL_PERIODS,
  useSetGoal,
  usePatchGoal,
  type Goal,
  type GoalMetric,
  type GoalPeriod,
} from "@/hooks/useRecruiters";

const METRIC_LABEL: Record<GoalMetric, string> = {
  submissions: "Submissions",
  client_submits: "Client submits",
  selects: "Selects",
  offers: "Offers",
  joins: "Joins",
  calls: "Calls",
  conversion_rate: "Conversion rate (bps)",
};

function thisQuarter(): { start: string; end: string } {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function GoalDialog({
  open,
  onOpenChange,
  recruiterId,
  recruiterName,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recruiterId: string;
  recruiterName: string;
  editing?: Goal | null;
}) {
  const q = thisQuarter();
  const [metric, setMetric] = useState<GoalMetric>("submissions");
  const [period, setPeriod] = useState<GoalPeriod>("quarterly");
  const [periodStart, setPeriodStart] = useState(q.start);
  const [periodEnd, setPeriodEnd] = useState(q.end);
  const [target, setTarget] = useState("10");
  const [note, setNote] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const create = useSetGoal(recruiterId);
  const patch = usePatchGoal(recruiterId);
  const isEdit = !!editing;
  const pending = create.isPending || patch.isPending;

  useEffect(() => {
    if (!open) return;
    setServerError(null);
    if (editing) {
      setMetric(editing.metric);
      setPeriod(editing.period);
      setPeriodStart(editing.periodStart.slice(0, 10));
      setPeriodEnd(editing.periodEnd.slice(0, 10));
      setTarget(String(editing.targetValue));
      setNote(editing.note ?? "");
    } else {
      setMetric("submissions");
      setPeriod("quarterly");
      setPeriodStart(q.start);
      setPeriodEnd(q.end);
      setTarget("10");
      setNote("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const targetNum = Number(target);
  const dateRangeValid = !!periodStart && !!periodEnd && periodEnd > periodStart;
  const targetValid = target.trim() !== "" && Number.isInteger(targetNum) && targetNum >= 0;
  const valid = dateRangeValid && targetValid;

  const submit = async () => {
    if (!valid || pending) return;
    setServerError(null);
    try {
      if (isEdit && editing) {
        await patch.mutateAsync({ goalId: editing.id, body: { targetValue: targetNum, note: note.trim() || null } });
        toast.success("Goal updated");
      } else {
        await create.mutateAsync({
          metric,
          period,
          periodStart,
          periodEnd,
          targetValue: targetNum,
          // Omit the note when empty — the create schema is `z.string().optional()`
          // (no null), so sending null would 400 as invalid_payload.
          note: note.trim() || undefined,
        });
        toast.success("Goal set");
      }
      onOpenChange(false);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409) {
        setServerError("A live goal for this metric and period already exists. Edit that goal instead.");
        return;
      }
      const body = e.body as { error?: string } | undefined;
      setServerError(body?.error ?? (err instanceof Error ? err.message : "Failed to save goal"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" aria-describedby="goal-desc">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit goal" : "Set goal"}</DialogTitle>
          <DialogDescription id="goal-desc">
            {isEdit
              ? `Adjust the target for ${recruiterName}'s ${METRIC_LABEL[metric]} goal.`
              : `Set a measurable target for ${recruiterName}. Attainment tracks live against the funnel.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal-metric">Metric</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as GoalMetric)} disabled={isEdit}>
                <SelectTrigger id="goal-metric" aria-label="Metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECRUITER_GOAL_METRICS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-period">Period</Label>
              <Select value={period} onValueChange={(v) => setPeriod(v as GoalPeriod)} disabled={isEdit}>
                <SelectTrigger id="goal-period" aria-label="Period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECRUITER_GOAL_PERIODS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal-start">Period start</Label>
              <Input
                id="goal-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={isEdit}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-end">Period end</Label>
              <Input
                id="goal-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={isEdit}
                aria-invalid={!dateRangeValid}
              />
            </div>
          </div>
          {!dateRangeValid && (
            <p className="text-xs text-destructive" role="alert">
              Period end must be after period start.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="goal-target">Target value</Label>
            <Input
              id="goal-target"
              type="number"
              min={0}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-invalid={!targetValid}
            />
            {!targetValid && (
              <p className="text-xs text-destructive" role="alert">
                Target must be a whole number ≥ 0.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goal-note">Note (optional)</Label>
            <Textarea
              id="goal-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Context for this target…"
            />
          </div>

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || pending}>
            {pending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {pending ? "Saving…" : isEdit ? "Save goal" : "Set goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
