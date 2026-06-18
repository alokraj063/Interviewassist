// p-value (calibrated difficulty) chip + over-use warning.
//
// calibratedDifficulty is a 0..1 p-value cache (mean score fraction). A LOW
// p-value means the question is HARD (few get it right). authoredDifficulty is
// 1..5. We surface a mismatch flag when the calibrated signal disagrees with
// the authored difficulty so curators can recalibrate.
import { AlertTriangle, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";

function authoredToExpectedP(difficulty: number): number {
  // difficulty 1 (easy) -> ~0.9 expected pass; 5 (hard) -> ~0.3.
  return Math.max(0, 1 - (difficulty - 1) * 0.15);
}

export function CalibrationBadge({
  calibratedDifficulty,
  authoredDifficulty,
  exposureCount,
  overUsed,
  className,
}: {
  calibratedDifficulty: string | number | null;
  authoredDifficulty?: number;
  exposureCount?: number;
  overUsed?: boolean;
  className?: string;
}) {
  const p =
    calibratedDifficulty == null || calibratedDifficulty === ""
      ? null
      : Number(calibratedDifficulty);

  const mismatch =
    p != null &&
    authoredDifficulty != null &&
    Math.abs(p - authoredToExpectedP(authoredDifficulty)) > 0.3;

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
          p == null
            ? "bg-muted text-muted-foreground"
            : mismatch
              ? "bg-amber-100 text-amber-800"
              : "bg-sky-100 text-sky-800",
        )}
        title={
          p == null
            ? "Not yet calibrated — run Recalibrate after attempts accrue"
            : `p-value ${p.toFixed(2)} (share of correct responses)`
        }
      >
        <Gauge className="h-3 w-3" aria-hidden />
        {p == null ? "Uncalibrated" : `p ${p.toFixed(2)}`}
        {mismatch && <span className="sr-only">difficulty mismatch</span>}
      </span>
      {overUsed && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800"
          title={`Used ${exposureCount ?? 0} times — over-exposed, candidates may have seen it`}
        >
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Over-used
        </span>
      )}
    </span>
  );
}
