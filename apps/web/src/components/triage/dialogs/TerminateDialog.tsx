import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  callerRef: string;
  pending: boolean;
  onSubmit: (reason: string | undefined) => void;
}

export function TerminateDialog({ open, onOpenChange, callerRef, pending, onSubmit }: Props) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            Terminate call
          </DialogTitle>
          <DialogDescription>
            Force-end the live call from <span className="font-mono">{callerRef}</span>. This ends
            the PSTN call and is recorded in the audit trail. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="py-1">
          <Label htmlFor="terminate-reason">Reason (optional)</Label>
          <Input
            id="terminate-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. caller stuck in classification loop"
            className="h-9 mt-1 text-sm"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => onSubmit(reason.trim() || undefined)}
          >
            {pending ? "Terminating…" : "Terminate call"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
