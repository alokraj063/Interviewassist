// Reviewer scorecard drill-down — /qa-review/reviewers/:userId.
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useQAScorecard, apiErrorMessage } from "@/hooks/useQAReview";

export default function QAReviewerScorecard() {
  const { userId } = useParams<{ userId: string }>();
  const nav = useNavigate();
  const { data, isLoading, isError, error, refetch } = useQAScorecard(userId);

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10">
        <EmptyState
          title="Reviewer not found"
          body={apiErrorMessage(error)}
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/qa-review?view=agreement")}>
              Back to QA Review
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "QA Review", href: "/qa-review?view=agreement" }, { label: "Reviewer scorecard" }]}
        title="Reviewer scorecard"
        subtitle={`Reviewer ${userId?.slice(0, 8)}`}
      />
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MetricCard label="Reviews" value={data.reviews} />
          <MetricCard label="Override rate" value={`${Math.round(data.overrideRate * 100)}%`} />
          <MetricCard
            label="Mean gold variance"
            value={data.meanGoldVariance == null ? "—" : data.meanGoldVariance.toFixed(1)}
            accent={
              data.meanGoldVariance != null && data.meanGoldVariance > 15 ? "danger" : "default"
            }
          />
        </div>

        <Card title="Weekly review volume">
          {data.trend.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No reviews recorded yet.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Week of</th>
                  <th className="text-right">Reviews</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((t) => (
                  <tr key={t.week}>
                    <td>{t.week}</td>
                    <td className="text-right tabular-nums">{t.reviews}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
