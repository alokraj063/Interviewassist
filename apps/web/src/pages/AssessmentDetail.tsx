import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronLeft,
  Send,
  Pencil,
  Eye,
  Copy,
  Archive,
  BarChart3,
  CheckCircle2,
  Lock,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useTemplateDetail,
  useAudit,
  usePublishTemplate,
  useUnpublishTemplate,
  useDuplicateTemplate,
  useArchiveTemplate,
  ITEM_TYPE_LABELS,
  AUTO_GRADABLE,
  type ItemType,
} from "@/hooks/useAssessments";
import { InviteDialog } from "@/components/assessments/InviteDialog";
import { PreviewDialog } from "@/components/assessments/PreviewDialog";
import { ActivityTimeline } from "@/components/assessments/ActivityTimeline";

const ATTEMPT_STATUS_PILL: Record<string, string> = {
  invited: "bg-muted text-muted-foreground",
  started: "bg-info/15 text-info",
  submitted: "bg-warning/15 text-warning",
  reviewed: "bg-success/15 text-success",
  expired: "bg-destructive/15 text-destructive",
  revoked: "bg-destructive/10 text-destructive line-through",
};

export default function AssessmentDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("assessments.write");
  const canInvite = useCan("assessments.invite");

  const { data, isLoading, isError, error, refetch } = useTemplateDetail(id);
  const audit = useAudit(id);
  const publish = usePublishTemplate(id ?? "");
  const unpublish = useUnpublishTemplate(id ?? "");
  const duplicate = useDuplicateTemplate();
  const archive = useArchiveTemplate();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10 flex flex-col items-center gap-3 text-sm">
        <AlertTriangle className="w-7 h-7 text-destructive" />
        <div className="text-destructive">
          {(error as { body?: { error?: string } })?.body?.error ?? "Template not found."}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { template, items, recentAttempts, versions } = data;
  const published = template.status === "published";
  const gradable = items.filter((it) => AUTO_GRADABLE.includes(it.type)).length;
  const submitted = recentAttempts.filter((a) => a.status === "submitted").length;
  const reviewed = recentAttempts.filter((a) => a.status === "reviewed").length;
  const passed = recentAttempts.filter((a) => a.pass === true).length;

  const onPublish = async () => {
    try {
      const res = await publish.mutateAsync();
      toast.success(`Published v${res.version}`);
    } catch (err) {
      const body = (err as { body?: { error?: string; message?: string } })?.body;
      toast.error("Couldn't publish", { description: body?.message ?? body?.error ?? (err instanceof Error ? err.message : String(err)) });
    }
  };

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              <Link to="/assessments" className="text-muted-foreground hover:text-foreground" aria-label="Back to assessments">
                <ChevronLeft className="w-4 h-4" />
              </Link>
              {template.title}
              <span className={cn("pill text-[11px] capitalize", published ? "bg-success/15 text-success" : template.status === "archived" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                {template.status}
                {published && template.publishedVersion ? ` · v${template.publishedVersion}` : ""}
              </span>
            </span>
          }
          subtitle={template.description ?? undefined}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                <Eye className="w-3.5 h-3.5 mr-1.5" /> Preview
              </Button>
              <Button variant="outline" size="sm" onClick={() => nav(`/assessments/${id}/results`)}>
                <BarChart3 className="w-3.5 h-3.5 mr-1.5" /> Results
              </Button>
              {canWrite && (
                <Button variant="outline" size="sm" onClick={() => nav(`/assessments/${id}/build`)}>
                  <Pencil className="w-3.5 h-3.5 mr-1.5" /> Build
                </Button>
              )}
              {canWrite && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void duplicate.mutateAsync(id!).then((r) => {
                      toast.success("Duplicated to a new draft");
                      nav(`/assessments/${r.template.id}/build`);
                    });
                  }}
                  disabled={duplicate.isPending}
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" /> Duplicate
                </Button>
              )}
              {canWrite &&
                (published ? (
                  <Button variant="outline" size="sm" onClick={() => void unpublish.mutateAsync().then(() => toast.success("Unpublished"))} disabled={unpublish.isPending}>
                    {unpublish.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Lock className="w-3.5 h-3.5 mr-1.5" />}
                    Unpublish
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void onPublish()} disabled={publish.isPending || items.length === 0 || gradable === 0}>
                    {publish.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
                    Publish
                  </Button>
                ))}
              {canInvite ? (
                <Button size="sm" onClick={() => setInviteOpen(true)} disabled={!published}>
                  <Send className="w-3.5 h-3.5 mr-1.5" /> Invite
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button size="sm" disabled>
                        <Send className="w-3.5 h-3.5 mr-1.5" /> Invite
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Requires assessments.invite</TooltipContent>
                </Tooltip>
              )}
              {canWrite && template.status !== "archived" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => void archive.mutateAsync(id!).then(() => { toast.success("Archived"); nav("/assessments"); })}
                  disabled={archive.isPending}
                >
                  <Archive className="w-3.5 h-3.5 mr-1.5" /> Archive
                </Button>
              )}
            </div>
          }
        />

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="Questions" value={`${items.length} (${gradable} auto)`} />
            <MetricCard label="Pass score" value={`${template.passScore}%`} />
            <MetricCard label="Submitted" value={submitted} />
            <MetricCard label="Reviewed" value={reviewed} accent={passed > 0 ? "success" : "default"} />
          </div>

          {!published && (
            <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              This assessment is a draft. {canWrite ? "Add questions in the builder, then publish to invite candidates." : "Publish it before inviting candidates."}
            </div>
          )}

          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-7 space-y-4">
              <Card
                title="Questions"
                action={canWrite ? <Button size="sm" variant="outline" onClick={() => nav(`/assessments/${id}/build`)}><Pencil className="w-3.5 h-3.5 mr-1" /> Edit</Button> : undefined}
              >
                {items.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No questions yet. {canWrite ? "Open the builder to author typed questions." : "Awaiting authoring."}
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {items.map((q, i) => (
                      <li key={q.id} className="px-4 py-3">
                        <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
                          <span>Q{i + 1}</span>
                          <span className={cn("pill text-[10px]", AUTO_GRADABLE.includes(q.type) ? "bg-success/15 text-success" : "bg-muted text-muted-foreground")}>
                            {ITEM_TYPE_LABELS[q.type as ItemType]}
                          </span>
                          <span className="tabular-nums">{q.points} pt</span>
                        </div>
                        <div className="text-sm">{q.prompt}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Recent attempts">
                {recentAttempts.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No attempts yet. Invite candidates to start collecting results.
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {recentAttempts.map((a) => (
                      <li key={a.id} className="px-4 py-3 flex items-center justify-between text-sm">
                        <Link to={`/attempts/${a.id}`} className="font-medium hover:underline">
                          {a.candidateName ?? (a.candidateId ? a.candidateId.slice(0, 8) : "Unlinked")}
                        </Link>
                        <div className="flex items-center gap-3">
                          {a.totalScore != null && (
                            <span className={cn("tabular-nums text-sm font-semibold", a.pass ? "text-success" : a.pass === false ? "text-destructive" : "")}>
                              {a.totalScore}%{a.passBand ? ` · ${a.passBand}` : ""}
                            </span>
                          )}
                          <span className={cn("pill text-[11px] capitalize", ATTEMPT_STATUS_PILL[a.status])}>{a.status}</span>
                          <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="col-span-5 space-y-4">
              <Card title="Versions">
                {versions.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">Not published — no immutable versions yet.</div>
                ) : (
                  <ul className="divide-y divide-border">
                    {versions.map((v) => (
                      <li key={v.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
                        <span className="font-medium">v{v.version}{v.version === template.publishedVersion ? " · live" : ""}</span>
                        <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(v.publishedAt), { addSuffix: true })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Activity">
                <ActivityTimeline entries={audit.data?.entries} loading={audit.isLoading} />
              </Card>
            </div>
          </div>
        </div>

        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          templateId={id!}
          templatePublished={published}
          onInvited={() => void refetch()}
        />
        <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} templateId={id!} />
      </div>
    </TooltipProvider>
  );
}
