import { Camera, Monitor, AlertTriangle, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProctorEventRow } from "@/hooks/useProctor";

/**
 * Webcam + screen feed grid.
 *
 * Real path consumes a LiveKit viewer token (streamMode === "live"). When the
 * stream provider is unconfigured (streamMode === "snapshot") we render the
 * last evidence snapshot stills with an honest "Live feed unavailable" banner —
 * never a fabricated live feed.
 */
export function FeedGrid({
  streamMode,
  events,
  liveState,
  onExpand,
}: {
  streamMode: "live" | "snapshot";
  events: ProctorEventRow[];
  liveState: "active" | "paused" | "ended";
  onExpand?: (which: "webcam" | "screen") => void;
}) {
  const lastSnapshot = [...events].reverse().find((e) => e.evidenceBlobKey)?.evidenceBlobKey ?? null;
  const feedLost = liveState === "ended";

  return (
    <div className="space-y-2">
      {streamMode === "snapshot" && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
          <span>Live feed unavailable — snapshots only (configure PROCTOR_STREAM_PROVIDER for live WebRTC).</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <FeedTile
          icon={<Camera className="w-4 h-4" aria-hidden />}
          label="Webcam"
          mode={streamMode}
          snapshot={lastSnapshot}
          feedLost={feedLost}
          onExpand={() => onExpand?.("webcam")}
        />
        <FeedTile
          icon={<Monitor className="w-4 h-4" aria-hidden />}
          label="Screen"
          mode={streamMode}
          snapshot={lastSnapshot}
          feedLost={feedLost}
          onExpand={() => onExpand?.("screen")}
        />
      </div>
    </div>
  );
}

function FeedTile({
  icon,
  label,
  mode,
  snapshot,
  feedLost,
  onExpand,
}: {
  icon: React.ReactNode;
  label: string;
  mode: "live" | "snapshot";
  snapshot: string | null;
  feedLost: boolean;
  onExpand: () => void;
}) {
  return (
    <div className="relative aspect-video rounded-md border border-border bg-slate-900/95 overflow-hidden group">
      <div className="absolute top-1.5 left-1.5 z-10 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
        {icon}
        <span>{label}</span>
        {mode === "live" && !feedLost && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> live
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Expand ${label} feed`}
        className="absolute top-1.5 right-1.5 z-10 rounded bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>
      <div className={cn("h-full w-full flex items-center justify-center text-slate-400 text-xs", feedLost && "opacity-50")}>
        {feedLost ? (
          <span className="flex flex-col items-center gap-1">
            <AlertTriangle className="w-5 h-5" aria-hidden />
            Feed ended
          </span>
        ) : snapshot ? (
          <span className="px-3 text-center break-all">{snapshot.split("/").pop()}</span>
        ) : mode === "live" ? (
          <span>Connecting…</span>
        ) : (
          <span>No snapshot yet</span>
        )}
      </div>
    </div>
  );
}

export function FeedExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Maximize2 className="w-3.5 h-3.5 mr-1.5" /> Expand
    </Button>
  );
}
