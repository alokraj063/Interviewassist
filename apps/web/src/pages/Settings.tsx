import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Card, Avatar } from "@/components/ui-kit";
import { TEAMS as MOCK_TEAMS, AGENTS } from "@/data/store";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Check, X, Plus, Search, Download, Copy, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth, useCan } from "@/auth/AuthContext";
import TranslationSettings from "@/pages/settings/TranslationSettings";
import TranscriptionSettings from "@/pages/settings/TranscriptionSettings";
import {
  useUsers,
  useInviteUser,
  useUpdateUser,
  useSuspendUser,
  useInvitations,
  useRevokeInvitation,
  useUpdateMe,
  useOrg,
  useUpdateOrg,
  useRolePermissions,
  useUpdateRolePermissions,
  useTeams,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  useAddTeamMember,
  useRemoveTeamMember,
  type OrgUser,
} from "@/hooks/useSettings";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "workspace", label: "Workspace" },
  { id: "team", label: "Team & Roles" },
  { id: "rubrics", label: "Rubrics" },
  { id: "question-banks", label: "Question Banks" },
  { id: "integrations", label: "Integrations" },
  { id: "telephony", label: "Voice & Telephony" },
  { id: "transcription", label: "Transcription (STT)" },
  { id: "translation", label: "Translation" },
  { id: "compliance", label: "Compliance & Data" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "billing", label: "Billing" },
  { id: "api", label: "API & Webhooks" },
  { id: "audit", label: "Audit Log" },
];

