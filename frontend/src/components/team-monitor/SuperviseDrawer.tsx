// Supervisor intervention drawer for a live call. Shows the live transcript
// tail (real, polled from /supervise/feed), an audio-monitor element wired to
// the provider listenUrl when present (else a clear "audio unavailable —
// transcript live" state), and Whisper / Barge / Takeover buttons. Takeover
// requires an explicit confirm. All actions are permission-gated via useCan.
import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Ear, Mic, ArrowLeftRight, Loader2, Volume2, VolumeX, Square } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useSuperviseFeed,
  useSupervise,
  useEndSupervision,
  type LiveCallRow,
  type SupervisionMode,
} from "@/hooks/useTeamMonitor";

const SUPERVISE_ERR: Record<string, string> = {
  call_not_active: "This call is no longer active.",
  cannot_supervise_own_call: "You can't supervise your own call.",
  not_found: "Call not found.",
};

export function SuperviseDrawer({
  call,
  open,
  onOpenChange,
}: {
  call: LiveCallRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const canSupervise = useCan("team_monitor.supervise");
  const feed = useSuperviseFeed(open && call ? call.id : null);
  const supervise = useSupervise();
  const endSupervision = useEndSupervision();
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<SupervisionMode | null>(null);
  const [confirmTakeover, setConfirmTakeover] = useState(false);

  useEffect(() => {
    if (!open) {
      setSessionId(null);
      setActiveMode(null);
      setConfirmTakeover(false);
    }
  }, [open]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "nearest" });
  }, [feed.data?.transcript.length]);

  if (!call) return null;

  const audio = feed.data?.audio;
  const audioLive = audio?.provider === "vapi" && !!audio.listenUrl;

  async function start(mode: SupervisionMode) {
    if (!call) return;
    try {
      const res = await supervise.mutateAsync({ callId: call.id, mode });
      setSessionId(res.session.id);
      setActiveMode(mode);
      toast.success(`${labelOf(mode)} started`);
    } catch (err) {
      const e = err as { body?: { error?: string } };
      const code = e.body?.error;
      toast.error((code && SUPERVISE_ERR[code]) || code || "Couldn't start supervision");
    }
  }

  async function stop() {
    if (!sessionId) return;
    try {
      await endSupervision.mutateAsync({ sessionId });
      setSessionId(null);
      setActiveMode(null);
      toast.success("Supervision ended");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't end supervision");
    }
  }

  const busy = supervise.isPending || endSupervision.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col">
        <SheetHeader>
          <SheetTitle>Supervise live call</SheetTitle>
          <SheetDescription>
            {call.candidateName ?? "Candidate"}
            {call.recruiterName ? ` · ${call.recruiterName}` : ""}
            {call.demandTitle ? ` · ${call.demandTitle}` : ""}
          </SheetDescription>
        </SheetHeader>

        {/* Audio monitor state */}
        <div
          className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 flex items-center gap-2 text-xs"
          data-testid="audio-state"
        >
          {audioLive ? (
            <>
              <Volume2 className="w-4 h-4 text-emerald-600" />
              <span>Audio monitor live</span>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={audio!.listenUrl!} controls autoPlay className="ml-auto h-7" />
            </>
          ) : (
            <>
              <VolumeX className="w-4 h-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                Audio monitor unavailable for this call type — transcript live below.
              </span>
            </>
          )}
        </div>

        {/* Intervention controls */}
        <div className="mt-3">
          {activeMode ? (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <span className="text-xs font-medium" data-testid="active-mode-banner">
                {labelOf(activeMode)} active
              </span>
              <Button size="sm" variant="outline" disabled={busy} onClick={stop}>
                {endSupervision.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Square className="w-3.5 h-3.5 mr-1.5" />
                )}
                End
              </Button>
            </div>
          ) : (
            <TooltipProvider>
              <div className="grid grid-cols-3 gap-2">
                <Gated can={canSupervise}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canSupervise || busy}
                    onClick={() => start("whisper")}
                    data-testid="whisper-btn"
                  >
                    <Ear className="w-3.5 h-3.5 mr-1.5" /> Whisper
                  </Button>
                </Gated>
                <Gated can={canSupervise}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canSupervise || busy}
                    onClick={() => start("barge")}
                    data-testid="barge-btn"
                  >
                    <Mic className="w-3.5 h-3.5 mr-1.5" /> Barge
                  </Button>
                </Gated>
                <Gated can={canSupervise}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canSupervise || busy}
                    onClick={() => setConfirmTakeover(true)}
                    data-testid="takeover-btn"
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 mr-1.5" /> Takeover
                  </Button>
                </Gated>
              </div>
            </TooltipProvider>
          )}
          {confirmTakeover && (
            <div
              className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3"
              role="alertdialog"
              aria-describedby="takeover-desc"
            >
              <p id="takeover-desc" className="text-xs text-amber-900">
                Takeover removes the recruiter from the call and routes it to you. Continue?
              </p>
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setConfirmTakeover(false);
                    await start("takeover");
                  }}
                  data-testid="takeover-confirm"
                >
                  Take over
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmTakeover(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Live transcript tail */}
        <div className="mt-3 flex-1 min-h-0 flex flex-col">
          <div className="text-xs font-medium mb-1.5">Live transcript</div>
          <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border p-3 space-y-1.5 bg-card">
            {feed.isLoading ? (
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading transcript…
              </div>
            ) : (feed.data?.transcript.length ?? 0) === 0 ? (
              <div className="text-xs text-muted-foreground">No transcript yet for this call.</div>
            ) : (
              feed.data!.transcript.map((t) => (
                <div key={t.id} className="text-xs">
                  <span className="font-medium capitalize text-muted-foreground mr-1.5">
                    {t.speaker ?? "speaker"}:
                  </span>
                  <span>{t.text}</span>
                </div>
              ))
            )}
            <div ref={transcriptEnd} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function labelOf(mode: SupervisionMode): string {
  return mode === "whisper" ? "Whisper" : mode === "barge" ? "Barge" : "Takeover";
}

function Gated({ can, children }: { can: boolean; children: React.ReactNode }) {
  if (can) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block w-full">{children}</span>
      </TooltipTrigger>
      <TooltipContent>Requires supervisor permission</TooltipContent>
    </Tooltip>
  );
}
