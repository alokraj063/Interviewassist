import type { ResultsResponse } from "@/hooks/useAssessments";

// Cohort score distribution histogram from the live /results aggregate. Every
// bar height traces to a real attempt count — no illustrative data. The "as of"
// timestamp is surfaced by the parent.
export function ScoreDistributionChart({ distribution }: { distribution: ResultsResponse["distribution"] }) {
  const max = Math.max(1, ...distribution.buckets.map((b) => b.count));
  return (
    <div>
      <div className="grid grid-cols-3 gap-4 mb-4">
        <Stat label="Attempts" value={distribution.attemptCount} />
        <Stat
          label="Mean score"
          value={distribution.meanPercent == null ? "—" : `${distribution.meanPercent}%`}
        />
        <Stat
          label="Pass rate"
          value={distribution.passRate == null ? "—" : `${Math.round(distribution.passRate * 100)}%`}
        />
      </div>

      {distribution.attemptCount === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          No graded attempts yet — invite and grade candidates to populate the distribution.
        </p>
      ) : (
        <div className="flex items-end gap-1.5 h-40" role="img" aria-label="Score distribution histogram">
          {distribution.buckets.map((b) => (
            <div key={b.from} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex items-end h-full">
                <div
                  className="w-full rounded-t bg-primary/70 transition-all"
                  style={{ height: `${(b.count / max) * 100}%` }}
                  title={`${b.from}–${b.to}%: ${b.count}`}
                />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums">{b.count}</span>
              <span className="text-[9px] text-muted-foreground">{b.from}</span>
            </div>
          ))}
        </div>
      )}

      {distribution.passBandBreakdown.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {distribution.passBandBreakdown.map((band) => (
            <span
              key={band.band}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs"
            >
              <span className="font-medium">{band.band}</span>
              <span className="tabular-nums text-muted-foreground">{band.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
