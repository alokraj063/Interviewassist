import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  RECOMMENDATIONS,
  RECOMMENDATION_LABELS,
  useSaveScorecard,
  type Question,
  type QuestionScore,
  type Recommendation,
  type Scorecard,
} from "@/hooks/useAsyncVideo";

export function ScorecardForm({
  submissionId,
  questions,
  existing,
}: {
  submissionId: string;
  questions: Question[];
  existing: Scorecard | null;
}) {
  const [scores, setScores] = useState<Map<string, QuestionScore>>(() => {
    const m = new Map<string, QuestionScore>();
    for (const qs of existing?.questionScores ?? []) m.set(qs.questionId, qs);
    return m;
  });
  const [recommendation, setRecommendation] = useState<Recommendation | "">(existing?.recommendation ?? "");
  const [summaryNote, setSummaryNote] = useState(existing?.summaryNote ?? "");

  const save = useSaveScorecard(submissionId);

  const scoredCount = questions.filter((q) => scores.has(q.id)).length;
  const valid = scoredCount === questions.length && questions.length > 0 && recommendation !== "";

  const overall = useMemo(() => {
    const arr = [...scores.values()];
    if (arr.length === 0) return null;
    const mean = arr.reduce((a, b) => a + b.score, 0) / arr.length;
    return Math.round((mean / 5) * 100 * 10) / 10;
  }, [scores]);

  const setScore = (questionId: string, score: number) =>
    setScores((cur) => {
      const next = new Map(cur);
      const prev = next.get(questionId);
      next.set(questionId, { questionId, score, note: prev?.note });
      return next;
    });

  const setNote = (questionId: string, note: string) =>
    setScores((cur) => {
      const next = new Map(cur);
      const prev = next.get(questionId) ?? { questionId, score: 0 };
      next.set(questionId, { ...prev, note });
      return next;
    });

  const persist = async (submitted: boolean) => {
    if (submitted && !valid) return;
    try {
      await save.mutateAsync({
        questionScores: [...scores.values()],
        recommendation: recommendation || null,
        summaryNote: summaryNote.trim() || null,
        submitted,
      });
      toast.success(submitted ? "Scorecard submitted" : "Draft saved");
    } catch (err) {
      toast.error("Couldn't save scorecard", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="space-y-4">
      {existing?.submitted && (
        <div className="flex items-center gap-2 rounded-md bg-success/10 text-success px-3 py-2 text-sm">
          <CheckCircle2 className="w-4 h-4" /> Your scorecard is submitted. Editing will resubmit it.
        </div>
      )}

      <div className="space-y-3">
        {questions.map((q, i) => {
          const cur = scores.get(q.id);
          return (
            <div key={q.id} className="rounded border border-border p-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                Q{i + 1}
                {q.competencyKey ? ` · ${q.competencyKey}` : ""}
              </div>
              <div className="text-sm">{q.text}</div>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`Score for question ${i + 1}`}>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={cur?.score === n}
                    onClick={() => setScore(q.id, n)}
                    className={cn(
                      "h-8 w-8 rounded border text-sm tabular-nums",
                      cur?.score === n
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input hover:bg-muted",
                    )}
                  >
                    {n}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground ml-2">0 = poor · 5 = excellent</span>
              </div>
              <Textarea
                value={cur?.note ?? ""}
                onChange={(e) => setNote(q.id, e.target.value)}
                rows={1}
                placeholder="Evidence / note (optional)"
                className="text-xs"
                aria-label={`Note for question ${i + 1}`}
              />
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Recommendation</Label>
          <Select value={recommendation} onValueChange={(v) => setRecommendation(v as Recommendation)}>
            <SelectTrigger aria-label="Recommendation">
              <SelectValue placeholder="Pick one" />
            </SelectTrigger>
            <SelectContent>
              {RECOMMENDATIONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {RECOMMENDATION_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Overall (computed)</Label>
          <div className="h-9 flex items-center px-3 rounded border border-input bg-muted/40 text-sm tabular-nums">
            {overall == null ? "—" : `${overall} / 100`}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="av-summary">Summary</Label>
        <Textarea
          id="av-summary"
          value={summaryNote}
          onChange={(e) => setSummaryNote(e.target.value)}
          rows={2}
          placeholder="Overall assessment in your own words"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => void persist(false)} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
          Save draft
        </Button>
        <Button onClick={() => void persist(true)} disabled={!valid || save.isPending}>
          {save.isPending ? "Submitting…" : "Submit scorecard"}
        </Button>
        {!valid && (
          <span className="text-xs text-muted-foreground">
            Score every question ({scoredCount}/{questions.length}) and pick a recommendation to submit.
          </span>
        )}
      </div>
    </div>
  );
}
