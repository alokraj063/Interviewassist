// Drill-down drawer: the candidate/submission rows underlying a funnel bucket,
// a source bar, or a recruiter cell. Keyset-paginated; each row links to
// /candidates/:id. Opened from a chart click; closing is a controlled prop.
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Loader2, RotateCcw, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-kit";
import {
  useDrillCandidates,
  type AnalyticsFilters,
  type DrillParams,
  type DrillRow,
} from "@/hooks/useAnalyticsReports";

export function DrillDrawer({
  open,
  onOpenChange,
  filters,
  drill,
  title,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  filters: AnalyticsFilters;
  drill: DrillParams | null;
  title: string;
}) {
  const nav = useNavigate();
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<DrillRow[]>([]);

  // Reset accumulation when the drill target changes.
  const drillKey = JSON.stringify(drill);
  useEffect(() => {
    setCursor(null);
    setRows([]);
  }, [drillKey]);

  const q = useDrillCandidates(filters, open ? drill : null, cursor);

  useEffect(() => {
    if (!q.data) return;
    setRows((prev) => {
      if (cursor === null) return q.data!.rows;
      const seen = new Set(prev.map((r) => r.submission_id));
      return [...prev, ...q.data!.rows.filter((r) => !seen.has(r.submission_id))];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg" data-testid="drill-drawer">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Candidates underlying this segment. Click a row to open the candidate.</SheetDescription>
        </SheetHeader>

        <div className="mt-4">
          {q.isError ? (
            <div className="flex flex-col items-center gap-3 p-8 text-center">
              <AlertCircle className="h-6 w-6 text-destructive" />
              <div className="text-sm text-muted-foreground">
                {(q.error as { body?: { error?: string } } | null)?.body?.error ?? q.error?.message}
              </div>
              <Button size="sm" variant="outline" onClick={() => q.refetch()}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : q.isLoading && rows.length === 0 ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No candidates" body="No candidate rows match this segment in the selected period." />
          ) : (
            <>
              <div className="text-xs text-muted-foreground">{rows.length} candidate(s)</div>
              <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                {rows.map((r) => (
                  <li key={r.submission_id}>
                    <button
                      className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/30"
                      onClick={() => nav(`/candidates/${r.candidate_id}`)}
                      data-testid="drill-row"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {r.display_name ?? "Unnamed candidate"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {r.current_stage.replace(/_/g, " ")} · {r.source} ·{" "}
                          {formatDistanceToNow(new Date(r.submitted_at), { addSuffix: true })}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
              {q.data?.nextCursor && (
                <div className="mt-3 flex justify-center">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={q.isFetching}
                    onClick={() => setCursor(q.data!.nextCursor)}
                  >
                    {q.isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
