// Candidate-facing assessment runtime. Token-gated, no JWT — the recruiter
// shares /take-assessment/:token from the assessment detail page.
//
// Reads the pinned-version exam (redacted answer keys) via
// /api/public/assessments/:token, renders one typed item at a time, autosaves
// responses to the server (/:token/heartbeat) for resume, counts down to the
// SERVER deadline (deadlineAt), and auto-submits on timeout. The /:token/submit
// path enforces the deadline server-side and auto-grades objective items.
//
// Hinglish-friendly copy where it lowers anxiety; technical terms in English.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, ChevronLeft, ChevronRight, Send, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api";

type ItemType =
  | "mcq_single"
  | "mcq_multi"
  | "true_false"
  | "short_answer"
  | "long_answer"
  | "coding"
  | "file_upload"
  | "video_response";

interface ExamItem {
  id: string;
  sectionId: string | null;
  type: ItemType;
  position: number;
  prompt: string;
  points: number;
  required: boolean;
  timeLimitSeconds: number | null;
  config: {
    options?: Array<{ id: string; label: string }>;
    language?: string;
    starterCode?: string;
    acceptedTypes?: string[];
    maxSizeMb?: number;
    prepSeconds?: number;
    maxSeconds?: number;
    retakes?: number;
  };
}

interface TemplateInfo {
  id: string;
  title: string;
  description: string | null;
  durationMins: number | null;
  passScore: number;
}

interface SavedResponse {
  itemId: string;
  selectedOptionIds?: string[];
  boolValue?: boolean;
  textValue?: string;
  codeValue?: string;
}

interface LoadResponse {
  template: TemplateInfo;
  items: ExamItem[];
  attemptId: string;
  serverStartedAt: string | null;
  deadlineAt: string | null;
  expiresAt: string | null;
  savedResponses: SavedResponse[];
}

type Answer = { selectedOptionIds?: string[]; boolValue?: boolean; textValue?: string; codeValue?: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; data: LoadResponse }
  | { kind: "error"; message: string }
  | { kind: "submitted" };

