import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { SentimentDot } from "@/components/ui-kit";
import type { TranscriptTurn } from "@j2w/shared-types";
import { formatDuration } from "@/hooks/useLiveCall";
import type { TranslatedTurn, TranslationDisplayMode } from "@/lib/translationConfig";
import { TranslatedBubble } from "@/components/live/TranslatedBubble";

export type TranscriptState = "idle" | "starting" | "live" | "ending" | "ended";

function hasTranslation(turn: TranscriptTurn | TranslatedTurn): turn is TranslatedTurn {
  return "translation" in turn && !!(turn as TranslatedTurn).translation;
}

interface PanelShellProps {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  bodyClass?: string;
}

function PanelShell({ title, action, children, bodyClass }: PanelShellProps) {
  return (
    <div className="h-full bg-card border border-border rounded-lg flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
        {action}
      </div>
      <div className={cn("flex-1 min-h-0 overflow-y-auto", bodyClass)}>{children}</div>
    </div>
  );
}

interface TranscriptPanelProps {
  turns: Array<TranscriptTurn | TranslatedTurn>;
  elapsed?: number;
  state?: TranscriptState;
  title?: string;
  emptyHint?: string;
  autoScroll?: boolean;
  showStatusAction?: boolean;
  displayMode?: TranslationDisplayMode;
}

export function TranscriptPanel({
  turns,
  elapsed,
  state = "idle",
  title = "Live transcript",
  emptyHint = "No call in progress. Start a call and connect the audio companion.",
  autoScroll = true,
  showStatusAction = true,
  displayMode,
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTurnText = turns[turns.length - 1]?.text;

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScroll, turns.length, lastTurnText]);

  const action = showStatusAction ? (
    <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          state === "live"
            ? "bg-destructive animate-pulse-soft"
            : "bg-muted-foreground/40",
        )}
      />
      {state === "live"
        ? "Recording"
        : state === "starting"
          ? "Connecting…"
          : state === "ended"
            ? "Ended"
            : "Idle"}
      {elapsed != null && ` · ${formatDuration(elapsed)}`}
    </span>
  ) : undefined;

  return (
    <PanelShell title={title} action={action} bodyClass="p-3 space-y-2">
      <div ref={scrollRef} className="contents" />
      {turns.length === 0 && state !== "live" && (
        <div className="text-xs text-muted-foreground p-4 text-center">{emptyHint}</div>
      )}
      {turns.map((turn, i) => {
        const key = turn.id >= 0 ? `final-${turn.id}` : `partial-${turn.speaker}-${i}`;
        if (displayMode && hasTranslation(turn)) {
          return <TranslatedBubble key={key} turn={turn} displayMode={displayMode} />;
        }
        const isCustomer = turn.speaker === "candidate";
        const sentimentTone =
          turn.sentiment == null
            ? "neutral"
            : turn.sentiment >= 0.3
              ? "positive"
              : turn.sentiment <= -0.3
                ? "negative"
                : "neutral";
        return (
          <div
            key={key}
            className={cn("flex", isCustomer ? "justify-start" : "justify-end")}
          >
            <div
              className={cn(
                "text-sm px-3 py-2 rounded-2xl max-w-[85%] shadow-sm",
                isCustomer
                  ? "bg-muted rounded-bl-sm"
                  : "bg-primary/10 text-foreground rounded-br-sm",
                !turn.isFinal && "opacity-70 italic",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 mb-0.5",
                  isCustomer ? "justify-start" : "justify-end flex-row-reverse",
                )}
              >
                <span className="text-[11px] font-medium text-muted-foreground capitalize">
                  {turn.speaker}
                </span>
                <SentimentDot sentiment={sentimentTone} />
              </div>
              <div className={cn(isCustomer ? "text-left" : "text-right")}>{turn.text}</div>
            </div>
          </div>
        );
      })}
      {state === "live" && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse" />
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse [animation-delay:300ms]" />
          listening…
        </div>
      )}
    </PanelShell>
  );
}
