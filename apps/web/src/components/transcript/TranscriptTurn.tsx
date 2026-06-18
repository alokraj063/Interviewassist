import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import type { TranscriptTurn as TranscriptTurnType } from "@/data/types";

export interface TranscriptTurnProps {
  turn: TranscriptTurnType;
  highlighted?: boolean;
  onClick?: () => void;
}

export const TranscriptTurn = forwardRef<HTMLDivElement, TranscriptTurnProps>(
  function TranscriptTurn({ turn, highlighted, onClick }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex", turn.speaker === "customer" ? "justify-end" : "justify-start")}
      >
        <div
          onClick={onClick}
          className={cn(
            "max-w-[80%] rounded-lg px-3 py-2 text-sm cursor-pointer hover:ring-1 hover:ring-primary/30 transition-shadow",
            turn.speaker === "customer" ? "bg-muted" : "bg-primary-muted/60",
            highlighted && "ring-2 ring-primary shadow-md",
          )}
          style={{ fontFamily: 'ui-sans-serif, system-ui, "Noto Sans", "Noto Sans Devanagari", sans-serif' }}
        >
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-0.5">
            <span className="font-medium text-foreground">{turn.speakerName}</span>
            <span className="font-mono tabular-nums">{turn.ts}</span>
            {turn.sentiment && (
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  turn.sentiment === "positive" && "bg-success",
                  turn.sentiment === "negative" && "bg-warning",
                  turn.sentiment === "escalated" && "bg-destructive",
                  turn.sentiment === "neutral" && "bg-muted-foreground/50",
                )}
              />
            )}
            {turn.criterion && (
              <span className="ml-auto pill bg-primary text-primary-foreground">{turn.criterion}</span>
            )}
          </div>
          <div>{turn.text}</div>
          {turn.flag && <div className="mt-1.5 text-[11px] text-warning font-medium">⚠ {turn.flag}</div>}
        </div>
      </div>
    );
  },
);
