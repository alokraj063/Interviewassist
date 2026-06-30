import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Loader2, Mic, Sparkles, Plus, Download } from "lucide-react";
import { apiFetch, downloadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface SkillGroup { skill: string; questions: Array<{ difficulty: string; question: string }> }
interface JdBank { kind?: string; skills?: SkillGroup[]; total?: number; notesUsed?: string; generatedAt?: string }
interface BankVersion { version: number; addedJd: string; bank: JdBank; generatedAt: string | null }

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
  // PRIMARY source when a JD is selected: a VERSIONED, skill-wise question bank
  // stored on the demand. v1 = base JD; each later version layers extra JD points
  // the recruiter typed. Generated on demand and reused — not regenerated per call.
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [addedText, setAddedText] = useState("");
  const [activeVersion, setActiveVersion] = useState<number | null>(null);

  const { data: bankData, isLoading: bankLoading } = useQuery<{ ok: boolean; versions: BankVersion[]; assessmentNotes: string }>({
    queryKey: ["demand-question-bank", demandId],
    queryFn: () => apiFetch(`/api/demands/${demandId}/question-bank`),
    enabled: !!demandId,
  });
  const versions = bankData?.versions ?? [];
  const latest = versions[versions.length - 1];
  const current = versions.find((v) => v.version === activeVersion) ?? latest ?? null;

  async function generate() {
    if (!demandId) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ created: boolean; version?: number; versions: BankVersion[] }>(
        `/api/demands/${demandId}/question-bank`,
        { method: "POST", json: { addedJd: addedText.trim() } },
      );
      await qc.invalidateQueries({ queryKey: ["demand-question-bank", demandId] });
      if (res.created) {
        setActiveVersion(res.version ?? null);
        toast.success(`Question bank v${res.version} ready`);
      } else {
        toast.message("No extra JD points added — showing the existing bank.");
      }
      setShowPrompt(false);
      setAddedText("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the question bank");
    } finally {
      setBusy(false);
    }
  }

  // Download the selected version as a polished PDF (server-rendered).
  const [downloadingBank, setDownloadingBank] = useState(false);
  async function downloadBank() {
    if (!demandId || !current) return;
    setDownloadingBank(true);
    try {
      await downloadFile(
        `/api/demands/${demandId}/question-bank/download?version=${current.version}`,
        `question-bank-v${current.version}.pdf`,
      );
    } catch {
      toast.error("Could not download the question bank.");
    } finally {
      setDownloadingBank(false);
    }
  }

  // When a JD is selected, the versioned skill-wise bank owns this panel.
  if (demandId) {
    return (
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-4 py-2 border-b border-border bg-muted/30 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
              Question bank · by skill{current?.bank?.total ? ` · ${current.bank.total} q` : ""}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {current?.bank?.skills?.length ? (
                <button onClick={downloadBank} disabled={downloadingBank} className="inline-flex items-center gap-1 text-[11px] hover:text-foreground disabled:opacity-50" title="Download as PDF">
                  {downloadingBank ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} PDF
                </button>
              ) : null}
              {versions.length > 0 && (
                <button onClick={() => { setShowPrompt(true); setAddedText(""); }} disabled={busy}
                  className="inline-flex items-center gap-1 text-[11px] hover:text-foreground disabled:opacity-50">
                  <Plus className="w-3 h-3" /> New version
                </button>
              )}
            </div>
          </div>
          {versions.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">Versions</span>
              {versions.map((v) => (
                <button
                  key={v.version}
                  type="button"
                  onClick={() => setActiveVersion(v.version)}
                  title={v.addedJd ? `Added: ${v.addedJd}` : "Base JD"}
                  className={cn(
                    "text-xs font-medium px-2.5 py-1 rounded-full border transition-colors",
                    (current?.version ?? latest?.version) === v.version
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50",
                  )}
                >
                  v{v.version}
                </button>
              ))}
              {current?.bank?.skills?.length ? (
                <button
                  onClick={downloadBank}
                  disabled={downloadingBank}
                  title="Download the selected version as PDF"
                  className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {downloadingBank ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} PDF v{current.version}
                </button>
              ) : null}
            </div>
          )}
        </div>

        {showPrompt && (
          <div className="p-3 border-b border-border bg-muted/10 space-y-2">
            <div className="text-xs font-medium">Add anything to the JD? <span className="text-muted-foreground font-normal">(optional)</span></div>
            <textarea value={addedText} onChange={(e) => setAddedText(e.target.value)} rows={3}
              placeholder="e.g. Add a round on system design and Kafka exactly-once semantics. Leave blank to use the JD as-is."
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" />
            <div className="flex items-center gap-2">
              <button onClick={generate} disabled={busy}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-60 rounded-md px-3 py-1.5">
                {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Generating… (~15s)</> : <><Sparkles className="w-3.5 h-3.5" /> {addedText.trim() ? "Generate new version" : "Generate"}</>}
              </button>
              <button onClick={() => { setShowPrompt(false); setAddedText(""); }} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          </div>
        )}

        {bankLoading ? (
          <div className="p-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : current?.bank?.skills?.length ? (
          <div className="overflow-y-auto" style={{ maxHeight: 360 }}>
            {current.addedJd && (
              <div className="px-4 py-1.5 text-[11px] text-muted-foreground bg-amber-500/10 border-b border-border">
                <span className="font-semibold">v{current.version} added to JD:</span> {current.addedJd}
              </div>
            )}
            <div className="divide-y divide-border">
              {(current.bank.skills ?? []).map((g, gi) => (
                <div key={gi} className="py-1">
                  <div className="px-4 py-1.5 text-[11px] font-semibold text-foreground/80 bg-muted/20">{g.skill}</div>
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
          </div>
        ) : !showPrompt ? (
          // No bank yet → the "initiate question bank" CTA (pre-call).
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-3">
            <Sparkles className="w-6 h-6 text-primary" />
            <div className="text-sm font-medium">Generate the question bank for this JD</div>
            <p className="text-xs text-muted-foreground max-w-xs">
              Detailed, skill-wise questions built from the job description (and any emphasis notes). You can optionally add extra JD points — each set becomes a new version (v1, v2…).
            </p>
            <button
              onClick={() => { setShowPrompt(true); setAddedText(""); }}
              disabled={busy}
              className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-60 rounded-md px-3.5 py-2"
            >
              <Sparkles className="w-4 h-4" /> Generate question bank
            </button>
          </div>
        ) : null}
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
