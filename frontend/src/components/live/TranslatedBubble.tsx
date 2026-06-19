import { useState } from "react";
import { AlertTriangle, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { SentimentDot } from "@/components/ui-kit";
import { getLanguage, type TranslatedTurn, type TranslationDisplayMode } from "@/lib/translationConfig";

interface TranslatedBubbleProps {
  turn: TranslatedTurn;
  displayMode: TranslationDisplayMode;
}

export function TranslatedBubble({ turn, displayMode }: TranslatedBubbleProps) {
  const isCustomer = turn.speaker === "candidate";
  const [peekOriginal, setPeekOriginal] = useState(false);

  const sentimentTone =
    turn.sentiment == null
      ? "neutral"
      : turn.sentiment >= 0.3
        ? "positive"
        : turn.sentiment <= -0.3
          ? "negative"
          : "neutral";

  const translation = turn.translation;
  const lowConfidence = translation && translation.confidence < 0.6;

  // No translation on this turn yet — fall through to original-only style.
  if (!translation || displayMode === "original-only") {
    return (
      <div className={cn("flex", isCustomer ? "justify-start" : "justify-end")}>
        <div
          className={cn(
            "text-sm px-3 py-2 rounded-2xl max-w-[85%] shadow-sm",
            isCustomer ? "bg-muted rounded-bl-sm" : "bg-primary/10 text-foreground rounded-br-sm",
            !turn.isFinal && "opacity-70 italic",
          )}
        >
          <SpeakerRow speaker={turn.speaker} sentimentTone={sentimentTone} />
          <div className={cn(isCustomer ? "text-left" : "text-right")}>{turn.text}</div>
        </div>
      </div>
    );
  }

  const srcLang = getLanguage(translation.sourceLang);
  const tgtLang = getLanguage(translation.targetLang);

  if (displayMode === "translated-only") {
    return (
      <div className={cn("flex", isCustomer ? "justify-start" : "justify-end")}>
        <div
          className={cn(
            "text-sm px-3 py-2 rounded-2xl max-w-[85%] shadow-sm group relative",
            isCustomer ? "bg-muted rounded-bl-sm" : "bg-primary/10 text-foreground rounded-br-sm",
            !translation.isFinal && "opacity-80",
          )}
        >
          <SpeakerRow speaker={turn.speaker} sentimentTone={sentimentTone} />
          <div className={cn(isCustomer ? "text-left" : "text-right")}>
            {peekOriginal ? (
              <span className="italic text-muted-foreground">{turn.text}</span>
            ) : (
              <>
                {translation.text}
                {!translation.isFinal && (
                  <span className="inline-block w-1 h-3.5 ml-0.5 align-middle bg-primary/70 animate-pulse" />
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPeekOriginal((v) => !v)}
            className={cn(
              "mt-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-background/60 border border-border text-muted-foreground hover:bg-background hover:text-foreground transition-colors",
              isCustomer ? "" : "ml-auto",
            )}
            title={peekOriginal ? "Show translation" : "Show original"}
          >
            <Languages className="w-2.5 h-2.5" />
            {peekOriginal ? tgtLang.shortCode : srcLang.shortCode}
          </button>
          {lowConfidence && translation.isFinal && (
            <LowConfidenceBadge isCustomer={isCustomer} />
          )}
        </div>
      </div>
    );
  }

  // Default: dual — original above translation, with confidence pill.
  return (
    <div className={cn("flex", isCustomer ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "text-sm px-3 py-2 rounded-2xl max-w-[85%] shadow-sm",
          isCustomer ? "bg-muted rounded-bl-sm" : "bg-primary/10 text-foreground rounded-br-sm",
        )}
      >
        <SpeakerRow speaker={turn.speaker} sentimentTone={sentimentTone} />
        <div className={cn("flex items-start gap-1.5", isCustomer ? "" : "justify-end")}>
          <LangTag code={srcLang.shortCode} />
          <div
            className={cn(
              "text-[12px] leading-snug text-muted-foreground italic flex-1 min-w-0",
              isCustomer ? "text-left" : "text-right",
            )}
          >
            {turn.text}
          </div>
        </div>
        <div
          className={cn(
            "my-1 border-t border-dashed",
            isCustomer ? "border-foreground/10" : "border-primary/20",
          )}
        />
        <div className={cn("flex items-start gap-1.5", isCustomer ? "" : "justify-end")}>
          <LangTag code={tgtLang.shortCode} emphasised />
          <div className={cn("text-sm flex-1 min-w-0", isCustomer ? "text-left" : "text-right")}>
            {translation.text || <span className="text-muted-foreground">Translating…</span>}
            {!translation.isFinal && translation.text && (
              <span className="inline-block w-1 h-3.5 ml-0.5 align-middle bg-primary/70 animate-pulse" />
            )}
          </div>
        </div>
        {translation.isFinal && (
          <div
            className={cn(
              "mt-1 flex items-center gap-1.5",
              isCustomer ? "justify-start" : "justify-end",
            )}
          >
            <ConfidencePill confidence={translation.confidence} />
            {translation.latencyMs != null && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {translation.latencyMs}ms
              </span>
            )}
            {lowConfidence && (
              <span className="inline-flex items-center gap-1 text-[10px] bg-warning/15 text-warning px-1.5 py-0.5 rounded-full">
                <AlertTriangle className="w-2.5 h-2.5" />
                Review original
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SpeakerRow({
  speaker,
  sentimentTone,
}: {
  speaker: import("@j2w/shared-types").Speaker;
  sentimentTone: string;
}) {
  const isCustomer = speaker === "candidate";
  return (
    <div
      className={cn(
        "flex items-center gap-2 mb-0.5",
        isCustomer ? "justify-start" : "justify-end flex-row-reverse",
      )}
    >
      <span className="text-[11px] font-medium text-muted-foreground capitalize">{speaker}</span>
      <SentimentDot sentiment={sentimentTone} />
    </div>
  );
}

function LangTag({ code, emphasised }: { code: string; emphasised?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0 text-[9px] font-semibold tracking-wide rounded px-1 h-4 mt-0.5",
        emphasised
          ? "bg-primary/20 text-primary"
          : "bg-foreground/10 text-muted-foreground",
      )}
    >
      {code}
    </span>
  );
}

function ConfidencePill({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone =
    confidence >= 0.8
      ? "bg-success/15 text-success"
      : confidence >= 0.6
        ? "bg-muted text-muted-foreground"
        : "bg-warning/15 text-warning";
  return (
    <span className={cn("text-[10px] tabular-nums px-1.5 py-0.5 rounded-full", tone)}>
      {pct}% conf
    </span>
  );
}

function LowConfidenceBadge({ isCustomer }: { isCustomer: boolean }) {
  return (
    <div
      className={cn(
        "mt-1 inline-flex items-center gap-1 text-[10px] bg-warning/15 text-warning px-1.5 py-0.5 rounded-full",
        isCustomer ? "" : "ml-auto",
      )}
    >
      <AlertTriangle className="w-2.5 h-2.5" />
      Review original
    </div>
  );
}
