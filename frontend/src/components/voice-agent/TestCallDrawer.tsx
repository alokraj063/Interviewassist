import { useEffect, useState } from "react";
import { Mic, PhoneOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTestCallTicket } from "@/hooks/useVoiceAgents";
import { useVapiTestCall } from "@/hooks/useVapiTestCall";

export interface TestCallDrawerProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TestCallDrawer({ agentId, open, onOpenChange }: TestCallDrawerProps) {
  const ticket = useTestCallTicket(agentId);
  const { state, error, transcript, volume, start, stop } = useVapiTestCall();
  const [started, setStarted] = useState(false);

  // Auto-start the call when the drawer opens — the user explicitly clicked
  // "Test in browser", so a confirmation step would just add friction.
  useEffect(() => {
    if (!open) {
      stop();
      setStarted(false);
      return;
    }
    if (started) return;
    setStarted(true);
    (async () => {
      try {
        const t = await ticket.mutateAsync();
        await start(t);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not start test call",
        );
      }
    })();
  }, [open, started, ticket, start, stop]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Test call</SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          <div className="flex items-center gap-3 p-4 border border-border rounded">
            <div
              className={cn(
                "w-12 h-12 rounded-full inline-flex items-center justify-center",
                state === "active"
                  ? "bg-success/20 text-success"
                  : state === "error"
                    ? "bg-destructive/20 text-destructive"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {state === "connecting" ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </div>
            <div className="flex-1">
              <div className="text-sm font-medium capitalize">{state}</div>
              <div className="text-xs text-muted-foreground">
                {state === "active"
                  ? "Speak — the agent is listening."
                  : state === "connecting"
                    ? "Connecting…"
                    : state === "ended"
                      ? "Call ended."
                      : state === "error"
                        ? (error ?? "An error occurred")
                        : "Waiting to start."}
              </div>
            </div>
            {state === "active" ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  stop();
                  onOpenChange(false);
                }}
              >
                <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
                End
              </Button>
            ) : null}
          </div>

          {state === "active" && (
            <div className="h-1.5 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.min(100, Math.round(volume * 100))}%` }}
              />
            </div>
          )}

          <div className="border border-border rounded min-h-[300px] max-h-[50vh] overflow-y-auto p-3 space-y-2 bg-muted/20">
            {transcript.length === 0 ? (
              <div className="text-xs text-muted-foreground italic text-center py-8">
                Transcript will appear here once the call starts.
              </div>
            ) : (
              transcript.map((t, i) => (
                <div
                  key={i}
                  className={cn(
                    "text-sm p-2 rounded max-w-[85%]",
                    t.role === "assistant"
                      ? "bg-primary/10 text-foreground"
                      : "bg-background border border-border ml-auto",
                  )}
                >
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                    {t.role === "assistant" ? "Agent" : "You"}
                  </div>
                  {t.text}
                </div>
              ))
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
