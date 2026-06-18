import { useState } from "react";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Send, Copy } from "lucide-react";
import { toast } from "sonner";
import { useCandidateSearch, useInvite, useBulkInvite } from "@/hooks/useAsyncVideo";

export function InvitePanel({ campaignId, disabled }: { campaignId: string; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map()); // id -> name
  const candidatesQ = useCandidateSearch(search);
  const invite = useInvite();
  const bulkInvite = useBulkInvite();

  const toggle = (id: string, name: string) =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(id)) next.delete(id);
      else next.set(id, name);
      return next;
    });

  const inviteOne = async (candidateId: string | null) => {
    try {
      const res = await invite.mutateAsync({ campaignId, candidateId });
      try {
        await navigator.clipboard.writeText(res.inviteLink);
        toast.success("Invite created — link copied", { description: res.inviteLink });
      } catch {
        toast.success("Invite created", { description: res.inviteLink });
      }
    } catch (err) {
      toast.error("Couldn't create invite", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const inviteSelected = async () => {
    if (picked.size === 0) return;
    try {
      const res = await bulkInvite.mutateAsync({ campaignId, candidateIds: [...picked.keys()] });
      toast.success(`Invited ${res.created}, skipped ${res.skipped} already-invited`);
      setPicked(new Map());
    } catch (err) {
      toast.error("Bulk invite failed", { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Card title="Invite candidates">
      <div className="p-4 space-y-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search candidates by name…"
            className="pl-8 h-9"
            aria-label="Search candidates"
            disabled={disabled}
          />
        </div>

        {picked.size > 0 && (
          <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <span>{picked.size} selected</span>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void inviteSelected()} disabled={disabled || bulkInvite.isPending}>
                {bulkInvite.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                Invite selected
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())}>Clear</Button>
            </div>
          </div>
        )}

        <div className="max-h-64 overflow-y-auto divide-y divide-border rounded border border-border">
          {candidatesQ.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
            </div>
          ) : (candidatesQ.data?.candidates.length ?? 0) === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No candidates match. Refine your search.</div>
          ) : (
            candidatesQ.data!.candidates.map((c) => {
              const name = c.displayName ?? c.id.slice(0, 8);
              return (
                <label key={c.id} className="flex items-center gap-2 p-2.5 text-sm hover:bg-muted/30 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={() => toggle(c.id, name)}
                    disabled={disabled}
                    aria-label={`Select ${name}`}
                  />
                  <span className="flex-1">
                    <span className="font-medium">{name}</span>
                    {c.currentTitle ? <span className="text-muted-foreground text-xs ml-2">{c.currentTitle}</span> : null}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.preventDefault();
                      void inviteOne(c.id);
                    }}
                    disabled={disabled || invite.isPending}
                  >
                    <Send className="w-3 h-3 mr-1" /> Invite
                  </Button>
                </label>
              );
            })
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => void inviteOne(null)}
          disabled={disabled || invite.isPending}
        >
          <Copy className="w-3.5 h-3.5 mr-1" /> Create an unlinked invite link
        </Button>
      </div>
    </Card>
  );
}
