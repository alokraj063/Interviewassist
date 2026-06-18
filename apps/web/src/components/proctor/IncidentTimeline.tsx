import { AlertCircle, Crosshair, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SIGNAL_KIND_LABELS, type ProctorEventRow, type SignalKind } from "@/hooks/useProctor";

const SEVERITY_PILL: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-warning/15 text-warning",
  high: "bg-destructive/15 text-destructive",
};

function fmtOffset(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function kindLabel(kind: string): string {
  return (SIGNAL_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

interface Props {
  events: ProctorEventRow[];
  onJump: (offsetMs: number | null) => void;
  onAck: (eventId: number) => void;
  canReview: boolean;
  activeOffsetMs?: number | null;
}

export function IncidentTimeline({ events, onJump, onAck, canReview, activeOffsetMs }: Props) {
  if (events.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No integrity events recorded — clean session so far.</div>
    );
  }
  return (
    <ul className="divide-y divide-border max-h-[520px] overflow-y-auto">
      {events.map((e) => {
        const isActive = activeOffsetMs != null && e.offsetMs === activeOffsetMs;
        return (
          <li
            key={e.id}
            className={cn("px-4 py-3 flex items-start justify-between gap-3", isActive && "bg-primary/5")}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
                <span className="font-medium">{kindLabel(e.kind)}</span>
                <span className={cn("pill text-[10px] capitalize", SEVERITY_PILL[e.severity])}>{e.severity}</span>
                {e.evidenceBlobKey && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={e.evidenceBlobKey}>
                    <ImageIcon className="w-3 h-3" aria-hidden /> snapshot
                  </span>
                )}
                {e.reviewerAcked && <span className="text-[10px] text-muted-foreground">acked</span>}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                at {fmtOffset(e.offsetMs)}
                {e.payload && Object.keys(e.payload).length > 0 && <> · {JSON.stringify(e.payload)}</>}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onJump(e.offsetMs)}
                aria-label={`Jump to ${kindLabel(e.kind)} at ${fmtOffset(e.offsetMs)}`}
              >
                <Crosshair className="w-3.5 h-3.5 mr-1" /> Jump
              </Button>
              {e.flagged && !e.reviewerAcked && canReview && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onAck(e.id)}>
                  Ack
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export type { SignalKind };
