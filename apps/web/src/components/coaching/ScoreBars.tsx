// Per-criterion weighted score bars + band labels (status not color-only).
import type { RunScore } from "@/hooks/useCoaching";

const BAND_LABEL: Record<string, string> = {
  fail: "Needs work",
  pass: "On track",
  excellent: "Strong",
};

function barColor(score: number): string {
  if (score >= 75) return "bg-emerald-500";
  if (score >= 50) return "bg-amber-500";
  return "bg-rose-500";
}

export function ScoreBars({ scores }: { scores: RunScore[] }) {
  if (scores.length === 0) {
    return <p className="text-sm text-muted-foreground">No per-criterion scores yet.</p>;
  }
  return (
    <ul className="space-y-3" aria-label="Per-criterion scores">
      {scores.map((s) => {
        const val = Math.round(Number(s.score));
        return (
          <li key={s.criterionId}>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-medium">{s.criterionName}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>weight {Number(s.weight)}</span>
                {s.band && (
                  <span className="rounded bg-muted px-1.5 py-0.5">{BAND_LABEL[s.band] ?? s.band}</span>
                )}
                {s.source === "manual" && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">overridden</span>
                )}
                <span className="font-semibold tabular-nums text-foreground">{val}</span>
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded bg-muted"
              role="meter"
              aria-valuenow={val}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${s.criterionName}: ${val} of 100`}
            >
              <div className={`h-full ${barColor(val)}`} style={{ width: `${val}%` }} />
            </div>
            {s.evidence && (
              <p className="mt-1 text-xs italic text-muted-foreground">“{s.evidence}”</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
