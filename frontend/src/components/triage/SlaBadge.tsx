import { Clock, AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface SlaBadgeProps {
  slaTargetSec: number | null;
  slaRemainingSec: number | null;
  slaBreached: boolean;
  className?: string;
}

function fmt(sec: number): string {
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Status conveyed by icon + text (never color alone) so it stays accessible.
export function SlaBadge({
  slaTargetSec,
  slaRemainingSec,
  slaBreached,
  className,
}: SlaBadgeProps) {
  if (slaTargetSec == null) {
    return (
      <span
        className={cn(
          "pill text-[11px] inline-flex items-center gap-1 bg-muted text-muted-foreground",
          className,
        )}
        title="No SLA target on the matched rule"
      >
        <MinusCircle className="w-3 h-3" />
        No SLA
      </span>
    );
  }

  if (slaBreached) {
    const over = slaRemainingSec != null ? fmt(slaRemainingSec) : "—";
    return (
      <span
        className={cn(
          "pill text-[11px] inline-flex items-center gap-1 bg-destructive/15 text-destructive font-semibold",
          className,
        )}
        role="status"
        aria-label={`SLA breached by ${over}`}
        title={`SLA target ${slaTargetSec}s breached`}
      >
        <AlertTriangle className="w-3 h-3" />
        Breached +{over}
      </span>
    );
  }

  const remaining = slaRemainingSec ?? slaTargetSec;
  // Amber when under 25% of the target remains.
  const amber = remaining <= slaTargetSec * 0.25;
  return (
    <span
      className={cn(
        "pill text-[11px] inline-flex items-center gap-1",
        amber ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
        className,
      )}
      role="status"
      aria-label={`SLA ${fmt(remaining)} remaining`}
      title={`SLA target ${slaTargetSec}s`}
    >
      {amber ? <Clock className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
      {fmt(remaining)} left
    </span>
  );
}
