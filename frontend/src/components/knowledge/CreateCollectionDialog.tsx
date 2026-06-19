import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCreateCollection, KB_CORPORA, CORPUS_LABELS, type KbCorpus } from "@/hooks/useKnowledge";

export function CreateCollectionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [corpus, setCorpus] = useState<KbCorpus>("company");
  const [description, setDescription] = useState("");
  const [staleDays, setStaleDays] = useState("");
  const create = useCreateCollection();

  const validName = useMemo(() => name.trim().length >= 2, [name]);
  const staleNum = staleDays.trim() === "" ? undefined : Number(staleDays);
  const validStale = staleNum === undefined || (Number.isInteger(staleNum) && staleNum > 0);
  const canSubmit = validName && validStale && !create.isPending;

  function reset() {
    setName("");
    setCorpus("company");
    setDescription("");
    setStaleDays("");
  }

  async function submit() {
    if (!canSubmit) return;
    try {
      const col = await create.mutateAsync({
        name: name.trim(),
        corpus,
        description: description.trim() || undefined,
        staleAfterDays: staleNum,
      });
      toast.success(`Collection “${col.name}” created`);
      onOpenChange(false);
      reset();
      onCreated?.(col.id);
    } catch (err) {
      toast.error("Failed to create collection", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create collection</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="col-name" className="mb-1 block text-xs text-muted-foreground">
              Name
            </label>
            <Input
              id="col-name"
              placeholder="e.g. JD library"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Corpus</label>
            <Select value={corpus} onValueChange={(v) => setCorpus(v as KbCorpus)}>
              <SelectTrigger aria-label="Corpus">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KB_CORPORA.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CORPUS_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Determines which retrieval surfaces (Live Assist, scoring, voice agents) pull from
              sources in this collection.
            </div>
          </div>
          <div>
            <label htmlFor="col-desc" className="mb-1 block text-xs text-muted-foreground">
              Description (optional)
            </label>
            <Textarea
              id="col-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="col-stale" className="mb-1 block text-xs text-muted-foreground">
              Stale after (days, optional)
            </label>
            <Input
              id="col-stale"
              type="number"
              min={1}
              placeholder="e.g. 90"
              value={staleDays}
              onChange={(e) => setStaleDays(e.target.value)}
            />
            {!validStale && (
              <div className="mt-1 text-[11px] text-destructive">Must be a positive whole number.</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {create.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Creating…
              </>
            ) : (
              "Create collection"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
