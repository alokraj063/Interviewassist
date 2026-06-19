import { Link } from "react-router-dom";
import { Globe, ExternalLink } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LANGUAGE_CATALOG,
  type SupportedLanguage,
  type TranslationDisplayMode,
  type TranslationMode,
} from "@/lib/translationConfig";

interface TranslationPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: TranslationMode;
  sourceLang: SupportedLanguage | "auto";
  targetLang: SupportedLanguage;
  displayMode: TranslationDisplayMode;
  onModeChange: (mode: TranslationMode) => void;
  onSourceChange: (lang: SupportedLanguage | "auto") => void;
  onTargetChange: (lang: SupportedLanguage) => void;
  onDisplayModeChange: (mode: TranslationDisplayMode) => void;
  trigger: React.ReactNode;
}

export function TranslationPopover({
  open,
  onOpenChange,
  mode,
  sourceLang,
  targetLang,
  displayMode,
  onModeChange,
  onSourceChange,
  onTargetChange,
  onDisplayModeChange,
  trigger,
}: TranslationPopoverProps) {
  const isActive = mode !== "off";
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Globe className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Live translation</div>
            <div className="text-[11px] text-muted-foreground">
              {isActive ? "On · applies to this call" : "Off"}
            </div>
          </div>
          <Switch
            checked={isActive}
            onCheckedChange={(v) => onModeChange(v ? "bidirectional" : "off")}
          />
        </div>

        <div
          className={cn(
            "p-4 space-y-3 transition-opacity",
            !isActive && "opacity-50 pointer-events-none",
          )}
        >
          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Caller's language
            </Label>
            <Select
              value={sourceLang}
              onValueChange={(v) => onSourceChange(v as SupportedLanguage | "auto")}
            >
              <SelectTrigger className="h-9 mt-1 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <span className="inline-flex items-center gap-2">
                    <span>🌐</span>
                    Auto-detect
                  </span>
                </SelectItem>
                {LANGUAGE_CATALOG.filter((l) => l.code !== "multi").map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    <span className="inline-flex items-center gap-2">
                      <span>{l.flag}</span>
                      {l.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              My language
            </Label>
            <Select
              value={targetLang}
              onValueChange={(v) => onTargetChange(v as SupportedLanguage)}
            >
              <SelectTrigger className="h-9 mt-1 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_CATALOG.filter((l) => l.code !== "multi").map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    <span className="inline-flex items-center gap-2">
                      <span>{l.flag}</span>
                      {l.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Direction
            </Label>
            <RadioGroup
              value={mode === "off" ? "bidirectional" : mode}
              onValueChange={(v) => onModeChange(v as TranslationMode)}
              className="mt-1 space-y-1.5"
            >
              <Radio id="dir-in" value="inbound" label="Inbound only" hint="Translate caller → me" />
              <Radio
                id="dir-both"
                value="bidirectional"
                label="Bidirectional"
                hint="Translate both ways"
              />
            </RadioGroup>
          </div>

          <div>
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Show bubbles as
            </Label>
            <RadioGroup
              value={displayMode}
              onValueChange={(v) => onDisplayModeChange(v as TranslationDisplayMode)}
              className="mt-1 space-y-1.5"
            >
              <Radio id="disp-dual" value="dual" label="Both" hint="Original above translation" />
              <Radio
                id="disp-translated"
                value="translated-only"
                label="Translated only"
                hint="Hover to peek at the original"
              />
              <Radio
                id="disp-original"
                value="original-only"
                label="Original only"
                hint="Hide translations in transcript"
              />
            </RadioGroup>
          </div>
        </div>

        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between bg-muted/30">
          <Link
            to="/settings/translation"
            className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
          >
            Advanced settings
            <ExternalLink className="w-3 h-3" />
          </Link>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Radio({
  id,
  value,
  label,
  hint,
}: {
  id: string;
  value: string;
  label: string;
  hint: string;
}) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-2 text-sm cursor-pointer rounded-md p-1.5 hover:bg-muted/40"
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium leading-tight">{label}</div>
        <div className="text-[11px] text-muted-foreground leading-tight">{hint}</div>
      </div>
    </label>
  );
}
