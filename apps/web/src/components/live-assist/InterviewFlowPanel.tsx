// The structured interview-flow panel — replaces the old free-form suggestion
// card. Always shows exactly ONE current question to ask, whether the last
// answer was accepted, and the running Q&A history. No random generation.
import { Check, SkipForward, RefreshCw, Flag, Mic, CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  CurrentQuestion,
  FinalScore,
  FlowSnapshot,
  HistoryEntry,
  LatestVerdict,
} from "@/hooks/useInterviewFlow";

interface Props {
  running: boolean;
  live: boolean; // the call is live (audio flowing)
  snapshot: FlowSnapshot | null;
  current: CurrentQuestion | null;
  history: HistoryEntry[];
  latest: LatestVerdict | null;
  finalScore: FinalScore | null;
  status: { text: string; kind: "" | "ok" | "error" };
  onMarkAnswered: () => void;
  onSkip: () => void;
  onForceTick: () => void;
  onEnd: () => void;
}

const VERDICT_PILL: Record<string, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  weak: "bg-amber-50 text-amber-700 border-amber-200",
  bad: "bg-rose-50 text-rose-700 border-rose-200",
};

export function InterviewFlowPanel({
  running, live, snapshot, current, history, latest, finalScore, status,
  onMarkAnswered, onSkip, onForceTick, onEnd,
}: Props) {
  return (
    <div className="h-full bg-card border border-border rounded-lg flex flex-col min-h-0">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
          <CircleHelp className="w-3.5 h-3.5" /> Interview flow
        </h2>
        {running && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {history.length} answered
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {/* Pre-start / fit snapshot */}
        {!running && !finalScore && (
          <div className="text-xs text-muted-foreground p-4 text-center">
            {live
              ? status.text || "Building the interview plan…"
              : "Start the call to begin the guided interview. The co-pilot will read the JD + candidate and drive one question at a time."}
          </div>
        )}

        {snapshot && (
          <div className="rounded-md border border-border bg-muted/30 p-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Pre-call fit</span>
              <span className="text-[11px] font-semibold">{snapshot.fitVerdict}</span>
            </div>
            {snapshot.summary && <p className="text-xs text-foreground/80">{snapshot.summary}</p>}
            {snapshot.gaps.length > 0 && (
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">Probe: </span>{snapshot.gaps.join(" · ")}
              </div>
            )}
          </div>
        )}

        {/* THE current question */}
        {current && (
          <div className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wide font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                {current.category}
              </span>
              <span className="text-[10px] text-muted-foreground">Ask this now</span>
            </div>
            <p className="text-[15px] leading-snug font-medium">{current.question}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <button onClick={onMarkAnswered} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
                <Check className="w-3.5 h-3.5" /> Answered
              </button>
              <button onClick={onForceTick} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted/50">
                <RefreshCw className="w-3.5 h-3.5" /> Re-check
              </button>
              <button onClick={onSkip} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-muted/50">
                <SkipForward className="w-3.5 h-3.5" /> Skip
              </button>
              <button onClick={onEnd} className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10">
                <Flag className="w-3.5 h-3.5" /> End & score
              </button>
            </div>
          </div>
        )}

        {/* Live verdict on the answer so far */}
        {latest && current && (
          <div className={cn("rounded-md border p-2.5 text-xs", VERDICT_PILL[latest.kind] || "border-border")}>
            <div className="flex items-center gap-1.5 mb-0.5">
              <Mic className="w-3.5 h-3.5" />
              <span className="font-semibold">{latest.verdict}</span>
              <span className="opacity-70">— is the answer landing?</span>
            </div>
            {latest.feedback && <p>{latest.feedback}</p>}
            {latest.followUp && (
              <p className="mt-1 italic opacity-80">Probe: "{latest.followUp}"</p>
            )}
          </div>
        )}

        {status.kind === "error" && (
          <div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded p-2">
            {status.text}
          </div>
        )}

        {/* Final score */}
        {finalScore && (
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold">Final: {finalScore.verdict}</span>
              <span className="text-2xl font-bold tabular-nums">{finalScore.score.overall ?? "—"}</span>
            </div>
            {finalScore.saved && (
              <div className="text-[10px] text-emerald-600 inline-flex items-center gap-1 mb-1">
                <Check className="w-3 h-3" /> Saved to the call record
              </div>
            )}
            {finalScore.summary && <p className="text-xs text-muted-foreground mb-2">{finalScore.summary}</p>}
            {finalScore.concerns?.length > 0 && (
              <div className="text-[11px] text-muted-foreground mb-2">
                <span className="font-medium">Concerns: </span>{finalScore.concerns.join(" · ")}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              {(["communication", "relevance", "depth", "skills_match"] as const).map((k) => (
                <div key={k} className="flex justify-between">
                  <span className="capitalize text-muted-foreground">{k.replace("_", " ")}</span>
                  <span className="tabular-nums font-medium">{finalScore.score[k] ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Answered history */}
        {history.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Asked & answered</div>
            {history.map((h, i) => (
              <div key={i} className="rounded-md border border-border p-2 text-xs">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{h.category}</span>
                  <span className={cn(
                    "text-[9px] px-1 rounded font-medium",
                    h.verdict === "Skipped" ? "bg-muted text-muted-foreground"
                      : /strong|adequate|manually/i.test(h.verdict) ? "bg-emerald-50 text-emerald-700"
                        : "bg-amber-50 text-amber-700",
                  )}>{h.verdict}</span>
                </div>
                <p className="font-medium leading-snug">{h.question}</p>
                {h.answer && <p className="text-muted-foreground mt-0.5 line-clamp-2">{h.answer}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
