// Recruiter wedge entry point: pick demand → pick prospect/candidate →
// start a browser-mic mixed-mono call. Uses the new /ws/ingest-call
// pipeline through useWedgeCall.
//
// The rich live-assist grid is rendered the entire time — the top-left
// "candidate context" slot doubles as the demand+candidate picker before
// the call starts, and swaps to the real CandidateContext once the call
// goes live. Sentiment, suggestions, KB, and right-rail tabs render their
// own empty states pre-call.
//
// The page never unmounts during a call — that's intentional, because the
// audio-capture WebSocket lives in useWedgeCall's React state.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useDemands,
  useDemandProspects,
  type DemandListItem,
  type DemandProspectRow,
} from "@/hooks/useDemands";
import { useCandidates, type CandidateListItem } from "@/hooks/useCandidates";
import { useWedgeCall, type WedgeCallTicket } from "@/hooks/useWedgeCall";
import { useDemoLiveAssistRunner } from "@/lib/demoLiveAssistRunner";
import { useAuth } from "@/auth/AuthContext";

// Hardcoded so the web doesn't have to import @j2w/db. Mirrors
// `DEMO_ORG_ID` defined in packages/db/src/schema.ts.
const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
import { Avatar } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Mic,
  AlertTriangle,
  Phone,
  PhoneOff,
  Copy,
  ChevronDown,
  Search,
  UserPlus,
  FileText,
  Pencil,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CreateCandidateModal, type CreateMode } from "@/components/CreateCandidateModal";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TranscriptPanel } from "@/components/live/TranscriptPanel";
import { CandidateContext } from "@/components/live/CandidateContext";
import { SentimentCard } from "@/components/live-assist/SentimentCard";
import { KnowledgeCard } from "@/components/live-assist/KnowledgeCard";
import { RightPanelTabs } from "@/components/live-assist/RightPanelTabs";
import { InterviewFlowPanel } from "@/components/live-assist/InterviewFlowPanel";
import { useInterviewFlow, type FlowTurn } from "@/hooks/useInterviewFlow";
import { TranscriberSwitcher } from "@/components/live-assist/TranscriberSwitcher";
import { useTranscriptionSettings } from "@/hooks/useTranscriptionSettings";
import { firstModelFor, type TranscriptionProvider } from "@/lib/transcriptionConfig";
import { formatDuration } from "@/hooks/useLiveCall";
import type { TranscriptTurn } from "@j2w/shared-types";

type WedgeStatus = ReturnType<typeof useWedgeCall>["state"]["status"];

function isLiveStatus(status: WedgeStatus): boolean {
  return status === "live" || status === "ending" || status === "ended";
}

