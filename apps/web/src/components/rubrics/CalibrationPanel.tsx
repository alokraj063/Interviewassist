// Per-criterion AI-vs-reviewer agreement table, computed server-side from real
// QA review criterion overrides. Empty when no overrides exist for this rubric.
import { Loader2 } from "lucide-react";
import { EmptyState } from "@/components/ui-kit";
import { useRubricCalibration } from "@/hooks/useRubrics";

export function CalibrationPanel({ rubricId }: { rubricId: string }) {
  const { data, isLoading, isError, error } = useRubricCalibration(rubricId);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Computing agreement…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="p-6 text-sm text-destructive">
        Couldn't load calibration: {error instanceof Error ? error.message : "unknown error"}
      </div>
    );
  }
  if (!data || data.reviewCount === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No calibration data yet"
          body="Once QA reviewers override AI scores on calls graded by this rubric, per-criterion agreement appears here."
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="text-xs text-muted-foreground mb-3">
        Based on {data.reviewCount} QA review(s) on calls scored with this rubric. Agreement = AI within ±5 points of the reviewer.
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Criterion</th>
            <th className="text-right">AI avg</th>
            <th className="text-right">Reviewer avg</th>
            <th className="text-right">Override rate</th>
            <th className="text-right">Agreement</th>
            <th className="text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {data.criteria.map((c) => (
            <tr key={c.id}>
              <td className="text-sm font-medium">{c.name}</td>
              <td className="text-right tabular-nums">{c.aiAvg ?? "—"}</td>
              <td className="text-right tabular-nums">{c.reviewerAvg ?? "—"}</td>
              <td className="text-right tabular-nums">{c.overrideRate}%</td>
              <td className="text-right tabular-nums">
                {c.agreementPct === null ? (
                  "—"
                ) : (
                  <span className={c.agreementPct >= 80 ? "text-emerald-600" : c.agreementPct >= 50 ? "text-amber-600" : "text-destructive"}>
                    {c.agreementPct}%
                  </span>
                )}
              </td>
              <td className="text-right tabular-nums">{c.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
