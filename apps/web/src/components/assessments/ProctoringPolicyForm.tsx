import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { ProctoringPolicy } from "@/hooks/useAssessments";

const SIGNALS: Array<{ key: keyof ProctoringPolicy; label: string }> = [
  { key: "requireWebcam", label: "Require webcam" },
  { key: "requireScreenShare", label: "Require screen share" },
  { key: "requireIdVerification", label: "ID verification" },
  { key: "lockdownFullscreen", label: "Lockdown fullscreen" },
  { key: "blockCopyPaste", label: "Block copy / paste" },
  { key: "flagTabSwitch", label: "Flag tab switch" },
  { key: "flagMultiFace", label: "Flag multiple faces" },
  { key: "flagNoFace", label: "Flag no face" },
  { key: "flagSecondVoice", label: "Flag second voice" },
];

export function ProctoringPolicyForm({
  policy,
  onChange,
  disabled,
}: {
  policy: ProctoringPolicy;
  onChange: (p: ProctoringPolicy) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ProctoringPolicy>) => onChange({ ...policy, ...patch });
  const enabled = policy.enabled ?? false;
  const activeSignals = SIGNALS.filter((s) => policy[s.key]).map((s) => s.label);

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between">
        <span className="text-sm font-medium">Enable proctoring</span>
        <Switch checked={enabled} onCheckedChange={(v) => set({ enabled: v })} disabled={disabled} />
      </label>
      {enabled && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {SIGNALS.map((s) => (
              <label key={s.key} className="flex items-center gap-2 text-sm">
                <Switch
                  checked={!!policy[s.key]}
                  onCheckedChange={(v) => set({ [s.key]: v } as Partial<ProctoringPolicy>)}
                  disabled={disabled}
                />
                {s.label}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="auto-flag" className="text-sm">
              Auto-flag risk threshold
            </Label>
            <Input
              id="auto-flag"
              type="number"
              min={0}
              max={100}
              value={policy.autoFlagThreshold ?? 0}
              onChange={(e) => set({ autoFlagThreshold: Number(e.target.value) })}
              className="w-24 h-8"
              disabled={disabled}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            {activeSignals.length > 0
              ? `Signals that will fire: ${activeSignals.join(", ")}.`
              : "No integrity signals enabled yet."}
          </div>
        </>
      )}
    </div>
  );
}
