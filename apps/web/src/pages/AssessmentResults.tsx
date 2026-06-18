import { Link, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, AlertTriangle, Download, BarChart3 } from "lucide-react";
import { format } from "date-fns";
import { useResults, useTemplateDetail } from "@/hooks/useAssessments";
import { ScoreDistributionChart } from "@/components/assessments/ScoreDistributionChart";
import { ItemAnalysisTable } from "@/components/assessments/ItemAnalysisTable";
import { getApiBase, getAccessToken } from "@/lib/api";

export default function AssessmentResults() {
  const { id } = useParams<{ id: string }>();
  const detail = useTemplateDetail(id);
  const { data, isLoading, isError, error, refetch } = useResults(id);

  const title = detail.data?.template.title ?? "Results";

  const csvUrl = () => {
    const token = getAccessToken();
    return `${getApiBase()}/api/assessments/templates/${id}/results/export.csv${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  };

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={`/assessments/${id}`} className="text-muted-foreground hover:text-foreground" aria-label="Back to overview">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            Results · {title}
          </span>
        }
        subtitle={data ? `Live aggregate over ${data.attemptCount} graded attempt(s). As of ${format(new Date(data.asOf), "PP p")}.` : "Cohort distribution and per-item analysis from real graded attempts."}
        actions={
          <a href={csvUrl()} download>
            <Button size="sm" variant="outline">
              <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
            </Button>
          </a>
        }
      />

      <div className="p-6 space-y-4">
        {isLoading ? (
          <>
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </>
        ) : isError ? (
          <Card>
            <div className="p-8 flex flex-col items-center gap-3 text-sm">
              <AlertTriangle className="w-7 h-7 text-destructive" />
              <div className="text-destructive">
                {(error as { body?: { error?: string } })?.body?.error ?? "Failed to load results."}
              </div>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                Retry
              </Button>
            </div>
          </Card>
        ) : data ? (
          <>
            <Card title="Score distribution">
              <div className="p-4">
                <ScoreDistributionChart distribution={data.distribution} />
              </div>
            </Card>
            <Card title="Item analysis">
              {data.items.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
                  <BarChart3 className="w-8 h-8 opacity-30" />
                  No items to analyze yet.
                </div>
              ) : (
                <ItemAnalysisTable items={data.items} />
              )}
            </Card>
            <p className="text-xs text-muted-foreground">
              p-value = mean(awarded / max) per item (difficulty; higher = easier). Discrimination = point-biserial
              between item correctness and total score; items below 0.1 are flagged for review.
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
