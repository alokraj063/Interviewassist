import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { useCallDetail } from "@/hooks/useCalls";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ChevronLeft, Loader2, FileText, Sparkles, Activity, ListChecks, ShieldCheck, Briefcase } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiFetch, getApiBase, getStoredToken } from "@/lib/api";
import type { Speaker } from "@j2w/shared-types";

function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function speakerLabel(speaker: Speaker): { label: string; cls: string } {
  switch (speaker) {
    case "recruiter": return { label: "RECRUITER", cls: "text-primary" };
    case "candidate": return { label: "CANDIDATE", cls: "text-success" };
    case "mixed": return { label: "MIXED", cls: "text-muted-foreground" };
    case "unknown":
    default: return { label: "—", cls: "text-muted-foreground italic" };
  }
}

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // ?qa=1 hint from the QA Review queue — surfaces a "QA mode" pill so the
  // reviewer knows they're grading. The rubric-scores endpoint independently
  // checks qa.write before allowing edits.
  const qaModeHint = searchParams.get("qa") === "1";
  const { data, isLoading, isError } = useCallDetail(id);
  const [tab, setTab] = useState(qaModeHint ? "rubric" : "transcript");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  if (isLoading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading call…
      </div>
    );
  }
  if (isError || !data) {
    return <div className="p-10 text-sm text-destructive">Call not found.</div>;
  }

  const { call, recruiter, transcript } = data;
  const isUnknownDominant = transcript.filter((t) => t.speaker === "unknown").length > transcript.length / 2;

  // Use the authenticated playback endpoint. Token is appended as a query
  // param because <audio> can't send custom headers. The endpoint validates
  // the JWT either via the standard Authorization header or via a token
  // query param (the API supports both).
  const audioSrc =
    call.recordingUrl && id
      ? `${getApiBase()}/calls/${id}/recording?token=${encodeURIComponent(getStoredToken() ?? "")}`
      : null;

  function jumpTo(turn: { tsStartMs: number }) {
    if (audioRef.current) {
      audioRef.current.currentTime = turn.tsStartMs / 1000;
      audioRef.current.play().catch(() => { /* ignore */ });
    }
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/calls" className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            Call <span className="font-mono text-sm">{call.id.slice(0, 12)}…</span>
          </span>
        }
        subtitle={`${recruiter?.name ?? recruiter?.email ?? "—"} · ${call.mode} · ${call.status}${call.endedAt ? ` · ended ${formatDistanceToNow(new Date(call.endedAt), { addSuffix: true })}` : ""}`}
      />
      <div className="px-6 pt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="replay"><Activity className="w-3.5 h-3.5 mr-1.5" />Replay</TabsTrigger>
            <TabsTrigger value="transcript"><FileText className="w-3.5 h-3.5 mr-1.5" />Transcript ({transcript.length})</TabsTrigger>
            <TabsTrigger value="summary"><Sparkles className="w-3.5 h-3.5 mr-1.5" />Summary</TabsTrigger>
            <TabsTrigger value="rubric"><ListChecks className="w-3.5 h-3.5 mr-1.5" />Rubric</TabsTrigger>
            <TabsTrigger value="jd-match"><Briefcase className="w-3.5 h-3.5 mr-1.5" />JD-Match</TabsTrigger>
            <TabsTrigger value="compliance"><ShieldCheck className="w-3.5 h-3.5 mr-1.5" />Compliance</TabsTrigger>
          </TabsList>

          <TabsContent value="replay" className="pt-4">
            <Card title="Audio">
              <div className="p-4">
                {audioSrc ? (
                  <audio ref={audioRef} controls src={audioSrc} className="w-full" />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No recording available for this call. (Browser-mic mode dumps WAV when DUMP_WAVS=1.)
                  </div>
                )}
                {call.recordingDurationMs && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Duration: {Math.round(call.recordingDurationMs / 1000)}s
                  </div>
                )}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="transcript" className="pt-4">
            {isUnknownDominant && call.mode === "browser_mixed" && (
              <Card className="mb-3">
                <div className="p-3 text-xs text-muted-foreground border-l-4 border-warning/50 bg-warning/5">
                  This call was captured as a single mixed-mono stream (recruiter speakerphone). Speaker labels are not yet inferred — the post-call diarization worker may upgrade them retroactively where Deepgram confidence is high.
                </div>
              </Card>
            )}
            <Card>
              <div className="p-4 max-h-[640px] overflow-y-auto space-y-2">
                {transcript.length === 0 && (
                  <div className="text-sm text-muted-foreground">No transcript yet.</div>
                )}
                {transcript.map((t) => {
                  const sp = speakerLabel(t.speaker);
                  return (
                    <div key={t.id} className="text-sm flex gap-3 group">
                      <button
                        onClick={() => jumpTo(t)}
                        className="text-xs font-mono text-muted-foreground hover:text-foreground w-12 text-right shrink-0"
                        title="Jump audio here"
                      >
                        {formatTimestamp(t.tsStartMs)}
                      </button>
                      <span className={`text-[10px] uppercase font-semibold w-20 shrink-0 ${sp.cls}`}>{sp.label}</span>
                      <span className="flex-1">{t.text}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="summary" className="pt-4">
            <RecruiterSummaryTab summary={call.summary as RecruiterSummary | null} />
          </TabsContent>

          <TabsContent value="rubric" className="pt-4">
            <RubricTab callId={id ?? null} qaModeHint={qaModeHint} />
          </TabsContent>

          <TabsContent value="jd-match" className="pt-4">
            <JdMatchTab callId={id ?? null} />
          </TabsContent>

          <TabsContent value="compliance" className="pt-4">
            <ComplianceTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ---- Recruiter-shape summary ----

interface RecruiterSummary {
  overview?: string;
  discoveredFacts?: {
    currentCompany?: string | null;
    currentTitle?: string | null;
    totalExperienceYears?: number | null;
    currentCtcLakhs?: number | null;
    expectedCtcLakhs?: number | null;
    noticePeriodDays?: number | null;
    noticePeriodNegotiable?: boolean | null;
    currentLocation?: string | null;
    willingToRelocate?: boolean | null;
    reasonForChange?: string | null;
  };
  unaddressedItems?: string[];
  nextStep?: string;
  recruiterNotes?: string;
  // Legacy contact-center keys; render gracefully if a pre-Phase-6 row remains.
  resolution?: string;
  nextSteps?: string[];
}

function RecruiterSummaryTab({ summary }: { summary: RecruiterSummary | null }) {
  if (!summary) {
    return (
      <Card title="Call summary">
        <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Summary will appear within ~30–60 seconds after call end.
        </div>
      </Card>
    );
  }
  const facts = summary.discoveredFacts ?? {};
  return (
    <Card title="Call summary">
      <div className="p-4 text-sm space-y-4">
        {summary.overview && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Overview</div>
            <div>{summary.overview}</div>
          </div>
        )}
        {Object.values(facts).some((v) => v !== null && v !== undefined) && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Discovered facts</div>
            <div className="grid grid-cols-2 gap-2">
              <FactRow label="Current company" value={facts.currentCompany} />
              <FactRow label="Current title" value={facts.currentTitle} />
              <FactRow label="Total experience" value={facts.totalExperienceYears != null ? `${facts.totalExperienceYears} yrs` : null} />
              <FactRow label="Current CTC" value={facts.currentCtcLakhs != null ? `${facts.currentCtcLakhs} L` : null} />
              <FactRow label="Expected CTC" value={facts.expectedCtcLakhs != null ? `${facts.expectedCtcLakhs} L` : null} />
              <FactRow
                label="Notice period"
                value={
                  facts.noticePeriodDays != null
                    ? `${facts.noticePeriodDays}d${facts.noticePeriodNegotiable ? " (neg.)" : ""}`
                    : null
                }
              />
              <FactRow label="Current location" value={facts.currentLocation} />
              <FactRow label="Relocate?" value={facts.willingToRelocate == null ? null : facts.willingToRelocate ? "Yes" : "No"} />
              <FactRow label="Reason for change" value={facts.reasonForChange} className="col-span-2" />
            </div>
          </div>
        )}
        {summary.unaddressedItems && summary.unaddressedItems.length > 0 && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Unaddressed</div>
            <ul className="list-disc pl-5 space-y-1 text-warning">
              {summary.unaddressedItems.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {summary.nextStep && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Next step</div>
            <div>{summary.nextStep}</div>
          </div>
        )}
        {summary.recruiterNotes && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Recruiter notes</div>
            <div className="text-muted-foreground">{summary.recruiterNotes}</div>
          </div>
        )}
        {/* Legacy fallback for pre-Phase-6 rows. */}
        {summary.resolution && (
          <div>
            <div className="text-xs uppercase text-muted-foreground mb-1">Resolution (legacy)</div>
            <div>{summary.resolution}</div>
          </div>
        )}
      </div>
    </Card>
  );
}

function FactRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <div className={`rounded-md bg-muted/40 px-2 py-1.5 ${className ?? ""}`}>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs">{value ?? <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}

// ---- Rubric tab ----

interface RubricResponse {
  rubric: {
    id: string;
    name: string;
    purpose: string;
    criteria: Array<{
      id: string;
      name: string;
      description?: string;
      weight: number;
      bandThresholds: { fail: number; pass: number; excellent: number };
      kind: string;
    }>;
  } | null;
  scores: Array<{
    criterionId: string;
    score: string;
    band: "fail" | "pass" | "excellent" | null;
    evidenceQuotes: Array<{ tsStartMs: number; tsEndMs: number; text: string }>;
    rationale: string | null;
    confidence: string | null;
    modelVersion: string | null;
  }>;
  qaReview: {
    id: string;
    decision: "accept" | "override" | "escalate";
    aiScore: string | null;
    reviewerScore: number | null;
    note: string | null;
    criterionOverrides: Record<string, { aiScore: number; reviewerScore: number; reason: string }>;
  } | null;
  editable: boolean;
}

function RubricTab({ callId, qaModeHint }: { callId: string | null; qaModeHint: boolean }) {
  const [data, setData] = useState<RubricResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<RubricResponse>(`/api/calls/${callId}/rubric`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  if (loading && !data) {
    return (
      <Card title="Rubric">
        <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading rubric…
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card title="Rubric">
        <div className="p-4 text-sm text-error">Failed to load rubric: {error}</div>
      </Card>
    );
  }
  if (!data || !data.rubric || data.scores.length === 0) {
    return (
      <Card title="Rubric">
        <div className="p-6 text-sm text-muted-foreground">
          Rubric scoring will appear within ~1–2 minutes after call end. The
          rubric_finalize worker scores criteria with evidence quotes, then
          this tab refreshes with a per-criterion grade.
        </div>
      </Card>
    );
  }

  const scoresByCriterion = new Map(data.scores.map((s) => [s.criterionId, s]));

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ListChecks className="w-3.5 h-3.5" />
          {data.rubric.name}
          {qaModeHint && (
            <span className="pill bg-warning/15 text-warning text-[10px] px-1.5 py-0.5">
              QA mode
            </span>
          )}
          {data.editable ? (
            <span className="pill bg-primary/10 text-primary text-[10px] px-1.5 py-0.5">
              Editable
            </span>
          ) : (
            <span className="pill bg-muted text-muted-foreground text-[10px] px-1.5 py-0.5">
              Read-only
            </span>
          )}
          {data.qaReview?.aiScore != null && (
            <span className="ml-auto text-xs text-muted-foreground">
              Aggregate AI score: <span className="font-mono">{data.qaReview.aiScore}</span>
            </span>
          )}
        </span>
      }
    >
      <div className="p-4 space-y-3">
        {data.rubric.criteria.map((c) => {
          const s = scoresByCriterion.get(c.id);
          return (
            <div key={c.id} className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="font-medium text-sm">{c.name}</div>
                <span className="text-[10px] uppercase text-muted-foreground">
                  weight {c.weight}
                </span>
                {s?.band && (
                  <span
                    className={`pill text-[10px] px-1.5 py-0.5 ${
                      s.band === "excellent"
                        ? "bg-success/15 text-success"
                        : s.band === "pass"
                          ? "bg-primary/15 text-primary"
                          : "bg-error/15 text-error"
                    }`}
                  >
                    {s.band}
                  </span>
                )}
                {s && (
                  <span className="ml-auto font-mono text-sm">
                    {Math.round(Number(s.score))}
                  </span>
                )}
              </div>
              {c.description && (
                <div className="text-xs text-muted-foreground">{c.description}</div>
              )}
              {s?.rationale && (
                <div className="text-xs text-foreground/80">{s.rationale}</div>
              )}
              {s?.evidenceQuotes && s.evidenceQuotes.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {s.evidenceQuotes.map((q, i) => (
                    <li key={i} className="bg-muted/40 rounded px-2 py-1.5">
                      <span className="font-mono text-[10px] text-muted-foreground mr-2">
                        {formatTimestamp(q.tsStartMs)}
                      </span>
                      {q.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {data.editable && (
          <div className="text-xs text-muted-foreground italic">
            Editable: in-line override controls land in the next iteration.
            Use the QA Review queue at <Link to="/qa-review" className="text-primary hover:underline">/qa-review</Link> to grade calls today.
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- JD-Match tab ----

interface JdMatchRun {
  id: string;
  demandId: string;
  candidateId: string;
  overallScore: string | number;
  verdict: "strong_match" | "partial_match" | "weak_match" | "no_match";
  mustHavesScore: string | number | null;
  niceToHavesScore: string | number | null;
  experienceFitScore: string | number | null;
  compensationFitScore: string | number | null;
  locationFitScore: string | number | null;
  noticePeriodFitScore: string | number | null;
  strengths: Array<{ kind: string; label: string; detail?: string }>;
  gaps: Array<{ kind: string; label: string; detail?: string }>;
  explanation: Array<{ dimension: string; score: number; note: string }>;
  createdAt: string;
  modelVersion: string;
}

interface JdMatchResponse {
  match: JdMatchRun | null;
  status: "ok" | "no_pair" | "not_yet_run";
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function JdMatchTab({ callId }: { callId: string | null }) {
  const [data, setData] = useState<JdMatchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<JdMatchResponse>(`/api/calls/${callId}/jd-match`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  if (loading) {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading JD-match…
        </div>
      </Card>
    );
  }

  if (!data || data.status === "no_pair") {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground">
          This call isn't linked to both a demand and a candidate, so a
          JD-match run can't be scoped. Open the candidate's profile to
          run JD-match against any open demand.
        </div>
      </Card>
    );
  }

  const triggerRun = async (candidateId: string, demandId: string) => {
    setRunning(true);
    try {
      await apiFetch<{ matches: JdMatchRun[] }>(
        `/api/candidates/${candidateId}/jd-matches/run`,
        { method: "POST", json: { demandId } },
      );
      const res = await apiFetch<JdMatchResponse>(
        `/api/calls/${callId}/jd-match`,
      );
      setData(res);
    } finally {
      setRunning(false);
    }
  };

  if (data.status === "not_yet_run") {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground space-y-3">
          <div>No JD-match run for this call yet.</div>
          {/* The "run now" button is wired but needs candidateId + demandId
              from the call detail; we get those from the existing call
              shape via a follow-up hook. Until that hook lands, surface
              the prompt. */}
          <button
            type="button"
            disabled
            className="text-xs px-3 py-1.5 rounded border border-border bg-muted/50 text-muted-foreground cursor-not-allowed"
          >
            Run JD-match (open the candidate's profile and run from there)
          </button>
          <div className="text-xs">
            Or trigger a batch run from the candidate detail page.
          </div>
        </div>
      </Card>
    );
  }

  const m = data.match!;
  const overall = num(m.overallScore) ?? 0;

  const dims: Array<{ name: string; score: number | null; weight: number }> = [
    { name: "Must-have skills", score: num(m.mustHavesScore), weight: 35 },
    { name: "Nice-to-have skills", score: num(m.niceToHavesScore), weight: 10 },
    { name: "Experience fit", score: num(m.experienceFitScore), weight: 15 },
    { name: "Compensation fit", score: num(m.compensationFitScore), weight: 15 },
    { name: "Location fit", score: num(m.locationFitScore), weight: 15 },
    { name: "Notice period fit", score: num(m.noticePeriodFitScore), weight: 10 },
  ];

  const verdictPill =
    m.verdict === "strong_match"
      ? "bg-success/15 text-success"
      : m.verdict === "partial_match"
      ? "bg-primary/15 text-primary"
      : m.verdict === "weak_match"
      ? "bg-warning/15 text-warning"
      : "bg-destructive/15 text-destructive";

  return (
    <div className="space-y-4">
      <Card>
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">JD-Candidate match</div>
            <div className="text-xs text-muted-foreground">
              {m.modelVersion} · {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold tabular-nums">{Math.round(overall)}</span>
            <span className={`pill ${verdictPill} text-[11px]`}>{m.verdict.replace("_", " ")}</span>
            <button
              type="button"
              disabled={running}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-50"
              onClick={() => void triggerRun(m.candidateId, m.demandId)}
            >
              {running ? "Re-running…" : "Re-run"}
            </button>
          </div>
        </div>
        <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-3">
          {dims.map((c) => {
            const sc = c.score ?? 0;
            const band = sc >= 80 ? "bg-success" : sc >= 65 ? "bg-warning" : "bg-destructive";
            return (
              <div key={c.name}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {c.score == null ? "—" : `${Math.round(sc)}/100`} · w{c.weight}%
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div className={`h-full ${band}`} style={{ width: `${sc}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Card title="Strengths">
          <div className="p-4 text-sm space-y-2">
            {m.strengths.length === 0 ? (
              <div className="text-muted-foreground">No clear strengths above 80.</div>
            ) : (
              m.strengths.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-success mt-0.5">+</span>
                  <span>{s.label}</span>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card title="Gaps">
          <div className="p-4 text-sm space-y-2">
            {m.gaps.length === 0 ? (
              <div className="text-muted-foreground">No gaps below 50.</div>
            ) : (
              m.gaps.map((g, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-destructive mt-0.5">−</span>
                  <span>{g.label}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---- Compliance tab (Phase 1 placeholder) ----

function ComplianceTab() {
  const items: { label: string; ok: "yes" | "no" | "unknown"; rationale: string }[] = [
    { label: "JD positioning clarified", ok: "yes", rationale: "Recruiter explained the role, client, and team scope at 01:42." },
    { label: "Compensation range discussed within band", ok: "yes", rationale: "CTC range stated with rationale at 03:10." },
    { label: "Notice period probed and validated", ok: "unknown", rationale: "Mentioned but flexibility (buyout, partial release) not surfaced." },
    { label: "Location preference confirmed", ok: "yes", rationale: "Recruiter validated Bengaluru hybrid expectation." },
    { label: "Mandatory checks disclosed (BGV, drug)", ok: "no", rationale: "Not mentioned in transcript." },
    { label: "Closed with explicit next step + ETA", ok: "yes", rationale: "Wrap at 09:42 stated JD email + EOD next-day reply." },
  ];
  return (
    <Card>
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Compliance &amp; coverage flags</div>
          <div className="text-xs text-muted-foreground">Auto-extracted from transcript by post-call worker. Phase 2 wires the worker.</div>
        </div>
        <span className="pill bg-warning/15 text-warning text-[11px]">Engine pending</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((it) => (
          <li key={it.label} className="px-4 py-3 flex items-start gap-3">
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded shrink-0 mt-0.5 ${
              it.ok === "yes" ? "bg-success/15 text-success" :
              it.ok === "no" ? "bg-destructive/15 text-destructive" :
              "bg-muted text-muted-foreground"
            }`}>
              {it.ok === "yes" ? "✓" : it.ok === "no" ? "✗" : "—"}
            </span>
            <div className="flex-1">
              <div className="text-sm font-medium">{it.label}</div>
              <div className="text-xs text-muted-foreground">{it.rationale}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
