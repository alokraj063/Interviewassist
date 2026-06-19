import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, Settings2, Volume2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getLanguage,
  type SupportedLanguage,
  type TranslationDisplayMode,
} from "@/lib/translationConfig";

interface TranslationStripProps {
  sourceLang: SupportedLanguage | "auto";
  targetLang: SupportedLanguage;
  displayMode: TranslationDisplayMode;
  onDisplayModeChange: (mode: TranslationDisplayMode) => void;
  onSwap: () => void;
  onOpenPopover: () => void;
  onDisable: () => void;
  outboundSpeaking?: boolean;
  detectedConfidence?: number;
}

export function TranslationStrip({
  sourceLang,
  targetLang,
  displayMode,
  onDisplayModeChange,
  onSwap,
  onOpenPopover,
  onDisable,
  outboundSpeaking,
  detectedConfidence,
}: TranslationStripProps) {
  const autoDetect = sourceLang === "auto";
  const resolvedSource = autoDetect ? "hi-IN" : (sourceLang as SupportedLanguage);
  const src = getLanguage(resolvedSource);
  const tgt = getLanguage(targetLang);

  return (
    <div className="shrink-0 mb-2 rounded-lg border border-primary/30 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">
          Translating
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="inline-flex items-center gap-1 rounded-md bg-background/70 border border-border px-1.5 py-0.5">
          <span className="text-sm leading-none">{src.flag}</span>
          <span className="font-semibold text-[11px]">{src.shortCode}</span>
          {autoDetect && (
            <span className="text-[9px] font-medium text-muted-foreground uppercase">
              auto{detectedConfidence != null ? ` · ${Math.round(detectedConfidence * 100)}%` : ""}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onSwap}
          disabled={autoDetect}
          title={autoDetect ? "Cannot swap when auto-detecting" : "Swap languages"}
          className={cn(
            "p-0.5 rounded hover:bg-background/60 transition-colors",
            autoDetect && "opacity-30 cursor-not-allowed",
          )}
        >
          <ArrowLeftRight className="w-3 h-3" />
        </button>
        <span className="inline-flex items-center gap-1 rounded-md bg-background/70 border border-border px-1.5 py-0.5">
          <span className="text-sm leading-none">{tgt.flag}</span>
          <span className="font-semibold text-[11px]">{tgt.shortCode}</span>
        </span>
      </div>

      <DisplayModeToggle value={displayMode} onChange={onDisplayModeChange} />

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <OutboundChip speaking={!!outboundSpeaking} targetShort={tgt.shortCode} />
        <button
          type="button"
          onClick={onOpenPopover}
          className="p-1 rounded hover:bg-background/60 text-muted-foreground hover:text-foreground transition-colors"
          title="Translation settings"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
        <Link
          to="/settings/translation"
          className="text-[10px] text-muted-foreground hover:text-primary hover:underline"
          title="Open full translation settings"
        >
          Advanced
        </Link>
        <button
          type="button"
          onClick={onDisable}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="Disable translation"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function DisplayModeToggle({
  value,
  onChange,
}: {
  value: TranslationDisplayMode;
  onChange: (mode: TranslationDisplayMode) => void;
}) {
  const options: Array<{ id: TranslationDisplayMode; label: string }> = [
    { id: "translated-only", label: "Translated" },
    { id: "dual", label: "Both" },
    { id: "original-only", label: "Original" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-background/60 p-0.5 shrink-0">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "px-2 py-0.5 text-[10px] font-medium rounded transition-colors",
            value === o.id
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function OutboundChip({ speaking, targetShort }: { speaking: boolean; targetShort: string }) {
  // Animate bars while "speaking" to sell the outbound voice translation.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!speaking) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 4), 180);
    return () => window.clearInterval(id);
  }, [speaking]);

  const bars = [0, 1, 2].map((i) => {
    const height = speaking ? 3 + ((tick + i) % 3) * 3 : 3;
    return (
      <span
        key={i}
        className={cn(
          "w-0.5 rounded-sm transition-all duration-150",
          speaking ? "bg-primary" : "bg-muted-foreground/40",
        )}
        style={{ height }}
      />
    );
  });

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
        speaking
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-background/60 text-muted-foreground",
      )}
      title={speaking ? `Synthesising agent voice in ${targetShort}` : `Outbound: agent → ${targetShort}`}
    >
      <Volume2 className="w-3 h-3" />
      <span className="flex items-end gap-[1px] w-[10px] h-[10px]">{bars}</span>
    </span>
  );
}
