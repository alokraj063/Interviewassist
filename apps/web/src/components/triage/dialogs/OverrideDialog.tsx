import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OverrideInput } from "@/lib/triageApi";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  currentIntent: string;
  intentVocabulary: string[];
  pending: boolean;
  onSubmit: (input: OverrideInput) => void;
}

const URGENCIES: Array<OverrideInput["urgency"]> = ["low", "normal", "high"];

export function OverrideDialog({
  open,
  onOpenChange,
  currentIntent,
  intentVocabulary,
  pending,
  onSubmit,
}: Props) {
  const [intent, setIntent] = useState("");
  const [urgency, setUrgency] = useState<OverrideInput["urgency"]>("normal");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      setIntent("");
      setUrgency("normal");
      setReason("");
    }
  }, [open]);

  const vocab = Array.from(new Set(intentVocabulary.filter((i) => i && i !== "*")));
  const valid = intent.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Override classification</DialogTitle>
          <DialogDescription>
            Correct a misclassification. The call is re-evaluated against the published rules.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="text-xs text-muted-foreground">
            Current intent:{" "}
            <span className="font-semibold text-foreground capitalize">{currentIntent}</span>
          </div>

          <div>
            <Label htmlFor="override-intent">Corrected intent</Label>
            {vocab.length > 0 ? (
              <Select value={intent} onValueChange={setIntent}>
                <SelectTrigger id="override-intent" className="h-9 mt-1">
                  <SelectValue placeholder="Choose an intent…" />
                </SelectTrigger>
                <SelectContent>
                  {vocab.map((i) => (
                    <SelectItem key={i} value={i} className="capitalize">
                      {i.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="override-intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. billing"
                className="h-9 mt-1 text-sm"
              />
            )}
          </div>

          <div>
            <Label htmlFor="override-urgency">Urgency</Label>
            <Select value={urgency} onValueChange={(v) => setUrgency(v as OverrideInput["urgency"])}>
              <SelectTrigger id="override-urgency" className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {URGENCIES.map((u) => (
                  <SelectItem key={u} value={u!} className="capitalize">
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="override-reason">Reason (optional)</Label>
            <Input
              id="override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this a misclassification?"
              className="h-9 mt-1 text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={!valid || pending}
            onClick={() =>
              onSubmit({
                intent: intent.trim(),
                urgency,
                reason: reason.trim() || undefined,
              })
            }
          >
            {pending ? "Applying…" : "Apply override"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
