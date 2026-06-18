// Side-by-side comparison of multiple async-video submissions on one campaign.
// Reached via /async-video/:campaignId/compare?ids=a,b,c — the review cockpit
// and queue link here once two or more candidates are selected. Server returns
// aligned per-question questions, each candidate's averaged scorecard, and the
// AI summary (labeled AI). Read-only.
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Loader2, ChevronLeft, Star } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CompareResponse {
  questions: Array<{ id: string; position: number; text: string }>;
  submissions: Array<{
    id: string;
    candidateId: string | null;
    candidateName: string | null;
    status: string;
    shortlisted: boolean;
    scorecardCount: number;
    avgOverall: number | null;
    aiSummary: string | null;
  }>;
}

export default function AsyncVideoCompare() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [search] = useSearchParams();
  const ids = useMemo(
    () => (search.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [search],
  );

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["async-video", "compare", campaignId, ids],
    enabled: !!campaignId && ids.length >= 2,
    queryFn: () =>
      apiFetch<CompareResponse>(
        `/api/async-video/campaigns/${campaignId}/compare?ids=${encodeURIComponent(ids.join(","))}`,
      ),
  });

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: "Async video", href: "/async-video" },
          { label: "Campaign", href: `/async-video/${campaignId}` },
          { label: "Compare" },
        ]}
        title={
          <span className="flex items-center gap-2">
            <Link to={`/async-video/${campaignId}`} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            Compare candidates
          </span>
        }
      />
      <div className="p-6 space-y-4">
        {ids.length < 2 ? (
          <Card title="Pick at least two candidates">
            <div className="p-4 text-sm text-muted-foreground">
              Select two or more submissions from the campaign to compare them side by side.
            </div>
          </Card>
        ) : isLoading ? (
          <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading comparison…
          </div>
        ) : isError ? (
          <div className="p-10 flex flex-col items-start gap-3 text-sm">
            <div className="text-destructive">
              {(error as { body?: { error?: string } })?.body?.error ??
                (error instanceof Error ? error.message : "Failed to load")}
            </div>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
          </div>
        ) : !data ? (
          <div className="p-10 text-sm text-destructive">Nothing to compare.</div>
        ) : (
          <Card title={`Comparison (${data.submissions.length})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2">Candidate</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Avg score</th>
                    <th className="px-4 py-2">Reviewers</th>
                    <th className="px-4 py-2">AI summary</th>
                  </tr>
                </thead>
                <tbody>
                  {data.submissions.map((s) => (
                    <tr key={s.id} className="border-b border-border align-top">
                      <td className="px-4 py-3">
                        <Link
                          to={`/async-video/${campaignId}/submissions/${s.id}`}
                          className="font-medium hover:underline inline-flex items-center gap-1.5"
                        >
                          {s.candidateName ?? (s.candidateId ? s.candidateId.slice(0, 8) : "Unlinked")}
                          {s.shortlisted && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />}
                        </Link>
                      </td>
                      <td className="px-4 py-3 capitalize">{s.status}</td>
                      <td className={cn("px-4 py-3 tabular-nums", s.avgOverall != null && s.avgOverall >= 70 && "text-success")}>
                        {s.avgOverall == null ? "—" : `${s.avgOverall}/100`}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{s.scorecardCount}</td>
                      <td className="px-4 py-3 text-muted-foreground max-w-md">
                        {s.aiSummary ? (
                          <span>
                            <span className="text-[10px] uppercase tracking-wide text-primary mr-1">AI</span>
                            {s.aiSummary}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
