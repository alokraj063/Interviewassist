// Live inter-reviewer agreement (Cohen's κ) + pairwise breakdown + drift alerts.
// All numbers come from GET /api/qa/agreement — no hardcoded figures.
import { Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, RotateCcw, AlertTriangle, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { useQAAgreement, apiErrorMessage } from "@/hooks/useQAReview";

function fmtKappa(k: number | null | undefined): string {
  return k == null ? "—" : k.toFixed(2);
}

function kappaAccent(k: number | null): "success" | "warning" | "danger" | "default" {
  if (k == null) return "default";
  if (k >= 0.8) return "success";
  if (k >= 0.6) return "warning";
  return "danger";
}

export function AgreementPanel() {
  const { data, isLoading, isError, error, refetch } = useQAAgreement();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 p-12 text-center">
          <AlertCircle className="h-7 w-7 text-destructive" />
          <div className="text-sm font-semibold">Couldn't load agreement metrics</div>
          <div className="max-w-md text-sm text-muted-foreground">{apiErrorMessage(error)}</div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  const a = data!;
  const hasData = a.pairwise.length > 0 || a.kappa != null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Overall Cohen's κ" value={fmtKappa(a.kappa)} accent={kappaAccent(a.kappa)} />
        <MetricCard label="Reviewer pairs" value={a.pairwise.length} />
        <MetricCard
          label="Drift alerts"
          value={a.driftAlerts.length}
          accent={a.driftAlerts.length > 0 ? "danger" : "success"}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        As of {formatDistanceToNow(new Date(a.asOf), { addSuffix: true })}. κ measures agreement beyond chance
        on banded scores (≥0.8 strong, 0.6–0.8 moderate, &lt;0.6 weak).
      </p>

      {!hasData ? (
        <EmptyState
          title="Not enough double-reviewed calls yet"
          body="Agreement is computed across calls graded by ≥2 reviewers. Run a double-review policy to populate it."
        />
      ) : (
        <>
          <Card title="Pairwise agreement">
            {a.pairwise.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No reviewer pairs with overlapping calls yet.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reviewer A</th>
                    <th>Reviewer B</th>
                    <th className="text-right">κ</th>
                    <th className="text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {a.pairwise.map((p, i) => (
                    <tr key={`${p.a}-${p.b}-${i}`}>
                      <td className="font-mono text-xs">
                        <Link to={`/qa-review/reviewers/${p.a}`} className="hover:underline">
                          {p.a.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">
                        <Link to={`/qa-review/reviewers/${p.b}`} className="hover:underline">
                          {p.b.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="text-right tabular-nums">{fmtKappa(p.kappa)}</td>
                      <td className="text-right tabular-nums">{p.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {a.driftAlerts.length > 0 && (
            <Card title="Drift alerts">
              <ul className="divide-y divide-border">
                {a.driftAlerts.map((d) => (
                  <li key={d.reviewerUserId}>
                    <Link
                      to={`/qa-review/reviewers/${d.reviewerUserId}`}
                      className="flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/50"
                    >
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
                        <span className="font-mono text-xs">{d.reviewerUserId.slice(0, 8)}</span>
                        <span className="text-muted-foreground">drifting from gold</span>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        mean variance {d.meanGoldVariance.toFixed(1)} over {d.n} call(s)
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
