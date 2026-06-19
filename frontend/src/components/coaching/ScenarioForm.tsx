// Multi-field scenario authoring dialog — create AND edit.
// Closes the original hard-fail (the "New scenario" toast no-op): this is a real
// builder that POSTs/PATCHes /api/coaching/scenarios with client + server
// validation, disabled-until-valid submit, and a "Saving…" state.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DIFFICULTIES,
  LANGUAGES,
  LANGUAGE_LABELS,
  useCreateScenario,
  useUpdateScenario,
  useRubricOptions,
  type Difficulty,
  type CoachingLanguage,
  type Persona,
  type SuccessCriterion,
  type ScenarioFull,
  type ScenarioInput,
} from "@/hooks/useCoaching";

const NONE = "__none__";

interface FormState {
  title: string;
  description: string;
  difficulty: Difficulty;
  language: CoachingLanguage;
  openingLine: string;
  estimatedMinutes: string;
  targetRubricId: string;
  tags: string[];
  isPublished: boolean;
  persona: Persona;
  objections: string[];
  successCriteria: SuccessCriterion[];
}

function blank(): FormState {
  return {
    title: "",
    description: "",
    difficulty: "medium",
    language: "hinglish",
    openingLine: "",
    estimatedMinutes: "8",
    targetRubricId: NONE,
    tags: [],
    isPublished: false,
    persona: {},
    objections: [],
    successCriteria: [],
  };
}

function fromScenario(s: ScenarioFull): FormState {
  return {
    title: s.title,
    description: s.description ?? "",
    difficulty: s.difficulty,
    language: s.language,
    openingLine: s.openingLine ?? "",
    estimatedMinutes: String(s.estimatedMinutes),
    targetRubricId: s.targetRubricId ?? NONE,
    tags: s.tags ?? [],
    isPublished: s.isPublished,
    persona: s.candidatePersona ?? {},
    objections: s.objections ?? [],
    successCriteria: s.successCriteria ?? [],
  };
}

