import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pause, Play, Clock, Send, Megaphone, Ban } from "lucide-react";
import { errMessage, useIntervene, type LiveState } from "@/hooks/useProctor";

const EXTEND_OPTIONS = [
  { label: "+5 min", seconds: 300 },
  { label: "+10 min", seconds: 600 },
  { label: "+15 min", seconds: 900 },
  { label: "+30 min", seconds: 1800 },
];

export function InterventionBar({ sessionId, liveState }: { sessionId: string; liveState: LiveState }) {
  const intervene = useIntervene();
  const [chat, setChat] = useState("");
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const [extendSeconds, setExtendSeconds] = useState(300);

  const ended = liveState === "ended";

  const send = (
    kind: "chat" | "broadcast" | "pause" | "resume" | "extend" | "terminate",
    extra?: { message?: string; extendSeconds?: number },
  ) => {
    intervene.mutate(
      { sessionId, kind, ...extra },
      {
        onSuccess: () => {
          const verb =
            kind === "pause"
              ? "Session paused"
              : kind === "resume"
                ? "Session resumed"
                : kind === "extend"
                  ? "Time extended"
                  : kind === "terminate"
                    ? "Session terminated"
                    : kind === "broadcast"
                      ? "Broadcast sent"
                      : "Message sent";
          toast.success(verb);
        },
        onError: (e) => toast.error("Intervention failed", { description: errMessage(e) }),
      },
    );
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {liveState === "paused" ? (
          <Button size="sm" variant="outline" disabled={ended || intervene.isPending} onClick={() => send("resume")}>
            <Play className="w-3.5 h-3.5 mr-1.5" /> Resume
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={ended || intervene.isPending} onClick={() => send("pause")}>
            <Pause className="w-3.5 h-3.5 mr-1.5" /> Pause
          </Button>
        )}

        <div className="flex items-center gap-1">
          <Select value={String(extendSeconds)} onValueChange={(v) => setExtendSeconds(Number(v))}>
            <SelectTrigger className="h-9 w-28" aria-label="Extend duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXTEND_OPTIONS.map((o) => (
                <SelectItem key={o.seconds} value={String(o.seconds)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={ended || intervene.isPending}
            onClick={() => send("extend", { extendSeconds })}
          >
            <Clock className="w-3.5 h-3.5 mr-1.5" /> Extend
          </Button>
        </div>

        <Button
          size="sm"
          variant="outline"
          disabled={ended || intervene.isPending}
          onClick={() => send("broadcast", { message: "Reminder: keep your face centered and stay in fullscreen." })}
        >
          <Megaphone className="w-3.5 h-3.5 mr-1.5" /> Broadcast reminder
        </Button>

        <Button
          size="sm"
          variant="destructive"
          disabled={ended || intervene.isPending}
          onClick={() => setTerminateOpen(true)}
        >
          <Ban className="w-3.5 h-3.5 mr-1.5" /> Terminate
        </Button>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const msg = chat.trim();
          if (!msg) return;
          send("chat", { message: msg });
          setChat("");
        }}
      >
        <Input
          aria-label="Chat to candidate"
          placeholder="Message the candidate…"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          disabled={ended}
          className="h-9"
        />
        <Button type="submit" size="sm" disabled={ended || !chat.trim() || intervene.isPending}>
          <Send className="w-3.5 h-3.5 mr-1.5" /> Send
        </Button>
      </form>

      <Dialog open={terminateOpen} onOpenChange={setTerminateOpen}>
        <DialogContent
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && justification.trim().length >= 10) {
              e.preventDefault();
              confirmTerminate();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Terminate session</DialogTitle>
            <DialogDescription>
              This ends the candidate&apos;s exam immediately. A justification is recorded in the chain-of-custody
              audit (minimum 10 characters).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="terminate-justification">Justification</Label>
            <Textarea
              id="terminate-justification"
              autoFocus
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              placeholder="e.g. Confirmed second device and repeated multi-face detections."
              rows={3}
            />
            <p className="text-xs text-muted-foreground">{justification.trim().length}/10 minimum</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTerminateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={justification.trim().length < 10 || intervene.isPending}
              onClick={confirmTerminate}
            >
              Terminate session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  function confirmTerminate() {
    if (justification.trim().length < 10) return;
    intervene.mutate(
      { sessionId, kind: "terminate", message: justification.trim() },
      {
        onSuccess: () => {
          toast.success("Session terminated");
          setTerminateOpen(false);
          setJustification("");
        },
        onError: (e) => toast.error("Terminate failed", { description: errMessage(e) }),
      },
    );
  }
}
