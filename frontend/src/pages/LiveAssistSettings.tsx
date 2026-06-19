// Live Assist — Settings / Setup data.
//
// A lightweight place to add the two things the guided interview needs:
// candidates and jobs (demands). Kept inside the Live-Assist-focused build so
// the recruiter can populate data without the full ATS nav. Language is fixed
// to English (the co-pilot is recruiter-facing English by design).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { UserPlus, Briefcase, Check, Loader2, ArrowLeft, Globe, Upload, Building2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCan } from "@/auth/AuthContext";
import { useDemands } from "@/hooks/useDemands";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateCandidateModal } from "@/components/CreateCandidateModal";
import { toast } from "sonner";

export default function LiveAssistSettings() {
  const canCreateDemand = useCan("demands.write");
  const canCreateCandidate = useCan("candidates.write");
  const canCreateClient = useCan("clients.write");
  const canReadClients = useCan("clients.read");
  const qc = useQueryClient();
  const { data: demands = [] } = useDemands({});

  // Real clients list (so newly-created clients show up immediately and the
  // picker works even before any demand exists).
  const { data: clientsData } = useQuery<{ clients: Array<{ id: string; name: string }> }>({
    queryKey: ["clients", "all"],
    queryFn: () => apiFetch("/api/clients"),
    enabled: canReadClients,
  });

  // Fallback for accounts without clients.read: derive distinct clients from
  // the demands the user can already see.
  const demandClients = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of demands) {
      if (d.clientId && !seen.has(d.clientId)) seen.set(d.clientId, d.clientName ?? "Client");
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [demands]);

  const clients = clientsData?.clients ?? demandClients;

  const [tab, setTab] = useState<"jd" | "resume">("jd");
  const [resumeModal, setResumeModal] = useState(false);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-5">
      <div>
        <Link to="/live-assist" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Live Assist
        </Link>
        <h1 className="text-xl font-semibold mt-1">JD & Résumé</h1>
        <p className="text-sm text-muted-foreground">Add the job (JD) and the candidate (résumé) to interview against.</p>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-start gap-2">
        <Globe className="w-4 h-4 mt-0.5 text-muted-foreground" />
        <div className="text-sm">
          <div className="font-medium">Interview language: English</div>
          <div className="text-muted-foreground text-xs">
            The co-pilot reads the conversation in any language but always coaches you in English — questions, verdicts, and scores. There are no language options to set.
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {([
          { id: "jd", label: "JD (Job)", icon: Briefcase },
          { id: "resume", label: "Résumé (Candidate)", icon: UserPlus },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 ${
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "jd" && (
        <div className="space-y-3">
          <AddClientCard
            disabled={!canCreateClient}
            onCreated={() => qc.invalidateQueries({ queryKey: ["clients"] })}
          />
          <AddJobCard
            disabled={!canCreateDemand}
            clients={clients}
            onCreated={() => qc.invalidateQueries({ queryKey: ["demands"] })}
          />
        </div>
      )}

      {tab === "resume" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" disabled={!canCreateCandidate} onClick={() => setResumeModal(true)}>
              <Upload className="w-4 h-4" /> Add via résumé upload
            </Button>
          </div>
          <AddCandidateCard disabled={!canCreateCandidate} onCreated={() => qc.invalidateQueries({ queryKey: ["candidates"] })} />
        </div>
      )}

      <CreateCandidateModal
        open={resumeModal}
        initialMode="from-resume"
        onClose={() => setResumeModal(false)}
        onCreated={() => { setResumeModal(false); qc.invalidateQueries({ queryKey: ["candidates"] }); }}
        onUseExisting={() => { setResumeModal(false); qc.invalidateQueries({ queryKey: ["candidates"] }); }}
      />
    </div>
  );
}

