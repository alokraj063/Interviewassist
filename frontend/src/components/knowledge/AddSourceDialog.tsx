import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  useCreateKbSource,
  useUploadDocuments,
  useKbCollections,
  CORPUS_LABELS,
  type KbCollection,
} from "@/hooks/useKnowledge";

// Inner uploader needs the new source id, so we use a child mutation keyed on it.
function UploadAndClose({
  sourceId,
  files,
  onDone,
  onError,
}: {
  sourceId: string;
  files: File[];
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const upload = useUploadDocuments(sourceId);
  // fire once on mount
  useMemo(() => {
    upload
      .mutateAsync(files)
      .then(onDone)
      .catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function AddSourceDialog({
  open,
  onOpenChange,
  defaultCollectionId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultCollectionId?: string;
}) {
  const [name, setName] = useState("");
  const [collectionId, setCollectionId] = useState(defaultCollectionId ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [pendingUpload, setPendingUpload] = useState<{ sourceId: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const createSource = useCreateKbSource();
  const { data: colData, isLoading: colsLoading } = useKbCollections({ status: "active" });
  const collections: KbCollection[] = colData?.collections ?? [];

  const selectedCol = collections.find((c) => c.id === collectionId);
  const validName = useMemo(() => name.trim().length >= 2, [name]);
  const canSubmit =
    validName && !!collectionId && files.length > 0 && !createSource.isPending && !pendingUpload;

  function reset() {
    setName("");
    setFiles([]);
    setCollectionId(defaultCollectionId ?? "");
    setPendingUpload(null);
  }

  async function submit() {
    if (!canSubmit) return;
    try {
      const source = await createSource.mutateAsync({
        name: name.trim(),
        type: "Upload",
        collectionId,
      });
      setPendingUpload({ sourceId: source.id });
    } catch (err) {
      toast.error("Failed to create source", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (!pendingUpload ? onOpenChange(v) : null)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add knowledge source</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="src-name" className="mb-1 block text-xs text-muted-foreground">
              Source name
            </label>
            <Input
              id="src-name"
              placeholder="e.g. Senior Java JD — GCC Hiring Pod 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Collection</label>
            <Select value={collectionId} onValueChange={setCollectionId} disabled={colsLoading}>
              <SelectTrigger aria-label="Collection">
                <SelectValue placeholder={colsLoading ? "Loading…" : "Choose a collection"} />
              </SelectTrigger>
              <SelectContent>
                {collections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedCol ? (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Corpus: <span className="font-medium">{CORPUS_LABELS[selectedCol.corpus]}</span> —
                drives which retrieval surfaces include this source.
              </div>
            ) : collections.length === 0 && !colsLoading ? (
              <div className="mt-1 text-[11px] text-destructive">
                No collections yet — create one first.
              </div>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Documents (PDF, DOCX, MD, TXT)
            </label>
            <button
              type="button"
              className="flex w-full flex-col items-center gap-2 rounded border border-dashed border-border p-6 text-sm text-muted-foreground transition hover:border-primary/40 hover:bg-muted/30"
              onClick={() => fileInput.current?.click()}
            >
              <Upload className="h-5 w-5" />
              {files.length === 0
                ? "Click to choose files"
                : `${files.length} file${files.length === 1 ? "" : "s"} selected`}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.docx,.md,.txt,.markdown"
              className="hidden"
              aria-label="Documents"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {files.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {files.map((f) => (
                  <li key={f.name}>
                    {f.name} · {(f.size / 1024).toFixed(1)} KB
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!pendingUpload}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {createSource.isPending || pendingUpload ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {pendingUpload ? "Uploading…" : "Creating…"}
              </>
            ) : (
              "Add source"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      {pendingUpload && (
        <UploadAndClose
          sourceId={pendingUpload.sourceId}
          files={files}
          onDone={() => {
            toast.success(
              `Source created — ${files.length} file${files.length === 1 ? "" : "s"} queued for indexing`,
            );
            onOpenChange(false);
            reset();
          }}
          onError={(err) => {
            toast.error("Upload failed", {
              description: err instanceof Error ? err.message : String(err),
            });
            setPendingUpload(null);
          }}
        />
      )}
    </Dialog>
  );
}
