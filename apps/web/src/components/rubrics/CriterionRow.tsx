// A single rubric criterion editor: name, kind, weight (with live normalized
// %), numeric bands, three behavioral-anchor textareas, min-evidence stepper,
// auto-score toggle, reorder (up/down), and remove. All inputs are labeled.
import {
  ChevronDown,
  ChevronUp,
  Trash2,
} from "lucide-react";
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
import { CRITERION_KINDS, type RubricCriterionV2 } from "@/hooks/useRubrics";

const BANDS = ["fail", "pass", "excellent"] as const;

export function CriterionRow({
  criterion,
  index,
  total,
  normalizedPct,
  readOnly,
  onChange,
  onRemove,
  onMove,
}: {
  criterion: RubricCriterionV2;
  index: number;
  total: number;
  normalizedPct: number;
  readOnly: boolean;
  onChange: (next: RubricCriterionV2) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const c = criterion;
  const monotonic = c.bandThresholds.fail <= c.bandThresholds.pass && c.bandThresholds.pass <= c.bandThresholds.excellent;
  const nameInvalid = !c.name.trim();

  return (
    <div className="rounded-lg border border-border p-4 space-y-3" data-testid="criterion-row">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-0.5 pt-1">
          <button
            type="button"
            aria-label="Move criterion up"
            disabled={readOnly || index === 0}
            onClick={() => onMove(-1)}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            aria-label="Move criterion down"
            disabled={readOnly || index === total - 1}
            onClick={() => onMove(1)}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5 space-y-1">
            <Label htmlFor={`crit-name-${c.id}`} className="text-xs">Name</Label>
            <Input
              id={`crit-name-${c.id}`}
              value={c.name}
              disabled={readOnly}
              aria-invalid={nameInvalid}
              onChange={(e) => onChange({ ...c, name: e.target.value })}
            />
            {nameInvalid && <div className="text-[11px] text-destructive">Name is required.</div>}
          </div>
          <div className="md:col-span-4 space-y-1">
            <Label htmlFor={`crit-kind-${c.id}`} className="text-xs">Kind</Label>
            <Select value={c.kind} disabled={readOnly} onValueChange={(v) => onChange({ ...c, kind: v as RubricCriterionV2["kind"] })}>
              <SelectTrigger id={`crit-kind-${c.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRITERION_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>{k.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-3 space-y-1">
            <Label htmlFor={`crit-weight-${c.id}`} className="text-xs">Weight</Label>
            <Input
              id={`crit-weight-${c.id}`}
              type="number"
              min={0}
              max={100}
              step={1}
              disabled={readOnly}
              value={c.weight}
              onChange={(e) => onChange({ ...c, weight: parseFloat(e.target.value) || 0 })}
            />
            <div className="text-[11px] text-muted-foreground tabular-nums">{normalizedPct.toFixed(1)}% normalized</div>
          </div>
        </div>

        {!readOnly && (
          <Button variant="ghost" size="sm" className="text-destructive" aria-label="Remove criterion" onClick={onRemove}>
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Numeric bands */}
      <div className="grid grid-cols-3 gap-2">
        {BANDS.map((b) => (
          <div key={b} className="space-y-1">
            <Label htmlFor={`crit-band-${c.id}-${b}`} className="text-[11px] capitalize">{b} cutoff</Label>
            <Input
              id={`crit-band-${c.id}-${b}`}
              type="number"
              min={0}
              max={100}
              disabled={readOnly}
              value={c.bandThresholds[b]}
              onChange={(e) =>
                onChange({ ...c, bandThresholds: { ...c.bandThresholds, [b]: parseInt(e.target.value, 10) || 0 } })
              }
            />
          </div>
        ))}
      </div>
      {!monotonic && (
        <div className="text-[11px] text-destructive" role="status">Bands must be monotonic: fail ≤ pass ≤ excellent.</div>
      )}

      {/* Behavioral anchors */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {BANDS.map((b) => (
          <div key={b} className="space-y-1">
            <Label htmlFor={`crit-anchor-${c.id}-${b}`} className="text-[11px] capitalize text-muted-foreground">{b} anchor</Label>
            <Textarea
              id={`crit-anchor-${c.id}-${b}`}
              rows={2}
              className="text-xs"
              disabled={readOnly}
              placeholder={`Behavior that scores "${b}"…`}
              value={c.anchors?.[b] ?? ""}
              onChange={(e) => onChange({ ...c, anchors: { ...c.anchors, [b]: e.target.value } })}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={`crit-evidence-${c.id}`} className="text-xs text-muted-foreground">Min evidence quotes</Label>
          <Input
            id={`crit-evidence-${c.id}`}
            type="number"
            min={0}
            max={3}
            disabled={readOnly}
            className="h-8 w-16"
            value={c.minEvidenceQuotes ?? 0}
            onChange={(e) => onChange({ ...c, minEvidenceQuotes: Math.max(0, Math.min(3, parseInt(e.target.value, 10) || 0)) })}
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={c.autoScoreEnabled}
            disabled={readOnly}
            onCheckedChange={(v) => onChange({ ...c, autoScoreEnabled: !!v })}
            aria-label="Auto-score enabled"
          />
          Auto-score with AI
        </label>
      </div>
    </div>
  );
}