export default function TakeAssessment() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [idx, setIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const submittedRef = useRef(false);

  const items = state.kind === "loaded" ? state.data.items : [];
  const deadlineAt = state.kind === "loaded" ? state.data.deadlineAt : null;

  const buildResponses = useCallback(
    (): SavedResponse[] =>
      items.map((it) => ({ itemId: it.id, ...(answers[it.id] ?? {}) })),
    [items, answers],
  );

  // Load exam + restore saved server-side responses.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${getApiBase()}/api/public/assessments/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `http_${res.status}`);
        }
        return res.json() as Promise<LoadResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({ kind: "loaded", data });
        const restored: Record<string, Answer> = {};
        for (const r of data.savedResponses ?? []) {
          restored[r.itemId] = {
            selectedOptionIds: r.selectedOptionIds,
            boolValue: r.boolValue,
            textValue: r.textValue,
            codeValue: r.codeValue,
          };
        }
        setAnswers(restored);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Countdown ticker.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const submit = useCallback(async () => {
    if (state.kind !== "loaded" || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(`${getApiBase()}/api/public/assessments/${token}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responses: buildResponses() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `http_${res.status}`);
      }
      setState({ kind: "submitted" });
    } catch (err) {
      submittedRef.current = false;
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }, [state, token, buildResponses]);

  const remainingMs = useMemo(() => {
    if (!deadlineAt) return null;
    return Math.max(0, new Date(deadlineAt).getTime() - now);
  }, [deadlineAt, now]);

  // Auto-submit when the server deadline elapses.
  useEffect(() => {
    if (remainingMs === 0 && state.kind === "loaded" && !submittedRef.current) {
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs]);

  // Debounced server-side autosave (resume support).
  useEffect(() => {
    if (state.kind !== "loaded" || submittedRef.current) return;
    const t = setTimeout(() => {
      setSaving(true);
      fetch(`${getApiBase()}/api/public/assessments/${token}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responses: buildResponses() }),
      })
        .catch(() => {})
        .finally(() => setSaving(false));
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers]);

  if (!token) return <Frame title="Invalid link">No assessment token in the URL.</Frame>;

  if (state.kind === "loading") {
    return (
      <Frame title="Loading…">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Fetching your assessment…
        </div>
      </Frame>
    );
  }
  if (state.kind === "error") {
    const m = state.message;
    return (
      <Frame title="Hmm, that didn't work">
        <div className="flex items-start gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            {m === "expired" || m === "deadline_passed"
              ? "Your time is up or the link expired. Reach out to your recruiter for a fresh one."
              : m === "already_submitted"
                ? "This assessment was already submitted. Contact your recruiter if you need to retake it."
                : m === "revoked"
                  ? "This invite was revoked. Please contact your recruiter."
                  : m === "invalid_token"
                    ? "This link doesn't look right. Double-check the URL or ask your recruiter to resend."
                    : `Error: ${m}`}
          </div>
        </div>
      </Frame>
    );
  }
  if (state.kind === "submitted") {
    return (
      <Frame title="Submitted!">
        <div className="flex items-start gap-3 text-sm">
          <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
          <div>
            <div className="font-medium mb-1">Your responses are in.</div>
            <div className="text-muted-foreground">
              Aapka assessment submit ho gaya. The recruiter will review your answers and get back to you. You can close this tab.
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  const tpl = state.data.template;
  const item = items[idx];
  const total = items.length;
  const answered = items.filter((it) => isAnswered(answers[it.id])).length;
  const progressPct = total === 0 ? 0 : Math.round((answered / total) * 100);

  const setAnswer = (itemId: string, patch: Answer) =>
    setAnswers((a) => ({ ...a, [itemId]: { ...a[itemId], ...patch } }));

  return (
    <Frame title={tpl.title} subtitle={tpl.description ?? undefined}>
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs">
          <div className="text-muted-foreground">
            Question {idx + 1} of {total} · {answered}/{total} answered
            {saving && <span className="ml-2 italic">saving…</span>}
          </div>
          {remainingMs !== null && (
            <div className={cn("inline-flex items-center gap-1.5 tabular-nums", remainingMs < 60_000 ? "text-destructive" : "text-muted-foreground")}>
              <Clock className="w-3.5 h-3.5" />
              {formatMs(remainingMs)} left
            </div>
          )}
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
        </div>

        {item == null ? (
          <div className="text-sm text-muted-foreground">No questions on this assessment.</div>
        ) : (
          <div>
            <div className="text-base mb-3 leading-relaxed">
              {item.prompt}
              {item.required && <span className="text-destructive ml-1">*</span>}
            </div>
            <ItemInput item={item} answer={answers[item.id] ?? {}} onChange={(p) => setAnswer(item.id, p)} />
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" disabled={idx === 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Back
          </Button>
          {idx < total - 1 ? (
            <Button size="sm" onClick={() => setIdx((i) => i + 1)}>
              Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          ) : (
            <Button size="sm" disabled={submitting || answered === 0} onClick={() => void submit()}>
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
              Submit
            </Button>
          )}
        </div>
      </div>
    </Frame>
  );
}

function ItemInput({ item, answer, onChange }: { item: ExamItem; answer: Answer; onChange: (patch: Answer) => void }) {
  if (item.type === "mcq_single" || item.type === "mcq_multi") {
    const options = item.config.options ?? [];
    const selected = new Set(answer.selectedOptionIds ?? []);
    return (
      <div className="space-y-2">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm rounded border border-border px-3 py-2 cursor-pointer hover:bg-muted/30">
            <input
              type={item.type === "mcq_single" ? "radio" : "checkbox"}
              name={`item-${item.id}`}
              checked={selected.has(o.id)}
              onChange={() => {
                if (item.type === "mcq_single") onChange({ selectedOptionIds: [o.id] });
                else {
                  const next = new Set(selected);
                  if (next.has(o.id)) next.delete(o.id);
                  else next.add(o.id);
                  onChange({ selectedOptionIds: [...next] });
                }
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (item.type === "true_false") {
    return (
      <div className="flex gap-3">
        {[true, false].map((val) => (
          <label key={String(val)} className="flex items-center gap-2 text-sm rounded border border-border px-4 py-2 cursor-pointer hover:bg-muted/30">
            <input type="radio" name={`item-${item.id}`} checked={answer.boolValue === val} onChange={() => onChange({ boolValue: val })} />
            {val ? "True" : "False"}
          </label>
        ))}
      </div>
    );
  }
  if (item.type === "coding") {
    return (
      <textarea
        className="w-full text-xs font-mono border border-border rounded p-3 min-h-[220px]"
        placeholder={`// ${item.config.language ?? "code"}`}
        value={answer.codeValue ?? item.config.starterCode ?? ""}
        onChange={(e) => onChange({ codeValue: e.target.value })}
      />
    );
  }
  if (item.type === "file_upload") {
    return (
      <div className="space-y-2">
        <input
          type="file"
          className="text-sm"
          onChange={(e) => onChange({ textValue: e.target.files?.[0]?.name ?? "" })}
        />
        <p className="text-xs text-muted-foreground">
          Accepted: {(item.config.acceptedTypes ?? []).join(", ") || "any"} · max {item.config.maxSizeMb ?? "—"}MB. Your reviewer collects the file separately.
        </p>
      </div>
    );
  }
  if (item.type === "video_response") {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Video response · {item.config.prepSeconds ?? 0}s prep · {item.config.maxSeconds ?? 0}s take · {item.config.retakes ?? 0} retakes.
        </p>
        <textarea
          className="w-full text-sm border border-border rounded p-3 min-h-[120px]"
          placeholder="Add a note for your reviewer (optional)…"
          value={answer.textValue ?? ""}
          onChange={(e) => onChange({ textValue: e.target.value })}
        />
      </div>
    );
  }
  // short / long answer
  return (
    <textarea
      className={cn("w-full text-sm border border-border rounded p-3", item.type === "long_answer" ? "min-h-[200px]" : "min-h-[100px]")}
      placeholder="Your answer (English ya Hinglish, jo comfortable ho)…"
      value={answer.textValue ?? ""}
      onChange={(e) => onChange({ textValue: e.target.value })}
      autoFocus
    />
  );
}

function isAnswered(a: Answer | undefined): boolean {
  if (!a) return false;
  return (
    (a.selectedOptionIds?.length ?? 0) > 0 ||
    a.boolValue !== undefined ||
    (a.textValue ?? "").trim().length > 0 ||
    (a.codeValue ?? "").trim().length > 0
  );
}

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-muted via-background to-accent-muted py-10 px-4">
      <div className="max-w-2xl mx-auto bg-background border border-border rounded-xl shadow p-6 sm:p-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </div>
        {children}
      </div>
      <div className="text-center text-[11px] text-muted-foreground mt-6">Powered by RecruitAssist</div>
    </div>
  );
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
