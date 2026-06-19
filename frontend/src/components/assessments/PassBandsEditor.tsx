import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import type { PassBand } from "@/hooks/useAssessments";

// Banded scoring rows (e.g. Strong ≥85 / Borderline ≥60 / Fail ≥0). The runtime
// labels each attempt with the highest band whose minPercent it clears.
export function PassBandsEditor({
  bands,
  onChange,
  disabled,
}: {
  bands: PassBand[];
  onChange: (next: PassBand[]) => void;
  disabled?: boolean;
}) {
  const setBand = (i: number, patch: Partial<PassBand>) =>
    onChange(bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  return (
    <div className="space-y-2">
      {bands.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No pass bands yet — add bands to label attempts (e.g. Strong / Borderline / Fail).
        </p>
      )}
      {bands.map((b, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="space-y-1 flex-1">
            {i === 0 && <Label className="text-xs">Band label</Label>}
            <Input
              value={b.label}
              maxLength={40}
              placeholder="Strong"
              onChange={(e) => setBand(i, { label: e.target.value })}
              disabled={disabled}
              aria-label={`Band ${i + 1} label`}
            />
          </div>
          <div className="space-y-1 w-28">
            {i === 0 && <Label className="text-xs">Min %</Label>}
            <Input
              type="number"
              min={0}
              max={100}
              value={b.minPercent}
              onChange={(e) => setBand(i, { minPercent: Number(e.target.value) })}
              disabled={disabled}
              aria-label={`Band ${i + 1} minimum percent`}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(bands.filter((_, idx) => idx !== i))}
            disabled={disabled}
            aria-label={`Remove band ${i + 1}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...bands, { label: "", minPercent: 0 }])}
        disabled={disabled || bands.length >= 6}
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add band
      </Button>
    </div>
  );
}
