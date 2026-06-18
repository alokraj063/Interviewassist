import { useState } from "react";
import { X, Shuffle, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useReassignSession,
  useTerminateSession,
  useTriageDestinations,
} from "@/hooks/useTriage";
import { ReassignDialog } from "@/components/triage/dialogs/ReassignDialog";
import { TerminateDialog } from "@/components/triage/dialogs/TerminateDialog";

interface Props {
  selectedIds: string[];
  onClear: () => void;
}

export function BulkSessionBar({ selectedIds, onClear }: Props) {
  const [reassignOpen, setReassignOpen] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const destinations = useTriageDestinations();
  const reassign = useReassignSession();
  const terminate = useTerminateSession();

  if (selectedIds.length === 0) return null;

  async function runBulk<T>(
    fn: (callId: string) => Promise<T>,
    label: string,
  ): Promise<void> {
    const results = await Promise.allSettled(selectedIds.map((id) => fn(id)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (failed === 0) {
      toast.success(`${label} ${ok} call${ok === 1 ? "" : "s"}`);
    } else {
      toast.warning(`${label} ${ok}/${results.length} — ${failed} failed`);
    }
    onClear();
  }

  return (
    <>
      <div
        className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2"
        role="region"
        aria-label="Bulk actions"
      >
        <span className="text-sm font-medium">
          {selectedIds.length} selected
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setReassignOpen(true)}
            disabled={reassign.isPending}
          >
            <Shuffle className="w-3.5 h-3.5 mr-1.5" />
            Reassign selected
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs text-destructive"
            onClick={() => setTerminateOpen(true)}
            disabled={terminate.isPending}
          >
            <PhoneOff className="w-3.5 h-3.5 mr-1.5" />
            Terminate selected
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClear} aria-label="Clear selection">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <ReassignDialog
        open={reassignOpen}
        onOpenChange={setReassignOpen}
        humanTeams={destinations.data?.humanTeams ?? []}
        voiceAgents={destinations.data?.voiceAgents ?? []}
        pending={reassign.isPending}
        onSubmit={async (input) => {
          setReassignOpen(false);
          await runBulk(
            (callId) => reassign.mutateAsync({ callId, input }),
            "Reassigned",
          );
        }}
      />

      <TerminateDialog
        open={terminateOpen}
        onOpenChange={setTerminateOpen}
        callerRef={`${selectedIds.length} calls`}
        pending={terminate.isPending}
        onSubmit={async (reason) => {
          setTerminateOpen(false);
          await runBulk(
            (callId) => terminate.mutateAsync({ callId, reason }),
            "Terminated",
          );
        }}
      />
    </>
  );
}