export default function Settings() {
  const { section } = useParams();
  const nav = useNavigate();
  const active = section || "profile";

  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid grid-cols-[220px_1fr] gap-0 border-t border-border h-[calc(100vh-130px)]">
        <aside className="border-r border-border bg-background p-3 overflow-y-auto">
          {SECTIONS.map(s => (
            <button key={s.id} onClick={() => nav(`/settings/${s.id}`)} className={cn("w-full text-left px-2.5 py-1.5 rounded text-sm font-medium mb-0.5", active === s.id ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>{s.label}</button>
          ))}
        </aside>
        <div className="overflow-y-auto p-6">
          <SettingsContent section={active} />
        </div>
      </div>
    </div>
  );
}

function SettingsContent({ section }: { section: string }) {
  if (section === "profile") return <ProfileSection />;
  if (section === "workspace") return <WorkspaceSection />;
  if (section === "team") return <TeamSection />;
  if (section === "integrations") return <IntegrationsSection />;
  if (section === "telephony") return <TelephonySection />;
  if (section === "transcription") return <TranscriptionSettings />;
  if (section === "translation") return <TranslationSettings />;
  if (section === "compliance") return <ComplianceSection />;
  if (section === "security") return <SecuritySection />;
  if (section === "notifications") return <NotificationsSection />;
  if (section === "billing") return <BillingSection />;
  if (section === "api") return <ApiSection />;
  if (section === "audit") return <AuditSection />;
  if (section === "rubrics") return (
    <Card title="Rubrics">
      <div className="p-5 text-sm">
        Rubrics are managed in the dedicated workspace at <a className="text-primary hover:underline" href="/rubrics">/rubrics</a>.
        <div className="mt-2 text-xs text-muted-foreground">
          Each rubric drives live scoring during recruiter calls and post-call QA. Default rubrics:
          General Recruiter Screen, Technical Screen, Senior Hiring.
        </div>
      </div>
    </Card>
  );
  if (section === "question-banks") return (
    <Card title="Question Banks">
      <div className="p-5 text-sm">
        Question banks are managed in the dedicated workspace at <a className="text-primary hover:underline" href="/question-banks">/question-banks</a>.
        <div className="mt-2 text-xs text-muted-foreground">
          Curated technical questions tagged by skill / level / difficulty. Used by Live Assist suggestions
          (one-click "Ask this") and post-call technical Q&amp;A evaluation.
        </div>
      </div>
    </Card>
  );
  return <Card title="Settings"><div className="p-5 text-sm text-muted-foreground">Section not found.</div></Card>;
}

function ProfileSection() {
  const { user, refreshMe } = useAuth();
  const updateMe = useUpdateMe();
  const [name, setName] = useState(user?.name ?? "");
  const [jobTitle, setJobTitle] = useState("");
  const [timezone, setTimezone] = useState("");
  const [locale, setLocale] = useState("");

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  async function save() {
    try {
      await updateMe.mutateAsync({
        name: name || undefined,
        jobTitle: jobTitle || undefined,
        timezone: timezone || undefined,
        locale: locale || undefined,
      });
      await refreshMe();
      toast.success("Profile saved");
    } catch (err) {
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  const initials = (name || user?.email || "?")
    .split(/[@.\s]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <Card title="Profile">
      <div className="p-5 space-y-4 max-w-2xl">
        <div className="flex items-center gap-4">
          <Avatar initials={initials} size={56} />
          <div className="text-sm text-muted-foreground">Avatar uploads coming soon.</div>
        </div>
        <Field label="Full name" value={name} onChange={setName} />
        <Field label="Email" value={user?.email ?? ""} readOnly />
        <Field label="Job title" value={jobTitle} onChange={setJobTitle} placeholder="e.g. Senior Support Agent" />
        <Field label="Timezone" value={timezone} onChange={setTimezone} placeholder="e.g. Asia/Kolkata" />
        <Field label="Locale" value={locale} onChange={setLocale} placeholder="e.g. en-IN" />
        <div>
          <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">Multi-factor authentication</div>
          <div className="border border-border rounded p-3 flex items-center gap-3">
            <Shield className="w-5 h-5 text-muted-foreground" />
            <div className="flex-1">
              <div className="text-sm font-medium">Authenticator app</div>
              <div className="text-xs text-muted-foreground">{user?.mfaEnrolledAt ? "Enrolled" : "Not enrolled"} · coming soon</div>
            </div>
          </div>
        </div>
        <Button onClick={save} disabled={updateMe.isPending}>
          {updateMe.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Card>
  );
}

function WorkspaceSection() {
  const { data: org, isLoading } = useOrg();
  const update = useUpdateOrg();
  const canEdit = useCan("workspace.write");
  const [state, setState] = useState({
    name: "",
    subdomain: "",
    defaultLocale: "",
    defaultTimezone: "",
    fiscalYearStart: "",
  });

  useEffect(() => {
    if (!org) return;
    setState({
      name: org.name ?? "",
      subdomain: org.subdomain ?? "",
      defaultLocale: org.defaultLocale ?? "",
      defaultTimezone: org.defaultTimezone ?? "",
      fiscalYearStart: org.fiscalYearStart ?? "",
    });
  }, [org]);

  async function save() {
    try {
      await update.mutateAsync(state);
      toast.success("Workspace saved");
    } catch (err) {
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  if (isLoading || !org) return <Card title="Workspace"><div className="p-5 text-sm text-muted-foreground">Loading…</div></Card>;

  return (
    <Card title="Workspace">
      <div className="p-5 space-y-4 max-w-2xl">
        <Field label="Workspace name" value={state.name} onChange={(v) => setState((s) => ({ ...s, name: v }))} readOnly={!canEdit} />
        <Field label="Subdomain" value={state.subdomain} onChange={(v) => setState((s) => ({ ...s, subdomain: v }))} readOnly={!canEdit} />
        <Field label="Default locale" value={state.defaultLocale} onChange={(v) => setState((s) => ({ ...s, defaultLocale: v }))} placeholder="en-IN" readOnly={!canEdit} />
        <Field label="Default timezone" value={state.defaultTimezone} onChange={(v) => setState((s) => ({ ...s, defaultTimezone: v }))} placeholder="Asia/Kolkata" readOnly={!canEdit} />
        <Field label="Fiscal year start" value={state.fiscalYearStart} onChange={(v) => setState((s) => ({ ...s, fiscalYearStart: v }))} placeholder="April 1" readOnly={!canEdit} />
        {canEdit && (
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </div>
    </Card>
  );
}

const ROLE_LABELS: Record<OrgUser["role"], string> = {
  agent: "Agent",
  team_lead: "Team Lead",
  manager: "Manager",
  qa_reviewer: "QA Reviewer",
  admin: "Admin",
};

function TeamSection() {
  const [tab, setTab] = useState<"users" | "roles" | "teams">("users");
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {(["users", "roles", "teams"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px capitalize",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersPanel />}
      {tab === "roles" && <RolesPanel />}
      {tab === "teams" && <TeamsPanel />}
    </div>
  );
}

function UsersPanel() {
  const { data: users = [], isLoading } = useUsers();
  const { data: invitations = [] } = useInvitations();
  const invite = useInviteUser();
  const updateUser = useUpdateUser();
  const suspend = useSuspendUser();
  const revoke = useRevokeInvitation();
  const canInvite = useCan("users.invite");
  const canWrite = useCan("users.write");
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.email, u.name ?? "", u.role, ...u.teams.map((t) => t.name)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [users, query]);

  return (
    <div className="space-y-4">
      <Card
        title={`Users (${users.length})`}
        action={
          canInvite ? (
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="w-3.5 h-3.5 mr-1" />Invite user
            </Button>
          ) : null
        }
      >
        <div className="px-4 py-2 border-b border-border">
          <div className="relative max-w-md">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search users…"
              className="h-8 pl-8 text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Teams</th><th>Last active</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-4 text-sm text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="p-4 text-sm text-muted-foreground">No users match.</td></tr>
            ) : (
              filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar
                        initials={(u.name ?? u.email).split(/[@\s.]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("")}
                        size={22}
                      />
                      <span className="text-sm">{u.name ?? "—"}</span>
                    </div>
                  </td>
                  <td className="text-xs">{u.email}</td>
                  <td className="text-xs">
                    {canWrite ? (
                      <select
                        className="h-7 border border-border rounded px-1.5 text-xs bg-background"
                        value={u.role}
                        onChange={(e) =>
                          updateUser.mutate(
                            { id: u.id, role: e.target.value as OrgUser["role"] },
                            {
                              onSuccess: () => toast.success("Role updated"),
                              onError: (err) => toast.error("Update failed", { description: String(err) }),
                            },
                          )
                        }
                      >
                        {Object.entries(ROLE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[u.role]
                    )}
                  </td>
                  <td className="text-xs">{u.teams.map((t) => t.name).join(", ") || "—"}</td>
                  <td className="text-xs text-muted-foreground">
                    {u.lastActiveAt ? new Date(u.lastActiveAt).toLocaleString() : "—"}
                  </td>
                  <td>
                    <span className={cn(
                      "pill capitalize",
                      u.status === "active" ? "bg-success/15 text-success" :
                      u.status === "invited" ? "bg-info/15 text-info" :
                      "bg-muted text-muted-foreground",
                    )}>{u.status}</span>
                  </td>
                  <td className="text-right">
                    {canWrite && u.status !== "suspended" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-destructive"
                        onClick={() => {
                          if (!confirm(`Suspend ${u.email}?`)) return;
                          suspend.mutate(u.id, {
                            onSuccess: () => toast.success("User suspended"),
                            onError: (err) => toast.error("Suspend failed", { description: String(err) }),
                          });
                        }}
                      >
                        Suspend
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      {invitations.length > 0 && (
        <Card title={`Pending invitations (${invitations.length})`}>
          <table className="data-table">
            <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Sent</th><th></th></tr></thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td className="text-sm">{inv.email}</td>
                  <td className="text-xs">{ROLE_LABELS[inv.role]}</td>
                  <td className="text-xs text-muted-foreground">{new Date(inv.expiresAt).toLocaleString()}</td>
                  <td className="text-xs text-muted-foreground">{new Date(inv.createdAt).toLocaleString()}</td>
                  <td className="text-right">
                    {canInvite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7"
                        onClick={() => revoke.mutate(inv.id, {
                          onSuccess: () => toast.success("Invitation revoked"),
                          onError: (err) => toast.error("Revoke failed", { description: String(err) }),
                        })}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSubmit={async ({ email, role }) => {
          try {
            await invite.mutateAsync({ email, role });
            toast.success("Invitation sent");
            setInviteOpen(false);
          } catch (err) {
            const body = (err as { body?: { error?: string } }).body;
            toast.error(
              body?.error === "already_member"
                ? "That email is already an active member"
                : "Invite failed",
              { description: err instanceof Error ? err.message : String(err) },
            );
          }
        }}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { email: string; role: OrgUser["role"] }) => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgUser["role"]>("agent");

  useEffect(() => {
    if (!open) { setEmail(""); setRole("agent"); }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Invite user</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Email address" value={email} onChange={setEmail} placeholder="teammate@company.com" />
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Role</label>
            <select
              className="h-9 w-full border border-border rounded px-2 text-sm bg-background"
              value={role}
              onChange={(e) => setRole(e.target.value as OrgUser["role"])}
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => email && onSubmit({ email, role })} disabled={!email}>Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PERMISSION_GROUPS: { title: string; prefix: string }[] = [
  { title: "Conversations", prefix: "conversations." },
  { title: "QA Review", prefix: "qa." },
  { title: "Coaching", prefix: "coaching." },
  { title: "Scorecards", prefix: "scorecards." },
  { title: "Voice Agents", prefix: "voice_agents." },
  { title: "Knowledge", prefix: "knowledge." },
  { title: "Live Assist", prefix: "live_assist." },
  { title: "Analytics", prefix: "analytics." },
  { title: "Calls", prefix: "calls." },
  { title: "Users", prefix: "users." },
  { title: "Teams", prefix: "teams." },
  { title: "Roles", prefix: "roles." },
  { title: "Workspace", prefix: "workspace." },
  { title: "Security", prefix: "security." },
  { title: "Billing", prefix: "billing." },
  { title: "Integrations", prefix: "integrations." },
  { title: "API Keys", prefix: "api_keys." },
  { title: "Audit", prefix: "audit." },
  { title: "Notifications", prefix: "notifications." },
];

function RolesPanel() {
  const { data, isLoading } = useRolePermissions();
  const update = useUpdateRolePermissions();
  const canWrite = useCan("roles.write");
  const [draft, setDraft] = useState<Record<string, Set<string>> | null>(null);

  useEffect(() => {
    if (!data) return;
    const next: Record<string, Set<string>> = {};
    for (const role of data.roles) next[role] = new Set(data.matrix[role] ?? []);
    setDraft(next);
  }, [data]);

  if (isLoading || !data || !draft) {
    return <Card title="Roles & permissions"><div className="p-5 text-sm text-muted-foreground">Loading…</div></Card>;
  }

  const dirty = data.roles.some((role) => {
    const a = new Set(data.matrix[role] ?? []);
    const b = draft[role] ?? new Set<string>();
    if (a.size !== b.size) return true;
    for (const p of a) if (!b.has(p)) return true;
    return false;
  });

  function toggle(role: string, perm: string) {
    if (!canWrite) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [role]: new Set(prev[role]) };
      if (next[role].has(perm)) next[role].delete(perm);
      else next[role].add(perm);
      return next;
    });
  }

  async function save() {
    try {
      const matrix: Record<string, string[]> = {};
      for (const role of data.roles) matrix[role] = Array.from(draft[role] ?? []);
      await update.mutateAsync(matrix);
      toast.success("Permissions saved");
    } catch (err) {
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  const knownPermissions = new Set(data.permissions);

  return (
    <Card
      title="Roles & permissions"
      action={canWrite && dirty ? (
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
      ) : null}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase text-muted-foreground">Permission</th>
              {data.roles.map((r) => (
                <th key={r} className="px-2 py-2.5 text-center text-xs font-semibold capitalize">{ROLE_LABELS[r as OrgUser["role"]] ?? r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((g) => {
              const perms = data.permissions.filter((p) => p.startsWith(g.prefix));
              if (perms.length === 0) return null;
              return (
                <>
                  <tr key={g.title} className="bg-muted/20 border-b border-border">
                    <td colSpan={data.roles.length + 1} className="px-4 py-1.5 text-[11px] uppercase font-semibold text-muted-foreground tracking-wide">
                      {g.title}
                    </td>
                  </tr>
                  {perms.map((p) => (
                    <tr key={p} className="border-b border-border/50">
                      <td className="px-4 py-2 text-sm font-mono text-xs">{p.slice(g.prefix.length)}</td>
                      {data.roles.map((role) => {
                        const has = draft[role].has(p);
                        return (
                          <td key={role} className="text-center py-2">
                            <button
                              type="button"
                              disabled={!canWrite || !knownPermissions.has(p)}
                              onClick={() => toggle(role, p)}
                              className={cn(
                                "inline-flex items-center justify-center w-6 h-6 rounded",
                                canWrite ? "hover:bg-muted cursor-pointer" : "cursor-default",
                              )}
                              aria-label={`${role} ${has ? "has" : "does not have"} ${p}`}
                            >
                              {has ? <Check className="w-4 h-4 text-success" /> : <X className="w-3.5 h-3.5 text-muted-foreground/30" />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function TeamsPanel() {
  const { data: teams = [], isLoading } = useTeams();
  const { data: users = [] } = useUsers();
  const create = useCreateTeam();
  const updateTeam = useUpdateTeam();
  const del = useDeleteTeam();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();
  const canWrite = useCan("teams.write");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await create.mutateAsync({ name: newName.trim() });
      setNewName("");
      setCreateOpen(false);
      toast.success("Team created");
    } catch (err) {
      toast.error("Create failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <>
      <Card
        title={`Teams (${teams.length})`}
        action={canWrite ? <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" />Create team</Button> : null}
      >
        {isLoading ? (
          <div className="p-5 text-sm text-muted-foreground">Loading…</div>
        ) : teams.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">No teams yet. Create one to organize your agents.</div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Team</th><th>Manager</th><th>Members</th><th className="text-right">Actions</th></tr></thead>
            <tbody>
              {teams.map((t) => {
                const manager = users.find((u) => u.id === t.managerUserId);
                return (
                  <tr key={t.id}>
                    <td className="text-sm font-medium">{t.name}</td>
                    <td className="text-sm">{manager?.name ?? manager?.email ?? "—"}</td>
                    <td className="text-xs">
                      <div className="flex items-center gap-2">
                        <div className="flex -space-x-1.5">
                          {t.members.slice(0, 5).map((m) => (
                            <Avatar
                              key={m.id}
                              initials={(m.name ?? m.email).split(/[@\s.]/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("")}
                              size={22}
                              className="ring-2 ring-card"
                            />
                          ))}
                          {t.members.length > 5 && (
                            <span className="w-[22px] h-[22px] inline-flex items-center justify-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-card">
                              +{t.members.length - 5}
                            </span>
                          )}
                          {t.members.length === 0 && <span className="text-muted-foreground">—</span>}
                        </div>
                        {canWrite && (
                          <select
                            className="h-7 border border-border rounded px-1.5 text-xs bg-background"
                            value=""
                            onChange={(e) => {
                              const uid = e.target.value;
                              if (!uid) return;
                              addMember.mutate({ teamId: t.id, userId: uid }, {
                                onSuccess: () => toast.success("Member added"),
                                onError: (err) => toast.error("Add failed", { description: String(err) }),
                              });
                              e.currentTarget.value = "";
                            }}
                          >
                            <option value="">Add member…</option>
                            {users
                              .filter((u) => u.status === "active" && !t.members.some((m) => m.id === u.id))
                              .map((u) => (
                                <option key={u.id} value={u.id}>{u.name ?? u.email}</option>
                              ))}
                          </select>
                        )}
                      </div>
                    </td>
                    <td className="text-right space-x-1">
                      {canWrite && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={() => {
                              const name = prompt("Team name", t.name);
                              if (!name || name === t.name) return;
                              updateTeam.mutate({ id: t.id, name }, {
                                onSuccess: () => toast.success("Team updated"),
                                onError: (err) => toast.error("Update failed", { description: String(err) }),
                              });
                            }}
                          >
                            Rename
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-destructive"
                            onClick={() => {
                              if (!confirm(`Delete team "${t.name}"?`)) return;
                              del.mutate(t.id, {
                                onSuccess: () => toast.success("Team deleted"),
                                onError: (err) => toast.error("Delete failed", { description: String(err) }),
                              });
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create team</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Team name" value={newName} onChange={setNewName} placeholder="e.g. Premier Support" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Keep the mock reference importable but unused — we'll wire the agent/analytics
// view later. Lint-safe: use both so it doesn't complain.
void AGENTS; void MOCK_TEAMS;

interface IntegrationItem {
  key: string;
  name: string;
  desc: string;
  pathOnConnect?: string;
  status?: { ok: boolean; reason?: string };
}

function IntegrationsSection() {
  const nav = useNavigate();
  const [items, setItems] = useState<IntegrationItem[]>([
    { key: "naukri", name: "Naukri", desc: "Source candidates from Naukri search" },
    { key: "linkedin", name: "LinkedIn Recruiter", desc: "InMail + search integration" },
    { key: "whatsapp", name: "WhatsApp Business API", desc: "Outbound candidate messaging" },
    { key: "exotel", name: "Exotel", desc: "Telephony bridge for two-leg recorded calls" },
    { key: "greenhouse", name: "Greenhouse", desc: "Push hires to client ATS" },
    { key: "workday", name: "Workday", desc: "Push hires to client HRIS" },
    { key: "mock", name: "Mock pool", desc: "Deterministic fake candidates for demos" },
  ]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      items.map(async (it) => {
        try {
          const h = await apiFetch<{ ok: boolean; reason?: string }>(
            `/api/sourcing/health/${it.key}`,
          );
          return { key: it.key, status: { ok: h.ok, reason: h.reason } };
        } catch {
          return { key: it.key, status: { ok: false, reason: "unreachable" } };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setItems((prev) =>
        prev.map((it) => {
          const r = results.find((x) => x.key === it.key);
          return r ? { ...it, status: r.status } : it;
        }),
      );
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = (it: IntegrationItem) => {
    if (it.pathOnConnect) {
      nav(it.pathOnConnect);
      return;
    }
    if (it.key === "naukri" || it.key === "linkedin" || it.key === "mock") {
      nav(`/sourcing/${it.key}`);
      return;
    }
    toast.info(
      `${it.name} credentials are configured at the platform level — admin: paste the API key in tenant_integrations and reload.`,
    );
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((it) => {
        const ok = it.status?.ok === true;
        return (
          <div key={it.key} className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-sm font-semibold">{it.name}</div>
              <span
                className={
                  ok
                    ? "pill bg-success/15 text-success"
                    : loading
                    ? "pill bg-muted text-muted-foreground"
                    : "pill bg-warning/15 text-warning"
                }
              >
                {loading ? "Checking…" : ok ? "OK" : "Mock"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mb-3">{it.desc}</div>
            <Button size="sm" variant="outline" className="w-full" onClick={() => onConnect(it)}>
              {ok ? "Open" : "Configure"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function TelephonySection() {
  return (
    <div className="space-y-4">
      <Card title="Owned phone numbers">
        <table className="data-table">
          <thead><tr><th>Number</th><th>Type</th><th>Region</th><th>Assigned to</th><th>Status</th></tr></thead>
          <tbody>
            {[
              { n: "+1 (415) 555-0142", t: "Local", r: "US-CA", a: "Billing Assistant (Voice Agent)", s: "Active" },
              { n: "+1 (415) 555-0188", t: "Local", r: "US-CA", a: "Order Status Bot", s: "Active" },
              { n: "+1 (415) 555-0156", t: "Local", r: "US-CA", a: "Appointment Scheduler", s: "Active" },
              { n: "+1 (415) 555-0173", t: "Local", r: "US-CA", a: "Password Reset Agent", s: "Active" },
              { n: "+1 (800) 555-0199", t: "Toll-free", r: "US", a: "Premier hotline (humans)", s: "Active" },
              { n: "+44 20 4525 0145", t: "Local", r: "UK-LON", a: "EU billing queue", s: "Active" },
            ].map(p => (
              <tr key={p.n}><td className="font-mono text-xs">{p.n}</td><td className="text-xs">{p.t}</td><td className="text-xs">{p.r}</td><td className="text-sm">{p.a}</td><td><span className="pill bg-success/15 text-success">{p.s}</span></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Carrier & SIP">
        <div className="p-5 grid grid-cols-2 gap-4 max-w-3xl">
          <Field label="Primary carrier" defaultValue="Twilio Programmable Voice" />
          <Field label="Failover carrier" defaultValue="Amazon Connect (US-East)" />
          <Field label="SIP region" defaultValue="us-east-1, eu-west-1" />
          <Field label="Codec preference" defaultValue="OPUS, G.711" />
        </div>
      </Card>
    </div>
  );
}

function ComplianceSection() {
  return (
    <div className="space-y-4">
      <Card title="Certifications & compliance status">
        <div className="p-5 grid grid-cols-2 gap-3">
          {[
            { name: "SOC 2 Type II", status: "Active", expires: "2025-08-14" },
            { name: "HIPAA", status: "Active", expires: "Continuous" },
            { name: "GDPR (EU)", status: "Active", expires: "Continuous" },
            { name: "DPDP (India)", status: "Active", expires: "Continuous" },
            { name: "PCI-DSS L1", status: "Active", expires: "2025-03-22" },
            { name: "ISO 27001", status: "In progress", expires: "Audit Q1 2025" },
          ].map(c => (
            <div key={c.name} className={cn("border rounded p-3", c.status === "Active" ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5")}>
              <div className="text-sm font-semibold">{c.name}</div>
              <div className={cn("text-xs", c.status === "Active" ? "text-success" : "text-warning")}>{c.status} · {c.expires}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Data retention">
        <div className="p-5 space-y-3 max-w-2xl">
          <Field label="Call recordings" defaultValue="180 days, then archive to cold storage" />
          <Field label="Transcripts" defaultValue="730 days" />
          <Field label="Analytics aggregates" defaultValue="Indefinite (anonymized after 730 days)" />
          <Field label="Deleted-user PII" defaultValue="30 days, then purge" />
        </div>
      </Card>
      <Card title="Data residency">
        <div className="p-5 grid grid-cols-3 gap-3">
          {[{ r: "US (Virginia)", live: true }, { r: "EU (Frankfurt)", live: true }, { r: "APAC (Sydney)", live: false }].map(d => (
            <div key={d.r} className="border border-border rounded p-3"><div className="text-sm font-medium">{d.r}</div><div className={cn("text-xs", d.live ? "text-success" : "text-muted-foreground")}>{d.live ? "Live" : "Available on Enterprise"}</div></div>
          ))}
        </div>
      </Card>
      <Card title="Consent templates">
        <table className="data-table">
          <thead><tr><th>Region</th><th>Template</th><th className="text-right">Last updated</th></tr></thead>
          <tbody>{[["US", "Standard recording disclosure"], ["EU", "GDPR processing notice"], ["UK", "UK-GDPR notice"], ["IN", "DPDP consent script"]].map(([r, t]) => (
            <tr key={r}><td className="text-sm">{r}</td><td className="text-sm">{t}</td><td className="text-right text-xs text-muted-foreground">2024-11-04</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </div>
  );
}

function SecuritySection() {
  return (
    <div className="space-y-4">
      <Card title="Authentication">
        <div className="p-5 space-y-3 max-w-2xl text-sm">
          <div className="flex items-center justify-between border border-border rounded p-3">
            <div><div className="font-medium">Enforce MFA for all users</div><div className="text-xs text-muted-foreground">Authenticator app or hardware key</div></div>
            <input type="checkbox" defaultChecked className="accent-primary" />
          </div>
          <div className="flex items-center justify-between border border-border rounded p-3">
            <div><div className="font-medium">SSO (SAML)</div><div className="text-xs text-muted-foreground">Configured · Okta · last sync 2h ago</div></div>
            <Button variant="outline" size="sm">Manage</Button>
          </div>
          <div className="flex items-center justify-between border border-border rounded p-3">
            <div><div className="font-medium">SCIM provisioning</div><div className="text-xs text-muted-foreground">Active · 142 users synced</div></div>
            <Button variant="outline" size="sm">Configure</Button>
          </div>
        </div>
      </Card>
      <Card title="Session & access">
        <div className="p-5 space-y-3 max-w-2xl">
          <Field label="Session timeout (minutes)" defaultValue="60" />
          <Field label="IP allowlist (CIDR)" defaultValue="0.0.0.0/0" />
          <Field label="Allowed email domains" defaultValue="northwind.com, j2w.app" />
        </div>
      </Card>
    </div>
  );
}

function NotificationsSection() {
  const events = [
    "Coaching overdue", "Coaching assigned to you", "Voice agent performance drop",
    "Compliance disclosure missed", "QA queue threshold (>50 items)", "Weekly executive summary",
    "Daily quality digest", "User invited to workspace", "Scorecard published",
  ];
  return (
    <Card title="Notification rules">
      <table className="data-table">
        <thead><tr><th>Event</th><th className="text-center">In-app</th><th className="text-center">Email</th><th className="text-center">SMS</th></tr></thead>
        <tbody>{events.map(e => (
          <tr key={e}><td className="text-sm">{e}</td>
            <td className="text-center"><input type="checkbox" defaultChecked className="accent-primary" /></td>
            <td className="text-center"><input type="checkbox" defaultChecked={!e.includes("Daily")} className="accent-primary" /></td>
            <td className="text-center"><input type="checkbox" defaultChecked={e.includes("overdue") || e.includes("missed")} className="accent-primary" /></td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

function BillingSection() {
  return (
    <div className="space-y-4">
      <Card title="Current plan">
        <div className="p-5 grid grid-cols-3 gap-4">
          <div><div className="text-xs uppercase text-muted-foreground">Plan</div><div className="text-lg font-semibold">Enterprise</div><div className="text-xs text-muted-foreground">Renews Jan 1, 2025</div></div>
          <div><div className="text-xs uppercase text-muted-foreground">Calls scored / month</div><div className="text-lg font-semibold tabular-nums">38,402 <span className="text-xs text-muted-foreground">/ 100,000</span></div><div className="h-1.5 bg-muted rounded-full mt-1.5"><div className="h-full bg-primary rounded-full" style={{ width: "38%" }} /></div></div>
          <div><div className="text-xs uppercase text-muted-foreground">Voice agent minutes</div><div className="text-lg font-semibold tabular-nums">12,840 <span className="text-xs text-muted-foreground">/ 25,000</span></div><div className="h-1.5 bg-muted rounded-full mt-1.5"><div className="h-full bg-primary rounded-full" style={{ width: "51%" }} /></div></div>
        </div>
      </Card>
      <Card title="Invoices" action={<Button variant="outline" size="sm"><Download className="w-3.5 h-3.5 mr-1" />Download all</Button>}>
        <table className="data-table">
          <thead><tr><th>Date</th><th>Invoice</th><th>Period</th><th>Amount</th><th className="text-right">Status</th></tr></thead>
          <tbody>{[
            ["2024-12-01", "INV-2024-12", "Dec 2024", "$4,200.00", "Paid"],
            ["2024-11-01", "INV-2024-11", "Nov 2024", "$4,200.00", "Paid"],
            ["2024-10-01", "INV-2024-10", "Oct 2024", "$3,950.00", "Paid"],
            ["2024-09-01", "INV-2024-09", "Sep 2024", "$3,950.00", "Paid"],
          ].map(([d, n, p, a, s]) => (
            <tr key={n}><td className="text-xs">{d}</td><td className="font-mono text-xs">{n}</td><td className="text-sm">{p}</td><td className="tabular-nums text-sm">{a}</td><td className="text-right"><span className="pill bg-success/15 text-success">{s}</span></td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Payment method">
        <div className="p-5 flex items-center gap-4">
          <div className="w-12 h-8 bg-gradient-to-br from-slate-700 to-slate-900 rounded text-white text-[10px] font-bold flex items-center justify-center">VISA</div>
          <div className="flex-1"><div className="text-sm font-medium">Visa ending in 4242</div><div className="text-xs text-muted-foreground">Expires 08/27 · Billing contact: alex.morgan@northwind.com</div></div>
          <Button variant="outline" size="sm">Update</Button>
        </div>
      </Card>
    </div>
  );
}

function ApiSection() {
  return (
    <div className="space-y-4">
      <Card title="API keys" action={<Button size="sm"><Plus className="w-3.5 h-3.5 mr-1" />Create key</Button>}>
        <table className="data-table">
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th className="text-right">Actions</th></tr></thead>
          <tbody>{[
            { name: "Production", key: "sk_live_••••••••••••aE8x", c: "2024-08-12", u: "2 min ago" },
            { name: "Analytics ETL", key: "sk_live_••••••••••••72mQ", c: "2024-09-30", u: "3h ago" },
            { name: "Staging", key: "sk_test_••••••••••••91xR", c: "2024-11-04", u: "yesterday" },
          ].map(k => (
            <tr key={k.name}><td className="font-medium text-sm">{k.name}</td><td className="font-mono text-xs">{k.key} <button onClick={() => toast("Copied")} className="ml-1 text-muted-foreground hover:text-foreground"><Copy className="w-3 h-3 inline" /></button></td><td className="text-xs text-muted-foreground">{k.c}</td><td className="text-xs text-muted-foreground">{k.u}</td><td className="text-right"><Button variant="ghost" size="sm" className="h-7 text-destructive">Revoke</Button></td></tr>
          ))}</tbody>
        </table>
      </Card>
      <Card title="Webhooks" action={<Button size="sm" variant="outline"><Plus className="w-3.5 h-3.5 mr-1" />Add endpoint</Button>}>
        <table className="data-table">
          <thead><tr><th>URL</th><th>Events</th><th>Status</th><th className="text-right">Last delivery</th></tr></thead>
          <tbody>
            <tr><td className="font-mono text-xs">https://hooks.northwind.com/j2w/scoring</td><td className="text-xs">conversation.scored, qa.overridden</td><td><span className="pill bg-success/15 text-success">Healthy</span></td><td className="text-right text-xs text-muted-foreground">2 min ago · 200</td></tr>
            <tr><td className="font-mono text-xs">https://etl.northwind.com/coaching</td><td className="text-xs">coaching.* </td><td><span className="pill bg-success/15 text-success">Healthy</span></td><td className="text-right text-xs text-muted-foreground">14 min ago · 200</td></tr>
            <tr><td className="font-mono text-xs">https://slack-bridge.northwind.com</td><td className="text-xs">voice_agent.handoff</td><td><span className="pill bg-warning/15 text-warning">3 retries</span></td><td className="text-right text-xs text-muted-foreground">1h ago · 504</td></tr>
          </tbody>
        </table>
      </Card>
      <Card title="API usage (30d)">
        <div className="p-5 grid grid-cols-3 gap-4 text-sm">
          <div><div className="text-xs uppercase text-muted-foreground">Requests</div><div className="text-lg font-semibold tabular-nums">1.42M</div></div>
          <div><div className="text-xs uppercase text-muted-foreground">Avg latency</div><div className="text-lg font-semibold tabular-nums">142ms</div></div>
          <div><div className="text-xs uppercase text-muted-foreground">Error rate</div><div className="text-lg font-semibold tabular-nums">0.04%</div></div>
        </div>
      </Card>
    </div>
  );
}

function AuditSection() {
  const rows = Array.from({ length: 28 }).map((_, i) => ({
    ts: new Date(Date.now() - i * 47 * 60000).toLocaleString(),
    actor: ["Alex Morgan", "Sam Rivera", "Jordan Park", "Morgan Lee", "System"][i % 5],
    action: ["scorecard.update", "user.invite", "voice_agent.deploy", "kb.reindex", "coaching.assign", "user.role_change", "qa.override", "api_key.create"][i % 8],
    target: ["sc-billing", "u-110", "va-1", "kb-2", "CA-1004", "u-103", "CV-10231", "sk_live_…aE8x"][i % 8],
    ip: `10.${i % 12}.${(i * 7) % 256}.${(i * 13) % 256}`,
  }));
  return (
    <Card title="Audit log" action={<Button variant="outline" size="sm"><Download className="w-3.5 h-3.5 mr-1" />Export CSV</Button>}>
      <div className="px-4 py-2 border-b border-border flex gap-2"><div className="relative flex-1 max-w-md"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search actor, action, target…" className="h-8 pl-8 text-sm" /></div></div>
      <table className="data-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th className="text-right">IP</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td className="text-xs whitespace-nowrap">{r.ts}</td><td className="text-sm">{r.actor}</td><td className="font-mono text-xs">{r.action}</td><td className="font-mono text-xs text-muted-foreground">{r.target}</td><td className="text-right font-mono text-xs text-muted-foreground">{r.ip}</td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

function Field({
  label,
  defaultValue,
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  label: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const controlled = value !== undefined && onChange !== undefined;
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 items-center">
      <label className="text-xs text-muted-foreground">{label}</label>
      {controlled ? (
        <Input
          value={value}
          onChange={(e) => onChange!(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          className="h-8"
        />
      ) : (
        <Input defaultValue={defaultValue} placeholder={placeholder} readOnly={readOnly} className="h-8" />
      )}
    </div>
  );
}
