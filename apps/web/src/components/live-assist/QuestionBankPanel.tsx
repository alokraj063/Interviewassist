import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Loader2, Mic, Sparkles, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface SkillGroup { skill: string; questions: Array<{ difficulty: string; question: string }> }
interface JdBank { kind?: string; skills?: SkillGroup[]; total?: number; notesUsed?: string; generatedAt?: string }

interface BankSummary {
  id: string;
  name: string;
  questionCount: number;
}
interface BankQuestion {
  id: string;
  skillId: string | null;
  level: "junior" | "mid" | "senior" | "staff";
  difficulty: number;
  prompt: string;
  expectedAnswerHints: string | null;
  followUpQuestions: string[];
}
interface QuestionListResponse {
  questions: BankQuestion[];
}

const DIFFICULTY_PILL: Record<string, string> = {
  easy: "bg-emerald-50 text-emerald-700",
  medium: "bg-amber-50 text-amber-700",
  hard: "bg-rose-50 text-rose-700",
};

const LEVEL_PILL: Record<string, string> = {
  junior: "bg-emerald-50 text-emerald-700",
  mid: "bg-sky-50 text-sky-700",
  senior: "bg-violet-50 text-violet-700",
  staff: "bg-rose-50 text-rose-700",
};

/**
 * Live Assist right-panel: Question Bank.
 *
 * Pulls every bank for the org and renders the first one's questions as
 * one-click "Ask this" buttons during a call. Phase 2 will filter to the
 * current demand's must-have skills and log clicks to a per-call store.
 */
