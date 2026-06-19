// Bulk action dialog for the leaderboard's multi-select bar. Two modes:
//   - "goal": apply one goal template to every selected recruiter (POST /:id/goals)
//   - "nudge": send the same coaching nudge to every selected recruiter (POST /:id/nudge)
// Fans out to the per-id endpoints, tracks per-recruiter success/failure, and
// summarizes the result. Idempotency-Key is generated per nudge by the hook.
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
import { apiFetch } from "@/lib/api";
import {
  RECRUITER_NUDGE_KINDS,
  RECRUITER_GOAL_METRICS,
  useInvalidateRecruiters,
  type NudgeKind,
  type GoalMetric,
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
const KIND_LABEL: Record<NudgeKind, string> = {
  coaching: "Coaching",
  sla_breach: "SLA breach",
  capacity: "Capacity",
  goal: "Goal",
  kudos: "Kudos",
};

function thisQuarter() {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function BulkActionDialog({
  open,
  onOpenChange,
  mode,
  recruiterIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "goal" | "nudge";
  recruiterIds: string[];
  onDone: () => void;
}) {
  const q = thisQuarter();
  const invalidate = useInvalidateRecruiters();

  const [metric, setMetric] = useState<GoalMetric>("submissions");
  const [target, setTarget] = useState("10");
  const [kind, setKind] = useState<NudgeKind>("coaching");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMetric("submissions");
    setTarget("10");
    setKind("coaching");
    setMessage("");
    setRunning(false);
    setServerError(null);
  }, [open]);

  const targetNum = Number(target);
  const valid =
    mode === "goal"
      ? Number.isInteger(targetNum) && targetNum >= 0
      : message.trim().length > 0;

  const submit = async () => {
    if (!valid || running) return;
    setRunning(true);
    setServerError(null);
    let ok = 0;
    let failed = 0;
    await Promise.all(
      recruiterIds.map(async (id) => {
        try {
          if (mode === "goal") {
            await apiFetch(`/api/recruiters/${id}/goals`, {
              method: "POST",
              json: {
                metric,
                period: "quarterly",
                periodStart: q.start,
                periodEnd: q.end,
                targetValue: targetNum,
              },
            });
          } else {
            await apiFetch(`/api/recruiters/${id}/nudge`, {
              method: "POST",
              json: { kind, message: message.trim() },
              headers: { "Idempotency-Key": crypto.randomUUID() },
            });
          }
          ok += 1;
        } catch {
          failed += 1;
        }
      }),
    );
    invalidate();
    setRunning(false);
    if (ok > 0) {
      toast.success(
        `${mode === "goal" ? "Goal set" : "Nudge sent"} for ${ok} recruiter(s)` +
          (failed > 0 ? ` · ${failed} skipped` : ""),
      );
      onDone();
      onOpenChange(false);
    } else {
      setServerError(`All ${failed} action(s) failed (e.g. an existing goal for this metric/period).`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="bulk-desc">
        <DialogHeader>
          <DialogTitle>{mode === "goal" ? "Bulk set goal" : "Bulk nudge"}</DialogTitle>
          <DialogDescription id="bulk-desc">
            Apply to {recruiterIds.length} selected recruiter(s).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {mode === "goal" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bulk-metric">Metric</Label>
                <Select value={metric} onValueChange={(v) => setMetric(v as GoalMetric)}>
                  <SelectTrigger id="bulk-metric" aria-label="Metric">
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
                <Label htmlFor="bulk-target">Quarterly target</Label>
                <Input
                  id="bulk-target"
                  type="number"
                  min={0}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Applies a quarter-to-date goal to each selected recruiter.</p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="bulk-kind">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as NudgeKind)}>
                  <SelectTrigger id="bulk-kind" aria-label="Nudge kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECRUITER_NUDGE_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {KIND_LABEL[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bulk-message">Message</Label>
                <Textarea
                  id="bulk-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  placeholder="Same message to every selected recruiter…"
                />
              </div>
            </>
          )}

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || running}>
            {running && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {running ? "Applying…" : mode === "goal" ? "Set goal" : "Send nudge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
