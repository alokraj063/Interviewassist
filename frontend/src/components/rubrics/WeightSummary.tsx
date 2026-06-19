// Normalized-weight summary bar. Shows each criterion's normalized % and warns
// (and blocks publish) when raw weights sum to zero.
import { AlertTriangle } from "lucide-react";
import { normalizedWeights, type RubricCriterionV2 } from "@/hooks/useRubrics";

export function WeightSummary({ criteria }: { criteria: RubricCriterionV2[] }) {
  const total = criteria.reduce((s, c) => s + (c.weight || 0), 0);
  const norm = normalizedWeights(criteria);

  if (criteria.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">Add criteria to see weighting.</div>
    );
  }

  return (
    <div className="space-y-2">
      {total <= 0 && (
        <div className="flex items-center gap-1.5 text-xs text-destructive" role="status">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
          Weights sum to zero — publishing is blocked until at least one criterion has weight.
        </div>
      )}
      <div className="flex h-3 w-full overflow-hidden rounded bg-muted" aria-hidden>
        {criteria.map((c, i) => {
          const pct = norm.get(c.id) ?? 0;
          return (
            <div
              key={c.id}
              className="h-full"
              style={{
                width: `${pct}%`,
                backgroundColor: ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#8b5cf6"][i % 6],
              }}
              title={`${c.name}: ${pct.toFixed(1)}%`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {criteria.map((c) => (
          <span key={c.id}>
            {c.name || "Untitled"}: <span className="tabular-nums font-medium text-foreground">{(norm.get(c.id) ?? 0).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
