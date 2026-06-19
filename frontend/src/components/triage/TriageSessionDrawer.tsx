import { formatDistanceToNowStrict } from "date-fns";
import { Phone, Clock, GitBranch, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { TranscriptPanel } from "@/components/live/TranscriptPanel";
import { ClassificationCard } from "@/components/triage/ClassificationCard";
import { useTriageSession } from "@/hooks/useTriage";
import type { TriageSessionDetail } from "@j2w/shared-types";

interface TriageSessionDrawerProps {
  callId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function statusIcon(status: TriageSessionDetail["status"]) {
  if (status === "completed") return CheckCircle2;
  if (status === "failed") return AlertTriangle;
  return Loader2;
}

function statusLabel(status: TriageSessionDetail["status"]) {
  switch (status) {
    case "classifying":
      return "Classifying intent";
    case "decided":
      return "Decision made";
    case "handing_off":
      return "Handing off";
    case "completed":
      return "Handoff complete";
    case "failed":
      return "Handoff failed";
  }
}

function formatElapsed(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TriageSessionDrawer({ callId, open, onOpenChange }: TriageSessionDrawerProps) {
  const { data, isLoading } = useTriageSession(callId ?? undefined);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(100vw,720px)] sm:max-w-[720px] p-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle className="text-base font-semibold flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-primary" />
            Triage session
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{callId ?? "—"}</SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Loading session…
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-5 gap-0">
            <div className="col-span-3 min-h-0 border-r border-border flex flex-col">
              <div className="shrink-0 px-5 py-3 border-b border-border flex items-center gap-3 flex-wrap">
                <SessionBadge status={data.status} />
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Phone className="w-3 h-3" />
                  <span className="font-mono">{data.callerRef}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="w-3 h-3" />
                  {formatElapsed(data.elapsedSec)}
                </span>
                {data.destinationLabel && (
                  <span className="ml-auto pill bg-primary/15 text-primary text-[11px]">
                    → {data.destinationLabel}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 p-3">
                <TranscriptPanel
                  turns={data.turns}
                  state={data.status === "completed" || data.status === "failed" ? "ended" : "live"}
                  title="Triage conversation"
                  showStatusAction={true}
                  elapsed={data.elapsedSec}
                />
              </div>
            </div>
            <div className="col-span-2 min-h-0 overflow-y-auto p-4 space-y-3">
              <ClassificationCard classification={data.classification} />

              <div className="bg-card border border-border rounded-lg">
                <div className="px-3 py-2 border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                  Timeline
                </div>
                <ol className="p-3 space-y-2.5">
                  {data.timeline.map((t, i) => (
                    <li key={i} className="flex items-start gap-2.5">
                      <div
                        className={cn(
                          "mt-0.5 w-1.5 h-1.5 rounded-full shrink-0",
                          t.kind === "handoff_completed"
                            ? "bg-success"
                            : t.kind === "route_decision" || t.kind === "handoff_initiated"
                              ? "bg-primary"
                              : "bg-muted-foreground/50",
                        )}
                      />
                      <div className="min-w-0">
                        <div className="text-sm leading-tight">{t.label}</div>
                        <div className="text-[10px] text-muted-foreground tabular-nums">
                          {formatDistanceToNowStrict(new Date(t.t), { addSuffix: true })}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="bg-card border border-border rounded-lg p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                  Caller
                </div>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Phone</span>
                    <span className="font-mono">{data.callerRef}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Started</span>
                    <span>{new Date(data.startedAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Flow</span>
                    <span>{data.flowName}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function SessionBadge({ status }: { status: TriageSessionDetail["status"] }) {
  const Icon = statusIcon(status);
  const tone =
    status === "completed"
      ? "bg-success/15 text-success"
      : status === "failed"
        ? "bg-destructive/15 text-destructive"
        : status === "handing_off"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground";
  return (
    <span className={cn("pill text-[11px] font-semibold inline-flex items-center gap-1.5", tone)}>
      <Icon
        className={cn(
          "w-3 h-3",
          (status === "classifying" || status === "handing_off") && "animate-spin",
        )}
      />
      {statusLabel(status)}
    </span>
  );
}
