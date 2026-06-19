import { Loader2 } from "lucide-react";
import { SCORECARDS } from "@/data/store";
import { cn } from "@/lib/utils";

const DEFAULT_RUBRIC = SCORECARDS[0];

export interface LiveRubricSnapshot {
  rubricId: string;
  rubricName: string;
  ts: number;
  scores: Array<{
    criterionId: string;
    score: number;
    band: "fail" | "pass" | "excellent";
    rationale: string;
  }>;
}

/**
 * Live Assist right-panel: live rubric tick.
 *
 * When a `liveRubric` snapshot is supplied, render real LLM-inferred
 * scores per criterion. Otherwise fall back to the default rubric
 * shape with placeholder bars and a "waiting for first tick" hint.
 */
export function RubricLivePanel({
  liveRubric,
}: {
  liveRubric?: LiveRubricSnapshot | null;
} = {}) {
  const live = !!liveRubric;
  const rubricName = liveRubric?.rubricName ?? DEFAULT_RUBRIC.name;
  const stale =
    liveRubric != null && Date.now() - liveRubric.ts > 30_000;

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between">
        <span>{rubricName}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 normal-case",
            live ? (stale ? "text-warning" : "text-info") : "text-muted-foreground",
          )}
        >
          {!live && <Loader2 className="w-3 h-3 animate-spin" />}
          {live ? (stale ? "Stale" : "Live") : "Waiting for first tick"}
        </span>
      </div>
      <div className="divide-y divide-border">
        {DEFAULT_RUBRIC.criteria.map((c) => {
          const liveScore = liveRubric?.scores.find((s) => s.criterionId === c.id);
          const score = liveScore?.score ?? null;
          const band: "pass" | "warn" | "fail" =
            score == null
              ? "warn"
              : score >= 80
              ? "pass"
              : score >= 65
              ? "warn"
              : "fail";
          return (
            <div key={c.id} className="p-3">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-medium truncate flex-1">{c.name}</span>
                <span className="text-muted-foreground tabular-nums ml-2">
                  {score == null ? "—" : Math.round(score)} · w{c.weight}%
                </span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all",
                    band === "pass"
                      ? "bg-success"
                      : band === "warn"
                      ? "bg-warning"
                      : "bg-destructive",
                  )}
                  style={{ width: `${score ?? 0}%` }}
                />
              </div>
              {liveScore?.rationale && (
                <div className="text-[10px] text-muted-foreground mt-1">
                  {liveScore.rationale}
                </div>
              )}
              {!liveScore && (
                <div className="text-[10px] text-muted-foreground mt-1 italic">
                  Waiting for first tick
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
