import { useQuery } from "@tanstack/react-query";
import { Library, Loader2, Mic } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
}: {
  /** When set, prefer banks linked to this demand (the selected JD). */
  demandId?: string;
  /** Click "Ask this" → overtake the interview flow's current question. */
  onAsk?: (question: string, category: string) => void;
} = {}) {
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
