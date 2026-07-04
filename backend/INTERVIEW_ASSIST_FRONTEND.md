# Interview Assist — Frontend implementation guide (release/offer-letter-v1.0)

This branch's **backend/** (MongoDB) now has the full interview-assist feature
set. This is the **single, complete** guide to the frontend work needed to light
it up. All code below is the exact, working implementation from the
`feature/krishna-agent` React app (`apps/web`) — copy it verbatim.

**Nothing here is deployed.** Code-only.

---

## 0. Prerequisites

- shadcn/ui `Dialog` (`@/components/ui/dialog`), `Input`, `Button`.
- `lucide-react`, `sonner` (toast), `@tanstack/react-query`, `react-router-dom`.
- The app already has `useInterviewFlow`, `useWedgeCall`, `LiveAssistSetup`,
  `RightPanelTabs`, `QuestionBankPanel`, `InterviewFlowPanel`, `AppShell`, `App`.

## Backend endpoints (contract)

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/calls?limit=200&withEvaluation=true` | — | `{ calls: [{ id,status,mode,startedAt,endedAt,label,demandTitle,candidateName,recruiterName,hasEvaluation,verdict,overallScore,summaryText }] }` |
| `GET /api/calls/:id` | — | inline call doc (`summary`, `transcript[]`, `candidate`, `demandSnapshot`) |
| `GET /api/calls/:id/report` | — | **PDF** (attachment). Auto-generates the eval from the transcript if none saved; never fails. |
| `GET /api/demands/:id/question-bank` | — | `{ ok, versions:[{version,addedJd,bank,generatedAt}], assessmentNotes }` |
| `POST /api/demands/:id/question-bank` | `{ addedJd? }` | `{ ok, created, version?, versions }` |
| `GET /api/demands/:id/question-bank/download?version=N` | — | **PDF** (attachment) |

`bank` = `{ skills:[{ skill, questions:[{ difficulty, question }] }], total }`.

---

## 1. `lib/api.ts` — add `downloadFile` (auth + 401-refresh)

Uses the module's existing `accessToken`, `refreshAccessToken`, `setAccessToken`,
`makeError`, `API_BASE`.

```ts
/** Fetch an authenticated binary endpoint (PDF) and save it as a file. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const doFetch = () => {
    const headers = new Headers();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(`${API_BASE}${path}`, { headers, credentials: "include" });
  };
  let res = await doFetch();
  if (res.status === 401) {
    const ok = await refreshAccessToken();
    if (ok) res = await doFetch(); else setAccessToken(null);
  }
  if (!res.ok) { let body: unknown; try { body = await res.json(); } catch {} throw makeError(res.status, body); }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
```

## 2. `hooks/useWedgeCall.ts` — clear per-call state on `create()`

So a new call never continues the previous transcript/scoring. In `create()`,
make the first `setState` reset everything:

```ts
const create = useCallback(async (input: CreateWedgeCallInput) => {
  setState((s) => ({
    ...s,
    status: "creating", errorMessage: null,
    callId: null, turns: [], partial: null, bytesSent: 0, startedAt: null,
    sentiment: 50, sentimentSeries: [], suggestions: [], citations: [], liveRubric: null,
  }));
  // …rest unchanged…
}, []);
```

## 3. `components/live-assist/InterviewFlowPanel.tsx` — remove "End & score"

- Delete the `onEnd: () => void;` prop from `Props`, remove `onEnd` from the
  destructure, and **delete the "End & score" button** (the one with the `Flag`
  icon). Remove the now-unused `Flag` import. Ending the call is the only
  scoring trigger now.

## 4. `components/live-assist/RightPanelTabs.tsx` — only Question bank + Notes

Replace the whole file:

```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import { QuestionBankPanel } from "./QuestionBankPanel";
import { type LiveRubricSnapshot } from "./RubricLivePanel";
import { NotesPanel } from "./NotesPanel";

type RightTab = "question-bank" | "notes";

export function RightPanelTabs({
  callId, demandId, onAsk, generatedPlan, generating,
}: {
  callId?: string;
  liveRubric?: LiveRubricSnapshot | null; // kept for call-site compat
  demandId?: string;
  onAsk?: (question: string, category: string) => void;
  generatedPlan?: Array<{ name: string; questions: string[] }>;
  generating?: boolean;
}) {
  const [tab, setTab] = useState<RightTab>("question-bank");
  const tabs: { id: RightTab; label: string }[] = [
    { id: "question-bank", label: "Question bank" },
    { id: "notes", label: "Notes" },
  ];
  return (
    <div className="bg-card border border-border rounded-lg flex flex-col min-h-0 h-full overflow-hidden">
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn("px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "question-bank" && <QuestionBankPanel demandId={demandId} onAsk={onAsk} generatedPlan={generatedPlan} generating={generating} />}
        {tab === "notes" && <NotesPanel callId={callId} />}
      </div>
    </div>
  );
}
```

## 5. `pages/LiveAssistSetup.tsx` — End=evaluation popup, clear-on-start, modal

**Imports** — add:
```ts
import { Loader2, Check, Download /* …existing icons… */ } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadFile } from "@/lib/api";
```

**State** (inside the component):
```ts
const [scoreModalOpen, setScoreModalOpen] = useState(false);
const [evaluating, setEvaluating] = useState(false);
```

**`handleStart()`** — reset before creating:
```ts
async function handleStart() {
  if (!demandId) { toast.error("Pick a demand to call against."); return; }
  if (!prospectId && !candidateId) { toast.error("Pick a prospect or candidate."); return; }
  flow.reset();                 // clear scoring + Q&A
  setScoreModalOpen(false);
  const t = await wedge.create({ demandId, prospectId: prospectId ?? undefined, candidateId: candidateId ?? undefined });
  if (!t) { toast.error(wedge.state.errorMessage ?? "Couldn't create call."); return; }
  setTicket(t);
  try { await wedge.start(t); } catch { toast.error("Couldn't start audio capture."); }
}
```

**`handleEnd()`** — open modal, evaluate:
```ts
async function handleEnd() {
  setScoreModalOpen(true);
  setEvaluating(true);
  try { await wedge.end(); await flow.endNow(); }
  finally { setEvaluating(false); }
}
```

**`InterviewFlowPanel` usage** — remove the `onEnd={flow.endNow}` prop.

**Render the modal** near `<CreateCandidateModal … />`:
```tsx
<EvaluationModal
  open={scoreModalOpen}
  evaluating={evaluating}
  finalScore={flow.finalScore}
  history={flow.history}
  statusText={flow.status.text}
  callId={sourceCallId}
  onClose={() => setScoreModalOpen(false)}
