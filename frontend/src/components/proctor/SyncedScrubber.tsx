import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { SIGNAL_KIND_LABELS, type ProctorEventRow } from "@/hooks/useProctor";

const MARKER_COLOR: Record<string, string> = {
  low: "bg-muted-foreground",
  medium: "bg-warning",
  high: "bg-destructive",
};

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Synced replay scrubber for completed sessions. A single timeline aligns the
 * webcam + screen replay position with event markers; clicking a marker seeks
 * both players (here, the snapshot position). Position is controlled by the
 * parent so the IncidentTimeline jump-to-moment and the scrubber stay in sync.
 */
export function SyncedScrubber({
  events,
  durationMs,
  positionMs,
  onSeek,
}: {
  events: ProctorEventRow[];
  durationMs: number;
  positionMs: number;
  onSeek: (ms: number) => void;
}) {
  const total = Math.max(durationMs, 1);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="tabular-nums">{fmt(positionMs)}</span>
        <span>Synced replay</span>
        <span className="tabular-nums">{fmt(total)}</span>
      </div>
      <div className="relative h-8">
        {/* event markers */}
        <div className="absolute inset-x-0 top-0 h-3">
          {events
            .filter((e) => e.offsetMs != null)
            .map((e) => {
              const pct = Math.min(100, Math.max(0, ((e.offsetMs ?? 0) / total) * 100));
              const lbl = (SIGNAL_KIND_LABELS as Record<string, string>)[e.kind] ?? e.kind;
              return (
                <button
                  key={e.id}
                  type="button"
                  aria-label={`Seek to ${lbl} at ${fmt(e.offsetMs ?? 0)}`}
                  title={`${lbl} @ ${fmt(e.offsetMs ?? 0)}`}
                  onClick={() => onSeek(e.offsetMs ?? 0)}
                  className={cn(
                    "absolute -translate-x-1/2 top-0 h-3 w-1.5 rounded-sm hover:scale-y-150 transition-transform",
                    MARKER_COLOR[e.severity] ?? "bg-muted-foreground",
                  )}
                  style={{ left: `${pct}%` }}
                />
              );
            })}
        </div>
        <div className="absolute inset-x-0 bottom-1">
          <Slider
            aria-label="Replay position"
            value={[Math.min(positionMs, total)]}
            min={0}
            max={total}
            step={1000}
            onValueChange={([v]) => onSeek(v)}
          />
        </div>
      </div>
    </div>
  );
}
