// Shared explicit state surfaces for Team Monitor panels (A3).
// First-run-empty is a DISTINCT string from filtered-to-zero so a supervisor
// never confuses "nobody clocked in" with "your filter excluded everyone".
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, RotateCw, ChevronLeft, ChevronRight } from "lucide-react";

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-border" data-testid="skeleton-rows">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="p-8 flex flex-col items-center text-center gap-3"
      role="alert"
      data-testid="error-state"
    >
      <AlertTriangle className="w-6 h-6 text-destructive" />
      <div className="text-sm font-medium">Couldn't load this view</div>
      <div className="text-xs text-muted-foreground max-w-sm">{message}</div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="w-3.5 h-3.5 mr-1.5" /> Retry
      </Button>
    </div>
  );
}

export function EmptyFirstRun({ title, body }: { title: string; body: string }) {
  return (
    <div className="p-10 text-center" data-testid="empty-firstrun">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">{body}</div>
    </div>
  );
}

export function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <div className="p-10 text-center" data-testid="empty-filtered">
      <div className="text-sm font-medium">No matches for these filters</div>
      <div className="text-xs text-muted-foreground mt-1">
        Try widening the search or clearing the active filters.
      </div>
      <Button variant="outline" size="sm" className="mt-3" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

export function Pager({
  canPrev,
  canNext,
  onPrev,
  onNext,
  label,
}: {
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-xs text-muted-foreground">
      <span>{label}</span>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" disabled={!canPrev} onClick={onPrev}>
          <ChevronLeft className="w-3.5 h-3.5" /> Prev
        </Button>
        <Button variant="outline" size="sm" disabled={!canNext} onClick={onNext}>
          Next <ChevronRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}
