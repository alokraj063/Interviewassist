// Platform-admin tenant list. Lets the super-admin browse every workspace
// and provision new ones (which sends a normal /accept-invite email to the
// first admin). Read-only beyond that.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users, Bot, BookOpen, Building2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  kbSourceCount: number;
  voiceAgentCount: number;
}

export default function PlatformTenants() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["platform", "orgs"],
    queryFn: () => apiFetch<{ orgs: OrgRow[] }>("/api/platform/orgs"),
  });
  const orgs = data?.orgs ?? [];

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");

  const createMut = useMutation({
    mutationFn: (input: { name: string; adminEmail: string; adminName?: string }) =>
      apiFetch<{ org: OrgRow; invitation: { email: string; expiresAt: string } }>(
        "/api/platform/orgs",
        { method: "POST", json: input },
      ),
    onSuccess: (res) => {
      toast.success(`Created ${res.org.name}`, {
        description: `Invitation sent to ${res.invitation.email}.`,
      });
      qc.invalidateQueries({ queryKey: ["platform", "orgs"] });
      setOpen(false);
      setName("");
      setAdminEmail("");
      setAdminName("");
    },
    onError: (err) => {
      const body = (err as { body?: { error?: string } }).body;
      const msg =
        body?.error === "email_already_in_a_tenant"
          ? "That email is already a member of another tenant."
          : err instanceof Error
            ? err.message
            : "Unexpected error";
      toast.error("Could not create tenant", { description: msg });
    },
  });

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Tenants</h2>
          <p className="text-sm text-muted-foreground">
            Every workspace running on this deployment.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="w-4 h-4 mr-1.5" /> New tenant
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : orgs.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          No tenants yet. Create one to send the first admin an invite.
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.map((o) => (
            <Link key={o.id} to={`/platform/tenants/${o.id}`}>
              <Card className="p-4 hover:border-primary transition-colors cursor-pointer h-full">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded bg-primary/10 flex items-center justify-center text-primary">
                    <Building2 className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{o.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{o.slug}</div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <Stat icon={Users} label="Members" value={o.memberCount} />
                  <Stat icon={Bot} label="Agents" value={o.voiceAgentCount} />
                  <Stat icon={BookOpen} label="KB" value={o.kbSourceCount} />
                </div>
                <div className="mt-3 text-[11px] text-muted-foreground">
                  Created {new Date(o.createdAt).toLocaleDateString()}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create tenant</DialogTitle>
            <DialogDescription>
              Provisions a new workspace and emails the first admin an invite to set
              their password.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs uppercase text-muted-foreground">Workspace name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Support" />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground">Admin email</label>
              <Input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="founder@acme.com"
              />
            </div>
            <div>
              <label className="text-xs uppercase text-muted-foreground">Admin name (optional)</label>
              <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Ada Lovelace" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name || !adminEmail || createMut.isPending}
              onClick={() =>
                createMut.mutate({ name, adminEmail, adminName: adminName || undefined })
              }
            >
              {createMut.isPending ? "Creating…" : "Create + send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <Icon className="w-3.5 h-3.5" />
      <span className="font-medium text-foreground">{value}</span>
      <span>{label}</span>
    </div>
  );
}
