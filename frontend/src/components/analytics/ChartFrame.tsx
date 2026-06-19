// Shared chart wrapper: title, "as of <ts>" timestamp, per-chart Export CSV,
// and the four explicit states (loading skeleton / error+retry / first-run-empty
// distinct from filtered-to-zero / content). Permission gating for export is
// handled by the disabled-with-reason ExportButton passed in.
import { type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface ChartFrameProps {
  title: string;
  description?: string;
  asOf?: string;
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  onRetry?: () => void;
  isEmpty: boolean;
  /** True when segment/search filters are applied — drives empty-state copy. */
  filtered?: boolean;
  onClearFilters?: () => void;
  action?: ReactNode;
  /** Accessible summary of the rendered series for screen readers. */
  ariaLabel?: string;
  children: ReactNode;
}

function fmtAsOf(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChartFrame({
  title,
  description,
  asOf,
  isLoading,
  isError,
  error,
  onRetry,
  isEmpty,
  filtered,
  onClearFilters,
  action,
  ariaLabel,
  children,
}: ChartFrameProps) {
  const asOfLabel = fmtAsOf(asOf);
  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {asOfLabel && (
            <span className="whitespace-nowrap text-xs text-muted-foreground" data-testid="as-of">
              as of {asOfLabel}
            </span>
          )}
          {action}
        </div>
      </div>
      <div className="p-4" aria-label={ariaLabel} role="region">
        {isError ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <div className="text-sm font-semibold">Couldn't load {title.toLowerCase()}</div>
            <div className="max-w-md text-sm text-muted-foreground">
              {(error as { body?: { error?: string } } | null | undefined)?.body?.error ??
                error?.message ??
                "Unexpected error"}
            </div>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            )}
          </div>
        ) : isLoading ? (
          <div className="space-y-3" data-testid="chart-skeleton">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : isEmpty && filtered ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <div className="text-sm font-semibold">No results for these filters</div>
            <div className="max-w-md text-sm text-muted-foreground">
              No records match the current segment filters in this period.
            </div>
            {onClearFilters && (
              <Button size="sm" variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <div className="text-sm font-semibold">No data in this period yet</div>
            <div className="max-w-md text-sm text-muted-foreground">
              Try widening the date range to see results.
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </Card>
  );
}
