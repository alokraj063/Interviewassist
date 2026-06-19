import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import type { TemplateRow } from "@/hooks/useAssessments";

export function NewTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (template: TemplateRow) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationMins, setDurationMins] = useState<string>("30");
  const [passScore, setPassScore] = useState<string>("60");
  const [submitting, setSubmitting] = useState(false);

  const valid = title.trim().length > 0;

  const reset = () => {
    setTitle("");
    setDescription("");
    setDurationMins("30");
    setPassScore("60");
  };

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const res = await apiFetch<{ template: TemplateRow }>("/api/assessments/templates", {
        method: "POST",
        json: {
          title: title.trim(),
          description: description.trim() || null,
          durationMins: durationMins ? Number(durationMins) : null,
          passScore: passScore ? Number(passScore) : 60,
        },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      toast.success("Assessment created");
      reset();
      onOpenChange(false);
      onCreated(res.template);
    } catch (err) {
      toast.error("Couldn't create assessment", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>New assessment</DialogTitle>
          <DialogDescription>
            Create a draft, then author sections and typed questions in the builder.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-title">Title</Label>
            <Input
              id="tpl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Java Backend — Senior Screen"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-desc">Description</Label>
            <Textarea
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this test covers (optional)"
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-dur">Duration (min)</Label>
              <Input
                id="tpl-dur"
                type="number"
                min={1}
                max={720}
                value={durationMins}
                onChange={(e) => setDurationMins(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-pass">Pass score (%)</Label>
              <Input
                id="tpl-pass"
                type="number"
                min={0}
                max={100}
                value={passScore}
                onChange={(e) => setPassScore(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || submitting}>
            {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {submitting ? "Creating…" : "Create assessment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
