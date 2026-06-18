import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Plus,
  ClipboardList,
  Search,
  X,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Send,
  Ban,
  Download,
  Copy,
  Archive,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { apiFetch, getApiBase, getAccessToken } from "@/lib/api";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useTemplatesList,
  useAttemptsList,
  useInvalidateAssessments,
  type AttemptStatus,
  type TemplateStatus,
} from "@/hooks/useAssessments";
import { NewTemplateDialog } from "@/components/assessments/NewTemplateDialog";

const TEMPLATE_STATUS_PILL: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-success/15 text-success",
  archived: "bg-destructive/10 text-destructive",
};
const ATTEMPT_STATUS_PILL: Record<string, string> = {
  invited: "bg-muted text-muted-foreground",
  started: "bg-info/15 text-info",
  submitted: "bg-warning/15 text-warning",
  reviewed: "bg-success/15 text-success",
  expired: "bg-destructive/15 text-destructive",
  revoked: "bg-destructive/10 text-destructive line-through",
};

type Tab = "templates" | "attempts";

export default function Assessments() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const canWrite = useCan("assessments.write");
  const canInvite = useCan("assessments.invite");
  const invalidate = useInvalidateAssessments();

  const tab = (params.get("tab") as Tab) ?? "templates";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const sort = params.get("sort") ?? "createdAt.desc";
  const cursor = params.get("cursor") ?? undefined;

  const [searchInput, setSearchInput] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Debounced search → URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== q) patch({ q: searchInput.trim() || undefined, cursor: undefined });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  function patch(next: Record<string, string | undefined>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
    setSelected(new Set());
  }

  function setTab(t: Tab) {
    patch({ tab: t === "templates" ? undefined : t, status: undefined, q: undefined, cursor: undefined });
    setSearchInput("");
  }

  const templatesQ = useTemplatesList({
    status: tab === "templates" ? status || undefined : undefined,
    q: tab === "templates" ? q || undefined : undefined,
    sort,
    cursor: tab === "templates" ? cursor : undefined,
  });
  const attemptsQ = useAttemptsList({
    status: tab === "attempts" ? status || undefined : undefined,
    q: tab === "attempts" ? q || undefined : undefined,
    sort,
    cursor: tab === "attempts" ? cursor : undefined,
  });

  const active = tab === "templates" ? templatesQ : attemptsQ;
  const total =
    tab === "templates" ? templatesQ.data?.total ?? 0 : attemptsQ.data?.total ?? 0;
  const nextCursor =
    tab === "templates" ? templatesQ.data?.nextCursor : attemptsQ.data?.nextCursor;
  const hasFilters = !!(status || q);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ----- bulk actions -----
  const bulkArchive = async () => {
    await Promise.all(
      [...selected].map((id) =>
        apiFetch(`/api/assessments/templates/${id}`, { method: "DELETE" }).catch(() => null),
      ),
    );
    toast.success(`Archived ${selected.size} template(s)`);
    invalidate();
    setSelected(new Set());
  };
  const bulkDuplicate = async () => {
    await Promise.all(
      [...selected].map((id) =>
        apiFetch(`/api/assessments/templates/${id}/duplicate`, { method: "POST" }).catch(() => null),
      ),
    );
    toast.success(`Duplicated ${selected.size} template(s)`);
    invalidate();
    setSelected(new Set());
  };
  const bulkReminder = async () => {
    await Promise.all(
      [...selected].map((id) =>
        apiFetch(`/api/assessments/attempts/${id}/resend`, { method: "POST" }).catch(() => null),
      ),
    );
    toast.success(`Sent reminders for ${selected.size} attempt(s)`);
    invalidate();
    setSelected(new Set());
  };
  const bulkRevoke = async () => {
    await Promise.all(
      [...selected].map((id) =>
        apiFetch(`/api/assessments/attempts/${id}/revoke`, { method: "POST" }).catch(() => null),
      ),
    );
    toast.success(`Revoked ${selected.size} invite(s)`);
    invalidate();
    setSelected(new Set());
  };

  const statusOptions =
    tab === "templates"
      ? (["draft", "published", "archived"] as TemplateStatus[])
      : (["invited", "started", "submitted", "reviewed", "expired", "revoked"] as AttemptStatus[]);

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          title="Assessments"
          subtitle="Author structured tests, invite candidates, auto-grade objective items, and review results."
          actions={
            canWrite ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                New template
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> New template
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Requires assessments.write</TooltipContent>
              </Tooltip>
            )
          }
        />

        <div className="px-6 pt-4 border-b border-border bg-background flex gap-1">
          {(["templates", "attempts"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px capitalize",
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <MetricCard
              label={tab === "templates" ? "Templates" : "Attempts"}
              value={total}
            />
            <MetricCard
              label="Showing"
              value={`${(active.data ? (tab === "templates" ? templatesQ.data!.templates.length : attemptsQ.data!.attempts.length) : 0)}`}
            />
            <MetricCard label="Sort" value={sort.startsWith("createdAt") ? "Recent" : "A–Z"} />
          </div>

          {/* filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={tab === "templates" ? "Search titles…" : "Search candidates…"}
                className="pl-8 h-9"
                aria-label="Search"
              />
            </div>
            <Select value={status || "all"} onValueChange={(v) => patch({ status: v === "all" ? undefined : v, cursor: undefined })}>
              <SelectTrigger className="w-40 h-9">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => patch({ sort: v, cursor: undefined })}>
              <SelectTrigger className="w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="createdAt.desc">Newest first</SelectItem>
                <SelectItem value="createdAt.asc">Oldest first</SelectItem>
                {tab === "templates" && <SelectItem value="title.asc">Title A–Z</SelectItem>}
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchInput("");
                  patch({ status: undefined, q: undefined, cursor: undefined });
                }}
              >
                <X className="w-3.5 h-3.5 mr-1" /> Clear filters
              </Button>
            )}
          </div>

          {/* bulk bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              {tab === "templates" && canWrite && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void bulkDuplicate()}>
                    <Copy className="w-3.5 h-3.5 mr-1" /> Duplicate
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void bulkArchive()}>
                    <Archive className="w-3.5 h-3.5 mr-1" /> Archive
                  </Button>
                </>
              )}
              {tab === "attempts" && canInvite && (
                <>
                  <Button size="sm" variant="outline" onClick={() => void bulkReminder()}>
                    <Send className="w-3.5 h-3.5 mr-1" /> Send reminder
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void bulkRevoke()}>
                    <Ban className="w-3.5 h-3.5 mr-1" /> Revoke
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* table */}
          {active.isLoading ? (
            <Card>
              <div className="p-4 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </Card>
          ) : active.isError ? (
            <Card>
              <div className="p-6 flex flex-col items-center gap-3 text-sm">
                <AlertTriangle className="w-7 h-7 text-destructive" />
                <div className="text-destructive">
                  {(active.error as { body?: { error?: string } })?.body?.error ??
                    (active.error instanceof Error ? active.error.message : "Failed to load")}
                </div>
                <Button size="sm" variant="outline" onClick={() => void active.refetch()}>
                  Retry
                </Button>
              </div>
            </Card>
          ) : tab === "templates" ? (
            templatesQ.data!.templates.length === 0 ? (
              <EmptyBlock filtered={hasFilters} canWrite={canWrite} onCreate={() => setCreateOpen(true)} onClear={() => { setSearchInput(""); patch({ status: undefined, q: undefined }); }} kind="templates" />
            ) : (
              <Card>
                <table className="data-table">
                  <thead>
                    <tr>
                      {canWrite && <th className="w-8"></th>}
                      <th>Title</th>
                      <th>Status</th>
                      <th>Questions</th>
                      <th>Duration</th>
                      <th>Pass</th>
                      <th>Proctored</th>
                      <th>Attempts</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templatesQ.data!.templates.map((t) => (
                      <tr key={t.id} className="hover:bg-muted/30">
                        {canWrite && (
                          <td onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selected.has(t.id)}
                              onCheckedChange={() => toggle(t.id)}
                              aria-label={`Select ${t.title}`}
                            />
                          </td>
                        )}
                        <td>
                          <button
                            className="text-left hover:underline font-medium"
                            onClick={() => nav(`/assessments/${t.id}`)}
                          >
                            {t.title}
                          </button>
                        </td>
                        <td>
                          <span className={cn("pill text-[11px] capitalize", TEMPLATE_STATUS_PILL[t.status])}>
                            {t.status}
                            {t.status === "published" && t.publishedVersion ? ` · v${t.publishedVersion}` : ""}
                          </span>
                        </td>
                        <td className="tabular-nums">{t.itemCount}</td>
                        <td className="text-xs">{t.durationMins ? `${t.durationMins} min` : "—"}</td>
                        <td className="tabular-nums">{t.passScore}%</td>
                        <td className="text-xs">{t.proctoringEnabled ? "Yes" : "—"}</td>
                        <td className="tabular-nums">{t.attemptCount}</td>
                        <td className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(t.updatedAt), { addSuffix: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          ) : attemptsQ.data!.attempts.length === 0 ? (
            <EmptyBlock filtered={hasFilters} canWrite={false} onClear={() => { setSearchInput(""); patch({ status: undefined, q: undefined }); }} kind="attempts" />
          ) : (
            <Card>
              <table className="data-table">
                <thead>
                  <tr>
                    {canInvite && <th className="w-8"></th>}
                    <th>Candidate</th>
                    <th>Template</th>
                    <th>Status</th>
                    <th>Score</th>
                    <th>Proctor</th>
                    <th>Reminders</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {attemptsQ.data!.attempts.map((a) => (
                    <tr key={a.id} className="hover:bg-muted/30">
                      {canInvite && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(a.id)}
                            onCheckedChange={() => toggle(a.id)}
                            aria-label="Select attempt"
                          />
                        </td>
                      )}
                      <td>
                        <Link to={`/attempts/${a.id}`} className="hover:underline font-medium">
                          {a.candidateName ?? (a.candidateId ? a.candidateId.slice(0, 8) : "Unlinked")}
                        </Link>
                      </td>
                      <td>
                        <Link to={`/assessments/${a.templateId}`} className="hover:underline text-xs">
                          {a.templateTitle ?? "—"}
                        </Link>
                      </td>
                      <td>
                        <span className={cn("pill text-[11px] capitalize", ATTEMPT_STATUS_PILL[a.status])}>
                          {a.status}
                        </span>
                      </td>
                      <td className="tabular-nums">
                        {a.totalScore == null ? (
                          "—"
                        ) : (
                          <span className={a.pass ? "text-success font-semibold" : a.pass === false ? "text-destructive" : ""}>
                            {a.totalScore}%{a.passBand ? ` · ${a.passBand}` : ""}
                          </span>
                        )}
                      </td>
                      <td className="text-xs">{a.proctorFlags > 0 ? `${a.proctorFlags} session(s)` : "—"}</td>
                      <td className="tabular-nums text-xs">{a.remindersSent || "—"}</td>
                      <td className="text-xs text-muted-foreground">
                        {a.submittedAt ? formatDistanceToNow(new Date(a.submittedAt), { addSuffix: true }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* pagination */}
          {active.data && !active.isError && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Showing {tab === "templates" ? templatesQ.data!.templates.length : attemptsQ.data!.attempts.length} of {total}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!cursor}
                  onClick={() => patch({ cursor: undefined })}
                >
                  <ChevronLeft className="w-3.5 h-3.5 mr-1" /> First
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!nextCursor}
                  onClick={() => patch({ cursor: nextCursor ?? undefined })}
                >
                  Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>

        <NewTemplateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(tpl) => nav(`/assessments/${tpl.id}/build`)}
        />
      </div>
    </TooltipProvider>
  );
}

function EmptyBlock({
  filtered,
  canWrite,
  onCreate,
  onClear,
  kind,
}: {
  filtered: boolean;
  canWrite: boolean;
  onCreate?: () => void;
  onClear: () => void;
  kind: "templates" | "attempts";
}) {
  if (filtered) {
    return (
      <Card>
        <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Search className="w-8 h-8 opacity-30" />
          <div>No {kind} match these filters.</div>
          <Button size="sm" variant="outline" onClick={onClear}>
            <X className="w-3.5 h-3.5 mr-1" /> Clear filters
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
        <ClipboardList className="w-8 h-8 opacity-30" />
        {kind === "templates" ? (
          <>
            <div>No assessments yet — create your first test.</div>
            {canWrite && onCreate && (
              <Button size="sm" onClick={onCreate}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> New template
              </Button>
            )}
          </>
        ) : (
          <div>No attempts yet. Publish a template and invite candidates from its detail page.</div>
        )}
      </div>
    </Card>
  );
}

// kept for CSV-export helpers in detail/results pages
export function resultsCsvUrl(templateId: string): string {
  const token = getAccessToken();
  return `${getApiBase()}/api/assessments/templates/${templateId}/results/export.csv${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}
export { Download };
