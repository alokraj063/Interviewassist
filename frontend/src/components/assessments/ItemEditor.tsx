import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Save, X, AlertTriangle } from "lucide-react";
import type { Item, ItemType } from "@/hooks/useAssessments";
import { AUTO_GRADABLE, ITEM_TYPE_LABELS } from "@/hooks/useAssessments";

type Draft = {
  type: ItemType;
  prompt: string;
  points: number;
  negativePoints: number;
  partialCredit: boolean;
  required: boolean;
  timeLimitSeconds: number | null;
  config: Record<string, unknown>;
};

interface McqOption {
  id: string;
  label: string;
  correct: boolean;
}

function toDraft(item: Item | null, defaultType: ItemType): Draft {
  if (!item)
    return {
      type: defaultType,
      prompt: "",
      points: 1,
      negativePoints: 0,
      partialCredit: false,
      required: true,
      timeLimitSeconds: null,
      config: defaultConfig(defaultType),
    };
  return {
    type: item.type,
    prompt: item.prompt,
    points: item.points,
    negativePoints: item.negativePoints,
    partialCredit: item.partialCredit,
    required: item.required,
    timeLimitSeconds: item.timeLimitSeconds,
    config: item.config ?? {},
  };
}

function defaultConfig(type: ItemType): Record<string, unknown> {
  switch (type) {
    case "mcq_single":
    case "mcq_multi":
      return {
        options: [
          { id: crypto.randomUUID(), label: "", correct: false },
          { id: crypto.randomUUID(), label: "", correct: false },
        ],
      };
    case "true_false":
      return { correct: true };
    case "coding":
      return {
        language: "python",
        starterCode: "",
        testCases: [{ id: crypto.randomUUID(), stdin: "", expected: "", hidden: false, weight: 1 }],
        timeoutMs: 5000,
      };
    case "file_upload":
      return { acceptedTypes: ["pdf"], maxSizeMb: 10 };
    case "video_response":
      return { prepSeconds: 30, maxSeconds: 120, retakes: 1 };
    default:
      return {};
  }
}

// Client-side validation mirroring the server Zod per type.
function validate(draft: Draft): string | null {
  if (!draft.prompt.trim()) return "Prompt is required.";
  const cfg = draft.config;
  if (draft.type === "mcq_single") {
    const opts = (cfg.options as McqOption[]) ?? [];
    if (opts.length < 2) return "Add at least 2 options.";
    if (opts.some((o) => !o.label.trim())) return "Every option needs a label.";
    if (opts.filter((o) => o.correct).length !== 1) return "MCQ (single) needs exactly one correct option.";
  }
  if (draft.type === "mcq_multi") {
    const opts = (cfg.options as McqOption[]) ?? [];
    if (opts.length < 2) return "Add at least 2 options.";
    if (opts.some((o) => !o.label.trim())) return "Every option needs a label.";
    if (!opts.some((o) => o.correct)) return "Mark at least one correct option.";
  }
  if (draft.type === "coding") {
    const tcs = (cfg.testCases as Array<{ expected: string }>) ?? [];
    if (tcs.length < 1) return "Add at least one test case.";
    if (tcs.some((t) => !t.expected.trim())) return "Every test case needs an expected output.";
  }
  return null;
}