export function QuestionBankPanel({
  demandId,
  onAsk,
  generatedPlan,
  generating,
}: {
  /** When set, prefer banks linked to this demand (the selected JD). */
  demandId?: string;
  /** Click "Ask this" → overtake the interview flow's current question. */
  onAsk?: (question: string, category: string) => void;
  /** The question plan AI-generated for THIS call from the JD (preferred). */
  generatedPlan?: Array<{ name: string; questions: string[] }>;
  /** True while the plan is still being generated. */
  generating?: boolean;
} = {}) {
  // PRIMARY source when a JD is selected: the cached, skill-wise question bank
  // stored on the demand. Generated ONCE per JD (button below) and reused — not
  // regenerated every call.
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data: bankData, isLoading: bankLoading } = useQuery<{ ok: boolean; bank: JdBank | null; generatedAt: string | null }>({
    queryKey: ["demand-question-bank", demandId],
    queryFn: () => apiFetch(`/api/demands/${demandId}/question-bank`),
    enabled: !!demandId,
  });
  const skillBank = bankData?.bank?.skills?.length ? bankData.bank : null;

  async function generate(force: boolean) {
    if (!demandId) return;
    setBusy(true);
    try {
      await apiFetch(`/api/demands/${demandId}/question-bank`, { method: "POST", json: { force } });
      await qc.invalidateQueries({ queryKey: ["demand-question-bank", demandId] });
      toast.success(force ? "Question bank regenerated" : "Question bank ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the question bank");
    } finally {
      setBusy(false);
    }
  }

  // When a JD is selected, the cached skill-wise bank owns this panel.
  if (demandId) {
    const total = skillBank?.total ?? (skillBank?.skills ?? []).reduce((n, s) => n + s.questions.length, 0);
    return (
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between shrink-0">
          <span className="truncate">Question bank · by skill{skillBank ? ` · ${total} q` : ""}</span>
          {skillBank && (
            <button onClick={() => generate(true)} disabled={busy} className="inline-flex items-center gap-1 normal-case text-[11px] hover:text-foreground disabled:opacity-50">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Regenerate
            </button>
          )}
        </div>

        {bankLoading ? (
          <div className="p-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : skillBank ? (
          <div className="overflow-y-auto divide-y divide-border" style={{ maxHeight: 360 }}>
            {(skillBank.skills ?? []).map((g, gi) => (
              <div key={gi} className="py-1">
                <div className="px-4 py-1.5 text-[11px] font-semibold text-foreground/80 bg-muted/20 sticky top-0">{g.skill}</div>
                {g.questions.map((q, qi) => (
                  <div key={qi} className="px-4 py-2 hover:bg-muted/30">
                    <span className={cn("pill text-[10px] mb-1 inline-block", DIFFICULTY_PILL[(q.difficulty || "").toLowerCase()] ?? "bg-muted text-muted-foreground")}>{q.difficulty}</span>
                    <div className="text-sm">{q.question}</div>
                    <button
                      className="mt-2 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-md px-2 py-1 inline-flex items-center gap-1"
                      onClick={() => { onAsk?.(q.question, g.skill); toast.success("Now asking this question", { description: q.question.slice(0, 60) }); }}
                    >
                      <Mic className="w-3 h-3" />Ask this
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          // No bank yet → the "initiate question bank" CTA (pre-call).
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-3">
            <Sparkles className="w-6 h-6 text-primary" />
            <div className="text-sm font-medium">Generate the question bank for this JD</div>
            <p className="text-xs text-muted-foreground max-w-xs">
              Detailed, skill-wise questions built from the job description (and any emphasis notes you added). Generated once and reused — no need to redo it each call.
            </p>
            <button
              onClick={() => generate(false)}
              disabled={busy}
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-60 rounded-md px-3.5 py-2"
            >
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating… (~15s)</> : <><Sparkles className="w-4 h-4" /> Generate question bank</>}
            </button>
          </div>
        )}
      </div>
    );
  }

  // No JD selected → fall back to the legacy per-call plan, then org banks.
  const planQuestions = (generatedPlan ?? []).flatMap((c) =>
    (c.questions ?? []).map((q) => ({ category: c.name, prompt: q })),
  );
  if (generating && planQuestions.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating the question bank…
      </div>
    );
  }
  if (planQuestions.length > 0) {
    return (
      <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
        <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between">
          <span className="truncate">Generated for this call</span>
          <span className="tabular-nums shrink-0">{planQuestions.length} q</span>
        </div>
        <div className="divide-y divide-border">
          {planQuestions.map((q, i) => (
            <div key={i} className="p-3 hover:bg-muted/30">
              <span className={cn("pill text-[10px] mb-1 inline-block", DIFFICULTY_PILL[q.category.toLowerCase()] ?? "bg-muted text-muted-foreground")}>
                {q.category}
              </span>
              <div className="text-sm">{q.prompt}</div>
              <button
                className="mt-2 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-md px-2 py-1 inline-flex items-center gap-1"
                onClick={() => {
                  onAsk?.(q.prompt, q.category);
                  toast.success("Now asking this question", { description: q.prompt.slice(0, 60) });
                }}
              >
                <Mic className="w-3 h-3" />Ask this
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return <DbBankPanel demandId={demandId} onAsk={onAsk} />;
}

function DbBankPanel({
  demandId,
  onAsk,
}: {
  demandId?: string;
  onAsk?: (question: string, category: string) => void;
}) {
  // Banks linked to the selected demand (the JD). Strictly JD-based: when a
  // demand is selected we ONLY show its linked bank(s). With no demand (pre-call
  // browsing) we show all org banks.
  const { data: demandBanks, isLoading: demandLoading } = useQuery<{ banks: BankSummary[] }>({
    queryKey: ["question-banks", "demand", demandId],
    queryFn: () => apiFetch(`/api/question-banks?demandId=${demandId}`),
    enabled: !!demandId,
  });
  const { data: allBanks, isLoading: allLoading } = useQuery<{ banks: BankSummary[] }>({
    queryKey: ["question-banks", "all"],
    queryFn: () => apiFetch("/api/question-banks"),
    enabled: !demandId,
  });

  const banks = demandId ? demandBanks?.banks ?? [] : allBanks?.banks ?? [];
  const banksLoading = demandId ? demandLoading : allLoading;
  const firstBank = banks[0];
  const firstBankId = firstBank?.id;

  // The `/:id` endpoint returns bank metadata only; questions live under
  // `/:id/questions` (paginated). Pull the first page for the live panel.
  const { data: questionsData, isLoading: questionsLoading } = useQuery<QuestionListResponse>({
    queryKey: ["question-bank-questions", firstBankId],
    queryFn: () => apiFetch(`/api/question-banks/${firstBankId}/questions`),
    enabled: !!firstBankId,
  });

  if (banksLoading || questionsLoading) {
    return (
      <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading question bank…
      </div>
    );
  }

  const questions = questionsData?.questions ?? [];

  if (!banks.length || !firstBank) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground">
        <Library className="w-5 h-5 mx-auto opacity-40 mb-1" />
        {demandId
          ? "No question bank linked to this JD. Link one in Settings → Jobs."
          : "No question banks yet. Add one in Settings → Jobs."}
      </div>
    );
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between">
        <span className="truncate">{firstBank.name}</span>
        <span className="tabular-nums shrink-0">{questions.length} q</span>
      </div>
      <div className="divide-y divide-border">
        {questions.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground text-center">No questions in this bank yet.</div>
        ) : questions.slice(0, 12).map((q) => (
          <div key={q.id} className="p-3 hover:bg-muted/30">
            <div className="flex items-center gap-2 mb-1">
              <span className={cn("pill text-[10px]", LEVEL_PILL[q.level])}>{q.level}</span>
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">D{q.difficulty}</span>
            </div>
            <div className="text-sm">{q.prompt}</div>
            {q.expectedAnswerHints && (
              <div className="text-[11px] text-muted-foreground mt-1 italic">Listen for: {q.expectedAnswerHints}</div>
            )}
            <button
              className="mt-2 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-md px-2 py-1 inline-flex items-center gap-1"
              onClick={() => {
                if (onAsk) {
                  onAsk(q.prompt, `Bank · ${q.level}`);
                  toast.success("Now asking this question", { description: q.prompt.slice(0, 60) + "…" });
                } else {
                  toast.success("Question logged as asked", { description: q.prompt.slice(0, 60) + "…" });
                }
              }}
            >
              <Mic className="w-3 h-3" />Ask this
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