export function ScenarioForm({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: ScenarioFull | null;
}) {
  const [form, setForm] = useState<FormState>(blank());
  const [tagInput, setTagInput] = useState("");
  const rubricsQ = useRubricOptions(open);
  const create = useCreateScenario();
  const update = useUpdateScenario(editing?.id ?? "");

  useEffect(() => {
    if (open) {
      setForm(editing ? fromScenario(editing) : blank());
      setTagInput("");
    }
  }, [open, editing]);

  const minutes = Number(form.estimatedMinutes);
  const titleError = form.title.trim().length === 0 ? "Title is required" : undefined;
  const minutesError =
    !Number.isInteger(minutes) || minutes < 1 || minutes > 120
      ? "Minutes must be 1–120"
      : undefined;
  const criteriaError = form.successCriteria.some((c) => !c.label.trim())
    ? "Each success criterion needs a label"
    : undefined;
  const valid = !titleError && !minutesError && !criteriaError;

  const pending = create.isPending || update.isPending;

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function setPersona<K extends keyof Persona>(k: K, v: Persona[K]) {
    setForm((f) => ({ ...f, persona: { ...f.persona, [k]: v } }));
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !form.tags.includes(t)) set("tags", [...form.tags, t]);
    setTagInput("");
  }

  function buildPayload(): ScenarioInput {
    return {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      difficulty: form.difficulty,
      language: form.language,
      openingLine: form.openingLine.trim() || undefined,
      candidatePersona: cleanPersona(form.persona),
      objections: form.objections.filter((o) => o.trim()),
      successCriteria: form.successCriteria.map((c, i) => ({
        id: c.id || `c${i + 1}`,
        label: c.label.trim(),
        weight: Number(c.weight) || 1,
      })),
      targetRubricId: form.targetRubricId === NONE ? null : form.targetRubricId,
      estimatedMinutes: minutes,
      tags: form.tags,
      isPublished: form.isPublished,
    };
  }

  function onSubmit() {
    if (!valid) return;
    const payload = buildPayload();
    const onError = (e: Error) => {
      const code = (e as { body?: { error?: string } }).body?.error;
      toast.error(code === "stale_write" ? "Scenario changed elsewhere — reopen and retry." : e.message);
    };
    if (editing) {
      update.mutate(
        { ...payload, expectedUpdatedAt: editing.updatedAt },
        {
          onSuccess: () => {
            toast.success("Scenario saved");
            onOpenChange(false);
          },
          onError,
        },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          toast.success("Scenario created");
          onOpenChange(false);
        },
        onError,
      });
    }
  }

  const rubricOptions = rubricsQ.data?.rubrics ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit scenario" : "New scenario"}</DialogTitle>
          <DialogDescription>
            Author a candidate roleplay: persona, objections, difficulty and a linked rubric.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Core */}
          <div className="space-y-1.5">
            <Label htmlFor="sc-title">Title</Label>
            <Input
              id="sc-title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Notice-period negotiation — senior backend"
              aria-invalid={!!titleError}
            />
            {titleError && <p className="text-xs text-destructive">{titleError}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-desc">Description</Label>
            <Textarea
              id="sc-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What is the recruiter practising?"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sc-diff">Difficulty</Label>
              <Select value={form.difficulty} onValueChange={(v) => set("difficulty", v as Difficulty)}>
                <SelectTrigger id="sc-diff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DIFFICULTIES.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sc-lang">Language</Label>
              <Select value={form.language} onValueChange={(v) => set("language", v as CoachingLanguage)}>
                <SelectTrigger id="sc-lang">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l} value={l}>
                      {LANGUAGE_LABELS[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sc-min">Est. minutes</Label>
              <Input
                id="sc-min"
                type="number"
                min={1}
                max={120}
                value={form.estimatedMinutes}
                onChange={(e) => set("estimatedMinutes", e.target.value)}
                aria-invalid={!!minutesError}
              />
              {minutesError && <p className="text-xs text-destructive">{minutesError}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-opening">Opening line (AI candidate's first message)</Label>
            <Input
              id="sc-opening"
              value={form.openingLine}
              onChange={(e) => set("openingLine", e.target.value)}
              placeholder="Haan ji, boliye…"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sc-rubric">Target rubric (scoring)</Label>
            <Select value={form.targetRubricId} onValueChange={(v) => set("targetRubricId", v)}>
              <SelectTrigger id="sc-rubric">
                <SelectValue placeholder="No rubric" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No rubric</SelectItem>
                {rubricOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Persona */}
          <fieldset className="space-y-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-semibold">Candidate persona</legend>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <PersonaText label="Name" value={form.persona.candidateName} onChange={(v) => setPersona("candidateName", v)} />
              <PersonaText label="Role" value={form.persona.candidateRole} onChange={(v) => setPersona("candidateRole", v)} />
              <PersonaText label="Current company" value={form.persona.currentCompany} onChange={(v) => setPersona("currentCompany", v)} />
              <PersonaText label="Location" value={form.persona.location} onChange={(v) => setPersona("location", v)} />
              <PersonaNum label="Years experience" value={form.persona.yearsExperience} onChange={(v) => setPersona("yearsExperience", v)} />
              <PersonaNum label="Notice period (days)" value={form.persona.noticePeriodDays} onChange={(v) => setPersona("noticePeriodDays", v)} />
              <div className="space-y-1.5">
                <Label htmlFor="sc-style">Speaking style</Label>
                <Select
                  value={form.persona.speakingStyle ?? NONE}
                  onValueChange={(v) => setPersona("speakingStyle", v === NONE ? undefined : (v as Persona["speakingStyle"]))}
                >
                  <SelectTrigger id="sc-style"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {["concise", "verbose", "evasive", "warm"].map((x) => (
                      <SelectItem key={x} value={x}>{x}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sc-resist">Resistance</Label>
                <Select
                  value={form.persona.resistance ?? NONE}
                  onValueChange={(v) => setPersona("resistance", v === NONE ? undefined : (v as Persona["resistance"]))}
                >
                  <SelectTrigger id="sc-resist"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {["low", "medium", "high"].map((x) => (
                      <SelectItem key={x} value={x}>{x}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sc-hidden">Hidden context (revealed only if probed)</Label>
              <Textarea
                id="sc-hidden"
                rows={2}
                value={form.persona.hiddenContext ?? ""}
                onChange={(e) => setPersona("hiddenContext", e.target.value)}
              />
            </div>
          </fieldset>

          {/* Objections */}
          <RepeatableList
            label="Objections (scripted pushbacks)"
            items={form.objections}
            onChange={(v) => set("objections", v)}
            placeholder="e.g. Notice period 90 din ka hai"
          />

          {/* Success criteria */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <Label>Success criteria (weighted)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  set("successCriteria", [
                    ...form.successCriteria,
                    { id: `c${form.successCriteria.length + 1}`, label: "", weight: 1 },
                  ])
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {form.successCriteria.length === 0 && (
              <p className="text-xs text-muted-foreground">No criteria — overall scoring falls back to the linked rubric.</p>
            )}
            {form.successCriteria.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Criterion ${i + 1} label`}
                  value={c.label}
                  onChange={(e) => {
                    const next = [...form.successCriteria];
                    next[i] = { ...c, label: e.target.value };
                    set("successCriteria", next);
                  }}
                  placeholder="Criterion label"
                />
                <Input
                  aria-label={`Criterion ${i + 1} weight`}
                  type="number"
                  className="w-20"
                  value={c.weight}
                  onChange={(e) => {
                    const next = [...form.successCriteria];
                    next[i] = { ...c, weight: Number(e.target.value) };
                    set("successCriteria", next);
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove criterion ${i + 1}`}
                  onClick={() => set("successCriteria", form.successCriteria.filter((_, j) => j !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {criteriaError && <p className="text-xs text-destructive">{criteriaError}</p>}
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <Label htmlFor="sc-tag">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="sc-tag"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Add a tag and press Enter"
              />
              <Button type="button" variant="outline" onClick={addTag}>
                Add
              </Button>
            </div>
            {form.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {form.tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
                    {t}
                    <button type="button" aria-label={`Remove tag ${t}`} onClick={() => set("tags", form.tags.filter((x) => x !== t))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch id="sc-pub" checked={form.isPublished} onCheckedChange={(v) => set("isPublished", v)} />
            <Label htmlFor="sc-pub">Published (recruiters can practise)</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!valid || pending}>
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {editing ? "Save changes" : "Create scenario"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cleanPersona(p: Persona): Persona {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Persona;
}

function PersonaText({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  const id = useMemo(() => `p-${label.replace(/\s+/g, "-").toLowerCase()}`, [label]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function PersonaNum({ label, value, onChange }: { label: string; value?: number; onChange: (v: number | undefined) => void }) {
  const id = useMemo(() => `p-${label.replace(/\s+/g, "-").toLowerCase()}`, [label]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </div>
  );
}

function RepeatableList({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...items, ""])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {items.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`${label} ${i + 1}`}
            value={it}
            placeholder={placeholder}
            onChange={(e) => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${label} ${i + 1}`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
