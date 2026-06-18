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
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useCreateCampaign, type CampaignRow, type QuestionDraft } from "@/hooks/useAsyncVideo";

interface DraftQuestion extends QuestionDraft {
  _key: string;
}

function blankQuestion(): DraftQuestion {
  return {
    _key: crypto.randomUUID(),
    text: "",
    prepSeconds: 30,
    maxSeconds: 120,
    maxRetakes: 0,
    competencyKey: null,
  };
}

export function CampaignBuilderDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (campaign: CampaignRow) => void;
}) {
  const [title, setTitle] = useState("");
  const [introText, setIntroText] = useState("");
  const [outroText, setOutroText] = useState("");
  const [blindReview, setBlindReview] = useState(false);
  const [requireDeviceCheck, setRequireDeviceCheck] = useState(true);
  const [questions, setQuestions] = useState<DraftQuestion[]>([blankQuestion()]);

  const create = useCreateCampaign();

  const validQuestions = questions.filter((q) => q.text.trim().length > 0);
  const valid = title.trim().length > 0 && validQuestions.length > 0;

  const reset = () => {
    setTitle("");
    setIntroText("");
    setOutroText("");
    setBlindReview(false);
    setRequireDeviceCheck(true);
    setQuestions([blankQuestion()]);
  };

  const patchQ = (key: string, patch: Partial<DraftQuestion>) =>
    setQuestions((cur) => cur.map((q) => (q._key === key ? { ...q, ...patch } : q)));

  const removeQ = (key: string) =>
    setQuestions((cur) => (cur.length > 1 ? cur.filter((q) => q._key !== key) : cur));

  const move = (key: string, dir: -1 | 1) =>
    setQuestions((cur) => {
      const idx = cur.findIndex((q) => q._key === key);
      const next = idx + dir;
      if (idx < 0 || next < 0 || next >= cur.length) return cur;
      const copy = [...cur];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });

  const submit = async () => {
    if (!valid || create.isPending) return;
    try {
      const res = await create.mutateAsync({
        title: title.trim(),
        introText: introText.trim() || null,
        outroText: outroText.trim() || null,
        blindReview,
        requireDeviceCheck,
        questions: validQuestions.map((q) => ({
          text: q.text.trim(),
          prepSeconds: q.prepSeconds,
          maxSeconds: q.maxSeconds,
          maxRetakes: q.maxRetakes,
          competencyKey: q.competencyKey?.trim() || null,
        })),
      });
      toast.success("Video screen created");
      reset();
      onOpenChange(false);
      onCreated(res.campaign);
    } catch (err) {
      toast.error("Couldn't create video screen", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New video screen</DialogTitle>
          <DialogDescription>
            Author the ordered questions, intro/outro, and bias controls. Publish from the builder once it's ready.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="av-title">Title</Label>
            <Input
              id="av-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior Backend — Self-introduction"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="av-intro">Intro (shown before recording)</Label>
              <Textarea id="av-intro" value={introText} onChange={(e) => setIntroText(e.target.value)} rows={2} placeholder="Welcome message (optional)" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="av-outro">Outro (shown after submit)</Label>
              <Textarea id="av-outro" value={outroText} onChange={(e) => setOutroText(e.target.value)} rows={2} placeholder="Thank-you message (optional)" />
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={blindReview} onCheckedChange={setBlindReview} aria-label="Blind review" />
              Blind review (hide candidate name/photo)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={requireDeviceCheck} onCheckedChange={setRequireDeviceCheck} aria-label="Require device check" />
              Require device check
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Questions ({validQuestions.length})</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => setQuestions((c) => [...c, blankQuestion()])}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Add question
              </Button>
            </div>
            <div className="space-y-2">
              {questions.map((q, i) => (
                <div key={q._key} className="rounded border border-border p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col items-center pt-1.5 text-muted-foreground">
                      <GripVertical className="w-4 h-4" />
                      <button type="button" className="text-xs hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={() => move(q._key, -1)} aria-label="Move up">▲</button>
                      <button type="button" className="text-xs hover:text-foreground disabled:opacity-30" disabled={i === questions.length - 1} onClick={() => move(q._key, 1)} aria-label="Move down">▼</button>
                    </div>
                    <div className="flex-1 space-y-2">
                      <Textarea
                        value={q.text}
                        onChange={(e) => patchQ(q._key, { text: e.target.value })}
                        rows={2}
                        placeholder={`Question ${i + 1} prompt…`}
                        aria-label={`Question ${i + 1} text`}
                      />
                      <div className="grid grid-cols-4 gap-2">
                        <NumberField label="Prep (s)" value={q.prepSeconds ?? 30} min={0} max={600} onChange={(v) => patchQ(q._key, { prepSeconds: v })} />
                        <NumberField label="Take (s)" value={q.maxSeconds ?? 120} min={15} max={600} onChange={(v) => patchQ(q._key, { maxSeconds: v })} />
                        <NumberField label="Retakes" value={q.maxRetakes ?? 0} min={0} max={5} onChange={(v) => patchQ(q._key, { maxRetakes: v })} />
                        <div className="space-y-1">
                          <Label className="text-[11px] text-muted-foreground">Competency</Label>
                          <Input
                            value={q.competencyKey ?? ""}
                            onChange={(e) => patchQ(q._key, { competencyKey: e.target.value })}
                            className="h-8"
                            placeholder="e.g. ownership"
                            aria-label={`Question ${i + 1} competency`}
                          />
                        </div>
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="ghost" className="text-destructive" disabled={questions.length === 1} onClick={() => removeQ(q._key)} aria-label={`Remove question ${i + 1}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || create.isPending}>
            {create.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            {create.isPending ? "Creating…" : "Create video screen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8"
        aria-label={label}
      />
    </div>
  );
}