export default function LiveAssistSetup() {
  const [searchParams] = useSearchParams();
  const wedge = useWedgeCall();
  const demoRunner = useDemoLiveAssistRunner();
  const auth = useAuth();
  const isDemoTenant = auth.user?.org.id === DEMO_ORG_ID;
  // When the demo runner is live or ended, panels read from the runner's
  // state instead of the wedge's. Idle = read wedge so design review on
  // non-demo tenants is unaffected.
  const demoActive = demoRunner.state.status !== "idle";
  const [transcription, updateTranscription] = useTranscriptionSettings();

  const [demandId, setDemandId] = useState<string | null>(searchParams.get("demandId"));
  const [prospectId, setProspectId] = useState<string | null>(searchParams.get("prospectId"));
  const [candidateId, setCandidateId] = useState<string | null>(searchParams.get("candidateId"));
  const [search, setSearch] = useState("");
  const [, setTicket] = useState<WedgeCallTicket | null>(null);
  const [createModal, setCreateModal] = useState<{ open: boolean; mode: CreateMode }>({
    open: false,
    mode: "manual",
  });

  // Show all org demands (not just assignedToMe) so jobs added in Settings are
  // immediately selectable here, regardless of assignment.
  const { data: demands = [] } = useDemands({});
  const { data: prospects = [] } = useDemandProspects(demandId ?? undefined);
  const { data: candidatePool = [] } = useCandidates({ q: search.trim() || undefined });

  const selectedDemand = useMemo(
    () => demands.find((d) => d.id === demandId),
    [demands, demandId],
  );
  const selectedProspect = useMemo(
    () => prospects.find((p) => p.id === prospectId),
    [prospects, prospectId],
  );
  const selectedCandidate = useMemo(
    () => candidatePool.find((c) => c.id === candidateId),
    [candidatePool, candidateId],
  );

  // Live elapsed-time tick
  const [, setTick] = useState(0);
  const tickStatus = demoActive ? demoRunner.state.status : wedge.state.status;
  useEffect(() => {
    if (tickStatus !== "live") return;
    const i = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [tickStatus]);
  const startedAt = demoActive ? demoRunner.state.startedAt : wedge.state.startedAt;
  const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  async function handleStart() {
    if (!demandId) {
      toast.error("Pick a demand to call against.");
      return;
    }
    if (!prospectId && !candidateId) {
      toast.error("Pick a prospect or candidate.");
      return;
    }
    const t = await wedge.create({
      demandId,
      prospectId: prospectId ?? undefined,
      candidateId: candidateId ?? undefined,
    });
    if (!t) {
      toast.error(wedge.state.errorMessage ?? "Couldn't create call.");
      return;
    }
    setTicket(t);
    try {
      await wedge.start(t);
    } catch {
      toast.error("Couldn't start audio capture.");
    }
  }

  async function handleEnd() {
    // Stop the audio capture, then generate the interview-flow final score
    // (verdict + dimension scores + summary) and show it in the panel. We do
    // NOT navigate to the legacy Call Detail — its Summary/Rubric tabs depend
    // on post-call workers that aren't wired yet, so they'd spin forever.
    await wedge.end();
    void flow.endNow();
  }

  const wedgeStatus = wedge.state.status;
  const effectiveStatus = demoActive ? demoRunner.state.status : wedgeStatus;
  const live = demoActive ? effectiveStatus === "live" : isLiveStatus(wedgeStatus);
  const canStart = Boolean(demandId && (prospectId || candidateId));

  const sourceTurns = demoActive ? demoRunner.state.turns : wedge.state.turns;
  const sourcePartial = demoActive ? demoRunner.state.partial : wedge.state.partial;
  const sourceSentiment = demoActive ? demoRunner.state.sentiment : wedge.state.sentiment;
  const sourceSentimentSeries = demoActive ? demoRunner.state.sentimentSeries : wedge.state.sentimentSeries;
  const sourceCitations = demoActive ? demoRunner.state.citations : wedge.state.citations;
  const sourceLiveRubric = demoActive ? demoRunner.state.liveRubric : wedge.state.liveRubric;
  const sourceCallId = demoActive ? demoRunner.state.callId : wedge.state.callId;

  // Combine finalized turns + the streaming partial (id=-1) so TranscriptPanel
  // can render the in-flight phrase the way it does for the Vapi path.
  const transcriptTurns = useMemo<TranscriptTurn[]>(() => {
    const finals: TranscriptTurn[] = sourceTurns.map(({ uiKey: _uiKey, ...t }) => t);
    if (sourcePartial) {
      const { uiKey: _uiKey, ...p } = sourcePartial;
      return [...finals, p];
    }
    return finals;
  }, [sourceTurns, sourcePartial]);

  // Structured interview-flow co-pilot (replaces the old free-form suggestions).
  // It reads the live transcript (speaker-labeled turns) and drives one question
  // at a time. Demo tenant keeps the scripted runner; real calls use this.
  const flowLog = useMemo<FlowTurn[]>(
    () => sourceTurns.map((t) => ({ speaker: t.speaker, text: t.text })),
    [sourceTurns],
  );
  const flow = useInterviewFlow(flowLog);
  const flowStartedFor = useRef<string | null>(null);
  useEffect(() => {
    if (demoActive) return; // the demo runner drives its own panels
    const id = wedge.state.callId;
    // Generate the plan/question-bank as soon as the call exists ("ready"),
    // i.e. before the conversation actually starts — so questions are ready.
    if ((effectiveStatus === "ready" || effectiveStatus === "live") && id && flowStartedFor.current !== id) {
      flowStartedFor.current = id;
      void flow.startFlow(id);
    }
    if (effectiveStatus === "idle" && flowStartedFor.current) {
      flowStartedFor.current = null;
      flow.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStatus, wedge.state.callId, demoActive]);

  const sentimentCurrent = sourceSentiment;
  const sentimentSeries = sourceSentimentSeries;
  const sentimentTrend =
    sentimentSeries.length > 5
      ? sentimentCurrent - sentimentSeries[sentimentSeries.length - 6].v
      : 0;

  const transcriptState =
    effectiveStatus === "live"
      ? "live"
      : effectiveStatus === "ending"
        ? "ending"
        : effectiveStatus === "ended"
          ? "ended"
          : "idle";

  return (
    <div className="h-full flex flex-col overflow-hidden bg-muted/20">
      <CallBar
        status={demoActive ? demoStatusToWedge(demoRunner.state.status) : wedge.state.status}
        callId={sourceCallId}
        elapsed={elapsedSec}
        canStart={canStart}
        onStart={handleStart}
        onEnd={demoActive ? () => demoRunner.reset() : handleEnd}
        transcriptionProvider={transcription.provider}
        transcriptionModel={transcription.model}
        onTranscriptionProviderChange={(provider) =>
          updateTranscription({ provider, model: firstModelFor(provider) })
        }
        onTranscriptionModelChange={(model) => updateTranscription({ model })}
        showDemoButton={isDemoTenant && !demoActive && wedge.state.status === "idle"}
        onStartDemo={() => demoRunner.start()}
      />

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3 p-3">
        <section className="col-span-12 lg:col-span-4 min-h-0 flex flex-col gap-2">
          <div className="flex-1 min-h-0">
            <TranscriptPanel
              turns={transcriptTurns}
              elapsed={elapsedSec}
              state={transcriptState}
              emptyHint={
                live
                  ? "Waiting for audio…"
                  : "Pick a demand and a prospect/candidate, then click Start live-assist call."
              }
            />
          </div>
          {live && (
            <div className="shrink-0 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() =>
                  wedge.markSpeaker(
                    "recruiter",
                    Date.now() - (wedge.state.startedAt ?? Date.now()),
                  )
                }
                disabled={wedge.state.status !== "live"}
              >
                <Mic className="w-3.5 h-3.5 mr-1" /> I'm speaking
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() =>
                  wedge.markSpeaker(
                    "candidate",
                    Date.now() - (wedge.state.startedAt ?? Date.now()),
                  )
                }
                disabled={wedge.state.status !== "live"}
              >
                <Mic className="w-3.5 h-3.5 mr-1" /> Candidate speaking
              </Button>
            </div>
          )}
        </section>

        <section className="col-span-12 lg:col-span-8 min-h-0 grid grid-cols-12 grid-rows-12 gap-3">
          <div className="col-span-12 xl:col-span-5 row-span-5 min-h-0">
            {live ? (
              demoActive ? (
                <DemoCandidateContext />
              ) : (
                <CandidateContext callId={wedge.state.callId} />
              )
            ) : (
              <SetupPicker
                demands={demands}
                demandId={demandId}
                onPickDemand={(id) => {
                  setDemandId(id);
                  setProspectId(null);
                  setCandidateId(null);
                }}
                prospects={prospects}
                prospectId={prospectId}
                onPickProspect={(p) => {
                  setProspectId(p.id);
                  setCandidateId(p.candidateId);
                }}
                search={search}
                onSearch={setSearch}
                candidatePool={candidatePool}
                candidateId={candidateId}
                onPickCandidate={(id) => {
                  setCandidateId(id);
                  setProspectId(null);
                }}
                onRequestCreateCandidate={(mode) => setCreateModal({ open: true, mode })}
                selectedDemand={selectedDemand}
                selectedProspect={selectedProspect}
                selectedCandidate={selectedCandidate}
                status={wedge.state.status}
                errorMessage={wedge.state.errorMessage}
              />
            )}
          </div>
          <div className="col-span-12 xl:col-span-7 row-span-5 min-h-0">
            <RightPanelTabs
              callId={sourceCallId ?? undefined}
              liveRubric={sourceLiveRubric}
              demandId={demandId ?? undefined}
              onAsk={(question, category) => flow.askCustom(question, category)}
              generatedPlan={flow.plan}
              generating={flow.running && flow.plan.flatMap((c) => c.questions ?? []).length === 0}
            />
          </div>
          <div className="col-span-12 xl:col-span-7 row-span-7 min-h-0">
            <InterviewFlowPanel
              running={flow.running}
              live={live}
              snapshot={flow.snapshot}
              current={flow.current}
              history={flow.history}
              latest={flow.latest}
              finalScore={flow.finalScore}
              status={flow.status}
              onMarkAnswered={flow.markAnswered}
              onSkip={flow.skip}
              onForceTick={flow.forceTick}
              onEnd={flow.endNow}
            />
          </div>
          <div className="col-span-12 xl:col-span-5 row-span-4 min-h-0">
            <KnowledgeCard citations={sourceCitations} limit={10} />
          </div>
          <div className="col-span-12 xl:col-span-5 row-span-3 min-h-0">
            <SentimentCard
              series={sentimentSeries}
              current={sentimentCurrent}
              trend={sentimentTrend}
              compact
            />
          </div>
        </section>
      </div>

      <CreateCandidateModal
        open={createModal.open}
        initialMode={createModal.mode}
        onClose={() => setCreateModal((s) => ({ ...s, open: false }))}
        onCreated={(id) => {
          setCandidateId(id);
          setProspectId(null);
          setCreateModal((s) => ({ ...s, open: false }));
        }}
        onUseExisting={(id) => {
          setCandidateId(id);
          setProspectId(null);
          setCreateModal((s) => ({ ...s, open: false }));
        }}
      />
    </div>
  );
}

