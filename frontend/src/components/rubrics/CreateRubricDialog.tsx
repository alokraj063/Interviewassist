// Multi-field rubric create dialog (replaces window.prompt). Focus-trapped
// shadcn Dialog with labeled fields, disabled-until-valid submit, a
// "Creating…" state, an Idempotency-Key minted per dialog-open, and an
// optional "start from template" select that clones an existing rubric.
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import {
  APPLIES_TO_OPTIONS,
  PURPOSE_LABELS,
  type RubricAppliesTo,
  type RubricListRow,
  type RubricPurpose,
} from "@/hooks/useRubrics";

export interface CreateRubricValues {
  name: string;
  purpose: RubricPurpose;
  description?: string;
  appliesTo: RubricAppliesTo[];
  templateId?: string;
  idempotencyKey: string;
}

const PURPOSES = Object.keys(PURPOSE_LABELS) as RubricPurpose[];

export function CreateRubricDialog({
  open,
  onOpenChange,
  templates,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: RubricListRow[];
  submitting: boolean;
  onSubmit: (values: CreateRubricValues) => void;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState<RubricPurpose>("general_screen");
  const [description, setDescription] = useState("");
  const [appliesTo, setAppliesTo] = useState<RubricAppliesTo[]>(["call"]);
  const [templateId, setTemplateId] = useState<string>("none");
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");

  // Reset + mint a fresh idempotency key each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setPurpose("general_screen");
      setDescription("");
      setAppliesTo(["call"]);
      setTemplateId("none");
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);

  const valid = name.trim().length > 0 && appliesTo.length > 0;

  function toggleApplies(v: RubricAppliesTo) {
    setAppliesTo((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  }

  function handleSubmit() {
    if (!valid || submitting) return;
    onSubmit({
      name: name.trim(),
      purpose,
      description: description.trim() || undefined,
      appliesTo,
      templateId: templateId !== "none" ? templateId : undefined,
      idempotencyKey,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
        }}
      >
        <DialogHeader>
          <DialogTitle>New rubric</DialogTitle>
          <DialogDescription>
            Author a weighted, behaviorally-anchored scoring rubric. You can publish an immutable version later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="rubric-name">Name</Label>
            <Input
              id="rubric-name"
              value={name}
              autoFocus
              placeholder="e.g. Senior Java — Technical Screen"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rubric-purpose">Purpose</Label>
              <Select value={purpose} onValueChange={(v) => setPurpose(v as RubricPurpose)}>
                <SelectTrigger id="rubric-purpose">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PURPOSES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PURPOSE_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rubric-template">Start from template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="rubric-template">
                  <SelectValue placeholder="Blank rubric" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Blank rubric</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <div className="flex flex-wrap gap-3">
              {APPLIES_TO_OPTIONS.map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm capitalize cursor-pointer">
                  <Checkbox checked={appliesTo.includes(opt)} onCheckedChange={() => toggleApplies(opt)} aria-label={opt} />
                  {opt.replace(/_/g, " ")}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rubric-desc">Description (optional)</Label>
            <Textarea
              id="rubric-desc"
              value={description}
              placeholder="What this rubric evaluates and when to use it…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || submitting}>
            {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {submitting ? "Creating…" : "Create rubric"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
