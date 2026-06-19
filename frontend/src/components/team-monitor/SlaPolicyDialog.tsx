// Author one SLA policy (warning + critical thresholds, enable toggle).
// Client validation mirrors the server: warning != critical AND critical must
// be the more-severe value per metric direction (answer_rate is lower-worse).
// Submit is disabled-until-valid; server errors surface inline.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SLA_METRIC_META } from "./labels";
import { useUpsertSla, type SlaPolicy } from "@/hooks/useTeamMonitor";

export function validateSla(
  metric: SlaPolicy["metric"],
  warning: number,
  critical: number,
): string | null {
  if (!Number.isFinite(warning) || !Number.isFinite(critical)) return "Enter numeric thresholds.";
  if (warning === critical) return "Warning and critical thresholds must differ.";
  const lowerWorse = SLA_METRIC_META[metric].lowerWorse;
  if (lowerWorse) {
    if (critical >= warning) return "Critical must be lower than warning for answer rate.";
  } else {
    if (critical <= warning) return "Critical must be higher than warning.";
  }
  return null;
}

export function SlaPolicyDialog({
  policy,
  open,
  onOpenChange,
}: {
  policy: SlaPolicy | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const meta = policy ? SLA_METRIC_META[policy.metric] : null;
  const upsert = useUpsertSla();
  const [warning, setWarning] = useState("");
  const [critical, setCritical] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [serverErr, setServerErr] = useState<string | null>(null);

  useEffect(() => {
    if (policy) {
      setWarning(String(policy.warningThreshold));
      setCritical(String(policy.criticalThreshold));
      setEnabled(policy.enabled);
      setServerErr(null);
    }
  }, [policy]);

  if (!policy || !meta) return null;

  const wNum = Number(warning);
  const cNum = Number(critical);
  const validationErr = validateSla(policy.metric, wNum, cNum);
  const canSubmit = !validationErr && !upsert.isPending;

  const unitHint =
    meta.unit === "ms" ? "milliseconds" : meta.unit === "pct" ? "percent ×100 (e.g. 8000 = 80%)" : "count";

  async function submit() {
    if (!policy || validationErr) return;
    setServerErr(null);
    try {
      await upsert.mutateAsync({
        metric: policy.metric,
        warningThreshold: wNum,
        criticalThreshold: cNum,
        enabled,
      });
      toast.success(`${meta!.label} SLA updated`);
      onOpenChange(false);
    } catch (err) {
      const e = err as { body?: { error?: string } };
      setServerErr(e.body?.error ?? (err instanceof Error ? err.message : "Update failed"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit SLA — {meta.label}</DialogTitle>
          <DialogDescription>{meta.help}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <label htmlFor="sla-warning" className="text-xs font-medium block mb-1">
              Warning threshold <span className="text-muted-foreground">({unitHint})</span>
            </label>
            <Input
              id="sla-warning"
              type="number"
              value={warning}
              onChange={(e) => setWarning(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sla-critical" className="text-xs font-medium block mb-1">
              Critical threshold <span className="text-muted-foreground">({unitHint})</span>
            </label>
            <Input
              id="sla-critical"
              type="number"
              value={critical}
              onChange={(e) => setCritical(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between">
            <label htmlFor="sla-enabled" className="text-xs font-medium">
              Policy enabled
            </label>
            <Switch id="sla-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          {validationErr && (
            <p className="text-xs text-destructive" data-testid="sla-validation">
              {validationErr}
            </p>
          )}
          {serverErr && (
            <p className="text-xs text-destructive" data-testid="sla-server-error">
              {serverErr}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit} data-testid="sla-save">
            {upsert.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Save policy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
