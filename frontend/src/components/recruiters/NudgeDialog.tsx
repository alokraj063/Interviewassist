// Nudge dialog: pick a kind, write (or AI-draft) a message, send. The send
// hook generates an Idempotency-Key client-side. "Draft with AI" calls the
// server draft endpoint; a 503 openai_key_missing surfaces a precise inline
// notice ("AI drafting unavailable — add OPENAI_API_KEY") and the manager types
// the message manually — no white-screen.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ApiError } from "@/lib/api";
import {
  RECRUITER_NUDGE_KINDS,
  useSendNudge,
  useDraftNudge,
  type NudgeKind,
} from "@/hooks/useRecruiters";

const KIND_LABEL: Record<NudgeKind, string> = {
  coaching: "Coaching",
  sla_breach: "SLA breach",
  capacity: "Capacity",
  goal: "Goal",
  kudos: "Kudos",
};

export function NudgeDialog({
  open,
  onOpenChange,
  recruiterId,
  recruiterName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recruiterId: string;
  recruiterName: string;
}) {
  const [kind, setKind] = useState<NudgeKind>("coaching");
  const [message, setMessage] = useState("");
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const send = useSendNudge(recruiterId);
  const draft = useDraftNudge(recruiterId);
  const valid = message.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    setKind("coaching");
    setMessage("");
    setAiNotice(null);
    setServerError(null);
  }, [open]);

  const onDraft = async () => {
    setAiNotice(null);
    try {
      const res = await draft.mutateAsync({ kind });
      setMessage(res.message);
    } catch (err) {
      const e = err as ApiError;
      const body = e.body as { error?: string } | undefined;
      if (e.status === 503 || body?.error === "openai_key_missing") {
        setAiNotice("AI drafting unavailable — add OPENAI_API_KEY. Type the message manually.");
      } else {
        setAiNotice(err instanceof Error ? err.message : "AI drafting failed");
      }
    }
  };

  const submit = async () => {
    if (!valid || send.isPending) return;
    setServerError(null);
    try {
      const res = await send.mutateAsync({ kind, message: message.trim() });
      toast.success(
        res.delivery === "in_app_only" ? "Nudge sent (in-app)" : "Nudge sent",
      );
      onOpenChange(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to send nudge");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" aria-describedby="nudge-desc">
        <DialogHeader>
          <DialogTitle>Nudge {recruiterName}</DialogTitle>
          <DialogDescription id="nudge-desc">
            Send a coaching message. AI can draft a starting point from the recruiter's KPI gap.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="nudge-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as NudgeKind)}>
              <SelectTrigger id="nudge-kind" aria-label="Nudge kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECRUITER_NUDGE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="nudge-message">Message</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void onDraft()}
                disabled={draft.isPending}
              >
                {draft.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 mr-1" />
                )}
                Draft with AI
              </Button>
            </div>
            <Textarea
              id="nudge-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="What do you want this recruiter to focus on?"
              aria-invalid={!valid}
            />
            {aiNotice && (
              <p className="text-xs text-warning" role="status">
                {aiNotice}
              </p>
            )}
          </div>

          {serverError && (
            <p className="text-sm text-destructive" role="alert">
              {serverError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || send.isPending}>
            {send.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {send.isPending ? "Sending…" : "Send nudge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
