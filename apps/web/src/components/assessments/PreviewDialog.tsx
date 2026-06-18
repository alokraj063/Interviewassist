import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle, Eye } from "lucide-react";
import { usePreview, ITEM_TYPE_LABELS, type ItemType } from "@/hooks/useAssessments";

// Preview-as-candidate: renders the redacted candidate runtime (answer keys
// stripped server-side) read-only. Never creates an attempt.
export function PreviewDialog({
  open,
  onOpenChange,
  templateId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templateId: string;
}) {
  const { data, isLoading, isError, error } = usePreview(templateId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-4 h-4" /> Preview as candidate
          </DialogTitle>
          <DialogDescription>
            This is exactly what a candidate sees — answer keys are hidden. No attempt is created.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading preview…
          </div>
        ) : isError ? (
          <div className="py-8 flex flex-col items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="w-6 h-6" />
            {(error as { body?: { error?: string } })?.body?.error ?? "Failed to load preview."}
          </div>
        ) : data ? (
          <div className="space-y-5 py-2">
            <div>
              <h3 className="text-lg font-semibold">{data.template.title}</h3>
              {data.template.description && (
                <p className="text-sm text-muted-foreground">{data.template.description}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {data.template.durationMins ? `${data.template.durationMins} min` : "Untimed"} · Pass{" "}
                {data.template.passScore}%
              </p>
            </div>

            {data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No questions added yet.</p>
            ) : (
              <ol className="space-y-4">
                {data.items.map((it, i) => (
                  <li key={it.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground">
                        Q{i + 1} · {ITEM_TYPE_LABELS[it.type as ItemType]} · {it.points} pt
                        {it.required ? " · required" : ""}
                      </span>
                    </div>
                    <div className="text-sm mb-3">{it.prompt}</div>
                    <PreviewBody type={it.type} config={it.config} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ type, config }: { type: ItemType; config: Record<string, unknown> }) {
  if (type === "mcq_single" || type === "mcq_multi") {
    const options = (config.options as Array<{ id: string; label: string }>) ?? [];
    return (
      <div className="space-y-1.5">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm opacity-80">
            <input type={type === "mcq_single" ? "radio" : "checkbox"} disabled />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (type === "true_false") {
    return (
      <div className="flex gap-4 text-sm opacity-80">
        <label className="flex items-center gap-1.5">
          <input type="radio" disabled /> True
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" disabled /> False
        </label>
      </div>
    );
  }
  if (type === "short_answer") {
    return <input className="w-full rounded border border-border bg-muted/30 px-2 py-1 text-sm" disabled placeholder="Candidate's short answer…" />;
  }
  if (type === "long_answer") {
    return <textarea className="w-full rounded border border-border bg-muted/30 px-2 py-1 text-sm" rows={3} disabled placeholder="Candidate's long answer…" />;
  }
  if (type === "coding") {
    return (
      <pre className="rounded border border-border bg-muted/30 px-2 py-2 text-xs font-mono overflow-x-auto">
        {(config.starterCode as string) || `// ${String(config.language ?? "code")} editor`}
      </pre>
    );
  }
  if (type === "file_upload") {
    return <div className="text-xs text-muted-foreground">File upload · {((config.acceptedTypes as string[]) ?? []).join(", ") || "any"} · max {String(config.maxSizeMb ?? "—")}MB</div>;
  }
  if (type === "video_response") {
    return (
      <div className="text-xs text-muted-foreground">
        Video response · {String(config.prepSeconds ?? 0)}s prep · {String(config.maxSeconds ?? 0)}s take ·{" "}
        {String(config.retakes ?? 0)} retakes
      </div>
    );
  }
  return null;
}