export function ItemEditor({
  item,
  defaultType,
  codeExecConfigured,
  onSave,
  onCancel,
  saving,
}: {
  item: Item | null;
  defaultType: ItemType;
  codeExecConfigured: boolean;
  onSave: (payload: Draft) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(item, defaultType));
  const err = validate(draft);

  const setType = (type: ItemType) => {
    setDraft((d) => ({ ...d, type, config: defaultConfig(type) }));
  };

  const options = (draft.config.options as McqOption[]) ?? [];
  const setOptions = (next: McqOption[]) => setDraft((d) => ({ ...d, config: { ...d.config, options: next } }));

  return (
    <div className="border border-border rounded-lg p-4 space-y-4 bg-muted/20">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1.5 w-64">
          <Label>Question type</Label>
          <Select value={draft.type} onValueChange={(v) => setType(v as ItemType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ITEM_TYPE_LABELS) as ItemType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {ITEM_TYPE_LABELS[t]}
                  {AUTO_GRADABLE.includes(t) ? " · auto" : " · manual"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="item-prompt">Prompt</Label>
        <Textarea
          id="item-prompt"
          value={draft.prompt}
          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          placeholder="The question text the candidate sees…"
          rows={2}
        />
      </div>

      {/* Type-specific config */}
      {(draft.type === "mcq_single" || draft.type === "mcq_multi") && (
        <div className="space-y-2">
          <Label>Options ({draft.type === "mcq_single" ? "one correct" : "≥1 correct"})</Label>
          {options.map((o, i) => (
            <div key={o.id} className="flex items-center gap-2">
              {draft.type === "mcq_single" ? (
                <input
                  type="radio"
                  name="correct-opt"
                  checked={o.correct}
                  onChange={() =>
                    setOptions(options.map((x) => ({ ...x, correct: x.id === o.id })))
                  }
                  aria-label={`Mark option ${i + 1} correct`}
                />
              ) : (
                <Checkbox
                  checked={o.correct}
                  onCheckedChange={(v) =>
                    setOptions(options.map((x) => (x.id === o.id ? { ...x, correct: !!v } : x)))
                  }
                  aria-label={`Mark option ${i + 1} correct`}
                />
              )}
              <Input
                value={o.label}
                onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)))}
                placeholder={`Option ${i + 1}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOptions(options.filter((x) => x.id !== o.id))}
                disabled={options.length <= 2}
                aria-label={`Remove option ${i + 1}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOptions([...options, { id: crypto.randomUUID(), label: "", correct: false }])}
            disabled={options.length >= 10}
          >
            <Plus className="w-3.5 h-3.5 mr-1" /> Add option
          </Button>
          {draft.type === "mcq_multi" && (
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.partialCredit}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, partialCredit: v }))}
              />
              Partial credit for partially-correct selections
            </label>
          )}
        </div>
      )}

      {draft.type === "true_false" && (
        <div className="space-y-1.5">
          <Label>Correct answer</Label>
          <Select
            value={String((draft.config.correct as boolean) ?? true)}
            onValueChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, correct: v === "true" } }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">True</SelectItem>
              <SelectItem value="false">False</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {(draft.type === "short_answer" || draft.type === "long_answer") && (
        <div className="space-y-1.5">
          <Label htmlFor="sample-ans">Sample answer (for reviewers / AI assist)</Label>
          <Textarea
            id="sample-ans"
            value={(draft.config.sampleAnswer as string) ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, config: { ...d.config, sampleAnswer: e.target.value } }))}
            placeholder="What a strong answer covers…"
            rows={2}
          />
          <p className="text-xs text-muted-foreground">Graded by a human reviewer (AI suggestion optional).</p>
        </div>
      )}

      {draft.type === "coding" && (
        <CodingConfig draft={draft} setDraft={setDraft} codeExecConfigured={codeExecConfigured} />
      )}

      {draft.type === "file_upload" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="accepted">Accepted types (comma-sep)</Label>
            <Input
              id="accepted"
              value={((draft.config.acceptedTypes as string[]) ?? []).join(",")}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  config: { ...d.config, acceptedTypes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) },
                }))
              }
              placeholder="pdf,docx"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="maxsize">Max size (MB)</Label>
            <Input
              id="maxsize"
              type="number"
              min={1}
              max={100}
              value={(draft.config.maxSizeMb as number) ?? 10}
              onChange={(e) => setDraft((d) => ({ ...d, config: { ...d.config, maxSizeMb: Number(e.target.value) } }))}
            />
          </div>
        </div>
      )}

      {draft.type === "video_response" && (
        <div className="grid grid-cols-3 gap-3">
          <NumField label="Prep (s)" value={(draft.config.prepSeconds as number) ?? 30} onChange={(n) => setDraft((d) => ({ ...d, config: { ...d.config, prepSeconds: n } }))} />
          <NumField label="Max (s)" value={(draft.config.maxSeconds as number) ?? 120} onChange={(n) => setDraft((d) => ({ ...d, config: { ...d.config, maxSeconds: n } }))} />
          <NumField label="Retakes" value={(draft.config.retakes as number) ?? 1} onChange={(n) => setDraft((d) => ({ ...d, config: { ...d.config, retakes: n } }))} />
        </div>
      )}

      {/* scoring controls */}
      <div className="grid grid-cols-3 gap-3 pt-2 border-t border-border">
        <NumField label="Points" value={draft.points} onChange={(n) => setDraft((d) => ({ ...d, points: n }))} />
        <NumField label="Negative" value={draft.negativePoints} onChange={(n) => setDraft((d) => ({ ...d, negativePoints: n }))} />
        <NumField
          label="Time limit (s)"
          value={draft.timeLimitSeconds ?? 0}
          onChange={(n) => setDraft((d) => ({ ...d, timeLimitSeconds: n > 0 ? n : null }))}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={draft.required} onCheckedChange={(v) => setDraft((d) => ({ ...d, required: v }))} />
        Required
      </label>

      {err && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5" /> {err}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!!err || saving} onClick={() => onSave(draft)}>
          <Save className="w-3.5 h-3.5 mr-1" /> {saving ? "Saving…" : item ? "Save changes" : "Add question"}
        </Button>
      </div>
    </div>
  );
}

