import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Avatar } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Phone, PhoneOff, Copy, Globe, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { formatDuration, useLiveCall } from "@/hooks/useLiveCall";
import { liveAssistDemoSeed } from "@/lib/liveAssistDemo";
import { liveAssistTranslationSeed } from "@/lib/liveAssistTranslationDemo";
import { TranscriptPanel } from "@/components/live/TranscriptPanel";
import { CandidateContext } from "@/components/live/CandidateContext";
import { FromTriageBanner } from "@/components/triage/FromTriageBanner";
import { TranslationStrip } from "@/components/live/TranslationStrip";
import { TranslationPopover } from "@/components/live/TranslationPopover";
import { useTranslationState } from "@/hooks/useTranslationState";
import { getLanguage } from "@/lib/translationConfig";
import {
  disableCallTranslation,
  enableCallTranslation,
  patchCallTranslation,
} from "@/hooks/useTranslationApi";
import { useTranscriptionSettings } from "@/hooks/useTranscriptionSettings";
import { SentimentCard } from "@/components/live-assist/SentimentCard";
import { SuggestionsCard } from "@/components/live-assist/SuggestionsCard";
import { KnowledgeCard } from "@/components/live-assist/KnowledgeCard";
import { RightPanelTabs } from "@/components/live-assist/RightPanelTabs";
import { TranscriberSwitcher } from "@/components/live-assist/TranscriberSwitcher";
import { firstModelFor, type TranscriptionProvider } from "@/lib/transcriptionConfig";

/* ------------------------------------------------------------------ */
/*  AGENT COPILOT — live-wired to /ws/session + /api/calls              */
/* ------------------------------------------------------------------ */

type Scenario = "default" | "spanish";

