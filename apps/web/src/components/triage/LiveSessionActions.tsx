import { useState } from "react";
import { MoreHorizontal, Shuffle, Tag, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useReassignSession,
  useOverrideClassification,
  useTerminateSession,
  useTriageDestinations,
} from "@/hooks/useTriage";
import type { LiveTriageSession, TriageDestinationType } from "@j2w/shared-types";
import { ReassignDialog } from "@/components/triage/dialogs/ReassignDialog";
import { OverrideDialog } from "@/components/triage/dialogs/OverrideDialog";
import { TerminateDialog } from "@/components/triage/dialogs/TerminateDialog";

interface Props {
  session: LiveTriageSession;
  canOperate: boolean;
  intentVocabulary: string[];
}

export function LiveSessionActions({ session, canOperate, intentVocabulary }: Props) {
  const [reassignOpen, setReassignOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);

  const destinations = useTriageDestinations();
  const reassign = useReassignSession();
  const override = useOverrideClassification();
  const terminate = useTerminateSession();

  const open = session.status !== "completed" && session.status !== "failed";

  if (!canOperate) {
    return (
      <span
        className="text-[11px] text-muted-foreground"
        title="You need triage.operate to act on live calls"
        data-testid="operate-readonly"
      >
        Read-only
      </span>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={`Actions for ${session.callerRef}`}
            data-testid="session-actions-trigger"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => setReassignOpen(true)}>
            <Shuffle className="w-3.5 h-3.5 mr-2" />
            Reassign…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOverrideOpen(true)}>
            <Tag className="w-3.5 h-3.5 mr-2" />
            Override classification…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!open}
            className="text-destructive focus:text-destructive"
            onSelect={() => setTerminateOpen(true)}
          >
            <PhoneOff className="w-3.5 h-3.5 mr-2" />
            Terminate call…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ReassignDialog
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        humanTeams={destinations.data?.humanTeams ?? []}
        voiceAgents={destinations.data?.voiceAgents ?? []}
        pending={reassign.isPending}
        onSubmit={async (input) => {
          try {
            await reassign.mutateAsync({ callId: session.callId, input });
            toast.success(`Reassigned to ${input.destinationLabel ?? input.destinationRef}`);
            setReassignOpen(false);
          } catch (err) {
            toast.error(errMsg(err, "Reassign failed"));
          }
        }}
      />

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        currentIntent={session.classification.intent}
        intentVocabulary={intentVocabulary}
        pending={override.isPending}
        onSubmit={async (input) => {
          try {
            const res = await override.mutateAsync({ callId: session.callId, input });
            toast.success(
              res.destinationLabel
                ? `Re-routed to ${res.destinationLabel}`
                : "Classification updated (no matching rule)",
            );
            setOverrideOpen(false);
          } catch (err) {
            toast.error(errMsg(err, "Override failed"));
          }
        }}
      />

      <TerminateDialog
        open={terminateOpen}
        onOpenChange={setTerminateOpen}
        callerRef={session.callerRef}
        pending={terminate.isPending}
        onSubmit={async (reason) => {
          try {
            await terminate.mutateAsync({ callId: session.callId, reason });
            toast.success("Call terminated");
            setTerminateOpen(false);
          } catch (err) {
            // External dependency (Vapi) gating surfaces as a graceful toast,
            // never a white-screen.
            if ((err as { status?: number; body?: { error?: string } }).status === 503) {
              toast.error("Telephony not configured — cannot end the live call (Vapi missing).");
            } else {
              toast.error(errMsg(err, "Terminate failed"));
            }
          }
        }}
      />
    </>
  );
}

function errMsg(err: unknown, fallback: string): string {
  const body = (err as { body?: { error?: string } }).body;
  if (body?.error) return body.error.replace(/_/g, " ");
  return err instanceof Error ? err.message : fallback;
}

export type { TriageDestinationType };