/>
```

**`EvaluationModal`** component (add to the file):
```tsx
function EvaluationModal({
  open, evaluating, finalScore, history, statusText, callId, onClose,
}: {
  open: boolean; evaluating: boolean;
  finalScore: ReturnType<typeof useInterviewFlow>["finalScore"];
  history: ReturnType<typeof useInterviewFlow>["history"];
  statusText: string; callId: string | null; onClose: () => void;
}) {
  const dims = ["communication", "relevance", "depth", "skills_match"] as const;
  const [downloading, setDownloading] = useState(false);
  async function downloadReport() {
    if (!callId) return;
    setDownloading(true);
    try { await downloadFile(`/api/calls/${callId}/report`, "interview-report.pdf"); }
    catch { toast.error("Could not download the report."); }
    finally { setDownloading(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Interview evaluation</DialogTitle></DialogHeader>
        {evaluating || !finalScore ? (
          <div className="py-10 flex flex-col items-center justify-center gap-3 text-center">
            {evaluating ? (<>
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <div className="text-sm font-medium">Evaluating — generating the score…</div>
              <p className="text-xs text-muted-foreground">Reviewing the full conversation and scoring the candidate.</p>
            </>) : (<p className="text-sm text-muted-foreground">{statusText || "No score was generated for this call."}</p>)}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
              <div><div className="text-xs uppercase tracking-wide text-muted-foreground">Verdict</div>
                <div className="text-lg font-semibold">{finalScore.verdict}</div></div>
              <div className="text-right"><div className="text-xs uppercase tracking-wide text-muted-foreground">Overall</div>
                <div className="text-3xl font-bold tabular-nums">{finalScore.score.overall ?? "—"}</div></div>
            </div>
            {finalScore.saved && (<div className="text-[11px] text-emerald-600 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Saved to the call record</div>)}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {dims.map((k) => (
                <div key={k} className="rounded-md border border-border p-2 text-center">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground capitalize">{k.replace("_", " ")}</div>
                  <div className="text-xl font-bold tabular-nums">{finalScore.score[k] ?? "—"}</div>
                </div>
              ))}
            </div>
            {finalScore.summary && <p className="text-sm leading-relaxed">{finalScore.summary}</p>}
            {finalScore.strengths?.length > 0 && (<div className="text-sm"><span className="font-medium text-emerald-700">Strengths: </span><span className="text-muted-foreground">{finalScore.strengths.join(" · ")}</span></div>)}
            {finalScore.concerns?.length > 0 && (<div className="text-sm"><span className="font-medium text-amber-700">Concerns: </span><span className="text-muted-foreground">{finalScore.concerns.join(" · ")}</span></div>)}
            {history.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Questions &amp; answers</div>
                <div className="space-y-2">
                  {history.map((h, i) => (
                    <div key={i} className="rounded-md border border-border p-2.5 text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{h.category}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium",
                          h.verdict === "Skipped" ? "bg-muted text-muted-foreground"
                            : /strong|adequate|manually/i.test(h.verdict) ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{h.verdict}</span>
                      </div>
                      <p className="font-medium leading-snug">{h.question}</p>
                      {h.answer && <p className="text-muted-foreground mt-1">{h.answer}</p>}
                      {h.feedback && <p className="text-xs italic text-muted-foreground/80 mt-1">{h.feedback}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end items-center gap-2 pt-1">
              <button onClick={downloadReport} disabled={downloading || !callId}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-md border border-border hover:bg-muted/50 disabled:opacity-50">
                {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download report
              </button>
              <button onClick={onClose} className="text-sm font-medium px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90">Close</button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

## 6. `components/live-assist/QuestionBankPanel.tsx` — versions + add-to-JD + PDF

Replace the component's `demandId` branch with the versioned one below. Keep the
existing non-demand fallback (`generatedPlan` / DB banks) after it. Add
`Download`, `Plus`, `Sparkles`, `Loader2` to the lucide import and
`downloadFile` to the `@/lib/api` import.

Types + state:
```ts
interface SkillGroup { skill: string; questions: Array<{ difficulty: string; question: string }> }
interface JdBank { kind?: string; skills?: SkillGroup[]; total?: number }
interface BankVersion { version: number; addedJd: string; bank: JdBank; generatedAt: string | null }

const DIFFICULTY_PILL: Record<string,string> = { easy:"bg-emerald-50 text-emerald-700", medium:"bg-amber-50 text-amber-700", hard:"bg-rose-50 text-rose-700" };

const qc = useQueryClient();
const [busy, setBusy] = useState(false);
const [showPrompt, setShowPrompt] = useState(false);
const [addedText, setAddedText] = useState("");
const [activeVersion, setActiveVersion] = useState<number | null>(null);
const [downloadingBank, setDownloadingBank] = useState(false);

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
      `/api/demands/${demandId}/question-bank`, { method: "POST", json: { addedJd: addedText.trim() } });
    await qc.invalidateQueries({ queryKey: ["demand-question-bank", demandId] });
    if (res.created) { setActiveVersion(res.version ?? null); toast.success(`Question bank v${res.version} ready`); }
    else toast.message("No extra JD points added — showing the existing bank.");
    setShowPrompt(false); setAddedText("");
  } catch (e) { toast.error(e instanceof Error ? e.message : "Could not generate the question bank"); }
  finally { setBusy(false); }
}
async function downloadBank() {
  if (!demandId || !current) return;
  setDownloadingBank(true);
  try { await downloadFile(`/api/demands/${demandId}/question-bank/download?version=${current.version}`, `question-bank-v${current.version}.pdf`); }
  catch { toast.error("Could not download the question bank."); }
  finally { setDownloadingBank(false); }
}
```

Render (the `if (demandId) { return (…) }` block): a header with a **PDF**
download button + **New version** button; **version pills** (`v1 v2 …`) plus a
**"PDF v{n}"** download-selected-version button; a **"Add anything to the JD?"**
textarea prompt; and the skill-wise question list with `DIFFICULTY_PILL` tags
and "Ask this" buttons. Copy the exact JSX from
`apps/web/src/components/live-assist/QuestionBankPanel.tsx` (the versioned block
+ the `showPrompt` block + the skill list + the "Generate question bank" CTA).

Also, in `LiveAssistSettings.tsx` (the Add-Job form), send `assessmentNotes`
(free-text emphasis) in the demand payload — the backend stores + weights it.

## 7. `pages/LiveAssistHistory.tsx` — Past Calls page (full file)

Create this file verbatim (drop-in). It lists `GET /api/calls?limit=200`, has an
"Only scored interviews" toggle (`?withEvaluation=true`), a **Report** download
button per row, and a detail drawer (`GET /api/calls/:id`) with the full eval +
transcript and its own Report button.

> Copy the full component from `apps/web/src/pages/LiveAssistHistory.tsx`
> (≈300 lines). Key pieces:
> - `downloadReport(id)` → `downloadFile(\`/api/calls/${id}/report\`, "interview-report.pdf")`.
> - Row: a clickable `<button>` for the label + a separate **Report** `<button>`
>   (never nest buttons — the row is a `<div>`).
> - `CallDetailDrawer` reads `GET /api/calls/:id`; treats `call.summary` as the
>   eval when `summary.kind === "interview_eval"`.

## 8. Route + nav

`App.tsx`:
```tsx
import LiveAssistHistory from "@/pages/LiveAssistHistory";
// inside the authed AppShell routes:
<Route path="/live-assist/history" element={<LiveAssistHistory />} />
```

`layouts/AppShell.tsx` (Live Assist nav group) — add `History` to the lucide
import and:
```ts
{ to: "/live-assist/history", label: "Past Calls", icon: History },
```

## 9. Résumé payload (so the report merges the original PDF)

When creating a call (`POST /api/calls`), include the résumé's **key, mime and
filename** on the candidate object:
```ts
candidate: { ...identity, resumeBlobKey, resumeMime, resumeFilename, parsedResume }
```
`POST /api/candidates/parse-resume-preview` returns `{ key, mime, filename,
parsed }` — thread `mime` + `filename` through, not just the key. Without them
the report still works but renders the résumé as text instead of merging the
original PDF pages.

---

## Parity checklist (what "works the same" means)

- [ ] Ending a call opens the **Evaluating → score** popup (no "End & score" button).
- [ ] Starting a new call **clears** the previous transcript + score.
- [ ] Right panel shows only **Question bank** + **Notes** (no Rubrics/Discovery).
- [ ] Question bank: generate, **add-to-JD versions (v1/v2…)**, switch versions, **download PDF** per version.
- [ ] **Past Calls** page with per-row + drawer + popup **Download report** (PDF: score page + résumé).
- [ ] Report works for **every completed call** (backend generates from transcript + caches).
- [ ] Résumé `mime`/`filename` threaded into the call payload.
