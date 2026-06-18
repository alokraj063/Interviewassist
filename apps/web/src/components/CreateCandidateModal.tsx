// Modal for creating a candidate without leaving the current page. Used by
// Live Assist's setup picker so a recruiter can ingest a fresh candidate
// (typed manually or parsed from a resume) and immediately select them for
// the call. The modal mirrors CandidateNew's create payload but skips the
// dedup-warn-then-confirm UX — there's no ambiguity here, the recruiter is
// in the middle of a flow and just needs to land a candidate quickly.

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateCandidate,
  useDedupCheck,
  useParseResumePreview,
  type DedupMatch,
  type ParsedResumePreview,
} from "@/hooks/useCandidates";
import { ResumeDropzone } from "@/components/ResumeDropzone";

export type CreateMode = "manual" | "from-resume";

interface Props {
  open: boolean;
  initialMode: CreateMode;
  onClose: () => void;
  // Fired with the new candidate id once the row is created. Does NOT fire
  // when the user clicks "Use existing" on a dedup match.
  onCreated: (candidateId: string) => void;
  // Fired when the user picks an existing candidate from the dedup list.
  onUseExisting?: (candidateId: string) => void;
}

const EMPTY_FORM = {
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
};

export function CreateCandidateModal({ open, initialMode, onClose, onCreated, onUseExisting }: Props) {
  const create = useCreateCandidate();
  const dedup = useDedupCheck();
  const parsePreview = useParseResumePreview();

  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [form, setForm] = useState(EMPTY_FORM);
  const [matches, setMatches] = useState<DedupMatch[]>([]);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [resumePreview, setResumePreview] = useState<ParsedResumePreview | null>(null);
  const [resumeStatus, setResumeStatus] = useState<
    null | { kind: "ok"; message: string } | { kind: "error"; message: string }
  >(null);

  // Reset state every time the modal is reopened so a previous abandoned
  // attempt doesn't leak in.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setForm(EMPTY_FORM);
      setMatches([]);
      setConfirmDuplicate(false);
      setResumePreview(null);
      setResumeStatus(null);
    }
  }, [open, initialMode]);

  function set<K extends keyof typeof EMPTY_FORM>(k: K, v: string) {
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
      const email = (p.email ?? "").trim();
      const phone = (p.phone ?? "").trim();
      if (email || phone) {
        const found = await dedup.mutateAsync({ email: email || undefined, phone: phone || undefined });
        setMatches(found);
      }
    } catch (err: unknown) {
      const apiError = err as { body?: { error?: string } };
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

  async function handleSubmit() {
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
      onCreated(result.candidateId);
    } catch (err: unknown) {
      const apiError = err as { status?: number; body?: { error?: string; matches?: DedupMatch[] } };
      if (apiError?.status === 409 && apiError?.body?.error === "duplicate_candidate") {
        setMatches(apiError.body.matches ?? []);
        toast.warning("Possible duplicates found. Review and confirm to create anyway.");
      } else {
        toast.error("Failed to create candidate.");
      }
    }
  }

  const isPending = create.isPending || parsePreview.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create candidate</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={`px-3 py-1.5 rounded-md border ${mode === "manual" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-muted/40"}`}
            >
              Type it in
            </button>
            <button
              type="button"
              onClick={() => setMode("from-resume")}
              className={`px-3 py-1.5 rounded-md border ${mode === "from-resume" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-muted/40"}`}
            >
              Upload a resume
            </button>
          </div>

          {mode === "from-resume" && (
            <ResumeDropzone
              onFile={handleResumeUpload}
              isPending={parsePreview.isPending}
              status={resumeStatus}
              label={resumePreview ? "Replace with a different resume" : "Drop a resume to autopopulate"}
              hint="We'll parse it with AI — review and edit before saving."
            />
          )}

          <div className="grid grid-cols-2 gap-3">
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
              <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} onBlur={handleDedupCheck} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Phone</label>
              <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} onBlur={handleDedupCheck} placeholder="+91…" />
            </div>
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

          {matches.length > 0 && (
            <div className="border-l-4 border-warning bg-warning/5 p-3 rounded">
              <div className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertTriangle className="w-4 h-4" />
                {matches.length} possible duplicate{matches.length > 1 ? "s" : ""}
              </div>
              <div className="mt-2 space-y-1.5">
                {matches.map((m) => (
                  <div key={m.id} className="border border-border rounded-md p-2 bg-card flex items-center justify-between text-xs">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{m.displayName ?? "—"}</div>
                      <div className="text-muted-foreground truncate">
                        {m.email ?? "—"}{m.phone ? ` · ${m.phone}` : ""}
                        {m.currentTitle ? ` · ${m.currentTitle}` : ""}
                        {m.currentCompany ? ` @ ${m.currentCompany}` : ""}
                      </div>
                    </div>
                    {onUseExisting && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0 ml-2"
                        onClick={() => onUseExisting(m.id)}
                      >
                        Use this candidate
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={confirmDuplicate}
                  onChange={(e) => setConfirmDuplicate(e.target.checked)}
                />
                Not the same person — create anyway.
              </label>
            </div>
          )}

          {resumePreview &&
            (resumePreview.parsed.experiences.length > 0 ||
              resumePreview.parsed.qualifications.length > 0 ||
              resumePreview.parsed.skills.length > 0) && (
              <div className="text-xs space-y-2 border border-border rounded-md p-3 bg-muted/40">
                <div className="font-medium text-muted-foreground">From resume — added on save</div>
                {resumePreview.parsed.experiences.length > 0 && (
                  <div>
                    <span className="font-medium">{resumePreview.parsed.experiences.length}</span> experience entries
                  </div>
                )}
                {resumePreview.parsed.qualifications.length > 0 && (
                  <div>
                    <span className="font-medium">{resumePreview.parsed.qualifications.length}</span> qualifications
                  </div>
                )}
                {resumePreview.parsed.skills.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {resumePreview.parsed.skills.map((s, i) => (
                      <span key={i} className="pill bg-primary/10 text-primary">{s.name}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {create.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
            Create &amp; select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