export default function LiveAssist() {
  const [searchParams, setSearchParams] = useSearchParams();
  const scenario: Scenario =
    searchParams.get("scenario") === "spanish" ? "spanish" : "default";

  // When a real callId is in the URL (?callId=...), this is a live recruiter
  // call — skip the demo seed so the page doesn't render mock turns over the
  // top of the real /ws/session feed. Without a callId, we keep the seeded
  // demo so the page is browsable for design review.
  const liveCallId = searchParams.get("callId");
  const seed = liveCallId
    ? undefined
    : scenario === "spanish"
      ? liveAssistTranslationSeed
      : liveAssistDemoSeed;

  const call = useLiveCall({ seed });
  const translation = useTranslationState();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [transcription, updateTranscription] = useTranscriptionSettings();

  // Auto-enable translation on the Spanish scenario so the demo is preconfigured.
  const appliedScenarioRef = useRef<Scenario | null>(null);
  useEffect(() => {
    if (appliedScenarioRef.current === scenario) return;
    appliedScenarioRef.current = scenario;
    if (scenario === "spanish") {
      translation.enable({
        mode: "bidirectional",
        sourceLang: "es-ES",
        targetLang: "en-US",
        displayMode: "dual",
      });
    }
    // We deliberately do NOT auto-disable when switching back to default — the
    // user's previous manual translation state is preserved from localStorage.
  }, [scenario, translation]);

  function switchScenario(next: Scenario) {
    const nextParams = new URLSearchParams(searchParams);
    if (next === "spanish") nextParams.set("scenario", "spanish");
    else nextParams.delete("scenario");
    setSearchParams(nextParams, { replace: true });
  }

  // Sync local translation toggles with the backend while a real call is
  // active. The desired state lives in `translation` (localStorage-backed);
  // we push that to the server so the pipeline knows what to translate and
  // fan out WS translation.* messages. No-op while the call is idle — the
  // demo seed path runs purely on the scripted runner in useLiveCall.
  const lastSyncRef = useRef<string | null>(null);
  useEffect(() => {
    const callId = call.callId;
    if (!callId || call.state !== "live") {
      lastSyncRef.current = null;
      return;
    }
    const signature = `${translation.mode}|${translation.sourceLang}|${translation.targetLang}`;
    if (lastSyncRef.current === signature) return;
    lastSyncRef.current = signature;

    // Fire and forget — errors surface as a toast so the user can retry by
    // toggling again. The strip reflects local state immediately regardless.
    (async () => {
      try {
        if (translation.mode === "off") {
          await disableCallTranslation(callId);
          return;
        }
        if (!call.serverTranslationConfig) {
          await enableCallTranslation(callId, {
            mode: translation.mode,
            sourceLang: translation.sourceLang,
            targetLang: translation.targetLang,
          });
        } else {
          await patchCallTranslation(callId, {
            mode: translation.mode,
            sourceLang: translation.sourceLang,
            targetLang: translation.targetLang,
          });
        }
      } catch (err) {
        toast.error("Translation sync failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, [
    call.callId,
    call.state,
    call.serverTranslationConfig,
    translation.mode,
    translation.sourceLang,
    translation.targetLang,
  ]);

  // When the server auto-detects the caller's language, surface it in the
  // local translation state so the strip pill stops saying "auto".
  useEffect(() => {
    if (!call.detectedLanguage || translation.sourceLang !== "auto") return;
    // Keep sourceLang = "auto" in the UI so the pill still shows the
    // detection confidence, but save the resolved code for the bubble
    // direction logic. No setter needed here — the TranslationStrip reads
    // detectedConfidence directly. Future Phase 3 may promote this to the
    // translation hook if other surfaces need the detected code.
  }, [call.detectedLanguage, translation.sourceLang]);

  const current = call.sentiment;
  const trend =
    call.sentimentSeries.length > 5
      ? current - call.sentimentSeries[call.sentimentSeries.length - 6].v
      : 0;

  // For the Phase 1 demo, the seed call id maps to a mock triage handoff so the
  // "Arrived from triage" banner renders on LiveAssist without any real backend.
  const triageBannerCallId = call.callId ?? "live-assist-demo";

  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">
      <CallBar
        state={call.state}
        elapsed={call.elapsed}
        callId={call.callId}
        onStart={() => void call.start()}
        onEnd={() => void call.end()}
        translationActive={translation.isActive}
        translationTargetShort={getLanguage(translation.targetLang).shortCode}
        onOpenTranslation={() => setPopoverOpen(true)}
        popoverOpen={popoverOpen}
        onPopoverOpenChange={setPopoverOpen}
        translationMode={translation.mode}
        sourceLang={translation.sourceLang}
        targetLang={translation.targetLang}
        displayMode={translation.displayMode}
        onModeChange={translation.setMode}
        onSourceChange={translation.setSourceLang}
        onTargetChange={translation.setTargetLang}
        onDisplayModeChange={translation.setDisplayMode}
        scenario={scenario}
        onScenarioChange={switchScenario}
        transcriptionProvider={transcription.provider}
        transcriptionModel={transcription.model}
        onTranscriptionProviderChange={(provider) =>
          updateTranscription({ provider, model: firstModelFor(provider) })
        }
        onTranscriptionModelChange={(model) => updateTranscription({ model })}
      />

      <FromTriageBanner callId={triageBannerCallId} />

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3 p-3">
        <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col">
          {translation.isActive && (
            <TranslationStrip
              sourceLang={translation.sourceLang}
              targetLang={translation.targetLang}
              displayMode={translation.displayMode}
              onDisplayModeChange={translation.setDisplayMode}
              onSwap={translation.swapLanguages}
              onOpenPopover={() => setPopoverOpen(true)}
              onDisable={translation.disable}
              outboundSpeaking={call.outboundSpeaking}
              detectedConfidence={
                translation.sourceLang === "auto"
                  ? call.detectedLanguage?.confidence ?? 0.94
                  : undefined
              }
            />
          )}
          <div className="flex-1 min-h-0">
            <TranscriptPanel
              turns={call.turns}
              elapsed={call.elapsed}
              state={call.state}
              displayMode={translation.isActive ? translation.displayMode : undefined}
            />
          </div>
        </section>

        <section className="col-span-12 lg:col-span-8 min-h-0 grid grid-cols-12 grid-rows-12 gap-3">
          <div className="col-span-12 xl:col-span-5 row-span-5 min-h-0">
            <CandidateContext callId={liveCallId ?? call.callId} />
          </div>
          <div className="col-span-12 xl:col-span-7 row-span-5 min-h-0">
            <RightPanelTabs callId={liveCallId ?? call.callId} />
          </div>
          <div className="col-span-12 xl:col-span-7 row-span-7 min-h-0">
            <SuggestionsCard suggestions={call.suggestions} />
          </div>
          <div className="col-span-12 xl:col-span-5 row-span-4 min-h-0">
            <KnowledgeCard citations={call.citations} />
          </div>
          <div className="col-span-12 xl:col-span-5 row-span-3 min-h-0">
            <SentimentCard series={call.sentimentSeries} current={current} trend={trend} compact />
          </div>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------ Call bar ------------------------------ */

function CallBar({
  state,
  elapsed,
  callId,
  onStart,
  onEnd,
  translationActive,
  translationTargetShort,
  onOpenTranslation,
  popoverOpen,
  onPopoverOpenChange,
  translationMode,
  sourceLang,
  targetLang,
  displayMode,
  onModeChange,
  onSourceChange,
  onTargetChange,
  onDisplayModeChange,
  scenario,
  onScenarioChange,
  transcriptionProvider,
  transcriptionModel,
  onTranscriptionProviderChange,
  onTranscriptionModelChange,
}: {
  state: "idle" | "starting" | "live" | "ending" | "ended";
  elapsed: number;
  callId: string | null;
  onStart: () => void;
  onEnd: () => void;
  translationActive: boolean;
  translationTargetShort: string;
  onOpenTranslation: () => void;
  popoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
  translationMode: ReturnType<typeof useTranslationState>["mode"];
  sourceLang: ReturnType<typeof useTranslationState>["sourceLang"];
  targetLang: ReturnType<typeof useTranslationState>["targetLang"];
  displayMode: ReturnType<typeof useTranslationState>["displayMode"];
  onModeChange: ReturnType<typeof useTranslationState>["setMode"];
  onSourceChange: ReturnType<typeof useTranslationState>["setSourceLang"];
  onTargetChange: ReturnType<typeof useTranslationState>["setTargetLang"];
  onDisplayModeChange: ReturnType<typeof useTranslationState>["setDisplayMode"];
  scenario: Scenario;
  onScenarioChange: (next: Scenario) => void;
  transcriptionProvider: TranscriptionProvider;
  transcriptionModel: string;
  onTranscriptionProviderChange: (provider: TranscriptionProvider) => void;
  onTranscriptionModelChange: (model: string) => void;
}) {
  const isLive = state === "live";
  const pillText = state === "live" ? "live" : state === "starting" ? "starting" : state === "ending" ? "ending" : state === "ended" ? "ended" : "idle";
  return (
    <div
      className={cn(
        "shrink-0 h-14 px-4 flex items-center gap-3 border-b",
        isLive
          ? "bg-gradient-to-r from-primary/10 via-card to-card border-primary/30"
          : "bg-card border-border",
      )}
    >
      <div className="relative shrink-0">
        <div
          className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center",
            isLive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          <Phone className="w-4 h-4" />
        </div>
        {isLive && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-destructive ring-2 ring-card animate-pulse-soft" />
        )}
      </div>

      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0",
          isLive
            ? "bg-destructive/15 text-destructive"
            : state === "ended"
              ? "bg-muted text-muted-foreground"
              : "bg-muted text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            isLive ? "bg-destructive animate-pulse-soft" : "bg-muted-foreground",
          )}
        />
        {pillText}
      </span>

      <div className="flex items-center gap-2 min-w-0">
        {callId ? (
          <>
            <Avatar initials="DR" size={26} />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">
                Call in progress
              </div>
              <div className="text-[11px] text-muted-foreground truncate font-mono">
                {callId}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              title="Copy call ID for the companion app"
              onClick={async () => {
                await navigator.clipboard.writeText(callId);
                toast.success("Call ID copied");
              }}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            Click <b>Start Test Call</b> to begin
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        <TranscriberSwitcher
          provider={transcriptionProvider}
          model={transcriptionModel}
          onProviderChange={onTranscriptionProviderChange}
          onModelChange={onTranscriptionModelChange}
          disabled={isLive || state === "starting" || state === "ending"}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded border border-border bg-background hover:bg-muted text-muted-foreground"
              title="Demo scenario"
            >
              <span className="uppercase tracking-wide font-semibold">Scenario</span>
              <span className="text-foreground font-medium">
                {scenario === "spanish" ? "Spanish" : "Default"}
              </span>
              <ChevronDown className="w-3 h-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
              Demo scenario
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => onScenarioChange("default")}
              className={scenario === "default" ? "bg-primary/10 text-primary" : ""}
            >
              Hinglish support (Rahul Verma)
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onScenarioChange("spanish")}
              className={scenario === "spanish" ? "bg-primary/10 text-primary" : ""}
            >
              Spanish caller (Carlos García)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal normal-case">
              Switching scenarios swaps the seed customer, transcript, and KB
              citations for demo purposes only.
            </DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>

        <TranslationPopover
          open={popoverOpen}
          onOpenChange={onPopoverOpenChange}
          mode={translationMode}
          sourceLang={sourceLang}
          targetLang={targetLang}
          displayMode={displayMode}
          onModeChange={onModeChange}
          onSourceChange={onSourceChange}
          onTargetChange={onTargetChange}
          onDisplayModeChange={onDisplayModeChange}
          trigger={
            <button
              type="button"
              onClick={onOpenTranslation}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2 rounded border text-[11px] font-medium transition-colors",
                translationActive
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background hover:bg-muted text-muted-foreground",
              )}
              title={translationActive ? "Configure live translation" : "Enable live translation"}
            >
              <Globe className="w-3.5 h-3.5" />
              {translationActive ? `Translate · ${translationTargetShort}` : "Translate"}
            </button>
          }
        />

        {isLive && (
          <div className="text-right mr-1">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground leading-none">
              Duration
            </div>
            <div className="font-mono text-sm font-semibold tabular-nums">
              {formatDuration(elapsed)}
            </div>
          </div>
        )}
        {!isLive ? (
          <Button
            size="sm"
            className="h-8"
            onClick={onStart}
            disabled={state === "starting"}
          >
            <Phone className="w-4 h-4" />
            <span className="hidden sm:inline">{state === "starting" ? "Starting…" : "Start Test Call"}</span>
          </Button>
        ) : (
          <Button size="sm" variant="destructive" className="h-8" onClick={onEnd}>
            <PhoneOff className="w-4 h-4" />
            <span className="hidden sm:inline">End</span>
          </Button>
        )}
      </div>
    </div>
  );
}

/* TranscriberSwitcher / SentimentCard / SuggestionsCard / KnowledgeCard /
   RightPanelTabs all live under apps/web/src/components/live-assist/ and are
   imported above. The recruiter-flavored CandidateContext lives at
   components/live/CandidateContext.tsx. */