function CodingConfig({
  draft,
  setDraft,
  codeExecConfigured,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  codeExecConfigured: boolean;
}) {
  const testCases = (draft.config.testCases as Array<{ id: string; stdin: string; expected: string; hidden: boolean; weight: number }>) ?? [];
  const setTC = (next: typeof testCases) => setDraft((d) => ({ ...d, config: { ...d.config, testCases: next } }));
  return (
    <div className="space-y-3">
      {!codeExecConfigured && (
        <div className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
          Code execution not configured — coding items will be routed to manual review.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Language</Label>
          <Select
            value={(draft.config.language as string) ?? "python"}
            onValueChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, language: v } }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["python", "javascript", "java", "cpp", "go"].map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Starter code</Label>
        <Textarea
          value={(draft.config.starterCode as string) ?? ""}
          onChange={(e) => setDraft((d) => ({ ...d, config: { ...d.config, starterCode: e.target.value } }))}
          rows={3}
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-2">
        <Label>Test cases</Label>
        {testCases.map((tc, i) => (
          <div key={tc.id} className="grid grid-cols-12 gap-2 items-center">
            <Input
              className="col-span-4 text-xs font-mono"
              placeholder="stdin"
              value={tc.stdin}
              onChange={(e) => setTC(testCases.map((x) => (x.id === tc.id ? { ...x, stdin: e.target.value } : x)))}
            />
            <Input
              className="col-span-4 text-xs font-mono"
              placeholder="expected stdout"
              value={tc.expected}
              onChange={(e) => setTC(testCases.map((x) => (x.id === tc.id ? { ...x, expected: e.target.value } : x)))}
            />
            <label className="col-span-2 flex items-center gap-1 text-xs">
              <Checkbox
                checked={tc.hidden}
                onCheckedChange={(v) => setTC(testCases.map((x) => (x.id === tc.id ? { ...x, hidden: !!v } : x)))}
                aria-label={`Hide test case ${i + 1}`}
              />
              hidden
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="col-span-2"
              onClick={() => setTC(testCases.filter((x) => x.id !== tc.id))}
              disabled={testCases.length <= 1}
              aria-label={`Remove test case ${i + 1}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTC([...testCases, { id: crypto.randomUUID(), stdin: "", expected: "", hidden: false, weight: 1 }])}
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add test case
        </Button>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8" />
    </div>
  );
}
