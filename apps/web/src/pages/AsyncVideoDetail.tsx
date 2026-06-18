import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  ChevronLeft,
  Plus,
  Trash2,
  Save,
  Copy,
  Send,
  Ban,
  Archive,
  Eye,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useCan } from "@/auth/AuthContext";
import {
  useCampaign,
  useAddQuestion,
  useUpdateQuestion,
  useDeleteQuestion,
  useReorderQuestions,
  usePublishCampaign,
  useUnpublishCampaign,
  useArchiveCampaign,
  useDuplicateCampaign,
  useRemindSubmission,
  useRevokeSubmission,
  type Question,
} from "@/hooks/useAsyncVideo";
import { InvitePanel } from "@/components/async-video/InvitePanel";

const SUB_STATUS_PILL: Record<string, string> = {
  invited: "bg-muted text-muted-foreground",
  started: "bg-info/15 text-info",
  submitted: "bg-warning/15 text-warning",
  reviewed: "bg-success/15 text-success",
  expired: "bg-destructive/15 text-destructive",
};

export default function AsyncVideoDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("async_video.write");
  const canInvite = useCan("async_video.invite");

  const { data, isLoading, isError, error, refetch } = useCampaign(id);
  const addQ = useAddQuestion(id ?? "");
  const reorder = useReorderQuestions(id ?? "");
  const publish = usePublishCampaign(id ?? "");
  const unpublish = useUnpublishCampaign(id ?? "");
  const archive = useArchiveCampaign();
  const duplicate = useDuplicateCampaign();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="p-10 flex flex-col items-start gap-3 text-sm">
        <div className="text-destructive">
          {(error as { body?: { error?: string } })?.body?.error ?? (error instanceof Error ? error.message : "Failed to load")}
        </div>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
  }
  if (!data) {
    return <div className="p-10 text-sm text-destructive">Campaign not found.</div>;
  }

  const { campaign, questions, submissions, counts } = data;
  const published = campaign.status === "published";

  const doPublish = async () => {
    try {
      await publish.mutateAsync();
      toast.success("Published");
    } catch (err) {
      const code = (err as { body?: { error?: string } }).body?.error;
      toast.error(code === "no_questions" ? "Add at least one question before publishing" : "Couldn't publish", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          breadcrumbs={[{ label: "Async video", href: "/async-video" }, { label: campaign.title }]}
          title={
            <span className="flex items-center gap-2">
              <Link to="/async-video" className="text-muted-foreground hover:text-foreground">
                <ChevronLeft className="w-4 h-4" />
              </Link>
              {campaign.title}
              <span className={cn("pill text-[11px] capitalize", {
                "bg-success/15 text-success": campaign.status === "published",
                "bg-muted text-muted-foreground": campaign.status === "draft",
                "bg-destructive/10 text-destructive": campaign.status === "archived",
              })}>
                {campaign.status} · v{campaign.version}
              </span>
            </span>
          }
          subtitle={campaign.introText ?? undefined}
          actions={
            <div className="flex gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
                    <Eye className="w-3.5 h-3.5 mr-1.5" /> Preview
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Preview the candidate runtime</TooltipContent>
              </Tooltip>
              {canWrite && (
                <>
                  <Button variant="outline" size="sm" onClick={() => { void duplicate.mutateAsync(id!).then((r) => nav(`/async-video/${r.campaign.id}`)); }}>
                    <Copy className="w-3.5 h-3.5 mr-1.5" /> Duplicate
                  </Button>
                  {published ? (
                    <Button variant="outline" size="sm" onClick={() => { void unpublish.mutateAsync().then(() => toast.success("Unpublished")); }}>
                      Unpublish
                    </Button>
                  ) : campaign.status === "draft" ? (
                    <Button size="sm" onClick={() => void doPublish()} disabled={publish.isPending}>
                      {publish.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                      Publish
                    </Button>
                  ) : null}
                  {campaign.status !== "archived" && (
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => setArchiveOpen(true)}>
                      <Archive className="w-3.5 h-3.5 mr-1.5" /> Archive
                    </Button>
                  )}
                </>
              )}
            </div>
          }
        />

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="Questions" value={questions.length} />
            <MetricCard label="Submissions" value={counts.total} />
            <MetricCard label="Submitted" value={counts.submitted} accent={counts.submitted > 0 ? "warning" : "default"} />
            <MetricCard label="Reviewed" value={counts.reviewed} accent="success" />
          </div>

          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-7 space-y-4">
              <Card
                title="Script builder"
                action={
                  canWrite ? (
                    <Button size="sm" variant="outline" onClick={() => addQ.mutate({ text: "New question — click to edit", prepSeconds: 30, maxSeconds: 120, maxRetakes: 0 })} disabled={addQ.isPending}>
                      <Plus className="w-3.5 h-3.5 mr-1" /> Add question
                    </Button>
                  ) : undefined
                }
              >
                {questions.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No questions yet{canWrite ? " — add a few to build the screen." : "."}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {questions.map((qn, i) => (
                      <QuestionRow
                        key={qn.id}
                        question={qn}
                        index={i}
                        total={questions.length}
                        campaignId={id!}
                        canWrite={canWrite}
                        onMove={(dir) => {
                          const ids = questions.map((x) => x.id);
                          const next = i + dir;
                          if (next < 0 || next >= ids.length) return;
                          [ids[i], ids[next]] = [ids[next], ids[i]];
                          reorder.mutate(ids);
                        }}
                      />
                    ))}
                  </div>
                )}
              </Card>

              {campaign.outroText && (
                <Card title="Outro">
                  <div className="p-4 text-sm text-muted-foreground">{campaign.outroText}</div>
                </Card>
              )}
            </div>

            <div className="col-span-5 space-y-4">
              {canInvite && published && <InvitePanel campaignId={id!} />}
              {canInvite && !published && (
                <Card title="Invite candidates">
                  <div className="p-4 text-sm text-muted-foreground">Publish this campaign to start inviting candidates.</div>
                </Card>
              )}

              <Card title={`Submissions (${submissions.length})`}>
                {submissions.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">No submissions yet.</div>
                ) : (
                  <ul className="divide-y divide-border">
                    {submissions.map((s) => (
                      <li key={s.id} className="px-4 py-3 flex items-center justify-between text-sm gap-2">
                        <div className="min-w-0">
                          <button
                            className="font-medium hover:underline truncate text-left"
                            onClick={() => nav(`/async-video/${id}/submissions/${s.id}`)}
                          >
                            {s.candidateName ?? (s.candidateId ? s.candidateId.slice(0, 8) : "Unlinked")}
                          </button>
                          <div className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
                            {s.reminderCount > 0 ? ` · ${s.reminderCount} reminder(s)` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={cn("pill text-[11px] capitalize", SUB_STATUS_PILL[s.status])}>{s.status}</span>
                          {canInvite && (s.status === "invited" || s.status === "started") && (
                            <InviteActions submissionId={s.id} token={s.inviteToken} campaignId={id!} />
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>

        <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive “{campaign.title}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The campaign will be hidden from the active list and can no longer receive new submissions. Existing
                submissions remain reviewable. This is a soft delete.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { void archive.mutateAsync(id!).then(() => { toast.success("Archived"); nav("/async-video"); }); }}
              >
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Preview — candidate view</DialogTitle>
              <DialogDescription>
                This is what the candidate sees when they open the invite link. Read-only — no recording happens here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <div className="text-base font-semibold">{campaign.title}</div>
                {campaign.introText && (
                  <p className="text-sm text-muted-foreground mt-1">{campaign.introText}</p>
                )}
                {campaign.requireDeviceCheck && (
                  <p className="text-xs text-muted-foreground mt-2">
                    A camera / mic / bandwidth check is shown before the first question.
                  </p>
                )}
              </div>
              {questions.length === 0 ? (
                <div className="text-sm text-muted-foreground">No questions yet — add some to preview the screen.</div>
              ) : (
                <ol className="space-y-2">
                  {questions.map((qn, i) => (
                    <li key={qn.id} className="rounded border border-border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">Q{i + 1}. {qn.text}</span>
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap capitalize">{qn.kind}</span>
                      </div>
                      {qn.stimulusText && (
                        <div className="text-xs text-muted-foreground mt-1">Stimulus: {qn.stimulusText}</div>
                      )}
                      <div className="text-[11px] text-muted-foreground mt-1.5">
                        {qn.prepSeconds}s prep · up to {qn.maxSeconds}s answer · {qn.maxRetakes} retake{qn.maxRetakes === 1 ? "" : "s"}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {campaign.outroText && (
                <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                  {campaign.outroText}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

function InviteActions({ submissionId, token, campaignId }: { submissionId: string; token: string; campaignId: string }) {
  const remind = useRemindSubmission(campaignId);
  const revoke = useRevokeSubmission(campaignId);
  const link = `${window.location.origin}/async-video/submit/${token}`;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(link); toast.success("Link copied"); }} aria-label="Copy invite link">
        <Copy className="w-3.5 h-3.5" />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { remind.mutate(submissionId, { onSuccess: () => toast.success("Reminder sent"), onError: (e) => toast.error((e as { body?: { error?: string } }).body?.error ?? "Reminder failed") }); }} aria-label="Send reminder" disabled={remind.isPending}>
        <Send className="w-3.5 h-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { revoke.mutate(submissionId, { onSuccess: () => toast.success("Invite revoked") }); }} aria-label="Revoke invite" disabled={revoke.isPending}>
        <Ban className="w-3.5 h-3.5" />
      </Button>
    </>
  );
}

function QuestionRow({
  question,
  index,
  total,
  campaignId,
  canWrite,
  onMove,
}: {
  question: Question;
  index: number;
  total: number;
  campaignId: string;
  canWrite: boolean;
  onMove: (dir: -1 | 1) => void;
}) {
  const [text, setText] = useState(question.text);
  const [prep, setPrep] = useState(question.prepSeconds);
  const [take, setTake] = useState(question.maxSeconds);
  const [retakes, setRetakes] = useState(question.maxRetakes);
  const [competency, setCompetency] = useState(question.competencyKey ?? "");
  const update = useUpdateQuestion(campaignId);
  const del = useDeleteQuestion(campaignId);

  const dirty =
    text !== question.text ||
    prep !== question.prepSeconds ||
    take !== question.maxSeconds ||
    retakes !== question.maxRetakes ||
    (competency || "") !== (question.competencyKey ?? "");

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-start gap-2">
        {canWrite && (
          <div className="flex flex-col text-muted-foreground pt-1">
            <button className="text-xs hover:text-foreground disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">▲</button>
            <button className="text-xs hover:text-foreground disabled:opacity-30" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move down">▼</button>
          </div>
        )}
        <div className="flex-1 space-y-2">
          <div className="text-xs text-muted-foreground">Q{index + 1}{question.competencyKey ? ` · ${question.competencyKey}` : ""}</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!canWrite}
            className="w-full text-sm border border-border rounded p-2 min-h-[56px] disabled:bg-muted/30"
            aria-label={`Question ${index + 1} text`}
          />
          {canWrite && (
            <div className="grid grid-cols-4 gap-2">
              <NumField label="Prep (s)" value={prep} min={0} max={600} onChange={setPrep} />
              <NumField label="Take (s)" value={take} min={15} max={600} onChange={setTake} />
              <NumField label="Retakes" value={retakes} min={0} max={5} onChange={setRetakes} />
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Competency</label>
                <Input value={competency} onChange={(e) => setCompetency(e.target.value)} className="h-8" aria-label={`Question ${index + 1} competency`} />
              </div>
            </div>
          )}
          {!canWrite && (
            <div className="text-xs text-muted-foreground flex gap-3">
              <span>Prep {question.prepSeconds}s</span>
              <span>Take {question.maxSeconds}s</span>
              <span>Retakes {question.maxRetakes}</span>
            </div>
          )}
        </div>
        {canWrite && (
          <div className="flex flex-col gap-1">
            {dirty && (
              <Button size="sm" onClick={() => update.mutate({ questionId: question.id, body: { text, prepSeconds: prep, maxSeconds: take, maxRetakes: retakes, competencyKey: competency || null } }, { onSuccess: () => toast.success("Saved") })} disabled={update.isPending}>
                <Save className="w-3.5 h-3.5 mr-1" /> Save
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => del.mutate(question.id)} aria-label={`Delete question ${index + 1}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function NumField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] text-muted-foreground">{label}</label>
      <Input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8" aria-label={label} />
    </div>
  );
}