/* ------------------------------ Call bar ------------------------------ */

function CallBar({
  status,
  callId,
  elapsed,
  canStart,
  onStart,
  onEnd,
  transcriptionProvider,
  transcriptionModel,
  onTranscriptionProviderChange,
  onTranscriptionModelChange,
  showDemoButton,
  onStartDemo,
}: {
  status: WedgeStatus;
  callId: string | null;
  elapsed: number;
  canStart: boolean;
  onStart: () => void;
  onEnd: () => void;
  transcriptionProvider: TranscriptionProvider;
  transcriptionModel: string;
  onTranscriptionProviderChange: (p: TranscriptionProvider) => void;
  onTranscriptionModelChange: (m: string) => void;
  showDemoButton?: boolean;
  onStartDemo?: () => void;
}) {
  const isLive = status === "live";
  const callActive = status === "live" || status === "ending";
  const pillText =
    status === "live"
      ? "live"
      : status === "ending"
        ? "ending"
        : status === "ended"
          ? "ended"
          : status === "creating"
            ? "starting"
            : status === "ready"
              ? "ready"
              : status === "error"
                ? "error"
                : "idle";

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
            : status === "error"
              ? "bg-destructive/15 text-destructive"
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
                {isLive ? "Call in progress" : status === "ended" ? "Call ended" : "Call ready"}
              </div>
              <div className="text-[11px] text-muted-foreground truncate font-mono">
                {callId}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              title="Copy call ID"
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
            Pick a demand and a prospect, then <b>Start live-assist call</b>.
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        <TranscriberSwitcher
          provider={transcriptionProvider}
          model={transcriptionModel}
          onProviderChange={onTranscriptionProviderChange}
          onModelChange={onTranscriptionModelChange}
          disabled={isLive || status === "creating" || status === "ending"}
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

        {!callActive ? (
          <>
            {showDemoButton && onStartDemo && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={onStartDemo}
                title="Demo-only: replay a scripted recruiter call into every panel"
              >
                <Phone className="w-4 h-4" />
                <span className="hidden sm:inline">Start test call</span>
              </Button>
            )}
            <Button
              size="sm"
              className="h-8"
              onClick={onStart}
              disabled={!canStart || status === "creating"}
            >
              <Phone className="w-4 h-4" />
              <span className="hidden sm:inline">
                {status === "creating" ? "Starting…" : "Start live-assist call"}
              </span>
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            className="h-8"
            onClick={onEnd}
            disabled={status === "ending"}
          >
            <PhoneOff className="w-4 h-4" />
            <span className="hidden sm:inline">End</span>
          </Button>
        )}
      </div>
    </div>
  );
}

