import { ChevronDown, Radio, Settings2 } from "lucide-react";
import { Link } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  TRANSCRIPTION_MODELS,
  TRANSCRIPTION_PROVIDER_DESCRIPTIONS,
  TRANSCRIPTION_PROVIDER_LABELS,
  TRANSCRIPTION_PROVIDER_SHORT,
  type TranscriptionProvider,
} from "@/lib/transcriptionConfig";

export function TranscriberSwitcher({
  provider,
  model,
  onProviderChange,
  onModelChange,
  disabled,
}: {
  provider: TranscriptionProvider;
  model: string;
  onProviderChange: (p: TranscriptionProvider) => void;
  onModelChange: (m: string) => void;
  disabled?: boolean;
}) {
  const models = TRANSCRIPTION_MODELS[provider] ?? [];
  const label = TRANSCRIPTION_PROVIDER_SHORT[provider];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded border border-border bg-background hover:bg-muted text-muted-foreground",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          title={
            disabled
              ? "End the current call to switch transcription provider"
              : "Transcription provider (applies to next call)"
          }
        >
          <Radio className="w-3 h-3" />
          <span className="uppercase tracking-wide font-semibold">STT</span>
          <span className="text-foreground font-medium">{label}</span>
          <ChevronDown className="w-3 h-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
          Transcription provider
        </DropdownMenuLabel>
        {(Object.keys(TRANSCRIPTION_PROVIDER_LABELS) as TranscriptionProvider[]).map((p) => (
          <DropdownMenuItem
            key={p}
            onClick={() => onProviderChange(p)}
            className={cn(
              "flex flex-col items-start gap-0.5 py-2",
              provider === p ? "bg-primary/10 text-primary" : "",
            )}
          >
            <span className="text-sm font-medium">{TRANSCRIPTION_PROVIDER_LABELS[p]}</span>
            <span className="text-[10px] text-muted-foreground whitespace-normal leading-tight">
              {TRANSCRIPTION_PROVIDER_DESCRIPTIONS[p]}
            </span>
          </DropdownMenuItem>
        ))}
        {models.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
              Model
            </DropdownMenuLabel>
            {models.map((m) => (
              <DropdownMenuItem
                key={m.id}
                onClick={() => onModelChange(m.id)}
                className={model === m.id ? "bg-primary/10 text-primary" : ""}
              >
                <span className="text-sm">{m.label}</span>
                {m.hint && (
                  <span className="ml-auto text-[10px] text-muted-foreground">{m.hint}</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/settings/transcription"
            className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5"
          >
            <Settings2 className="w-3 h-3" />
            Advanced transcription settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
