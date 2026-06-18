// Source detail — header lifecycle actions (reindex / move / deprecate / delete
// with named-confirm) + tabs: Documents (per-doc status + chunk preview),
// Usage (30d retrieval sparkline from real events), Feedback, Activity (audit).
// Live ingest via SSE.
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import {
  RefreshCw,
  Archive,
  Trash2,
  Upload,
  Loader2,
  ChevronDown,
  ThumbsUp,
  ThumbsDown,
  FolderInput,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useCan } from "@/auth/AuthContext";
import {
  useKbSource,
  useKbSourceEvents,
  useUploadDocuments,
  useReindexSource,
  useDeprecateSource,
  useDeleteKbSource,
  usePatchSource,
  useKbCollections,
} from "@/hooks/useKnowledge";
import { SourceStatusBadge } from "@/components/knowledge/StatusBadge";
import type { KBIngestEvent } from "@j2w/shared-types";

export default function KnowledgeSourceDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("knowledge.write");
  const canManage = useCan("knowledge.manage");

  const { data, isLoading, isError, refetch } = useKbSource(id);
  const upload = useUploadDocuments(id ?? "");
  const reindex = useReindexSource();
  const deprecate = useDeprecateSource();
  const del = useDeleteKbSource();
  const patch = usePatchSource(id ?? "");
  const { data: colData } = useKbCollections();
  const collections = colData?.collections ?? [];

  const [tab, setTab] = useState("documents");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useKbSourceEvents(id, (evt: KBIngestEvent) => {
    if (evt.kind === "document.indexed") toast.success("Document indexed");
    else if (evt.kind === "document.error") toast.error(`Ingest failed: ${evt.message ?? "unknown"}`);
    void refetch();
  });

  const documents = useMemo(() => data?.documents ?? [], [data?.documents]);

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data?.source) {
    return (
      <div className="p-10">
        <EmptyState
          title="Source not found"
          body="It may have been deleted or you don't have access."
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/knowledge")}>
              Back to Knowledge Base
            </Button>
          }
        />
      </div>
    );
  }

  const source = data.source;

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    try {
      await upload.mutateAsync(files);
      toast.success(`${files.length} file${files.length === 1 ? "" : "s"} queued for indexing`);
    } catch (err) {
      toast.error("Upload failed", { description: err instanceof Error ? err.message : String(err) });
    }
    e.target.value = "";
  }

  function doReindex() {
    reindex.mutate(source.id, {
      onSuccess: (r) =>
        r.reindexed
          ? toast.success(`Reindexing ${r.docCount ?? ""} document(s)`)
          : toast.info(r.reason === "already_indexing" ? "Already indexing" : "Nothing to reindex"),
      onError: (e: Error) => toast.error(e.message),
    });
  }
  function doDeprecate() {
    deprecate.mutate(source.id, {
      onSuccess: () => toast.success("Source deprecated — excluded from retrieval"),
      onError: (e: Error) => toast.error(e.message),
    });
  }
  function doMove(collectionId: string) {
    patch.mutate(
      { collectionId },
      {
        onSuccess: () => toast.success("Moved to collection"),
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Knowledge Base", href: "/knowledge" }, { label: source.name }]}
        title={source.name}
        subtitle={`${source.type} · ${source.documentCount} document(s)`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canWrite && (
              <label>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.docx,.md,.txt,.markdown"
                  className="hidden"
                  onChange={onFiles}
                />
                <Button size="sm" variant="outline" asChild>
                  <span>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Upload
                  </span>
                </Button>
              </label>
            )}
            {canManage && collections.length > 0 && (
              <Select value={source.collectionId ?? ""} onValueChange={doMove}>
                <SelectTrigger className="h-8 w-[160px]" aria-label="Move to collection">
                  <FolderInput className="mr-1 h-3.5 w-3.5" />
                  <SelectValue placeholder="Move…" />
                </SelectTrigger>
                <SelectContent>
                  {collections
                    .filter((c) => c.status === "active")
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
            {canWrite && (
              <Button
                size="sm"
                variant="outline"
                disabled={reindex.isPending || source.status === "indexing"}
                onClick={doReindex}
              >
                {reindex.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Reindex
              </Button>
            )}
            {canWrite && source.status !== "deprecated" && (
              <Button size="sm" variant="outline" disabled={deprecate.isPending} onClick={doDeprecate}>
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                Deprecate
              </Button>
            )}
            {canWrite && (
              <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5 text-destructive" />
                Delete
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Documents" value={source.documentCount} />
          <MetricCard
            label="Status"
            value={<SourceStatusBadge status={source.status} />}
          />
          <MetricCard label="Retrievals (7d)" value={source.retrievals7d.toLocaleString()} />
          <MetricCard
            label="Last indexed"
            value={
              source.lastIndexedAt
                ? formatDistanceToNow(new Date(source.lastIndexedAt), { addSuffix: true })
                : "—"
            }
            accent={source.isStale ? "warning" : "default"}
          />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="feedback">Feedback</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="space-y-4">
            <Card title="Documents">
              {documents.length === 0 ? (
                <EmptyState title="No documents yet" body="Upload files to populate this source." />
              ) : (
                <ul className="divide-y divide-border">
                  {documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="min-w-0 truncate">{d.title ?? d.id}</span>
                      <span className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="tabular-nums">{d.chunkCount} chunks</span>
                        <span title={d.errorMessage ?? undefined}>{d.status}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <ChunkPreview chunks={data.chunkPreview} />
          </TabsContent>

          <TabsContent value="usage">
            <Card title="Retrievals (last 30 days)">
              <UsageSparkline data={data.retrievalSparkline} />
            </Card>
          </TabsContent>

          <TabsContent value="feedback">
            <Card title="Answer feedback">
              {data.feedback.length === 0 ? (
                <EmptyState title="No feedback yet" body="Thumbs from served answers appear here." />
              ) : (
                <ul className="divide-y divide-border">
                  {data.feedback.map((f) => (
                    <li key={f.id} className="flex items-start gap-2 px-4 py-3 text-sm">
                      {f.rating === "up" ? (
                        <ThumbsUp className="mt-0.5 h-4 w-4 text-success" aria-label="up" />
                      ) : (
                        <ThumbsDown className="mt-0.5 h-4 w-4 text-destructive" aria-label="down" />
                      )}
                      <div className="min-w-0">
                        {f.query && <div className="truncate font-medium">“{f.query}”</div>}
                        {f.reason && (
                          <span className="text-xs text-muted-foreground">{f.reason}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="activity">
            <Card title="Activity">
              {data.audit.length === 0 ? (
                <EmptyState title="No activity yet" body="Lifecycle changes appear here." />
              ) : (
                <ul className="divide-y divide-border">
                  {data.audit.map((a) => (
                    <li key={a.id} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="font-medium">{a.action.replace(/[._]/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.createdAt
                          ? formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        sourceName={source.name}
        pending={del.isPending}
        onConfirm={(confirmName) =>
          del.mutate(
            { id: source.id, confirmName },
            {
              onSuccess: () => {
                toast.success("Source deleted");
                nav("/knowledge");
              },
              onError: (e: Error) => toast.error(e.message),
            },
          )
        }
      />
    </div>
  );
}

function ChunkPreview({
  chunks,
}: {
  chunks: { id: number; corpus: string | null; snippet: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (chunks.length === 0) return null;
  return (
    <Card>
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
        onClick={() => setOpen((o) => !o)}
      >
        Chunk preview ({chunks.length})
        <ChevronDown className={open ? "h-4 w-4 rotate-180 transition" : "h-4 w-4 transition"} />
      </button>
      {open && (
        <ul className="divide-y divide-border">
          {chunks.map((c) => (
            <li key={c.id} className="px-4 py-2 text-xs text-muted-foreground">
              {c.corpus && <span className="mr-2 rounded bg-muted px-1 py-0.5">{c.corpus}</span>}
              {c.snippet}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UsageSparkline({ data }: { data: { day: string; count: number }[] }) {
  if (data.length === 0) {
    return <EmptyState title="No retrievals in range" body="Run a search to populate usage." />;
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-0.5 p-4" style={{ height: 120 }}>
      {data.map((d) => (
        <div
          key={d.day}
          className="flex-1 rounded-t bg-primary/70"
          style={{ height: `${(d.count / max) * 100}%` }}
          title={`${d.day}: ${d.count}`}
        />
      ))}
    </div>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  sourceName,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceName: string;
  pending: boolean;
  onConfirm: (confirmName: string) => void;
}) {
  const [text, setText] = useState("");
  const match = text === sourceName;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete source</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This permanently removes the source and its documents. Type{" "}
          <span className="font-mono font-medium text-foreground">{sourceName}</span> to confirm.
        </p>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={sourceName}
          aria-label="Confirm source name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!match || pending}
            onClick={() => onConfirm(text)}
          >
            {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Delete source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
