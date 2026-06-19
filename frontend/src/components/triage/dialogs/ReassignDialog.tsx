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
import type {
  TriageDestinationOption,
  TriageDestinationType,
} from "@j2w/shared-types";
import type { ReassignInput } from "@/lib/triageApi";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  humanTeams: TriageDestinationOption[];
  voiceAgents: TriageDestinationOption[];
  pending: boolean;
  onSubmit: (input: ReassignInput) => void;
}

export function ReassignDialog({
  open,
  onOpenChange,
  humanTeams,
  voiceAgents,
  pending,
  onSubmit,
}: Props) {
  const [type, setType] = useState<TriageDestinationType>("human_team");
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) {
      setType("human_team");
      setRef("");
      setReason("");
    }
  }, [open]);

  const options =
    type === "human_team" ? humanTeams : type === "voice_agent" ? voiceAgents : [];
  const needsManualRef = type === "external_pstn" || type === "voicemail";
  const valid = needsManualRef ? ref.trim().length > 0 : !!ref;
  const label = options.find((o) => o.id === ref)?.name ?? ref;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Reassign live call</DialogTitle>
          <DialogDescription>
            Move this in-flight call to a different destination. The new assignee is notified.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div>
            <Label htmlFor="reassign-type">Destination type</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as TriageDestinationType);
                setRef("");
              }}
            >
              <SelectTrigger id="reassign-type" className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="human_team">Human team</SelectItem>
                <SelectItem value="voice_agent">Voice agent</SelectItem>
                <SelectItem value="external_pstn">External PSTN</SelectItem>
                <SelectItem value="voicemail">Voicemail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {needsManualRef ? (
            <div>
              <Label htmlFor="reassign-ref">
                {type === "external_pstn" ? "Phone number" : "Mailbox"}
              </Label>
              <Input
                id="reassign-ref"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={type === "external_pstn" ? "+91 9800000000" : "general"}
                className="h-9 mt-1 font-mono text-sm"
              />
            </div>
          ) : (
            <div>
              <Label htmlFor="reassign-target">Target</Label>
              <Select value={ref} onValueChange={setRef}>
                <SelectTrigger id="reassign-target" className="h-9 mt-1">
                  <SelectValue placeholder={options.length ? "Choose…" : "No options available"} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <Label htmlFor="reassign-reason">Reason (optional)</Label>
            <Input
              id="reassign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you reassigning?"
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
                destinationType: type,
                destinationRef: ref.trim(),
                destinationLabel: label,
                reason: reason.trim() || undefined,
              })
            }
          >
            {pending ? "Reassigning…" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
