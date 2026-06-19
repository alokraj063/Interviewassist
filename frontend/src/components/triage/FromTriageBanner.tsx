import { useState } from "react";
import { ChevronDown, ChevronUp, GitBranch, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TranscriptPanel } from "@/components/live/TranscriptPanel";
import { useHandoffContext } from "@/hooks/useTriage";

interface FromTriageBannerProps {
  callId: string | null | undefined;
}

export function FromTriageBanner({ callId }: FromTriageBannerProps) {
  const [expanded, setExpanded] = useState(true);
  const { data } = useHandoffContext(callId);

  if (!data) return null;

  const { classification, triageTurns, summary, fromFlowName } = data;
  const confPct = Math.round(classification.confidence * 100);
  const intentLabel = classification.intent.charAt(0).toUpperCase() + classification.intent.slice(1);

  return (
    <div
      className={cn(
        "shrink-0 border-b border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent",
      )}
    >
      <div className="px-4 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center">
            <GitBranch className="w-3.5 h-3.5" />
          </div>
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Arrived from triage
            </div>
            <div className="text-sm font-semibold">{fromFlowName}</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="pill bg-primary/15 text-primary text-[11px] font-semibold">
            {intentLabel}
          </span>
          <span className="pill bg-muted text-muted-foreground text-[11px] tabular-nums">
            {confPct}% conf
          </span>
          <span
            className={cn(
              "pill text-[11px] font-semibold uppercase",
              classification.urgency === "high"
                ? "bg-destructive/15 text-destructive"
                : classification.urgency === "normal"
                  ? "bg-warning/15 text-warning"
                  : "bg-success/15 text-success",
            )}
          >
            {classification.urgency}
          </span>
          {Object.entries(classification.entities)
            .slice(0, 3)
            .map(([k, v]) => (
              <span
                key={k}
                className="pill bg-muted text-[10px] text-muted-foreground font-mono"
              >
                {k}: {v}
              </span>
            ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                <MessageSquare className="w-3 h-3 mr-1" />
                Triage transcript
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[420px] p-0 h-[400px]">
              <TranscriptPanel
                turns={triageTurns}
                state="ended"
                title="Triage conversation"
                showStatusAction={false}
                autoScroll={false}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>

      {expanded && summary && (
        <div className="px-4 pb-2 text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">Summary: </span>
          {summary}
        </div>
      )}
    </div>
  );
}