/* ----- Pre-call picker (renders in the candidate-context slot) ----- */

function SetupPicker({
  demands,
  demandId,
  onPickDemand,
  prospects,
  prospectId,
  onPickProspect,
  search,
  onSearch,
  candidatePool,
  candidateId,
  onPickCandidate,
  onRequestCreateCandidate,
  selectedDemand,
  selectedProspect,
  selectedCandidate,
  status,
  errorMessage,
}: {
  demands: DemandListItem[];
  demandId: string | null;
  onPickDemand: (id: string) => void;
  prospects: DemandProspectRow[];
  prospectId: string | null;
  onPickProspect: (p: DemandProspectRow) => void;
  search: string;
  onSearch: (s: string) => void;
  candidatePool: CandidateListItem[];
  candidateId: string | null;
  onPickCandidate: (id: string) => void;
  onRequestCreateCandidate: (mode: CreateMode) => void;
  selectedDemand: DemandListItem | undefined;
  selectedProspect: DemandProspectRow | undefined;
  selectedCandidate: CandidateListItem | undefined;
  status: WedgeStatus;
  errorMessage: string | null;
}) {
  const [demandsOpen, setDemandsOpen] = useState(!demandId);
  const [demandSearch, setDemandSearch] = useState("");

  const demandMatches = useMemo(() => {
    const q = demandSearch.trim().toLowerCase();
    if (!q) return demands;
    return demands.filter((d) => {
      const hay = [d.title, d.clientName, d.primaryLocation, d.designation]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [demands, demandSearch]);

  // The candidate pool returns the full org-scoped list when unfiltered; we
  // do client-side filtering for instant feedback so newly-created candidates
  // surface without waiting for a server round trip.
  const candidateMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidatePool;
    return candidatePool.filter((c) => {
      const hay = [c.displayName, c.email, c.currentTitle, c.currentCompany]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [candidatePool, search]);

  const showCandidate =
    selectedCandidate && (!selectedProspect || candidateId !== selectedProspect.candidateId);

  return (
    <div className="h-full bg-card border border-border rounded-lg flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wide">Set up the call</h2>
        <span className="text-[11px] text-muted-foreground">
          {selectedDemand && (selectedProspect || selectedCandidate)
            ? "Ready to start"
            : "Pick demand · candidate"}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-3 gap-3">
        {/* Demand selector — collapsed once a demand is picked */}
        <div className="shrink-0">
          <button
            type="button"
            className="w-full flex items-center gap-2 text-left p-2 rounded-md border border-border bg-background hover:bg-muted/40"
            onClick={() => setDemandsOpen((o) => !o)}
          >
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
              Demand
            </span>
            <div className="min-w-0 flex-1">
              {selectedDemand ? (
                <>
                  <div className="text-sm font-medium truncate">{selectedDemand.title}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {selectedDemand.clientName ?? "—"} · {selectedDemand.primaryLocation ?? "—"}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">Pick a demand…</div>
              )}
            </div>
            <ChevronDown
              className={cn(
                "w-4 h-4 text-muted-foreground transition-transform",
                demandsOpen && "rotate-180",
              )}
            />
          </button>
          {demandsOpen && (
            <div className="mt-1.5 space-y-1.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={demandSearch}
                  onChange={(e) => setDemandSearch(e.target.value)}
                  placeholder="Search title, company, or location"
                  className="h-8 pl-8 text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {demands.length === 0 && (
                  <div className="text-xs text-muted-foreground p-2">
                    No demands assigned to you yet.
                  </div>
                )}
                {demands.length > 0 && demandMatches.length === 0 && (
                  <div className="text-xs text-muted-foreground p-2">No matches.</div>
                )}
                {demandMatches.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={cn(
                      "w-full text-left p-2 rounded-md border text-xs",
                      demandId === d.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-card hover:bg-muted/40",
                    )}
                    onClick={() => {
                      onPickDemand(d.id);
                      setDemandsOpen(false);
                      setDemandSearch("");
                    }}
                  >
                    <div className="font-medium truncate">{d.title}</div>
                    <div className="text-muted-foreground truncate">
                      {d.clientName ?? "—"} · {d.primaryLocation ?? "—"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Prospects on this demand — only when there are any */}
        {demandId && prospects.length > 0 && (
          <div className="shrink-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Prospects on this demand
            </div>
            <div className="space-y-1">
              {prospects.slice(0, 3).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={cn(
                    "w-full text-left p-2 rounded-md border text-xs",
                    prospectId === p.id
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:bg-muted/40",
                  )}
                  onClick={() => onPickProspect(p)}
                >
                  <div className="font-medium truncate">{p.candidateName ?? "—"}</div>
                  <div className="text-muted-foreground truncate">
                    {p.currentTitle} · {p.status}
                  </div>
                </button>
              ))}
              {prospects.length > 3 && (
                <div className="text-[11px] text-muted-foreground px-1">
                  + {prospects.length - 3} more — search by name below
                </div>
              )}
            </div>
          </div>
        )}

        {/* Candidate pool — fills the remaining vertical space */}
        {demandId && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {prospects.length > 0 ? "Or any candidate" : "Candidate"}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <UserPlus className="w-3 h-3" /> New
                    <ChevronDown className="w-3 h-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => onRequestCreateCandidate("manual")}>
                    <Pencil className="w-3.5 h-3.5 mr-2" />
                    <div>
                      <div className="text-sm">Type details in</div>
                      <div className="text-[11px] text-muted-foreground">Quick manual entry</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onRequestCreateCandidate("from-resume")}>
                    <FileText className="w-3.5 h-3.5 mr-2" />
                    <div>
                      <div className="text-sm">Upload a resume</div>
                      <div className="text-[11px] text-muted-foreground">AI fills the form for you</div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="shrink-0 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Search name or company"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto mt-1.5 space-y-1">
              {candidateMatches.length === 0 && (
                <div className="text-xs text-muted-foreground p-2">
                  {search.trim()
                    ? "No matches."
                    : "No candidates yet — create one with the New link above."}
                </div>
              )}
              {candidateMatches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn(
                    "w-full text-left p-2 rounded-md border text-xs",
                    showCandidate && candidateId === c.id
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:bg-muted/40",
                  )}
                  onClick={() => onPickCandidate(c.id)}
                >
                  <div className="font-medium truncate">{c.displayName ?? "—"}</div>
                  <div className="text-muted-foreground truncate">
                    {c.currentTitle ?? "—"}
                    {c.currentCompany ? ` @ ${c.currentCompany}` : ""}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {(status === "creating" || status === "ready") && (
          <div className="shrink-0 text-xs text-muted-foreground border-l-2 border-primary/40 bg-primary/5 p-2">
            Connecting…
          </div>
        )}
        {status === "error" && errorMessage && (
          <div className="shrink-0 text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded p-2 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------- Demo helpers (only used on the demo tenant) ----------- */

// Map demo runner status to the WedgeStatus enum the CallBar already
// understands so we don't have to teach it a new vocabulary.
function demoStatusToWedge(s: "idle" | "live" | "ended"): WedgeStatus {
  if (s === "live") return "live";
  if (s === "ended") return "ended";
  return "idle";
}

// Stand-in for the real CandidateContext while a demo call is running.
// The real component fetches via /api/calls/:id/context — we don't have a
// real call id, so render a stylistically similar card with canned content.
function DemoCandidateContext() {
  return (
    <div className="h-full bg-card border border-border rounded-lg p-3 flex flex-col gap-3 overflow-y-auto">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Candidate · Demand
        </div>
        <div className="text-sm font-semibold">Aarav Sharma</div>
        <div className="text-xs text-muted-foreground">
          Senior Software Engineer @ Razorpay · Bengaluru
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Current CTC" value="₹32 LPA total" />
        <Field label="Expected" value="₹40-45 fixed" />
        <Field label="Notice" value="60d (negotiable)" />
        <Field label="Location" value="Bengaluru · hybrid" />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Calling against
        </div>
        <div className="text-xs font-medium">Senior Java Backend Engineer</div>
        <div className="text-[11px] text-muted-foreground">
          Acme GCC India · ₹22-38 LPA · VIP demand
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
          Must-haves
        </div>
        <div className="flex flex-wrap gap-1">
          {["Java", "Spring Boot", "Microservices", "Kafka", "AWS"].map((s) => (
            <span
              key={s}
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground border-t pt-2">
        Demo · scripted call
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs font-medium truncate">{value}</div>
    </div>
  );
}