function Section({ icon: Icon, title, subtitle, children }: { icon: typeof UserPlus; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-primary" />
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function AddClientCard({ disabled, onCreated }: { disabled: boolean; onCreated: () => void }) {
  const [f, setF] = useState({ companyName: "", industry: "", tier: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit() {
    if (f.companyName.trim().length < 2) { toast.error("Company name is required."); return; }
    setBusy(true);
    try {
      await apiFetch("/api/clients", {
        method: "POST",
        json: {
          companyName: f.companyName.trim(),
          industry: f.industry.trim() || undefined,
          tier: f.tier.trim() || undefined,
        },
      });
      toast.success(`Client "${f.companyName.trim()}" added`);
      setF({ companyName: "", industry: "", tier: "" });
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create client";
      toast.error(/409/.test(msg) ? "A client with that name already exists." : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={Building2} title="Add client" subtitle="The company you're hiring for. Becomes selectable when adding a job below.">
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          Your account can't create clients (needs the <code>clients.write</code> permission).
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company name *"><Input value={f.companyName} onChange={set("companyName")} placeholder="Acme Corp GCC India" /></Field>
            <Field label="Industry"><Input value={f.industry} onChange={set("industry")} placeholder="IT Services" /></Field>
            <Field label="Tier"><Input value={f.tier} onChange={set("tier")} placeholder="A / B / C" /></Field>
          </div>
          <Button onClick={submit} disabled={busy} size="sm">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Add client
          </Button>
        </div>
      )}
    </Section>
  );
}

function AddCandidateCard({ disabled, onCreated }: { disabled: boolean; onCreated: () => void }) {
  const [f, setF] = useState({ firstName: "", lastName: "", currentTitle: "", currentCompany: "", totalExperienceYears: "", currentLocation: "", skills: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit() {
    if (!f.firstName.trim()) { toast.error("First name is required."); return; }
    setBusy(true);
    try {
      const skillNames = f.skills.split(",").map((s) => s.trim()).filter(Boolean);
      await apiFetch("/api/candidates", {
        method: "POST",
        json: {
          firstName: f.firstName.trim(),
          lastName: f.lastName.trim() || undefined,
          currentTitle: f.currentTitle.trim() || undefined,
          currentCompany: f.currentCompany.trim() || undefined,
          totalExperienceYears: f.totalExperienceYears ? Number(f.totalExperienceYears) : undefined,
          currentLocation: f.currentLocation.trim() || undefined,
          source: "direct",
          skillNames: skillNames.length ? skillNames : undefined,
        },
      });
      toast.success(`Candidate "${f.firstName}" added`);
      setF({ firstName: "", lastName: "", currentTitle: "", currentCompany: "", totalExperienceYears: "", currentLocation: "", skills: "" });
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create candidate");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={UserPlus} title="Add candidate" subtitle="Becomes selectable on the Live Assist setup screen.">
      {disabled ? (
        <p className="text-xs text-muted-foreground">Your account can't create candidates.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name *"><Input value={f.firstName} onChange={set("firstName")} placeholder="Aarav" /></Field>
            <Field label="Last name"><Input value={f.lastName} onChange={set("lastName")} placeholder="Sharma" /></Field>
            <Field label="Current title"><Input value={f.currentTitle} onChange={set("currentTitle")} placeholder="Backend Engineer" /></Field>
            <Field label="Current company"><Input value={f.currentCompany} onChange={set("currentCompany")} placeholder="Razorpay" /></Field>
            <Field label="Total experience (yrs)"><Input type="number" value={f.totalExperienceYears} onChange={set("totalExperienceYears")} placeholder="5" /></Field>
            <Field label="Location"><Input value={f.currentLocation} onChange={set("currentLocation")} placeholder="Bengaluru" /></Field>
          </div>
          <Field label="Skills (comma-separated)"><Input value={f.skills} onChange={set("skills")} placeholder="Java, Spring Boot, Kafka" /></Field>
          <Button onClick={submit} disabled={busy} size="sm">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Add candidate
          </Button>
        </div>
      )}
    </Section>
  );
}

function AddJobCard({ disabled, clients, onCreated }: { disabled: boolean; clients: Array<{ id: string; name: string }>; onCreated: () => void }) {
  const [f, setF] = useState({ clientId: "", title: "", description: "", primaryLocation: "", experienceMinYears: "", experienceMaxYears: "", bankId: "" });
  const [busy, setBusy] = useState(false);

  // Question banks to optionally link — so live-assist loads this JD's bank.
  const { data: banksData } = useQuery<{ banks: Array<{ id: string; name: string }> }>({
    queryKey: ["question-banks", "all"],
    queryFn: () => apiFetch("/api/question-banks"),
    enabled: !disabled,
  });
  const banks = banksData?.banks ?? [];
  const [uploading, setUploading] = useState(false);

  async function uploadJd(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch<{ ok: boolean; text: string }>("/api/demands/parse-jd", { method: "POST", body: fd });
      setF((s) => ({ ...s, description: res.text }));
      toast.success("JD text extracted into the description");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read that JD file");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!f.clientId) { toast.error("Pick a client."); return; }
    if (f.title.trim().length < 2) { toast.error("Title is required."); return; }
    setBusy(true);
    try {
      const created = await apiFetch<{ demandId: string }>("/api/demands", {
        method: "POST",
        json: {
          clientId: f.clientId,
          title: f.title.trim(),
          description: f.description.trim() || undefined,
          primaryLocation: f.primaryLocation.trim() || undefined,
          experienceMinYears: f.experienceMinYears ? Number(f.experienceMinYears) : undefined,
          experienceMaxYears: f.experienceMaxYears ? Number(f.experienceMaxYears) : undefined,
          status: "active",
        },
      });
      // Link the chosen question bank to the new demand (best-effort).
      if (f.bankId && created.demandId) {
        try {
          await apiFetch(`/api/question-banks/${f.bankId}/link-demand`, {
            method: "POST",
            json: { demandId: created.demandId },
          });
        } catch {
          toast.message("Job created, but linking the question bank failed (needs question_banks.write).");
        }
      }
      toast.success(`Job "${f.title}" added`);
      setF({ clientId: "", title: "", description: "", primaryLocation: "", experienceMinYears: "", experienceMaxYears: "", bankId: "" });
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create job");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section icon={Briefcase} title="Add job (demand)" subtitle="The JD drives the interview questions. Becomes selectable on the setup screen.">
      {disabled ? (
        <p className="text-xs text-muted-foreground">
          Your account can't create jobs (needs the <code>demands.write</code> permission). Sign in as an account manager or admin (e.g. <code>admin@recruitassist.local</code>) to add jobs.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client *">
              <select
                value={f.clientId}
                onChange={(e) => setF((s) => ({ ...s, clientId: e.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Select a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Title *"><Input value={f.title} onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} placeholder="Senior Java Backend Engineer" /></Field>
            <Field label="Location"><Input value={f.primaryLocation} onChange={(e) => setF((s) => ({ ...s, primaryLocation: e.target.value }))} placeholder="Bengaluru" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min exp"><Input type="number" value={f.experienceMinYears} onChange={(e) => setF((s) => ({ ...s, experienceMinYears: e.target.value }))} placeholder="5" /></Field>
              <Field label="Max exp"><Input type="number" value={f.experienceMaxYears} onChange={(e) => setF((s) => ({ ...s, experienceMaxYears: e.target.value }))} placeholder="9" /></Field>
            </div>
          </div>
          <Field label="Job description (drives the questions)">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-muted-foreground">Paste below, or upload a JD file →</span>
              <label className="text-xs text-primary hover:underline inline-flex items-center gap-1 cursor-pointer">
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                Upload JD (PDF/DOCX/TXT)
                <input
                  type="file"
                  accept=".pdf,.docx,.doc,.txt,.md"
                  className="hidden"
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadJd(file); e.target.value = ""; }}
                />
              </label>
            </div>
            <textarea
              value={f.description}
              onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))}
              rows={5}
              placeholder="Must-have skills, responsibilities, tech stack…"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="Link a question bank (optional — loads for this JD in Live Assist)">
            <select
              value={f.bankId}
              onChange={(e) => setF((s) => ({ ...s, bankId: e.target.value }))}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">No bank</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          {clients.length === 0 && <p className="text-xs text-amber-600">No clients yet — add one in the "Add client" card above first.</p>}
          <Button onClick={submit} disabled={busy} size="sm">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Add job
          </Button>
        </div>
      )}
    </Section>
  );
}
