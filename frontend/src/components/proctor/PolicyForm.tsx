import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_SIGNAL_PRESET,
  SIGNAL_KINDS,
  SIGNAL_KIND_LABELS,
  errMessage,
  useSavePolicy,
  type Policy,
  type PolicyInput,
  type SignalConfig,
  type SignalSeverity,
} from "@/hooks/useProctor";

interface Props {
  initial?: Policy | null;
  onSaved?: () => void;
  onCancel?: () => void;
}

const SEVERITIES: SignalSeverity[] = ["low", "medium", "high"];

export function PolicyForm({ initial, onSaved, onCancel }: Props) {
  const save = useSavePolicy();

  const [name, setName] = useState(initial?.name ?? "");
  const [scope, setScope] = useState<"default" | "template">(
    initial?.assessmentTemplateId ? "template" : initial?.isDefault ? "default" : "default",
  );
  const [templateId, setTemplateId] = useState<string | null>(initial?.assessmentTemplateId ?? null);
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [requireIdentity, setRequireIdentity] = useState(initial?.requireIdentity ?? true);
  const [requireWebcam, setRequireWebcam] = useState(initial?.requireWebcam ?? true);
  const [requireScreen, setRequireScreen] = useState(initial?.requireScreen ?? false);
  const [lockdownBrowser, setLockdownBrowser] = useState(initial?.lockdownBrowser ?? false);
  const [autoFlag, setAutoFlag] = useState(initial?.autoFlagRiskScore ?? 40);
  const [autoTerminate, setAutoTerminate] = useState<number | null>(initial?.autoTerminateRiskScore ?? null);
  const [signals, setSignals] = useState<SignalConfig>(() => {
    if (initial?.signalConfig && Object.keys(initial.signalConfig).length > 0) {
      return { ...DEFAULT_SIGNAL_PRESET, ...initial.signalConfig };
    }
    return { ...DEFAULT_SIGNAL_PRESET };
  });

  // Templates are optional — only used when the user has assessments.read.
  const { data: templatesData } = useQuery<{ templates: Array<{ id: string; title: string }> }>({
    queryKey: ["proctor", "policy-form", "templates"],
    queryFn: () => apiFetch<{ templates: Array<{ id: string; title: string }> }>("/api/assessments/templates?limit=50"),
    retry: false,
    staleTime: 60_000,
  });
  const templates = templatesData?.templates ?? [];

  const terminateInvalid = autoTerminate != null && autoTerminate < autoFlag;
  const nameInvalid = name.trim().length === 0;
  const templateScopeInvalid = scope === "template" && !templateId;
  const canSubmit = !nameInvalid && !terminateInvalid && !templateScopeInvalid && !save.isPending;

  const armedCount = useMemo(() => Object.values(signals).filter((s) => s.armed).length, [signals]);

  const updateSignal = (kind: string, patch: Partial<SignalConfig[string]>) => {
    setSignals((cur) => ({ ...cur, [kind]: { ...cur[kind], ...patch } }));
  };

  const submit = () => {
    if (!canSubmit) return;
    const body: PolicyInput & { id?: string } = {
      id: initial?.id,
      name: name.trim(),
      assessmentTemplateId: scope === "template" ? templateId : null,
      isDefault: scope === "default" ? isDefault : false,
      signalConfig: signals,
      requireIdentity,
      requireWebcam,
      requireScreen,
      lockdownBrowser,
      autoFlagRiskScore: autoFlag,
      autoTerminateRiskScore: autoTerminate,
    };
    save.mutate(body, {
      onSuccess: () => {
        toast.success(initial ? "Policy updated" : "Policy created");
        onSaved?.();
      },
      onError: (e) => toast.error("Save failed", { description: errMessage(e) }),
    });
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="policy-name">Policy name</Label>
          <Input
            id="policy-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Senior coding exam — strict"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Scope</Label>
          <Select value={scope} onValueChange={(v) => setScope(v as "default" | "template")}>
            <SelectTrigger aria-label="Policy scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Org default</SelectItem>
              <SelectItem value="template">Specific assessment</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {scope === "default" ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={isDefault} onCheckedChange={setIsDefault} aria-label="Make org default" />
          Make this the org-default policy (applies to sessions with no assessment-specific policy)
        </label>
      ) : (
        <div className="space-y-1.5">
          <Label>Assessment template</Label>
          <Select value={templateId ?? ""} onValueChange={(v) => setTemplateId(v || null)}>
            <SelectTrigger aria-label="Assessment template">
              <SelectValue placeholder={templates.length ? "Pick a template" : "No templates available"} />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {templateScopeInvalid && <p className="text-xs text-destructive">Pick an assessment template.</p>}
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Requirements</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow label="Require identity verification" checked={requireIdentity} onChange={setRequireIdentity} />
          <ToggleRow label="Require webcam" checked={requireWebcam} onChange={setRequireWebcam} />
          <ToggleRow label="Require screen share" checked={requireScreen} onChange={setRequireScreen} />
          <ToggleRow label="Lockdown browser" checked={lockdownBrowser} onChange={setLockdownBrowser} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">
          Auto-action thresholds
        </legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Auto-flag at risk ≥ {autoFlag}</Label>
            <Slider value={[autoFlag]} min={0} max={100} step={5} onValueChange={([v]) => setAutoFlag(v)} aria-label="Auto-flag risk score" />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Auto-terminate {autoTerminate == null ? "(off)" : `at risk ≥ ${autoTerminate}`}</Label>
              <label className="flex items-center gap-1.5 text-xs">
                <Switch
                  checked={autoTerminate != null}
                  onCheckedChange={(c) => setAutoTerminate(c ? Math.max(autoFlag, 85) : null)}
                  aria-label="Enable auto-terminate"
                />
                enabled
              </label>
            </div>
            {autoTerminate != null && (
              <Slider
                value={[autoTerminate]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) => setAutoTerminate(v)}
                aria-label="Auto-terminate risk score"
              />
            )}
            {terminateInvalid && (
              <p className="text-xs text-destructive">Auto-terminate must be ≥ auto-flag ({autoFlag}).</p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Instrumentation signals ({armedCount} armed)</legend>
        <div className="rounded-md border border-border divide-y divide-border max-h-72 overflow-y-auto">
          {SIGNAL_KINDS.map((kind) => {
            const cfg = signals[kind] ?? DEFAULT_SIGNAL_PRESET[kind];
            return (
              <div key={kind} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  id={`armed-${kind}`}
                  checked={cfg.armed}
                  onCheckedChange={(c) => updateSignal(kind, { armed: c === true })}
                  aria-label={`Arm ${SIGNAL_KIND_LABELS[kind]}`}
                />
                <Label htmlFor={`armed-${kind}`} className="flex-1 text-sm cursor-pointer">
                  {SIGNAL_KIND_LABELS[kind]}
                </Label>
                <Select
                  value={cfg.severity}
                  onValueChange={(v) => updateSignal(kind, { severity: v as SignalSeverity })}
                >
                  <SelectTrigger className="h-8 w-28" aria-label={`${SIGNAL_KIND_LABELS[kind]} severity`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  max={50}
                  value={cfg.weight}
                  onChange={(e) => updateSignal(kind, { weight: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })}
                  aria-label={`${SIGNAL_KIND_LABELS[kind]} weight`}
                  className="h-8 w-16"
                />
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {save.isPending ? "Saving…" : initial ? "Save changes" : "Create policy"}
        </Button>
      </div>
    </form>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
