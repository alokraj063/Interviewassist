// Multi-field question authoring form (create + edit). Replaces the old
// hardcoded-stub "Add question" POST. Disabled-until-valid, "Saving…" state,
// client-side mirror of the server superRefine option rules, optimistic-
// concurrency on edit (expectedVersion → 409 handling), and duplicate-409
// inline banner with an "Add anyway" override.
import { useEffect, useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateQuestion,
  usePatchQuestion,
  QUESTION_LEVELS,
  QUESTION_LANGUAGES,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  LANGUAGE_LABELS,
  type QuestionDraft,
  type QuestionLevel,
  type QuestionLanguage,
  type QuestionType,
  type QuestionOption,
  type QuestionRow,
} from "@/hooks/useQuestionBanks";
import { StringListEditor } from "./StringListEditor";

const CHOICE_TYPES: QuestionType[] = ["mcq_single", "mcq_multi", "true_false"];

function emptyDraft(): QuestionDraft {
  return {
    skillName: "",
    level: "mid",
    difficulty: 3,
    language: "en",
    questionType: "verbal",
    roleFamily: "",
    prompt: "",
    expectedAnswerHints: "",
    evaluationRubric: [],
    followUpQuestions: [],
    commonMistakes: [],
    options: [],
  };
}

function draftFromQuestion(q: QuestionRow): QuestionDraft {
  return {
    skillId: q.skillId,
    level: q.level,
    difficulty: q.difficulty,
    language: q.language,
    questionType: q.questionType,
    roleFamily: q.roleFamily ?? "",
    prompt: q.prompt,
    expectedAnswerHints: q.expectedAnswerHints ?? "",
    evaluationRubric: q.evaluationRubric,
    followUpQuestions: q.followUpQuestions,
    commonMistakes: q.commonMistakes,
    options: q.options,
  };
}

// Mirror of the server superRefine: returns an error string or null.
function validate(d: QuestionDraft): string | null {
  if (!d.prompt.trim()) return "A prompt is required.";
  if (CHOICE_TYPES.includes(d.questionType)) {
    if (d.options.length < 2) return "Choice questions need ≥2 options.";
    if (d.options.some((o) => !o.text.trim())) return "Every option needs text.";
    const correct = d.options.filter((o) => o.correct).length;
    if (d.questionType === "mcq_single" && correct !== 1)
      return "Single-choice needs exactly one correct option.";
    if (d.questionType === "mcq_multi" && correct < 1)
      return "Multi-choice needs ≥1 correct option.";
    if (d.questionType === "true_false" && correct < 1)
      return "True/false needs a correct option marked.";
  }
  return null;
}

