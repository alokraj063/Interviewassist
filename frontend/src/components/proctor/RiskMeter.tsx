import { cn } from "@/lib/utils";
import { riskLabelFor, type RiskLabel } from "@/hooks/useProctor";

const LABEL_CLASS: Record<RiskLabel, string> = {
  low: "bg-success/15 text-success",
  elevated: "bg-warning/15 text-warning",
  high: "bg-destructive/15 text-destructive",
};

const BAR_CLASS: Record<RiskLabel, string> = {
  low: "bg-success",
  elevated: "bg-warning",
  high: "bg-destructive",
};

/**
 * Cumulative session risk score with a color-coded bar AND a text-equivalent
 * label ("Risk 72 (high)") so the signal is not color-only (A8).
 */
export function RiskMeter({
  score,
  label,
  size = "sm",
}: {
  score: number;
  label?: RiskLabel;
  size?: "sm" | "lg";
}) {
  const lbl = label ?? riskLabelFor(score);
  const text = `Risk ${score} (${lbl})`;
  if (size === "lg") {
    return (
      <div className="space-y-1.5" aria-label={text}>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{score}</span>
          <span className={cn("pill text-[11px] capitalize", LABEL_CLASS[lbl])}>{lbl} risk</span>
        </div>
        <div
          className="h-2 w-full rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className={cn("h-full rounded-full transition-all", BAR_CLASS[lbl])} style={{ width: `${score}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" aria-label={text} title={text}>
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden" aria-hidden>
        <div className={cn("h-full rounded-full", BAR_CLASS[lbl])} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-medium tabular-nums">{score}</span>
      <span className="sr-only">{`risk level ${lbl}`}</span>
    </div>
  );
}
