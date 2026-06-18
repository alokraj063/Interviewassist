// Reassign a queued/assigned call to another recruiter. Searchable target list
// (from the live roster), required reason. Disabled-until-valid. Server errors
// (e.g. call_active_use_takeover) surface inline rather than as a blind toast.
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useReassign, useRoster, type LiveCallRow } from "@/hooks/useTeamMonitor";

const REASSIGN_ERR: Record<string, string> = {
  call_active_use_takeover: "This call is live — use Takeover instead of reassigning.",
  call_ended: "This call has already ended.",
  target_not_found: "That recruiter isn't a member of this org.",
  not_found: "Call not found.",
};

export function ReassignDialog({
  call,
  open,
  onOpenChange,
}: {
  call: LiveCallRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const reassign = useReassign();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<{ userId: string; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const [serverErr, setServerErr] = useState<string | null>(null);

  const roster = useRoster({ q: search || undefined, limit: 20 });
  const candidates = (roster.data?.rows ?? []).filter((r) => r.userId !== call?.recruiterUserId);

  const canSubmit = !!target && reason.trim().length > 0 && !reassign.isPending;

  async function submit() {
    if (!call || !target || !reason.trim()) return;
    setServerErr(null);
    try {
      await reassign.mutateAsync({ callId: call.id, toUserId: target.userId, reason: reason.trim() });
      toast.success(`Call reassigned to ${target.name}`);
      reset();
      onOpenChange(false);
    } catch (err) {
      const e = err as { body?: { error?: string } };
      const code = e.body?.error;
      setServerErr((code && REASSIGN_ERR[code]) || code || "Reassign failed");
    }
  }

  function reset() {
    setSearch("");
    setTarget(null);
    setReason("");
    setServerErr(null);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign call</DialogTitle>
          <DialogDescription>
            Move {call?.candidateName ?? "this candidate"}'s queued call to another recruiter.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div>
            <label className="text-xs font-medium block mb-1">Target recruiter</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                aria-label="Search recruiters"
                placeholder="Search recruiters…"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setTarget(null);
                }}
              />
            </div>
            <div className="mt-1.5 max-h-44 overflow-y-auto border border-border rounded-md divide-y divide-border">
              {roster.isLoading ? (
                <div className="p-3 text-xs text-muted-foreground">Loading recruiters…</div>
              ) : candidates.length === 0 ? (
                <div className="p-3 text-xs text-muted-foreground">No recruiters match.</div>
              ) : (
                candidates.map((r) => (
                  <button
                    key={r.userId}
                    type="button"
                    onClick={() => setTarget({ userId: r.userId, name: r.name ?? r.email })}
                    className={cn(
                      "w-full text-left px-3 py-2 text-xs hover:bg-muted/40",
                      target?.userId === r.userId && "bg-primary/10",
                    )}
                  >
                    <span className="font-medium">{r.name ?? r.email}</span>
                    <span className="text-muted-foreground ml-2 capitalize">
                      {(r.role ?? "").replace(/_/g, " ")}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div>
            <label htmlFor="reassign-reason" className="text-xs font-medium block mb-1">
              Reason <span className="text-destructive">*</span>
            </label>
            <Textarea
              id="reassign-reason"
              rows={2}
              placeholder="Why move this call?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {serverErr && (
            <p className="text-xs text-destructive" data-testid="reassign-server-error">
              {serverErr}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit} data-testid="reassign-submit">
            {reassign.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
