// Read-only tenant detail with the inline integrations editor. Members and
// counts are read-only — the only mutate surface is integration credentials
// (set / disable / delete). To touch tenant data the platform admin must be
// invited as a regular member of that tenant.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck, KeyRound, Eye, EyeOff, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type Provider = "vapi" | "deepgram" | "sarvam" | "shunya";

interface OrgDetail {
  org: { id: string; name: string; slug: string; createdAt: string };
  members: Array<{
    userId: string;
    email: string;
    name: string | null;
    role: string;
    status: "invited" | "active" | "suspended";
    joinedAt: string | null;
  }>;
  counts: { kbSources: number; voiceAgents: number };
}

interface IntegrationRow {
  provider: Provider;
  enabled: boolean;
  updatedAt: string;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  vapi: "Vapi",
  deepgram: "Deepgram",
  sarvam: "Sarvam",
  shunya: "Shunya",
};

export default function PlatformTenantDetail() {
  const { id } = useParams<{ id: string }>();
  const orgId = id!;
  const qc = useQueryClient();

  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ["platform", "orgs", orgId],
    queryFn: () => apiFetch<OrgDetail>(`/api/platform/orgs/${orgId}`),
  });

  const { data: integrations } = useQuery({
    queryKey: ["platform", "orgs", orgId, "integrations"],
    queryFn: () =>
      apiFetch<{ integrations: IntegrationRow[] }>(`/api/platform/orgs/${orgId}/integrations`),
  });
  const configured = new Map((integrations?.integrations ?? []).map((i) => [i.provider, i]));

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Link
        to="/platform/tenants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> All tenants
      </Link>

      {loadingDetail || !detail ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <div>
            <h2 className="text-xl font-semibold">{detail.org.name}</h2>
            <div className="text-xs text-muted-foreground">
              {detail.org.slug} · created {new Date(detail.org.createdAt).toLocaleDateString()}
            </div>
          </div>

          <Card className="p-5 space-y-3">
            <h3 className="font-medium flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" /> Integrations
            </h3>
            <p className="text-xs text-muted-foreground">
              Per-tenant credentials. When a provider isn't set here the deployment falls back
              to its env var. Stored encrypted at rest.
            </p>
            <div className="divide-y border rounded-md">
              {(["vapi", "deepgram", "sarvam", "shunya"] as Provider[]).map((p) => (
                <IntegrationRowView
                  key={p}
                  orgId={orgId}
                  provider={p}
                  current={configured.get(p)}
                />
              ))}
            </div>
          </Card>

          <Card className="p-5 space-y-3">
            <h3 className="font-medium">Members ({detail.members.length})</h3>
            {detail.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members yet.</p>
            ) : (
              <div className="divide-y">
                {detail.members.map((m) => (
                  <div key={m.userId} className="py-2 flex items-center justify-between text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{m.name ?? m.email}</div>
                      <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{m.role}</Badge>
                      <Badge variant={m.status === "active" ? "default" : "outline"}>
                        {m.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">Voice agents</div>
              <div className="text-2xl font-semibold">{detail.counts.voiceAgents}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground">KB sources</div>
              <div className="text-2xl font-semibold">{detail.counts.kbSources}</div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function IntegrationRowView({
  orgId,
  provider,
  current,
}: {
  orgId: string;
  provider: Provider;
  current: IntegrationRow | undefined;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["platform", "orgs", orgId, "integrations"] });

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch(`/api/platform/orgs/${orgId}/integrations/${provider}`, {
        method: "PATCH",
        json: { enabled },
      }),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/platform/orgs/${orgId}/integrations/${provider}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`${PROVIDER_LABEL[provider]} credentials cleared`);
      invalidate();
    },
  });

  return (
    <div className="px-3 py-2.5 flex items-center gap-3">
      <KeyRound className="w-4 h-4 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{PROVIDER_LABEL[provider]}</div>
        <div className="text-xs text-muted-foreground">
          {current
            ? `Configured · updated ${new Date(current.updatedAt).toLocaleDateString()}`
            : "Falls back to env var"}
        </div>
      </div>
      {current ? (
        <>
          <Switch
            checked={current.enabled}
            onCheckedChange={(v) => toggleMut.mutate(v)}
            aria-label="Enabled"
          />
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Rotate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm(`Remove ${PROVIDER_LABEL[provider]} credentials for this tenant?`)) {
                deleteMut.mutate();
              }
            }}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={() => setEditing(true)}>
          Configure
        </Button>
      )}
      <IntegrationEditDialog
        orgId={orgId}
        provider={provider}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}

function IntegrationEditDialog({
  orgId,
  provider,
  open,
  onClose,
}: {
  orgId: string;
  provider: Provider;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const [vapiApi, setVapiApi] = useState("");
  const [vapiPub, setVapiPub] = useState("");
  const [vapiHook, setVapiHook] = useState("");
  const [single, setSingle] = useState("");

  const reset = () => {
    setVapiApi("");
    setVapiPub("");
    setVapiHook("");
    setSingle("");
    setShow(false);
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { enabled: true };
      if (provider === "vapi") {
        body.vapi = {
          apiKey: vapiApi,
          publicKey: vapiPub || undefined,
          webhookSecret: vapiHook || undefined,
        };
      } else if (provider === "deepgram") {
        body.deepgram = { apiKey: single };
      } else if (provider === "sarvam") {
        body.sarvam = { apiSubscriptionKey: single };
      } else if (provider === "shunya") {
        body.shunya = { apiKey: single };
      }
      return apiFetch(`/api/platform/orgs/${orgId}/integrations/${provider}`, {
        method: "PUT",
        json: body,
      });
    },
    onSuccess: () => {
      toast.success(`${PROVIDER_LABEL[provider]} credentials saved`);
      qc.invalidateQueries({ queryKey: ["platform", "orgs", orgId, "integrations"] });
      reset();
      onClose();
    },
    onError: (err) => {
      toast.error("Save failed", {
        description: err instanceof Error ? err.message : "Unexpected error",
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{PROVIDER_LABEL[provider]} credentials</DialogTitle>
          <DialogDescription>
            Stored encrypted at rest. Plaintext is never returned to the UI — to rotate, just
            paste a new key here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {provider === "vapi" ? (
            <>
              <Field label="API key (private)" value={vapiApi} setValue={setVapiApi} show={show} setShow={setShow} />
              <Field label="Public key" value={vapiPub} setValue={setVapiPub} show={show} setShow={setShow} />
              <Field label="Webhook secret" value={vapiHook} setValue={setVapiHook} show={show} setShow={setShow} />
            </>
          ) : (
            <Field
              label={provider === "sarvam" ? "API subscription key" : "API key"}
              value={single}
              setValue={setSingle}
              show={show}
              setShow={setShow}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              saveMut.isPending ||
              (provider === "vapi" ? !vapiApi : !single)
            }
            onClick={() => saveMut.mutate()}
          >
            {saveMut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  setValue,
  show,
  setShow,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  show: boolean;
  setShow: (v: boolean) => void;
}) {
  return (
    <div>
      <label className="text-xs uppercase text-muted-foreground">{label}</label>
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="••••••••"
        />
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          onClick={() => setShow(!show)}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
