import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Loader2, ShieldCheck, Pencil, RefreshCw, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { useProctorPolicies, errMessage, type Policy } from "@/hooks/useProctor";
import { PolicyForm } from "@/components/proctor/PolicyForm";

export default function ProctorSettings() {
  const navigate = useNavigate();
  const canPolicy = useCan("proctoring.policy.write");
  const { data, isLoading, isError, error, refetch } = useProctorPolicies();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [creating, setCreating] = useState(false);

  if (!useCan("proctoring.read")) {
    return (
      <div className="p-10">
        <EmptyState
          title="Proctoring settings are restricted"
          body="You need the proctoring.read permission to view policies."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/proctor")}>
              <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to roster
            </Button>
          }
        />
      </div>
    );
  }

  const policies = data?.policies ?? [];

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Proctor", href: "/proctor" }, { label: "Policies" }]}
        title="Proctoring policies"
        subtitle="Define which integrity signals are armed, their severity/weight, and the auto-flag / auto-terminate risk thresholds."
        actions={
          <Button
            size="sm"
            disabled={!canPolicy}
            title={canPolicy ? undefined : "Requires proctoring.policy.write"}
            onClick={() => setCreating(true)}
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" /> New policy
          </Button>
        }
      />
      <div className="p-6 space-y-4">
        <Card title="Policies">
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading policies…
            </div>
          ) : isError ? (
            <div className="p-6 text-sm">
              <p className="text-destructive mb-3">{errMessage(error)}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
              </Button>
            </div>
          ) : policies.length === 0 ? (
            <EmptyState
              title="No proctoring policies yet"
              body="Create an org-default policy to start watching integrity signals on proctored sessions."
              action={
                canPolicy ? (
                  <Button size="sm" onClick={() => setCreating(true)}>
                    <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Create your first policy
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {policies.map((p) => {
                const armed = Object.values(p.signalConfig ?? {}).filter((s) => s.armed).length;
                return (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{p.name}</span>
                        {p.isDefault && <span className="pill bg-primary/10 text-primary text-[10px]">org default</span>}
                        {p.assessmentTemplateTitle && (
                          <span className="pill bg-muted text-muted-foreground text-[10px]">{p.assessmentTemplateTitle}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {armed} signals armed · auto-flag ≥ {p.autoFlagRiskScore}
                        {p.autoTerminateRiskScore != null ? ` · auto-terminate ≥ ${p.autoTerminateRiskScore}` : " · no auto-terminate"}
                        {" · "}updated {formatDistanceToNow(new Date(p.updatedAt), { addSuffix: true })}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn("shrink-0", !canPolicy && "opacity-60")}
                      disabled={!canPolicy}
                      title={canPolicy ? undefined : "Requires proctoring.policy.write"}
                      onClick={() => setEditing(p)}
                    >
                      <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New proctoring policy</DialogTitle>
            <DialogDescription>Configure signals, requirements, and auto-action thresholds.</DialogDescription>
          </DialogHeader>
          <PolicyForm onSaved={() => setCreating(false)} onCancel={() => setCreating(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit policy</DialogTitle>
            <DialogDescription>Changes apply to new sessions only — existing sessions keep their snapshot.</DialogDescription>
          </DialogHeader>
          {editing && <PolicyForm initial={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
