// Live Assist — Past Calls.
// Lists the org's interview calls (newest first) with the stored end-of-call
// evaluation (verdict + overall score + summary). Click a call to read the
// full evaluation — strengths, concerns, every Q&A — and the transcript.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, FileText, X, MessageSquare, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, downloadFile } from "@/lib/api";

interface CallRow {
  id: string;
  status: string;
  mode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  label: string;
  demandTitle: string | null;
  recruiterName: string | null;
  hasEvaluation: boolean;
  verdict: string | null;
  overallScore: number | null;
  summaryText: string | null;
}

interface Evaluation {
  verdict?: string;
  score?: Record<string, number>;
  summary?: string;
  strengths?: string[];
  concerns?: string[];
  candidateName?: string;
  generatedAt?: string;
  questions?: Array<{ category?: string; question?: string; answer?: string; verdict?: string }>;
}
interface CallRow_ { call: { id: string; summary: Evaluation | null; startedAt: string | null; endedAt: string | null; mode: string | null; status: string }; transcript: Array<{ id: string; speaker: string | null; text: string; tsStartMs: number | null }>; }

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const fmtDur = (a: string | null, b: string | null) => {
  if (!a || !b) return "—";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms <= 0) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
};

const VERDICT_TONE: Record<string, string> = {
  "Strong yes": "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  "Lean yes": "bg-green-500/15 text-green-600 border-green-500/30",
  Borderline: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  "Lean no": "bg-orange-500/15 text-orange-600 border-orange-500/30",
  "Strong no": "bg-red-500/15 text-red-600 border-red-500/30",
};

export default function LiveAssistHistory() {
  const [onlyScored, setOnlyScored] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dlId, setDlId] = useState<string | null>(null);

  async function downloadReport(id: string) {
    setDlId(id);
    try {
      await downloadFile(`/api/calls/${id}/report`, "interview-report.pdf");
    } catch {
      toast.error("Could not download the report.");
    } finally {
      setDlId(null);
    }
  }

  const { data, isLoading, refetch, isFetching } = useQuery<{ calls: CallRow[] }>({
    queryKey: ["calls", "history", onlyScored],
    queryFn: () => apiFetch(`/api/calls?limit=200${onlyScored ? "&withEvaluation=true" : ""}`),
  });
  const calls = data?.calls ?? [];

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <Link to="/live-assist" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Live Assist
          </Link>
          <h1 className="text-xl font-semibold mt-1">Past calls</h1>
          <p className="text-sm text-muted-foreground">Every interview, newest first — with its final evaluation and transcript.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={onlyScored} onChange={(e) => setOnlyScored(e.target.checked)} className="accent-primary" />
            Only scored interviews
          </label>
          <button onClick={() => refetch()} className="h-8 px-2 rounded-md border border-border text-sm inline-flex items-center gap-1 hover:bg-muted/50">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading calls…</div>
      ) : calls.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No calls yet. Start an interview from Live Assist — its summary will appear here when you end the call.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {calls.map((c) => (
            <div key={c.id} className="px-4 py-3 hover:bg-muted/40 flex items-center gap-3">
              <button onClick={() => setOpenId(c.id)} className="min-w-0 flex-1 text-left">
                <div className="text-sm font-medium truncate">{c.label}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {c.demandTitle ? `${c.demandTitle} · ` : ""}{fmtDate(c.startedAt)} · {fmtDur(c.startedAt, c.endedAt)}
                </div>
                {c.summaryText && <div className="text-xs text-muted-foreground/80 truncate mt-0.5">{c.summaryText}</div>}
              </button>
              {c.hasEvaluation ? (
                <div className="flex items-center gap-2 shrink-0">
                  {c.overallScore != null && (
                    <span className="text-sm font-bold tabular-nums w-9 text-right">{c.overallScore}</span>
                  )}
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${VERDICT_TONE[c.verdict ?? ""] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {c.verdict ?? "—"}
                  </span>
                  <button
                    onClick={() => downloadReport(c.id)}
                    disabled={dlId === c.id}
                    title="Download report (score + résumé)"
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border hover:bg-muted/60 disabled:opacity-50"
                  >
                    {dlId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    Report
                  </button>
                </div>
              ) : (
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-border text-muted-foreground shrink-0">{c.status}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {openId && <CallDetailDrawer callId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<CallRow_>({
    queryKey: ["calls", "detail", callId],
    queryFn: () => apiFetch(`/api/calls/${callId}`),
  });
  const ev = data?.call.summary && (data.call.summary as { kind?: string }).kind === "interview_eval" ? (data.call.summary as Evaluation) : null;
  const transcript = data?.transcript ?? [];
  const [downloading, setDownloading] = useState(false);
  async function downloadReport() {
    setDownloading(true);
    try {
      await downloadFile(`/api/calls/${callId}/report`, "interview-report.pdf");
    } catch {
      toast.error("Could not download the report.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-background border-l border-border overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b border-border px-5 py-3 flex items-center justify-between">
          <div className="font-semibold text-sm">{ev?.candidateName || "Call detail"}</div>
          <div className="flex items-center gap-2">
            {ev && (
              <button
                onClick={downloadReport}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border border-border hover:bg-muted/50 disabled:opacity-50"
              >
                {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Report
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {isLoading ? (
          <div className="p-5 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="p-5 space-y-5">
            {ev ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="text-3xl font-bold tabular-nums">{ev.score?.overall ?? "—"}</div>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${VERDICT_TONE[ev.verdict ?? ""] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {ev.verdict ?? "—"}
                  </span>
                </div>
                {ev.summary && <p className="text-sm leading-relaxed">{ev.summary}</p>}
                {ev.score && (
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(ev.score).filter(([k]) => k !== "overall").map(([k, v]) => (
                      <div key={k} className="rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k.replace(/_/g, " ")}</div>
                        <div className="text-lg font-bold tabular-nums">{v}</div>
                      </div>
                    ))}
                  </div>
                )}
                {!!ev.strengths?.length && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Strengths</div>
                    <ul className="list-disc pl-5 text-sm space-y-0.5 text-emerald-700 dark:text-emerald-400">{ev.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {!!ev.concerns?.length && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Concerns</div>
                    <ul className="list-disc pl-5 text-sm space-y-0.5 text-amber-700 dark:text-amber-400">{ev.concerns.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
                {!!ev.questions?.length && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Questions & answers</div>
                    <div className="space-y-2">
                      {ev.questions.map((q, i) => (
                        <div key={i} className="rounded-md border border-border p-2.5">
                          <div className="text-xs font-medium">{q.category ? `[${q.category}] ` : ""}{q.question}</div>
                          {q.answer && <div className="text-xs text-muted-foreground mt-1">{q.answer}</div>}
                          {q.verdict && <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mt-1">{q.verdict}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="w-4 h-4" /> No final evaluation was saved for this call (it may not have been scored).
              </div>
            )}

            {!!transcript.length && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" /> Transcript</div>
                <div className="space-y-1.5 max-h-80 overflow-y-auto rounded-md border border-border p-3">
                  {transcript.map((t) => (
                    <div key={t.id} className="text-xs"><span className="text-muted-foreground">{t.speaker || "?"}: </span>{t.text}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
