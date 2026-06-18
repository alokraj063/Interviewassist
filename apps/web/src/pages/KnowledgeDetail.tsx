import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, FileText, Loader2, RefreshCw, Search, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useKbSource, useKbSourceEvents, useUploadDocuments } from "@/hooks/useKnowledge";
import type { KBIngestEvent } from "@j2w/shared-types";

export default function KnowledgeDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, refetch } = useKbSource(id);
  const upload = useUploadDocuments(id ?? "");
  const [search, setSearch] = useState("");

  useKbSourceEvents(id, (evt: KBIngestEvent) => {
    if (evt.kind === "document.indexed") {
      toast.success(`Document indexed (${evt.chunkCount ?? 0} chunks)`);
    } else if (evt.kind === "document.error") {
      toast.error(`Ingest failed: ${evt.message ?? "unknown"}`);
    }
    void refetch();
  });

  const source = data?.source;
  const documents = useMemo(() => data?.documents ?? [], [data?.documents]);

  const filtered = useMemo(() => {
    if (!search.trim()) return documents;
    const q = search.toLowerCase();
    return documents.filter((d) => (d.title ?? "").toLowerCase().includes(q));
  }, [documents, search]);

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!source) {
    return <div className="p-6 text-sm text-muted-foreground">Source not found.</div>;
  }

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

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Knowledge Base", href: "/knowledge" }, { label: source.name }]}
        title={source.name}
        subtitle={`${source.type} · ${source.documentCount ?? documents.length} documents`}
        actions={
          <>
            <label>
              <input type="file" multiple accept=".pdf,.docx,.md,.txt,.markdown" className="hidden" onChange={onFiles} />
              <Button size="sm" variant="outline" asChild>
                <span>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  Upload more
                </span>
              </Button>
            </label>
          </>
        }
      />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Documents" value={source.documentCount ?? documents.length} />
          <MetricCard
            label="Status"
            value={source.status}
            accent={source.status === "indexed" ? "success" : source.status === "error" ? "danger" : "warning"}
          />
          <MetricCard label="Retrievals (7d)" value={(source.retrievals7d ?? 0).toLocaleString()} />
          <MetricCard label="Last updated" value={formatStamp(source.lastIndexedAt ?? source.createdAt)} />
        </div>

        <Card
          title="Documents"
          action={
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search documents…"
                className="h-8 pl-8 text-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          }
        >
          {filtered.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              {documents.length === 0 ? "No documents yet." : "No documents match your search."}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Status</th>
                  <th>Chunks</th>
                  <th className="text-right">Added</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-sm">{d.title ?? d.id}</span>
                      </div>
                    </td>
                    <td>
                      <StatusPill status={d.status} errorMessage={d.errorMessage} />
                    </td>
                    <td className="tabular-nums text-xs">{d.chunkCount}</td>
                    <td className="text-right tabular-nums text-xs text-muted-foreground">{formatStamp(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatusPill({ status, errorMessage }: { status: string; errorMessage?: string | null }) {
  if (status === "indexed") {
    return (
      <span className="pill bg-success/15 text-success">
        <CheckCircle2 className="w-3 h-3" />
        Indexed
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="pill bg-destructive/15 text-destructive" title={errorMessage ?? undefined}>
        <AlertTriangle className="w-3 h-3" />
        Error
      </span>
    );
  }
  return (
    <span className={cn("pill bg-info/15 text-info")}>
      <Loader2 className="w-3 h-3 animate-spin" />
      {status}
    </span>
  );
}

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}
