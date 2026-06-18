// Collection detail — sources in the collection, grants editor (role + level),
// staleness policy, deprecate/restore lifecycle. Permission-gated on manage.
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Archive, RotateCcw, Trash2, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useCan } from "@/auth/AuthContext";
import {
  useKbCollection,
  useSetCollectionStatus,
  useAddGrant,
  useRevokeGrant,
  CORPUS_LABELS,
} from "@/hooks/useKnowledge";
import { SourceStatusBadge } from "@/components/knowledge/StatusBadge";

const ROLES = ["recruiter", "delivery_lead", "account_manager", "qa_reviewer", "business_head"];

export default function KnowledgeCollectionDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canManage = useCan("knowledge.manage");

  const { data, isLoading, isError, refetch } = useKbCollection(id);
  const setStatus = useSetCollectionStatus(id ?? "");
  const addGrant = useAddGrant(id ?? "");
  const revokeGrant = useRevokeGrant(id ?? "");

  const [grantRole, setGrantRole] = useState("");
  const [grantLevel, setGrantLevel] = useState<"read" | "manage">("read");

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data?.collection) {
    return (
      <div className="p-10">
        <EmptyState
          title="Collection not found"
          body="It may have been deleted or you don't have access."
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/knowledge?tab=collections")}>
              Back to collections
            </Button>
          }
        />
      </div>
    );
  }

  const { collection, sources, grants } = data;

  function toggleStatus() {
    const next = collection.status === "active" ? "deprecate" : "restore";
    setStatus.mutate(next, {
      onSuccess: () =>
        toast.success(next === "deprecate" ? "Collection deprecated" : "Collection restored"),
      onError: (e: Error) => toast.error(e.message),
    });
  }

  function doAddGrant() {
    if (!grantRole) return;
    addGrant.mutate(
      { role: grantRole, level: grantLevel },
      {
        onSuccess: () => {
          toast.success(`Granted ${grantLevel} to ${grantRole}`);
          setGrantRole("");
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[
          { label: "Knowledge Base", href: "/knowledge?tab=collections" },
          { label: collection.name },
        ]}
        title={collection.name}
        subtitle={collection.description ?? CORPUS_LABELS[collection.corpus]}
        actions={
          canManage ? (
            <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={toggleStatus}>
              {setStatus.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : collection.status === "active" ? (
                <Archive className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {collection.status === "active" ? "Deprecate" : "Restore"}
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Corpus" value={CORPUS_LABELS[collection.corpus]} />
          <MetricCard label="Sources" value={collection.sourceCount} />
          <MetricCard label="Retrievals (7d)" value={collection.retrievals7d.toLocaleString()} />
          <MetricCard
            label="Stale after"
            value={collection.staleAfterDays == null ? "Never" : `${collection.staleAfterDays}d`}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Sources" className="lg:col-span-2">
            {sources.length === 0 ? (
              <EmptyState title="No sources" body="Add sources into this collection from the Sources tab." />
            ) : (
              <ul className="divide-y divide-border">
                {sources.map((s) => (
                  <li
                    key={s.id}
                    className="flex cursor-pointer items-center justify-between px-4 py-3 hover:bg-muted/20"
                    onClick={() => nav(`/knowledge/sources/${s.id}`)}
                  >
                    <span className="text-sm font-medium">{s.name}</span>
                    <SourceStatusBadge status={s.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Access grants">
            <div className="space-y-3 p-4">
              {grants.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No explicit grants — only roles with org-wide knowledge perms can manage.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {grants.map((g) => (
                    <li
                      key={g.id}
                      className="flex items-center justify-between rounded border border-border px-2.5 py-1.5 text-xs"
                    >
                      <span>
                        <span className="font-medium">{g.role ?? g.userId}</span>
                        <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {g.level}
                        </span>
                      </span>
                      {canManage && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label="Revoke grant"
                          onClick={() =>
                            revokeGrant.mutate(g.id, {
                              onSuccess: () => toast.success("Grant revoked"),
                              onError: (e: Error) => toast.error(e.message),
                            })
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canManage && (
                <div className="flex items-center gap-1.5 border-t border-border pt-3">
                  <Select value={grantRole} onValueChange={setGrantRole}>
                    <SelectTrigger className="h-8 flex-1" aria-label="Grant role">
                      <SelectValue placeholder="Role" />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={grantLevel} onValueChange={(v) => setGrantLevel(v as "read" | "manage")}>
                    <SelectTrigger className="h-8 w-[100px]" aria-label="Grant level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">read</SelectItem>
                      <SelectItem value="manage">manage</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    className="h-8 w-8"
                    disabled={!grantRole || addGrant.isPending}
                    onClick={doAddGrant}
                    aria-label="Add grant"
                  >
                    {addGrant.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          </Card>
        </div>

        {collection.updatedAt && (
          <p className="text-[11px] text-muted-foreground">
            Updated {formatDistanceToNow(new Date(collection.updatedAt), { addSuffix: true })}
          </p>
        )}
      </div>
    </div>
  );
}
