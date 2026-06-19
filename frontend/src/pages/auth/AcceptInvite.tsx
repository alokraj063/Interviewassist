import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthShell } from "@/auth/AuthShell";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { apiFetch, setAccessToken } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/auth/AuthContext";

interface Invitation {
  email: string;
  role: string;
  orgName: string;
}

const ROLE_LABEL: Record<string, string> = {
  agent: "Agent",
  team_lead: "Team Lead",
  manager: "Manager",
  qa_reviewer: "QA Reviewer",
  admin: "Admin",
};

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nav = useNavigate();
  const { refreshMe } = useAuth();

  useEffect(() => {
    if (!token) { setState("invalid"); return; }
    (async () => {
      try {
        const res = await apiFetch<{ invitation: Invitation }>(
          `/api/auth/invitations/${encodeURIComponent(token)}`,
          { auth: false },
        );
        setInvitation(res.invitation);
        setState("ready");
      } catch {
        setState("invalid");
      }
    })();
  }, [token]);

  async function accept(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ accessToken: string; user: unknown }>(
        "/api/auth/invitations/accept",
        { method: "POST", json: { token, password, name }, auth: false },
      );
      setAccessToken(res.accessToken);
      await refreshMe();
      nav("/", { replace: true });
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body;
      toast.error(
        body?.error === "invalid_or_expired_token" ? "This invitation has expired" : "Accept failed",
        { description: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return <AuthShell title="Checking invitation…"><p className="text-sm text-center text-muted-foreground">One moment.</p></AuthShell>;
  }
  if (state === "invalid" || !invitation) {
    return (
      <AuthShell title="Invitation expired">
        <p className="text-sm text-center text-muted-foreground">
          This invitation link is invalid or has expired. Ask your admin to send a new one.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${invitation.orgName}`} subtitle={`You're being added as ${ROLE_LABEL[invitation.role] ?? invitation.role}.`}>
      <form onSubmit={accept} className="space-y-3.5">
        <Input value={invitation.email} readOnly className="bg-muted/50" />
        <div>
          <label className="text-xs font-medium block mb-1.5">Full name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5">Set a password</label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <Button type="submit" className="w-full h-10" disabled={submitting}>
          {submitting ? "Joining…" : "Accept invitation"}
        </Button>
      </form>
    </AuthShell>
  );
}
