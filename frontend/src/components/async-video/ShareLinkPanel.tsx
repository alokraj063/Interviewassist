import { useState } from "react";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Copy, Ban, Link2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useShareLinks, useCreateShareLink, useRevokeShareLink } from "@/hooks/useAsyncVideo";

export function ShareLinkPanel({ submissionId, canShare }: { submissionId: string; canShare: boolean }) {
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("72");
  const linksQ = useShareLinks(submissionId);
  const create = useCreateShareLink(submissionId);
  const revoke = useRevokeShareLink(submissionId);

  const submit = async () => {
    try {
      const res = await create.mutateAsync({ label: label.trim() || null, expiresInHours: Number(hours) || 72, canScore: true });
      setLabel("");
      try {
        await navigator.clipboard.writeText(res.url);
        toast.success("Share link created — copied", { description: res.url });
      } catch {
        toast.success("Share link created", { description: res.url });
      }
    } catch (err) {
      toast.error("Couldn't create share link", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Card title="External reviewer links">
      <div className="p-4 space-y-3">
        {canShare && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted-foreground">Label</label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hiring manager — Priya" className="h-8" aria-label="Share link label" />
            </div>
            <div className="w-24 space-y-1">
              <label className="text-xs text-muted-foreground">Expires (h)</label>
              <Input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} className="h-8" aria-label="Expiry hours" />
            </div>
            <Button size="sm" onClick={() => void submit()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Link2 className="w-3.5 h-3.5 mr-1" />}
              Create
            </Button>
          </div>
        )}

        {linksQ.isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : (linksQ.data?.shareLinks.length ?? 0) === 0 ? (
          <div className="text-sm text-muted-foreground">No external links yet.</div>
        ) : (
          <ul className="divide-y divide-border">
            {linksQ.data!.shareLinks.map((l) => (
              <li key={l.id} className="py-2 flex items-center justify-between text-sm gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{l.label ?? "External reviewer"}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className={cn(l.active ? "text-success" : "text-destructive")}>
                      {l.revokedAt ? "Revoked" : l.active ? "Active" : "Expired"}
                    </span>
                    {" · "}views {l.viewCount}
                    {" · "}expires {formatDistanceToNow(new Date(l.expiresAt), { addSuffix: true })}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(l.url); toast.success("Copied"); }} aria-label="Copy link">
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                  {canShare && l.active && (
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke.mutate(l.id)} aria-label="Revoke link">
                      <Ban className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
