import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { useCandidate, useUploadCandidateResume } from "@/hooks/useCandidates";
import {
  Loader2,
  ChevronLeft,
  Briefcase,
  Mail,
  Phone,
  MapPin,
  Linkedin,
  Github,
  ExternalLink,
  FileText,
  Download,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatDistanceToNow } from "date-fns";
import { ResumeDropzone } from "@/components/ResumeDropzone";
import { apiFetch, getApiBase, getAccessToken } from "@/lib/api";
import { toast } from "sonner";

export default function CandidateDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useCandidate(id);
  const upload = useUploadCandidateResume(id);
  const [tab, setTab] = useState("profile");
  const [uploadStatus, setUploadStatus] = useState<
    null | { kind: "ok"; message: string } | { kind: "error"; message: string }
  >(null);

  async function handleResumeUpload(file: File) {
    setUploadStatus(null);
    try {
      const result = await upload.mutateAsync(file);
      const lines: string[] = [];
      if (result.mergedFields.length) lines.push(`filled ${result.mergedFields.length} empty field${result.mergedFields.length === 1 ? "" : "s"}`);
      if (result.addedExperienceCount) lines.push(`added ${result.addedExperienceCount} experience${result.addedExperienceCount === 1 ? "" : "s"}`);
      if (result.addedQualificationCount) lines.push(`added ${result.addedQualificationCount} qualification${result.addedQualificationCount === 1 ? "" : "s"}`);
      if (result.matchedSkillCount) lines.push(`matched ${result.matchedSkillCount} skill${result.matchedSkillCount === 1 ? "" : "s"}`);
      const summary = lines.length ? `Resume processed — ${lines.join(", ")}.` : "Resume processed.";
      setUploadStatus({ kind: "ok", message: summary });
      toast.success("Resume uploaded.");
    } catch (err: unknown) {
      const apiError = err as { status?: number; body?: { error?: string } };
      const code = apiError?.body?.error;
      const message =
        code === "openai_not_configured"
          ? "OpenAI is not configured on this server."
          : code === "unparseable_resume"
            ? "We couldn't extract enough text from this file."
            : code === "unsupported_media_type"
              ? "Only PDF, DOCX, DOC, TXT, or MD files are supported."
              : code === "file_too_large"
                ? "File is larger than 10 MB."
                : "Resume upload failed.";
      setUploadStatus({ kind: "error", message });
    }
  }

  function buildResumeFileUrl(resumeId: string): string {
    const token = getAccessToken();
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${getApiBase()}/api/candidates/${id}/resumes/${resumeId}/file${qs}`;
  }

  if (isLoading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading candidate…
      </div>
    );
  }
  if (isError || !data) {
    return <div className="p-10 text-sm text-destructive">Candidate not found.</div>;
  }

  const c = data.candidate;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/candidates" className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            {c.displayName ?? "—"}
          </span>
        }
        subtitle={`${c.currentTitle ?? "—"}${c.currentCompany ? ` @ ${c.currentCompany}` : ""}`}
      />
      <div className="px-6 pt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="experience">Experience ({data.experiences.length})</TabsTrigger>
            <TabsTrigger value="qualifications">Qualifications ({data.qualifications.length})</TabsTrigger>
            <TabsTrigger value="resume">Resume ({data.resumes.length})</TabsTrigger>
            <TabsTrigger value="submissions">Submissions ({data.submissions.length})</TabsTrigger>
            <TabsTrigger value="prospects">Prospects ({data.prospects.length})</TabsTrigger>
            <TabsTrigger value="jd-matches">JD matches</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="pt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Card title="Contact">
                <dl className="text-sm grid grid-cols-2 gap-y-2 p-4">
                  <dt className="text-muted-foreground"><Mail className="inline w-3.5 h-3.5 mr-1" />Email</dt><dd>{c.email ?? "—"}</dd>
                  <dt className="text-muted-foreground"><Phone className="inline w-3.5 h-3.5 mr-1" />Phone</dt><dd>{c.phone ?? "—"}</dd>
                  <dt className="text-muted-foreground"><MapPin className="inline w-3.5 h-3.5 mr-1" />Current location</dt><dd>{c.currentLocation ?? "—"}</dd>
                  <dt className="text-muted-foreground">Preferred</dt>
                  <dd>{c.preferredLocations.length ? c.preferredLocations.join(", ") : "—"}</dd>
                  <dt className="text-muted-foreground"><Linkedin className="inline w-3.5 h-3.5 mr-1" />LinkedIn</dt>
                  <dd>{c.linkedinUrl ? <a className="text-primary hover:underline" href={c.linkedinUrl} target="_blank" rel="noreferrer">profile <ExternalLink className="inline w-3 h-3" /></a> : "—"}</dd>
                  <dt className="text-muted-foreground"><Github className="inline w-3.5 h-3.5 mr-1" />GitHub</dt>
                  <dd>{c.githubUrl ? <a className="text-primary hover:underline" href={c.githubUrl} target="_blank" rel="noreferrer">profile <ExternalLink className="inline w-3 h-3" /></a> : "—"}</dd>
                  <dt className="text-muted-foreground">Source</dt><dd>{c.source}</dd>
                </dl>
              </Card>
              <Card title="Compensation & availability">
                <dl className="text-sm grid grid-cols-2 gap-y-2 p-4">
                  <dt className="text-muted-foreground">Total experience</dt><dd>{c.totalExperienceYears ?? "—"} yrs</dd>
                  <dt className="text-muted-foreground">Current CTC</dt><dd>₹{c.currentCtcLakhs ?? "—"} LPA</dd>
                  <dt className="text-muted-foreground">Expected CTC</dt><dd>₹{c.expectedCtcLakhs ?? "—"} LPA</dd>
                  <dt className="text-muted-foreground">Notice period</dt>
                  <dd>{c.noticePeriodDays ?? "—"} days {c.noticePeriodNegotiable ? "(negotiable)" : ""}</dd>
                </dl>
              </Card>
            </div>
            <Card title="Summary">
              <div className="p-4 text-sm whitespace-pre-line leading-relaxed">
                {c.summary ?? <span className="text-muted-foreground">No summary yet.</span>}
              </div>
            </Card>
            <Card title="Skills">
              <div className="p-4 flex flex-wrap gap-1.5">
                {data.skills.length === 0 && <span className="text-sm text-muted-foreground">No skills tagged.</span>}
                {data.skills.map((s) => (
                  <span key={s.skillId} className="pill bg-primary/15 text-primary">
                    {s.name}
                    {s.proficiencyLevel ? ` · L${s.proficiencyLevel}` : ""}
                  </span>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="experience" className="pt-4">
            <Card>
              <div className="p-4 space-y-3">
                {data.experiences.length === 0 && <div className="text-sm text-muted-foreground">No experience entries.</div>}
                {data.experiences.map((e) => (
                  <div key={e.id} className="border-l-2 border-primary/40 pl-3">
                    <div className="font-medium text-sm">{e.title ?? "—"} <span className="text-muted-foreground">@ {e.companyName}</span></div>
                    <div className="text-xs text-muted-foreground">{e.startDate ?? "?"} → {e.isCurrent ? "Present" : (e.endDate ?? "?")}</div>
                    {e.description && <div className="text-sm mt-1">{e.description}</div>}
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="qualifications" className="pt-4">
            <Card>
              <div className="p-4 space-y-3">
                {data.qualifications.length === 0 && <div className="text-sm text-muted-foreground">No qualification entries.</div>}
                {data.qualifications.map((q) => (
                  <div key={q.id}>
                    <div className="font-medium text-sm">{q.degree ?? "—"} <span className="text-muted-foreground">in {q.fieldOfStudy ?? "—"}</span></div>
                    <div className="text-xs text-muted-foreground">{q.institution ?? "—"} · {q.yearOfCompletion ?? "—"} · {q.marksOrGrade ?? "—"}</div>
                  </div>
                ))}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="resume" className="pt-4 space-y-4">
            <Card title={data.resumes.length === 0 ? "Upload resume" : "Upload a new resume"}>
              <div className="p-4">
                <ResumeDropzone
                  onFile={handleResumeUpload}
                  isPending={upload.isPending}
                  status={uploadStatus}
                  label={data.resumes.length === 0 ? "Drop a resume to autofill empty fields" : "Replace with a newer resume"}
                  hint="We'll parse it with AI, fill any empty profile fields, and add experience / qualification rows. Existing data isn't overwritten."
                />
              </div>
            </Card>

            <Card title={`Resume history (${data.resumes.length})`}>
              {data.resumes.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No resumes uploaded yet.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {data.resumes.map((r) => (
                    <li key={r.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <FileText className="w-5 h-5 text-muted-foreground" />
                        <div>
                          <div className="font-medium text-sm">{r.originalFilename ?? "resume"}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.bytes ? `${(r.bytes / 1024).toFixed(1)} KB` : "—"}
                            {r.mime ? ` · ${r.mime}` : ""}
                            {" · "}
                            {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                            {r.modelUsed ? ` · parsed by ${r.modelUsed}` : ""}
                          </div>
                        </div>
                      </div>
                      <a
                        href={buildResumeFileUrl(r.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1"
                      >
                        <Download className="w-3.5 h-3.5" /> View
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="submissions" className="pt-4">
            <Card>
              {data.submissions.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No submissions for this candidate yet.</div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Demand</th><th>Stage</th><th>Status</th><th>Submitted</th></tr></thead>
                  <tbody>
                    {data.submissions.map((s) => (
                      <tr key={s.id}>
                        <td><Link to={`/demands/${s.demandId}`} className="text-primary hover:underline">{s.demandId.slice(0, 8)}…</Link></td>
                        <td className="text-sm">{s.currentStage}</td>
                        <td className="text-sm">{s.status}</td>
                        <td className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(s.submittedAt), { addSuffix: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="prospects" className="pt-4">
            <Card>
              {data.prospects.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No active prospects for this candidate.</div>
              ) : (
                <table className="data-table">
                  <thead><tr><th>Demand</th><th>Status</th><th>Last contact</th><th>Created</th></tr></thead>
                  <tbody>
                    {data.prospects.map((p) => (
                      <tr key={p.id}>
                        <td><Link to={`/demands/${p.demandId}`} className="text-primary hover:underline">{p.demandId.slice(0, 8)}…</Link></td>
                        <td className="text-sm">{p.status}</td>
                        <td className="text-xs text-muted-foreground">{p.lastContactedAt ? formatDistanceToNow(new Date(p.lastContactedAt), { addSuffix: true }) : "—"}</td>
                        <td className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(p.createdAt), { addSuffix: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="jd-matches" className="pt-4">
            <CandidateJdMatchesTab candidateId={id ?? null} />
          </TabsContent>

          <TabsContent value="timeline" className="pt-4">
            <CandidateTimelineTab candidateId={id ?? null} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ---- JD-Matches tab ----

interface JdMatchSummary {
  id: string;
  demandId: string;
  demandTitle: string | null;
  overallScore: string | number;
  verdict: "strong_match" | "partial_match" | "weak_match" | "no_match";
  mustHavesScore: string | number | null;
  niceToHavesScore: string | number | null;
  experienceFitScore: string | number | null;
  compensationFitScore: string | number | null;
  locationFitScore: string | number | null;
  noticePeriodFitScore: string | number | null;
  strengths: Array<{ kind: string; label: string }>;
  gaps: Array<{ kind: string; label: string }>;
  createdAt: string;
  modelVersion: string;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function CandidateJdMatchesTab({ candidateId }: { candidateId: string | null }) {
  const [matches, setMatches] = useState<JdMatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const reload = async () => {
    if (!candidateId) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ matches: JdMatchSummary[] }>(
        `/api/candidates/${candidateId}/jd-matches`,
      );
      setMatches(res.matches);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  const runBatch = async () => {
    if (!candidateId) return;
    setRunning(true);
    try {
      await apiFetch<{ matches: JdMatchSummary[] }>(
        `/api/candidates/${candidateId}/jd-matches/run`,
        { method: "POST", json: {} },
      );
      await reload();
      toast.success("JD-match scores refreshed");
    } catch (err) {
      toast.error("JD-match run failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading JD-matches…
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {matches.length} match{matches.length === 1 ? "" : "es"} ranked by overall score
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => void runBatch()}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50 disabled:opacity-50"
        >
          {running ? "Running…" : "Re-score against open demands"}
        </button>
      </div>
      {matches.length === 0 ? (
        <Card>
          <div className="p-6 text-sm text-muted-foreground">
            No JD-matches yet for this candidate. Click "Re-score against open
            demands" to score them against every open demand in your org.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {matches
            .sort((a, b) => (num(b.overallScore) ?? 0) - (num(a.overallScore) ?? 0))
            .map((m) => {
              const score = num(m.overallScore) ?? 0;
              const verdictPill =
                m.verdict === "strong_match"
                  ? "bg-success/15 text-success"
                  : m.verdict === "partial_match"
                  ? "bg-primary/15 text-primary"
                  : m.verdict === "weak_match"
                  ? "bg-warning/15 text-warning"
                  : "bg-destructive/15 text-destructive";
              return (
                <Card key={m.id}>
                  <div className="px-4 py-3 flex items-center gap-4">
                    <div className="text-2xl font-semibold tabular-nums w-12 text-right">
                      {Math.round(score)}
                    </div>
                    <div className="flex-1">
                      <Link
                        to={`/demands/${m.demandId}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {m.demandTitle ?? "Untitled demand"}
                      </Link>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })} · {m.modelVersion}
                      </div>
                    </div>
                    <span className={`pill ${verdictPill} text-[11px]`}>
                      {m.verdict.replace("_", " ")}
                    </span>
                  </div>
                  {(m.strengths.length > 0 || m.gaps.length > 0) && (
                    <div className="px-4 pb-3 grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-1">Strengths</div>
                        {m.strengths.length === 0 ? (
                          <div className="text-muted-foreground italic">none</div>
                        ) : (
                          m.strengths.map((s, i) => (
                            <div key={i} className="text-success">
                              + {s.label}
                            </div>
                          ))
                        )}
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Gaps</div>
                        {m.gaps.length === 0 ? (
                          <div className="text-muted-foreground italic">none</div>
                        ) : (
                          m.gaps.map((g, i) => (
                            <div key={i} className="text-destructive">
                              − {g.label}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ---- Timeline tab ----
interface MessagingEvent {
  id: string;
  channel: "whatsapp" | "sms" | "email";
  provider: string;
  direction: "outbound" | "inbound";
  toAddress: string;
  body: string;
  status: string;
  remoteId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const CHANNEL_PILL: Record<string, string> = {
  whatsapp: "bg-success/15 text-success",
  sms: "bg-info/15 text-info",
  email: "bg-primary/15 text-primary",
};

function CandidateTimelineTab({ candidateId }: { candidateId: string | null }) {
  const [events, setEvents] = useState<MessagingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [channel, setChannel] = useState<"whatsapp" | "sms">("whatsapp");
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);

  const reload = async () => {
    if (!candidateId) return;
    setLoading(true);
    try {
      const res = await apiFetch<{ events: MessagingEvent[] }>(
        `/api/messaging/candidates/${candidateId}/timeline`,
      );
      setEvents(res.events);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  const send = async () => {
    if (!candidateId || !to.trim() || !body.trim()) return;
    setSending(true);
    try {
      await apiFetch("/api/messaging/send", {
        method: "POST",
        json: { channel, to: to.trim(), body: body.trim(), candidateId },
      });
      toast.success(`Sent (${channel})`);
      setBody("");
      setComposerOpen(false);
      await reload();
    } catch (err) {
      toast.error("Send failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {events.length} message{events.length === 1 ? "" : "s"} on this candidate
        </div>
        <button
          type="button"
          onClick={() => setComposerOpen((v) => !v)}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50"
        >
          {composerOpen ? "Close composer" : "Send message"}
        </button>
      </div>
      {composerOpen && (
        <div className="bg-card border border-border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-3 gap-2 text-xs">
            <select
              className="border border-border rounded px-2 py-1.5"
              value={channel}
              onChange={(e) => setChannel(e.target.value as "whatsapp" | "sms")}
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
            </select>
            <input
              className="col-span-2 border border-border rounded px-2 py-1.5"
              placeholder="Phone (e.g. +91 98765 43210)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <textarea
            className="w-full text-sm border border-border rounded p-2 min-h-[80px]"
            placeholder={
              channel === "whatsapp"
                ? "Hi! Aapka assessment ka link share kar raha hoon — please complete by EOD…"
                : "Short SMS message…"
            }
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={sending || !body.trim() || !to.trim()}
              onClick={() => void send()}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading timeline…</div>
      ) : events.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-6 text-sm text-muted-foreground text-center">
          No messages on this candidate yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.id} className="bg-card border border-border rounded-lg p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <div className="flex items-center gap-2">
                  <span className={`pill text-[10px] ${CHANNEL_PILL[e.channel]}`}>
                    {e.channel.toUpperCase()}
                  </span>
                  <span>{e.direction === "outbound" ? "→ " : "← "}{e.toAddress}</span>
                  <span className="capitalize">· {e.status}</span>
                  <span>· via {e.provider}</span>
                </div>
                <span>{formatDistanceToNow(new Date(e.createdAt), { addSuffix: true })}</span>
              </div>
              <div className="text-sm whitespace-pre-wrap">{e.body}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
