import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import {
  useCreateCandidate,
  useDedupCheck,
  useParseResumePreview,
  type DedupMatch,
  type ParsedResumePreview,
} from "@/hooks/useCandidates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ResumeDropzone } from "@/components/ResumeDropzone";

export default function CandidateNew() {
  const nav = useNavigate();
  const dedup = useDedupCheck();
  const create = useCreateCandidate();
  const parsePreview = useParseResumePreview();

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    currentTitle: "",
    currentCompany: "",
    totalExperienceYears: "",
    currentCtcLakhs: "",
    expectedCtcLakhs: "",
    noticePeriodDays: "",
    currentLocation: "",
    summary: "",
    linkedinUrl: "",
    githubUrl: "",
  });
  const [matches, setMatches] = useState<DedupMatch[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [resumePreview, setResumePreview] = useState<ParsedResumePreview | null>(null);
  const [resumeStatus, setResumeStatus] = useState<
    null | { kind: "ok"; message: string } | { kind: "error"; message: string }
  >(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleResumeUpload(file: File) {
    setResumeStatus(null);
    try {
      const preview = await parsePreview.mutateAsync(file);
      setResumePreview(preview);
      const p = preview.parsed;

      setForm((f) => ({
        firstName: f.firstName || p.firstName || "",
        lastName: f.lastName || p.lastName || "",
        email: f.email || p.email || "",
        phone: f.phone || p.phone || "",
        currentTitle: f.currentTitle || p.currentTitle || "",
        currentCompany: f.currentCompany || p.currentCompany || "",
        totalExperienceYears: f.totalExperienceYears || (p.totalExperienceYears != null ? String(p.totalExperienceYears) : ""),
        currentCtcLakhs: f.currentCtcLakhs || (p.currentCtcLakhs != null ? String(p.currentCtcLakhs) : ""),
        expectedCtcLakhs: f.expectedCtcLakhs || (p.expectedCtcLakhs != null ? String(p.expectedCtcLakhs) : ""),
        noticePeriodDays: f.noticePeriodDays || (p.noticePeriodDays != null ? String(p.noticePeriodDays) : ""),
        currentLocation: f.currentLocation || p.currentLocation || "",
        summary: f.summary || p.summary || "",
        linkedinUrl: f.linkedinUrl || p.linkedinUrl || "",
        githubUrl: f.githubUrl || p.githubUrl || "",
      }));

      const filledCount = Object.values(p).filter((v) => v !== null && v !== undefined && v !== "" && !Array.isArray(v)).length;
      setResumeStatus({
        kind: "ok",
        message: `Autofilled ${filledCount} fields, ${p.experiences.length} experience${p.experiences.length === 1 ? "" : "s"}, ${p.qualifications.length} qualification${p.qualifications.length === 1 ? "" : "s"}, ${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}.`,
      });

      // Trigger dedup if email or phone got filled
      const email = (p.email ?? "").trim();
      const phone = (p.phone ?? "").trim();
      if (email || phone) {
        const found = await dedup.mutateAsync({ email: email || undefined, phone: phone || undefined });
        setMatches(found);
      }
    } catch (err: unknown) {
      const apiError = err as { status?: number; body?: { error?: string; hint?: string } };
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
                : "Resume parse failed.";
      setResumeStatus({ kind: "error", message });
    }
  }

  async function handleDedupCheck() {
    const email = form.email.trim();
    const phone = form.phone.trim();
    if (!email && !phone) {
      setMatches([]);
      return;
    }
    const found = await dedup.mutateAsync({ email: email || undefined, phone: phone || undefined });
    setMatches(found);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim()) {
      toast.error("First name is required.");
      return;
    }
    try {
      const result = await create.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        currentTitle: form.currentTitle.trim() || undefined,
        currentCompany: form.currentCompany.trim() || undefined,
        totalExperienceYears: form.totalExperienceYears ? Number(form.totalExperienceYears) : undefined,
        currentCtcLakhs: form.currentCtcLakhs ? Number(form.currentCtcLakhs) : undefined,
        expectedCtcLakhs: form.expectedCtcLakhs ? Number(form.expectedCtcLakhs) : undefined,
        noticePeriodDays: form.noticePeriodDays ? Number(form.noticePeriodDays) : undefined,
        currentLocation: form.currentLocation.trim() || undefined,
        summary: form.summary.trim() || undefined,
        linkedinUrl: form.linkedinUrl.trim() || undefined,
        githubUrl: form.githubUrl.trim() || undefined,
        confirmDuplicate,
        ...(resumePreview
          ? {
              resumeBlobKey: resumePreview.blobKey,
              parsedResumeJson: {
                parsed: resumePreview.parsed,
                parseMeta: resumePreview.parseMeta,
                modelUsed: resumePreview.modelUsed,
              },
              resumeMeta: {
                sha256: resumePreview.sha256,
                bytes: resumePreview.bytes,
                mime: resumePreview.mime,
                filename: resumePreview.filename,
                modelUsed: resumePreview.modelUsed,
              },
              experiences: resumePreview.parsed.experiences,
              qualifications: resumePreview.parsed.qualifications,
              skillNames: resumePreview.parsed.skills.map((s) => s.name),
            }
          : {}),
      });
      toast.success("Candidate created.");
      nav(`/candidates/${result.candidateId}`);
    } catch (err: unknown) {
      const apiError = err as { status?: number; body?: { error?: string; matches?: DedupMatch[] } };
      if (apiError?.status === 409 && apiError?.body?.error === "duplicate_candidate") {
        setMatches(apiError.body.matches ?? []);
        toast.warning("Possible duplicates found. Review the matches and confirm to create anyway.");
      } else {
        toast.error("Failed to create candidate.");
      }
    }
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/candidates" className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            New candidate
          </span>
        }
        subtitle="Drop a resume to autopopulate, or fill manually. Dedup runs on email and phone."
      />
      <div className="p-6 max-w-3xl space-y-4">
        <Card title="Start from a resume">
          <div className="p-4">
            <ResumeDropzone
              onFile={handleResumeUpload}
              isPending={parsePreview.isPending}
              status={resumeStatus}
              label={resumePreview ? "Replace with a different resume" : "Upload a resume to autopopulate"}
              hint="We'll parse it with AI and fill the fields below — review and edit before saving."
            />
          </div>
        </Card>

        <Card title="Identity">
          <div className="p-4 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">First name *</label>
              <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Last name</label>
              <Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Email</label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                onBlur={handleDedupCheck}
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Phone</label>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                onBlur={handleDedupCheck}
                placeholder="+91…"
              />
            </div>
          </div>
        </Card>

        {matches.length > 0 && (
          <Card>
            <div className="p-4 border-l-4 border-warning">
              <div className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertTriangle className="w-4 h-4" />
                {matches.length} possible duplicate{matches.length > 1 ? "s" : ""} in the org
              </div>
              <div className="mt-3 space-y-2">
                {matches.map((m) => (
                  <div key={m.id} className="border border-border rounded-md p-3 bg-card">
                    <div className="flex items-center justify-between">
                      <div>
                        <Link to={`/candidates/${m.id}`} className="font-medium hover:underline">{m.displayName ?? "—"}</Link>
                        <div className="text-xs text-muted-foreground">
                          {m.email ?? "—"}{m.phone ? ` · ${m.phone}` : ""} · {m.totalExperienceYears ?? "?"} yrs
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.currentTitle ?? "—"}{m.currentCompany ? ` @ ${m.currentCompany}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm">{m.activeSubmissionCount} active submission{m.activeSubmissionCount === 1 ? "" : "s"}</div>
                        <Link to={`/candidates/${m.id}`} className="text-xs text-primary hover:underline">Use existing</Link>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmDuplicate}
                  onChange={(e) => setConfirmDuplicate(e.target.checked)}
                />
                These matches aren't the same person — create anyway.
              </label>
            </div>
          </Card>
        )}

        <Card title="Current role">
          <div className="p-4 grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">Current title</label>
              <Input value={form.currentTitle} onChange={(e) => set("currentTitle", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Current company</label>
              <Input value={form.currentCompany} onChange={(e) => set("currentCompany", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Total experience (yrs)</label>
              <Input value={form.totalExperienceYears} onChange={(e) => set("totalExperienceYears", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Current location</label>
              <Input value={form.currentLocation} onChange={(e) => set("currentLocation", e.target.value)} />
            </div>
          </div>
        </Card>

        <Card title="Compensation & availability">
          <div className="p-4 grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1">Current CTC (LPA)</label>
              <Input value={form.currentCtcLakhs} onChange={(e) => set("currentCtcLakhs", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Expected CTC (LPA)</label>
              <Input value={form.expectedCtcLakhs} onChange={(e) => set("expectedCtcLakhs", e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Notice period (days)</label>
              <Input value={form.noticePeriodDays} onChange={(e) => set("noticePeriodDays", e.target.value)} />
            </div>
          </div>
        </Card>

        {(form.summary || form.linkedinUrl || form.githubUrl) && (
          <Card title="Profile">
            <div className="p-4 space-y-3">
              {form.summary && (
                <div>
                  <label className="text-xs font-medium block mb-1">Summary</label>
                  <textarea
                    className="w-full text-sm border border-border rounded-md p-2 min-h-[80px]"
                    value={form.summary}
                    onChange={(e) => set("summary", e.target.value)}
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium block mb-1">LinkedIn URL</label>
                  <Input value={form.linkedinUrl} onChange={(e) => set("linkedinUrl", e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">GitHub URL</label>
                  <Input value={form.githubUrl} onChange={(e) => set("githubUrl", e.target.value)} />
                </div>
              </div>
            </div>
          </Card>
        )}

        {resumePreview && (resumePreview.parsed.experiences.length > 0 || resumePreview.parsed.qualifications.length > 0 || resumePreview.parsed.skills.length > 0) && (
          <Card title="From resume — will be added on save">
            <div className="p-4 space-y-3 text-sm">
              {resumePreview.parsed.experiences.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Experience ({resumePreview.parsed.experiences.length})</div>
                  <ul className="space-y-1">
                    {resumePreview.parsed.experiences.map((e, i) => (
                      <li key={i} className="text-xs">
                        <span className="font-medium">{e.title ?? "—"}</span> @ {e.companyName}{" "}
                        <span className="text-muted-foreground">
                          ({e.startDate ?? "?"} → {e.isCurrent ? "Present" : (e.endDate ?? "?")})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {resumePreview.parsed.qualifications.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Qualifications ({resumePreview.parsed.qualifications.length})</div>
                  <ul className="space-y-1">
                    {resumePreview.parsed.qualifications.map((q, i) => (
                      <li key={i} className="text-xs">
                        {q.degree ?? "—"} in {q.fieldOfStudy ?? "—"} · {q.institution ?? "—"} · {q.yearOfCompletion ?? "—"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {resumePreview.parsed.skills.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Skills ({resumePreview.parsed.skills.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {resumePreview.parsed.skills.map((s, i) => (
                      <span key={i} className="pill bg-primary/10 text-primary text-xs">{s.name}</span>
                    ))}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">Skills only attach when they match the existing skill taxonomy.</div>
                </div>
              )}
            </div>
          </Card>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => nav("/candidates")}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Create candidate
          </Button>
        </div>
      </div>
    </div>
  );
}
