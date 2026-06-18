// Sampling-policy authoring form. Create + edit (PATCH with dirty-tracking).
// Client validation mirrors the server Zod refine; submit disabled until valid.
import { useEffect, useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  useCreatePolicy,
  useUpdatePolicy,
  QA_SAMPLING_STRATEGIES,
  QA_STRATEGY_LABELS,
  QA_ROUTINGS,
  apiErrorMessage,
  type SamplingPolicy,
  type QaSamplingStrategy,
  type QaRouting,
  type PolicyInput,
} from "@/hooks/useQAReview";

interface FormState {
  name: string;
  description: string;
  strategy: QaSamplingStrategy;
  samplePercent: string;
  everyN: string;
  minAiScore: string;
  routing: QaRouting;
  slaHours: string;
  requireDoubleReview: boolean;
  blindReview: boolean;
}

function fromPolicy(p: SamplingPolicy | null): FormState {
  return {
    name: p?.name ?? "",
    description: p?.description ?? "",
    strategy: p?.strategy ?? "percentage",
    samplePercent: p?.samplePercent != null ? String(p.samplePercent) : "20",
    everyN: p?.everyN != null ? String(p.everyN) : "5",
    minAiScore: p?.minAiScore != null ? String(p.minAiScore) : "65",
    routing: p?.routing ?? "least_loaded",
    slaHours: p?.slaHours != null ? String(p.slaHours) : "",
    requireDoubleReview: p?.requireDoubleReview ?? false,
    blindReview: p?.blindReview ?? true,
  };
}

export function SamplingPolicyDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: SamplingPolicy | null;
}) {
  const create = useCreatePolicy();
  const update = useUpdatePolicy();
  const [form, setForm] = useState<FormState>(fromPolicy(editing ?? null));

  useEffect(() => {
    if (open) setForm(fromPolicy(editing ?? null));
  }, [open, editing]);

  const errors = useMemo(() => validate(form), [form]);
  const valid = Object.keys(errors).length === 0;
  const pending = create.isPending || update.isPending;

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function buildInput(): PolicyInput {
    return {
      name: form.name.trim(),
      description: form.description.trim() || null,
      strategy: form.strategy,
      samplePercent: form.strategy === "percentage" ? Number(form.samplePercent) : null,
      everyN: form.strategy === "every_n" ? Number(form.everyN) : null,
      minAiScore: form.strategy === "risk_weighted" ? Number(form.minAiScore) : null,
      routing: form.routing,
      slaHours: form.slaHours.trim() ? Number(form.slaHours) : null,
      requireDoubleReview: form.requireDoubleReview,
      blindReview: form.blindReview,
    };
  }

  function submit() {
    if (!valid) return;
    const input = buildInput();
    if (editing) {
      update.mutate(
        { id: editing.id, input },
        {
          onSuccess: () => {
            toast.success("Policy updated");
            onOpenChange(false);
          },
          onError: (e) => toast.error(apiErrorMessage(e)),
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: () => {
          toast.success("Sampling policy created");
          onOpenChange(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit sampling policy" : "New sampling policy"}</DialogTitle>
          <DialogDescription>
            Decides which ended calls become QA queue items and how they route to reviewers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Field label="Name" error={errors.name} htmlFor="policy-name">
            <Input
              id="policy-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Daily 20% sample"
            />
          </Field>

          <Field label="Description" htmlFor="policy-desc">
            <Textarea
              id="policy-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={2}
              placeholder="Optional — what this policy is for"
            />
          </Field>

          <Field label="Strategy" htmlFor="policy-strategy">
            <Select value={form.strategy} onValueChange={(v) => set("strategy", v as QaSamplingStrategy)}>
              <SelectTrigger id="policy-strategy" aria-label="Strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QA_SAMPLING_STRATEGIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {QA_STRATEGY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {form.strategy === "percentage" && (
            <Field label="Sample percent (0–100)" error={errors.samplePercent} htmlFor="policy-pct">
              <Input
                id="policy-pct"
                type="number"
                min={0}
                max={100}
                value={form.samplePercent}
                onChange={(e) => set("samplePercent", e.target.value)}
              />
            </Field>
          )}

          {form.strategy === "every_n" && (
            <Field label="Sample 1 of every N" error={errors.everyN} htmlFor="policy-n">
              <Input
                id="policy-n"
                type="number"
                min={1}
                value={form.everyN}
                onChange={(e) => set("everyN", e.target.value)}
              />
            </Field>
          )}

          {form.strategy === "risk_weighted" && (
            <Field label="Only sample calls with AI score below" error={errors.minAiScore} htmlFor="policy-minai">
              <Input
                id="policy-minai"
                type="number"
                min={0}
                max={100}
                value={form.minAiScore}
                onChange={(e) => set("minAiScore", e.target.value)}
              />
            </Field>
          )}

          <Field label="Routing" htmlFor="policy-routing">
            <Select value={form.routing} onValueChange={(v) => set("routing", v as QaRouting)}>
              <SelectTrigger id="policy-routing" aria-label="Routing">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QA_ROUTINGS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="SLA (hours, optional)" error={errors.slaHours} htmlFor="policy-sla">
            <Input
              id="policy-sla"
              type="number"
              min={1}
              value={form.slaHours}
              onChange={(e) => set("slaHours", e.target.value)}
              placeholder="No deadline"
            />
          </Field>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label htmlFor="policy-double" className="text-sm font-medium">
                Require double-review
              </Label>
              <p className="text-xs text-muted-foreground">Two independent reviewers per call.</p>
            </div>
            <Switch
              id="policy-double"
              checked={form.requireDoubleReview}
              onCheckedChange={(v) => set("requireDoubleReview", v)}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label htmlFor="policy-blind" className="text-sm font-medium">
                Blind review
              </Label>
              <p className="text-xs text-muted-foreground">Hide peers' scores until you submit.</p>
            </div>
            <Switch id="policy-blind" checked={form.blindReview} onCheckedChange={(v) => set("blindReview", v)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || pending}>
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {editing ? "Save changes" : "Create policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function validate(f: FormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e.name = "Name is required";
  if (f.strategy === "percentage") {
    const n = Number(f.samplePercent);
    if (f.samplePercent.trim() === "" || Number.isNaN(n) || n < 0 || n > 100)
      e.samplePercent = "Enter a percent between 0 and 100";
  }
  if (f.strategy === "every_n") {
    const n = Number(f.everyN);
    if (f.everyN.trim() === "" || Number.isNaN(n) || n < 1) e.everyN = "Enter a whole number ≥ 1";
  }
  if (f.strategy === "risk_weighted") {
    const n = Number(f.minAiScore);
    if (f.minAiScore.trim() === "" || Number.isNaN(n) || n < 0 || n > 100)
      e.minAiScore = "Enter a score between 0 and 100";
  }
  if (f.slaHours.trim()) {
    const n = Number(f.slaHours);
    if (Number.isNaN(n) || n < 1) e.slaHours = "Enter a whole number ≥ 1";
  }
  return e;
}

function Field({
  label,
  error,
  htmlFor,
  children,
}: {
  label: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
