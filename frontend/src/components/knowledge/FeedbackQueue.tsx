import { useSearchParams } from "react-router-dom";
import { Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ThumbsUp, ThumbsDown, AlertCircle, RotateCcw, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useKbFeedback, useResolveFeedback, type KbFeedback } from "@/hooks/useKnowledge";

export function FeedbackQueue({ canResolve }: { canResolve: boolean }) {
  const [params, setParams] = useSearchParams();
  const status = params.get("fbStatus") ?? "open";
  const { data, isLoading, isError, error, refetch } = useKbFeedback({
    status: status === "all" ? undefined : status,
  });
  const resolve = useResolveFeedback();

  const rows = data?.feedback ?? [];

  function setStatus(v: string) {
    const next = new URLSearchParams(params);
    next.set("fbStatus", v);
    setParams(next, { replace: true });
  }

  function doResolve(id: string, next: "actioned" | "dismissed") {
    resolve.mutate(
      { id, status: next },
      {
        onSuccess: () => toast.success(next === "actioned" ? "Marked actioned" : "Dismissed"),
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status</span>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]" aria-label="Filter feedback by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="actioned">Actioned</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card>
        {isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <AlertCircle className="h-7 w-7 text-destructive" />
            <div className="text-sm font-semibold">Couldn't load feedback</div>
            <div className="max-w-md text-sm text-muted-foreground">{(error as Error)?.message}</div>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : isLoading ? (
          <div className="divide-y divide-border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="p-4">
                <Skeleton className="h-5 w-2/3" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No feedback in this view"
            body="Thumbs up/down on served answers (from Live Assist and Copilot) land here for triage."
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((f) => (
              <FeedbackRow key={f.id} f={f} canResolve={canResolve} onResolve={doResolve} busy={resolve.isPending} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FeedbackRow({
  f,
  canResolve,
  onResolve,
  busy,
}: {
  f: KbFeedback;
  canResolve: boolean;
  onResolve: (id: string, s: "actioned" | "dismissed") => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {f.rating === "up" ? (
            <ThumbsUp className="h-4 w-4 text-success" aria-label="Thumbs up" />
          ) : (
            <ThumbsDown className="h-4 w-4 text-destructive" aria-label="Thumbs down" />
          )}
          {f.reason && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {f.reason}
            </span>
          )}
          <span
            className="rounded px-1.5 py-0.5 text-[11px]"
            data-status={f.status}
          >
            {f.status}
          </span>
        </div>
        {f.query && <div className="mt-1 truncate text-sm font-medium">“{f.query}”</div>}
        {f.comment && <div className="mt-0.5 text-xs text-muted-foreground">{f.comment}</div>}
        <div className="mt-1 text-[11px] text-muted-foreground">
          {f.createdAt ? formatDistanceToNow(new Date(f.createdAt), { addSuffix: true }) : ""}
        </div>
      </div>
      {f.status === "open" && (
        <div className="flex shrink-0 items-center gap-1">
          {canResolve ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve(f.id, "actioned")}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Action"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve(f.id, "dismissed")}>
                Dismiss
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled title="Requires knowledge.feedback">
              Action
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
