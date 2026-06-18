import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { Rocket, History, RotateCcw, Tag, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  usePublishRuleSet,
  useRollbackRuleSet,
  useRuleSets,
  useTriageFlow,
} from "@/hooks/useTriage";
import type { TriageRulesetStatus } from "@j2w/shared-types";

interface Props {
  flowId: string;
  canWrite: boolean;
}

const STATUS_TONE: Record<TriageRulesetStatus, string> = {
  published: "bg-success/15 text-success",
  draft: "bg-warning/15 text-warning",
  archived: "bg-muted text-muted-foreground",
};

export function RuleSetVersionBar({ flowId, canWrite }: Props) {
  const flow = useTriageFlow(flowId);
  const ruleSets = useRuleSets(flowId);
  const publish = usePublishRuleSet(flowId);
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [note, setNote] = useState("");

  const publishedVersion = flow.data?.publishedVersion ?? null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Tag className="w-4 h-4 text-muted-foreground" />
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            Published rule set
          </div>
          <div className="text-sm font-semibold" data-testid="published-version">
            {publishedVersion != null ? `v${publishedVersion}` : "Not published yet"}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => setHistoryOpen(true)}
        >
          <History className="w-3.5 h-3.5 mr-1.5" />
          History
        </Button>
        {canWrite ? (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              setNote("");
              setPublishOpen(true);
            }}
          >
            <Rocket className="w-3.5 h-3.5 mr-1.5" />
            Publish…
          </Button>
        ) : (
          <span
            className="text-[11px] text-muted-foreground inline-flex items-center gap-1"
            title="You need triage.write to publish"
          >
            <Lock className="w-3 h-3" />
            Read-only
          </span>
        )}
      </div>

      {/* Publish dialog */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Publish rule set</DialogTitle>
            <DialogDescription>
              Freeze the current draft into a new immutable version. The live router pins to the
              published snapshot.
            </DialogDescription>
          </DialogHeader>
          <div className="py-1">
            <Label htmlFor="publish-note">Changelog note (optional)</Label>
            <Textarea
              id="publish-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What changed in this version?"
              className="mt-1 text-sm"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)} disabled={publish.isPending}>
              Cancel
            </Button>
            <Button
              disabled={publish.isPending}
              onClick={async () => {
                try {
                  const rs = await publish.mutateAsync(note.trim() || undefined);
                  toast.success(`Published v${rs.version}`);
                  setPublishOpen(false);
                } catch (err) {
                  toast.error(publishErr(err));
                }
              }}
            >
              {publish.isPending ? "Publishing…" : "Publish version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History drawer */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="right" className="w-[min(100vw,520px)] sm:max-w-[520px] p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
            <SheetTitle className="flex items-center gap-2 text-base">
              <History className="w-4 h-4 text-primary" />
              Version history
            </SheetTitle>
            <SheetDescription>
              Each publish freezes an immutable snapshot. Roll back to re-publish an older one.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <VersionHistoryList flowId={flowId} canWrite={canWrite} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );

  function publishErr(err: unknown): string {
    const body = (err as { body?: { error?: string; issues?: unknown } }).body;
    if (body?.error === "no_rules_to_publish") return "Add at least one rule before publishing.";
    if (body?.error === "invalid_rules") return "Fix the rule validation errors before publishing.";
    if (body?.error) return body.error.replace(/_/g, " ");
    return err instanceof Error ? err.message : "Publish failed";
  }
}

function VersionHistoryList({ flowId, canWrite }: { flowId: string; canWrite: boolean }) {
  const ruleSets = useRuleSets(flowId);
  const rollback = useRollbackRuleSet(flowId);
  const [rollingId, setRollingId] = useState<string | null>(null);

  if (ruleSets.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-16 rounded bg-muted animate-pulse" />
        ))}
      </div>
    );
  }
  if (ruleSets.isError) {
    return (
      <div className="text-center text-sm py-6">
        <div className="text-destructive mb-2">
          {ruleSets.error instanceof Error ? ruleSets.error.message : "Failed to load versions"}
        </div>
        <button
          type="button"
          className="text-primary text-xs hover:underline"
          onClick={() => ruleSets.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }
  const versions = ruleSets.data?.ruleSets ?? [];
  if (versions.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-8">
        No published versions yet. Publish the draft to create v1.
      </div>
    );
  }

  return (
    <ol className="space-y-2">
      {versions.map((v) => (
        <li
          key={v.id}
          className="rounded-lg border border-border p-3 flex items-start justify-between gap-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">v{v.version}</span>
              <span className={cn("pill text-[10px] capitalize", STATUS_TONE[v.status])}>
                {v.status}
              </span>
              <span className="text-[11px] text-muted-foreground">{v.ruleCount} rules</span>
            </div>
            {v.note && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{v.note}</div>}
            <div className="text-[11px] text-muted-foreground mt-1">
              {v.publishedByName ?? "—"}
              {v.publishedAt &&
                ` · ${formatDistanceToNowStrict(new Date(v.publishedAt), { addSuffix: true })}`}
            </div>
          </div>
          {canWrite && v.status !== "published" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs shrink-0"
              disabled={rollback.isPending && rollingId === v.id}
              onClick={async () => {
                setRollingId(v.id);
                try {
                  const rs = await rollback.mutateAsync(v.id);
                  toast.success(`Rolled back — published v${rs.version}`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Rollback failed");
                } finally {
                  setRollingId(null);
                }
              }}
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              {rollback.isPending && rollingId === v.id ? "Rolling…" : "Roll back"}
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}
