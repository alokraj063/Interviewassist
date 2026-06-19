// CSV/QTI import: paste/upload content -> preview job (valid/dup/error counts)
// -> commit. Two-phase so the curator can review before writing.
import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, FileText } from "lucide-react";
import { toast } from "sonner";
import { useImportPreview, useCommitImport, type ImportJobResult } from "@/hooks/useQuestionBanks";

const SAMPLE = "prompt,level,difficulty,language,questionType,roleFamily\nExplain the Java memory model,senior,4,en,verbal,backend";

export function ImportDialog({
  open,
  onOpenChange,
  bankId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  bankId: string;
}) {
  const [content, setContent] = useState("");
  const [job, setJob] = useState<ImportJobResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useImportPreview(bankId);
  const commit = useCommitImport(bankId);

  function reset() {
    setContent("");
    setJob(null);
  }

  function runPreview() {
    if (!content.trim() || preview.isPending) return;
    preview.mutate(
      { format: "csv", content },
      {
        onSuccess: (res) => setJob(res),
        onError: (e: Error) =>
          toast.error((e as { body?: { error?: string } }).body?.error ?? e.message),
      },
    );
  }

  function runCommit() {
    if (!job || commit.isPending) return;
    commit.mutate(
      { jobId: job.jobId },
      {
        onSuccess: (res) => {
          toast.success(`Imported ${res.inserted} questions (drafts)`);
          reset();
          onOpenChange(false);
        },
        onError: (e: Error) =>
          toast.error((e as { body?: { error?: string } }).body?.error ?? e.message),
      },
    );
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((t) => {
      setContent(t);
      setJob(null);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import questions (CSV)</DialogTitle>
          <DialogDescription>
            Paste CSV or upload a file. Header row required; <code>prompt</code> is the only
            mandatory column. Imported rows land as drafts. Duplicates (by content) are skipped.
          </DialogDescription>
        </DialogHeader>

        {!job ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFile}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Choose file
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setContent(SAMPLE)}
              >
                Use sample
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="import-content">CSV content</Label>
              <Textarea
                id="import-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={SAMPLE}
                className="min-h-[160px] font-mono text-xs"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center text-sm">
              <Stat label="Rows" value={job.rowCount} />
              <Stat label="New" value={job.validCount} accent="text-emerald-600" />
              <Stat label="Duplicates" value={job.duplicateCount} accent="text-amber-600" />
              <Stat label="Errors" value={job.errorCount} accent="text-rose-600" />
            </div>
            {job.errors.length > 0 && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                {job.errors.slice(0, 5).map((e, i) => (
                  <div key={i}>
                    Row {e.row}: {e.message}
                  </div>
                ))}
              </div>
            )}
            <div className="max-h-64 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 font-medium">Prompt</th>
                    <th className="p-2 font-medium">Level</th>
                    <th className="p-2 font-medium">Diff</th>
                    <th className="p-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.preview.map((r) => (
                    <tr key={r.row} className="border-t border-border">
                      <td className="max-w-xs truncate p-2">{r.prompt}</td>
                      <td className="p-2">{r.level}</td>
                      <td className="p-2">{r.difficulty}</td>
                      <td className="p-2">
                        {r.duplicate ? (
                          <span className="text-amber-600">duplicate</span>
                        ) : (
                          <span className="text-emerald-600">new</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              {job.validCount} new question(s) will be created as drafts.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!job ? (
            <Button type="button" onClick={runPreview} disabled={!content.trim() || preview.isPending}>
              {preview.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {preview.isPending ? "Parsing…" : "Preview"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={runCommit}
              disabled={commit.isPending || job.validCount === 0}
            >
              {commit.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {commit.isPending ? "Importing…" : `Import ${job.validCount} new`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className={`text-lg font-semibold tabular-nums ${accent ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
