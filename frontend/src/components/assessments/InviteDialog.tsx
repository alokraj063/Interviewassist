import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Search, X, ClipboardCopy, Check } from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import { toast } from "sonner";

interface Candidate {
  id: string;
  displayName: string | null;
  currentTitle: string | null;
}

export function InviteDialog({
  open,
  onOpenChange,
  templateId,
  templatePublished,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templateId: string;
  templatePublished: boolean;
  onInvited: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Candidate[]>([]);
  const [expiresDays, setExpiresDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open || debounced.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    apiFetch<{ candidates: Candidate[] }>(`/api/candidates?q=${encodeURIComponent(debounced)}&limit=10`)
      .then((res) => {
        if (!cancelled) setResults(res.candidates);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected]);

  const expiresAt = useMemo(() => {
    const days = Number(expiresDays);
    if (!days || days <= 0) return undefined;
    return new Date(Date.now() + days * 86400_000).toISOString();
  }, [expiresDays]);

  const reset = () => {
    setQuery("");
    setResults([]);
    setSelected([]);
    setLink(null);
    setCopied(false);
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (selected.length === 0) {
        // unlinked single invite (link-only)
        const res = await apiFetch<{ attempt: { inviteToken: string } }>("/api/assessments/invites", {
          method: "POST",
          json: { templateId, expiresAt },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        });
        const l = `${window.location.origin}/take-assessment/${res.attempt.inviteToken}`;
        setLink(l);
        toast.success("Invite link generated");
      } else if (selected.length === 1) {
        const res = await apiFetch<{ attempt: { inviteToken: string } }>("/api/assessments/invites", {
          method: "POST",
          json: { templateId, candidateId: selected[0].id, expiresAt },
          headers: { "Idempotency-Key": crypto.randomUUID() },
        });
        const l = `${window.location.origin}/take-assessment/${res.attempt.inviteToken}`;
        setLink(l);
        toast.success(`Invited ${selected[0].displayName ?? "candidate"}`);
      } else {
        const res = await apiFetch<{ invited: number }>("/api/assessments/invites/bulk", {
          method: "POST",
          json: { templateId, candidateIds: selected.map((s) => s.id), expiresAt },
        });
        toast.success(`Invited ${res.invited} candidates`);
        reset();
        onOpenChange(false);
      }
      onInvited();
    } catch (err) {
      toast.error("Couldn't create invite", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Link copied");
    } catch {
      toast.info("Copy this link", { description: link });
    }
  };

  // Avoid unused import lint while keeping API base available for future delivery.
  void getApiBase;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite candidates</DialogTitle>
          <DialogDescription>
            Search candidates by name. Pick one for a personal link, or several for a bulk send.
          </DialogDescription>
        </DialogHeader>

        {!templatePublished ? (
          <div className="rounded border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            Publish this assessment before inviting candidates.
          </div>
        ) : link ? (
          <div className="space-y-3 py-2">
            <div className="text-sm text-success font-medium">Invite link generated — copy to share.</div>
            <div className="flex items-center gap-2">
              <Input readOnly value={link} className="text-xs" />
              <Button size="sm" variant="outline" onClick={() => void copyLink()}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs px-2 py-0.5"
                  >
                    {s.displayName ?? s.id.slice(0, 8)}
                    <button
                      type="button"
                      aria-label={`Remove ${s.displayName}`}
                      onClick={() => setSelected((cur) => cur.filter((c) => c.id !== s.id))}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search candidates…"
                className="pl-8"
                aria-label="Search candidates"
              />
            </div>
            {searching ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Searching…
              </div>
            ) : results.length > 0 ? (
              <div className="border border-border rounded max-h-48 overflow-y-auto divide-y divide-border">
                {results.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    disabled={selectedIds.has(c.id)}
                    onClick={() => setSelected((cur) => [...cur, c])}
                    className="w-full text-left px-3 py-2 hover:bg-muted/40 disabled:opacity-40 text-sm flex items-center justify-between"
                  >
                    <span>
                      <span className="font-medium">{c.displayName ?? c.id.slice(0, 8)}</span>
                      {c.currentTitle && <span className="text-muted-foreground text-xs ml-2">{c.currentTitle}</span>}
                    </span>
                    {selectedIds.has(c.id) && <Check className="w-3.5 h-3.5 text-success" />}
                  </button>
                ))}
              </div>
            ) : debounced.length >= 2 ? (
              <div className="text-xs text-muted-foreground px-1">No candidates match.</div>
            ) : (
              <div className="text-xs text-muted-foreground px-1">Type at least 2 characters to search.</div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="exp-days">Expires in (days)</Label>
              <Input
                id="exp-days"
                type="number"
                min={1}
                max={365}
                value={expiresDays}
                onChange={(e) => setExpiresDays(e.target.value)}
                className="w-32"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {link ? (
            <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={!templatePublished || submitting}>
                {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                {selected.length > 1 ? `Invite ${selected.length}` : selected.length === 1 ? "Invite & get link" : "Generate link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
