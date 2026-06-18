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
  Video,
  Search,
  X,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Archive,
  Send,
  Star,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useCampaigns,
  useQueue,
  useArchiveCampaign,
  useInvite,
  useInvalidateAsyncVideo,
} from "@/hooks/useAsyncVideo";
import { CampaignBuilderDialog } from "@/components/async-video/CampaignBuilderDialog";

const CAMPAIGN_STATUS_PILL: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-success/15 text-success",
  archived: "bg-destructive/10 text-destructive",
};
const SUB_STATUS_PILL: Record<string, string> = {
  invited: "bg-muted text-muted-foreground",
  started: "bg-info/15 text-info",
  submitted: "bg-warning/15 text-warning",
  reviewed: "bg-success/15 text-success",
  expired: "bg-destructive/15 text-destructive",
};
const DECISION_PILL: Record<string, string> = {
  forward: "bg-success/15 text-success",
  hold: "bg-warning/15 text-warning",
  reject: "bg-destructive/15 text-destructive",
};

type Tab = "campaigns" | "queue";

export default function AsyncVideo() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const canWrite = useCan("async_video.write");
  const canInvite = useCan("async_video.invite");
  const invalidate = useInvalidateAsyncVideo();
  const archive = useArchiveCampaign();
  const invite = useInvite();

  const tab = (params.get("tab") as Tab) ?? "campaigns";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const sort = params.get("sort") ?? (tab === "campaigns" ? "updated" : "created");
  const cursor = params.get("cursor") ?? undefined;
  const shortlisted = params.get("shortlisted") ?? "";

  const [searchInput, setSearchInput] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
    patch({ tab: t === "campaigns" ? undefined : t, status: undefined, q: undefined, sort: undefined, cursor: undefined, shortlisted: undefined });
    setSearchInput("");
  }

  const campaignsQ = useCampaigns({
    status: tab === "campaigns" ? status || undefined : undefined,
    q: tab === "campaigns" ? q || undefined : undefined,
    sort: tab === "campaigns" ? sort : undefined,
    cursor: tab === "campaigns" ? cursor : undefined,
  });
  const queueQ = useQueue({
    status: tab === "queue" ? status || undefined : undefined,
    q: tab === "queue" ? q || undefined : undefined,
    shortlisted: tab === "queue" ? shortlisted || undefined : undefined,
    sort: tab === "queue" ? sort : undefined,
    cursor: tab === "queue" ? cursor : undefined,
  });

  const active = tab === "campaigns" ? campaignsQ : queueQ;
  const total = tab === "campaigns" ? campaignsQ.data?.total ?? 0 : queueQ.data?.total ?? 0;
  const nextCursor = tab === "campaigns" ? campaignsQ.data?.nextCursor : queueQ.data?.nextCursor;
  const shown = tab === "campaigns" ? campaignsQ.data?.campaigns.length ?? 0 : queueQ.data?.submissions.length ?? 0;
  const hasFilters = !!(status || q || shortlisted);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ----- bulk actions -----
  const bulkArchive = async () => {
    await Promise.all([...selected].map((id) => archive.mutateAsync(id).catch(() => null)));
    toast.success(`Archived ${selected.size} campaign(s)`);
    setSelected(new Set());
  };
  const bulkInviteUnlinked = async () => {
    // Bulk-create unlinked invite links across the selected published campaigns
    // (recruiter can then distribute them). Linked bulk invite lives in the
    // campaign builder's candidate picker.
    let made = 0;
    await Promise.all(
      [...selected].map((campaignId) =>
        invite.mutateAsync({ campaignId }).then(() => { made += 1; }).catch(() => null),
      ),
    );
    toast.success(`Created ${made} invite link(s)`);
    invalidate();
    setSelected(new Set());
  };

  const statusOptions =
    tab === "campaigns"
      ? (["draft", "published", "archived"] as const)
      : (["invited", "started", "submitted", "reviewed", "expired"] as const);

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          title="Async video screening"
          subtitle="Author multi-question video screens, invite candidates, then review and score from a multi-reviewer cockpit."
          actions={
            canWrite ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> New campaign
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" disabled>
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> New campaign
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Requires async_video.write</TooltipContent>
              </Tooltip>
            )
          }
        />

        <div className="px-6 pt-4 border-b border-border bg-background flex gap-1" role="tablist" aria-label="Async video views">
          {(["campaigns", "queue"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px capitalize",
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "queue" ? "Review queue" : "Campaigns"}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <MetricCard label={tab === "campaigns" ? "Campaigns" : "Submissions"} value={total} />
            <MetricCard label="Showing" value={shown} />
            <MetricCard label="Filtered" value={hasFilters ? "Yes" : "No"} />
          </div>

          {/* filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-64">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={tab === "campaigns" ? "Search titles…" : "Search candidates…"}
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
            {tab === "queue" && (
              <Select value={shortlisted || "all"} onValueChange={(v) => patch({ shortlisted: v === "all" ? undefined : v, cursor: undefined })}>
                <SelectTrigger className="w-40 h-9">
                  <SelectValue placeholder="Shortlist" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All candidates</SelectItem>
                  <SelectItem value="true">Shortlisted</SelectItem>
                  <SelectItem value="false">Not shortlisted</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select value={sort} onValueChange={(v) => patch({ sort: v, cursor: undefined })}>
              <SelectTrigger className="w-44 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tab === "campaigns" ? (
                  <>
                    <SelectItem value="updated">Recently updated</SelectItem>
                    <SelectItem value="created">Newest first</SelectItem>
                    <SelectItem value="title">Title A–Z</SelectItem>
                  </>
                ) : (
                  <>
                    <SelectItem value="created">Newest first</SelectItem>
                    <SelectItem value="submitted">Recently submitted</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchInput("");
                  patch({ status: undefined, q: undefined, shortlisted: undefined, cursor: undefined });
                }}
              >
                <X className="w-3.5 h-3.5 mr-1" /> Clear filters
              </Button>
            )}
          </div>

          {/* bulk bar (campaigns only) */}
          {tab === "campaigns" && selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              {canInvite && (
                <Button size="sm" variant="outline" onClick={() => void bulkInviteUnlinked()}>
                  <Send className="w-3.5 h-3.5 mr-1" /> Bulk invite link
                </Button>
              )}
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => void bulkArchive()}>
                  <Archive className="w-3.5 h-3.5 mr-1" /> Archive
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
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
                <Button size="sm" variant="outline" onClick={() => void active.refetch()}>Retry</Button>
              </div>
            </Card>
          ) : tab === "campaigns" ? (
            campaignsQ.data!.campaigns.length === 0 ? (
              <EmptyBlock
                filtered={hasFilters}
                canWrite={canWrite}
                onCreate={() => setCreateOpen(true)}
                onClear={() => { setSearchInput(""); patch({ status: undefined, q: undefined }); }}
                kind="campaigns"
              />
            ) : (
              <Card>
                <table className="data-table">
                  <thead>
                    <tr>
                      {canWrite && <th className="w-8"></th>}
                      <th>Title</th>
                      <th>Demand</th>
                      <th>Status</th>
                      <th>Questions</th>
                      <th>Submitted</th>
                      <th>Reviewed</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignsQ.data!.campaigns.map((c) => (
                      <tr key={c.id} className="hover:bg-muted/30">
                        {canWrite && (
                          <td onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={`Select ${c.title}`} />
                          </td>
                        )}
                        <td>
                          <button className="text-left hover:underline font-medium" onClick={() => nav(`/async-video/${c.id}`)}>
                            {c.title}
                          </button>
                        </td>
                        <td className="text-xs">{c.demandTitle ?? "—"}</td>
                        <td>
                          <span className={cn("pill text-[11px] capitalize", CAMPAIGN_STATUS_PILL[c.status])}>{c.status}</span>
                        </td>
                        <td className="tabular-nums">{c.questionCount}</td>
                        <td className="tabular-nums">{c.submittedCount}</td>
                        <td className="tabular-nums">{c.reviewedCount}</td>
                        <td className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )
          ) : queueQ.data!.submissions.length === 0 ? (
            <EmptyBlock
              filtered={hasFilters}
              canWrite={false}
              onClear={() => { setSearchInput(""); patch({ status: undefined, q: undefined, shortlisted: undefined }); }}
              kind="queue"
            />
          ) : (
            <Card>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Decision</th>
                    <th>Scorecards</th>
                    <th>AI</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {queueQ.data!.submissions.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/30">
                      <td>
                        <button
                          className="text-left hover:underline font-medium flex items-center gap-1"
                          onClick={() => nav(`/async-video/${s.campaignId}/submissions/${s.id}`)}
                        >
                          {s.shortlisted && <Star className="w-3 h-3 text-amber-500 fill-amber-500" />}
                          {s.candidateName ?? (s.candidateId ? s.candidateId.slice(0, 8) : "Unlinked")}
                        </button>
                      </td>
                      <td>
                        <Link to={`/async-video/${s.campaignId}`} className="hover:underline text-xs">
                          {s.campaignTitle ?? "—"}
                        </Link>
                      </td>
                      <td>
                        <span className={cn("pill text-[11px] capitalize", SUB_STATUS_PILL[s.status])}>{s.status}</span>
                      </td>
                      <td>
                        {s.reviewerDecision ? (
                          <span className={cn("pill text-[11px] capitalize", DECISION_PILL[s.reviewerDecision])}>
                            {s.reviewerDecision}
                            {s.reviewerScore != null ? ` · ${s.reviewerScore}` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="tabular-nums">{s.scorecardCount || "—"}</td>
                      <td className="text-xs capitalize text-muted-foreground">{s.aiSummaryStatus ?? "—"}</td>
                      <td className="text-xs text-muted-foreground">
                        {s.submittedAt ? formatDistanceToNow(new Date(s.submittedAt), { addSuffix: true }) : "—"}
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
              <span>Showing {shown} of {total}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={!cursor} onClick={() => patch({ cursor: undefined })}>
                  <ChevronLeft className="w-3.5 h-3.5 mr-1" /> First
                </Button>
                <Button size="sm" variant="outline" disabled={!nextCursor} onClick={() => patch({ cursor: nextCursor ?? undefined })}>
                  Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>

        <CampaignBuilderDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(c) => nav(`/async-video/${c.id}`)} />
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
  kind: "campaigns" | "queue";
}) {
  if (filtered) {
    return (
      <Card>
        <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Search className="w-8 h-8 opacity-30" />
          <div>No {kind === "queue" ? "submissions" : "campaigns"} match these filters.</div>
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
        <Video className="w-8 h-8 opacity-30" />
        {kind === "campaigns" ? (
          <>
            <div>Create your first video screen.</div>
            {canWrite && onCreate && (
              <Button size="sm" onClick={onCreate}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> New campaign
              </Button>
            )}
          </>
        ) : (
          <div>No submissions yet. Publish a campaign and invite candidates from its detail page.</div>
        )}
      </div>
    </Card>
  );
}