export function QuestionEditorDialog({
  open,
  onOpenChange,
  bankId,
  bankDefaultLanguage,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bankId: string;
  bankDefaultLanguage?: QuestionLanguage;
  editing?: QuestionRow | null;
}) {
  const isEdit = !!editing;
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [dupId, setDupId] = useState<string | null>(null);

  const create = useCreateQuestion(bankId);
  const patch = usePatchQuestion(bankId);
  const pending = create.isPending || patch.isPending;

  useEffect(() => {
    if (!open) return;
    setDupId(null);
    setDraft(
      editing
        ? draftFromQuestion(editing)
        : { ...emptyDraft(), language: bankDefaultLanguage ?? "en" },
    );
  }, [open, editing, bankDefaultLanguage]);

  const validationError = useMemo(() => validate(draft), [draft]);
  const isChoice = CHOICE_TYPES.includes(draft.questionType);

  function up<K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDupId(null);
  }

  function setOptions(next: QuestionOption[]) {
    up("options", next);
  }

  function submit(allowDuplicate = false) {
    if (validationError || pending) return;
    const body: QuestionDraft = {
      ...draft,
      roleFamily: draft.roleFamily?.trim() || null,
      expectedAnswerHints: draft.expectedAnswerHints?.trim() || null,
      skillName: draft.skillName?.trim() || undefined,
      options: isChoice ? draft.options : [],
    };

    if (isEdit && editing) {
      patch.mutate(
        { questionId: editing.id, body: { ...body, expectedVersion: editing.currentVersion } },
        {
          onSuccess: () => {
            toast.success("Question saved");
            onOpenChange(false);
          },
          onError: (err) => {
            const e = err as { status?: number; body?: { error?: string } };
            if (e.status === 409 && e.body?.error === "version_conflict") {
              toast.error("Edited elsewhere — reload and retry");
            } else {
              toast.error(e.body?.error ?? (err as Error).message ?? "Save failed");
            }
          },
        },
      );
      return;
    }

    create.mutate(
      { body, allowDuplicate },
      {
        onSuccess: () => {
          toast.success("Question added (draft)");
          onOpenChange(false);
        },
        onError: (err) => {
          const e = err as { status?: number; body?: { error?: string; existingId?: string } };
          if (e.status === 409 && e.body?.error === "duplicate_question") {
            setDupId(e.body.existingId ?? null);
          } else {
            toast.error(e.body?.error ?? (err as Error).message ?? "Create failed");
          }
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit question" : "New question"}</DialogTitle>
          <DialogDescription>
            Author a screening question with rich tags so it can be filtered, calibrated, and routed
            through review.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="q-prompt">Prompt</Label>
            <Textarea
              id="q-prompt"
              autoFocus
              value={draft.prompt}
              onChange={(e) => up("prompt", e.target.value)}
              placeholder="The question the recruiter or AI screener will ask…"
              className="min-h-[80px]"
              maxLength={4000}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="q-type">Question type</Label>
              <Select
                value={draft.questionType}
                onValueChange={(v) => up("questionType", v as QuestionType)}
              >
                <SelectTrigger id="q-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {QUESTION_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-skill">Skill</Label>
              <Input
                id="q-skill"
                value={draft.skillName ?? ""}
                onChange={(e) => up("skillName", e.target.value)}
                placeholder={
                  isEdit && draft.skillId ? "(existing skill — type to change)" : "e.g. Spring Boot"
                }
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-level">Level</Label>
              <Select value={draft.level} onValueChange={(v) => up("level", v as QuestionLevel)}>
                <SelectTrigger id="q-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-lang">Language</Label>
              <Select
                value={draft.language}
                onValueChange={(v) => up("language", v as QuestionLanguage)}
              >
                <SelectTrigger id="q-lang">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUESTION_LANGUAGES.map((l) => (
                    <SelectItem key={l} value={l}>
                      {LANGUAGE_LABELS[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-role">Role family</Label>
              <Input
                id="q-role"
                value={draft.roleFamily ?? ""}
                onChange={(e) => up("roleFamily", e.target.value)}
                placeholder="e.g. backend, frontend, data"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="q-diff">Difficulty: {draft.difficulty}</Label>
              <Slider
                id="q-diff"
                min={1}
                max={5}
                step={1}
                value={[draft.difficulty]}
                onValueChange={([v]) => up("difficulty", v)}
                aria-label="Difficulty 1 to 5"
              />
            </div>
          </div>

          {isChoice && (
            <OptionsEditor
              questionType={draft.questionType}
              options={draft.options}
              onChange={setOptions}
            />
          )}

          <div className="space-y-1.5">
            <Label htmlFor="q-hints">Expected-answer hints</Label>
            <Textarea
              id="q-hints"
              value={draft.expectedAnswerHints ?? ""}
              onChange={(e) => up("expectedAnswerHints", e.target.value)}
              placeholder="What to listen for in a strong response…"
              maxLength={4000}
            />
          </div>

          <StringListEditor
            label="Evaluation rubric"
            items={draft.evaluationRubric}
            onChange={(v) => up("evaluationRubric", v)}
            placeholder="A point graders should look for…"
          />
          <StringListEditor
            label="Follow-up questions"
            items={draft.followUpQuestions}
            onChange={(v) => up("followUpQuestions", v)}
            placeholder="A probing follow-up…"
          />
          <StringListEditor
            label="Common mistakes"
            items={draft.commonMistakes}
            onChange={(v) => up("commonMistakes", v)}
            placeholder="A typical wrong answer to watch for…"
          />

          {dupId && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                A near-identical question already exists.{" "}
                <a
                  href={`/question-banks/${bankId}/questions/${dupId}`}
                  className="font-medium underline"
                >
                  View it
                </a>{" "}
                or add anyway.
              </div>
            </div>
          )}

          {validationError && (
            <div className="text-sm text-destructive" role="alert">
              {validationError}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {dupId && !isEdit ? (
              <Button type="button" onClick={() => submit(true)} disabled={pending}>
                {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Add anyway
              </Button>
            ) : (
              <Button type="submit" disabled={!!validationError || pending}>
                {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {pending ? "Saving…" : isEdit ? "Save changes" : "Add question"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionsEditor({
  questionType,
  options,
  onChange,
}: {
  questionType: QuestionType;
  options: QuestionOption[];
  onChange: (next: QuestionOption[]) => void;
}) {
  const single = questionType === "mcq_single";

  function add() {
    onChange([...options, { id: crypto.randomUUID(), text: "", correct: false }]);
  }
  function toggleCorrect(id: string) {
    onChange(
      options.map((o) =>
        o.id === id
          ? { ...o, correct: !o.correct }
          : single
            ? { ...o, correct: false }
            : o,
      ),
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Label>Options</Label>
      <div className="space-y-2">
        {options.map((o) => (
          <div key={o.id} className="flex items-center gap-2">
            <Checkbox
              checked={o.correct}
              onCheckedChange={() => toggleCorrect(o.id)}
              aria-label={`Mark "${o.text || "option"}" correct`}
            />
            <Input
              value={o.text}
              onChange={(e) =>
                onChange(options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))
              }
              placeholder="Option text…"
              maxLength={500}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Remove option"
              onClick={() => onChange(options.filter((x) => x.id !== o.id))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {options.length < 12 && (
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add option
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {single ? "Exactly one option must be correct." : "Mark at least one correct option."}
      </p>
    </div>
  );
}
