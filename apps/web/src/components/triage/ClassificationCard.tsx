import { AlertTriangle, Languages, Smile, Frown, Meh, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Classification } from "@j2w/shared-types";

interface ClassificationCardProps {
  classification: Classification;
  className?: string;
  compact?: boolean;
}

function sentimentIcon(s: number) {
  if (s >= 0.2) return Smile;
  if (s <= -0.2) return Frown;
  return Meh;
}

function sentimentTone(s: number) {
  if (s >= 0.2) return "text-success";
  if (s <= -0.2) return "text-destructive";
  return "text-warning";
}

function urgencyTone(u: Classification["urgency"]) {
  if (u === "high") return "bg-destructive/15 text-destructive";
  if (u === "normal") return "bg-warning/15 text-warning";
  return "bg-success/15 text-success";
}

function confidenceTone(c: number) {
  if (c >= 0.75) return "bg-success";
  if (c >= 0.55) return "bg-warning";
  return "bg-destructive";
}

function languageLabel(l: string) {
  if (l === "multi") return "Hinglish";
  return l;
}

export function ClassificationCard({ classification, className, compact }: ClassificationCardProps) {
  const Icon = sentimentIcon(classification.sentiment);
  const confPct = Math.round(classification.confidence * 100);
  return (
    <div className={cn("bg-card border border-border rounded-lg p-3 space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUp className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Classification
          </span>
        </div>
        <span
          className={cn(
            "pill text-[10px] font-semibold uppercase",
            urgencyTone(classification.urgency),
          )}
        >
          <AlertTriangle className="w-2.5 h-2.5" />
          {classification.urgency}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">Detected intent</div>
          <div className="text-base font-semibold capitalize truncate">
            {classification.intent}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-muted-foreground">Confidence</div>
          <div className="text-base font-semibold tabular-nums">{confPct}%</div>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full transition-all", confidenceTone(classification.confidence))}
          style={{ width: `${confPct}%` }}
        />
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            <div className="text-[10px] uppercase text-muted-foreground">Sentiment</div>
            <div
              className={cn(
                "mt-0.5 flex items-center gap-1.5 font-medium",
                sentimentTone(classification.sentiment),
              )}
            >
              <Icon className="w-3 h-3" />
              {classification.sentiment.toFixed(2)}
            </div>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            <div className="text-[10px] uppercase text-muted-foreground">Language</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-medium">
              <Languages className="w-3 h-3 text-muted-foreground" />
              {languageLabel(classification.language)}
            </div>
          </div>
        </div>
      )}

      {!compact && Object.keys(classification.entities).length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-muted-foreground mb-1">Extracted entities</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(classification.entities).map(([k, v]) => (
              <span
                key={k}
                className="pill bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 font-mono"
              >
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
