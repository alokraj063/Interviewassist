// Coaching scenario detail — header with Edit / Publish / Duplicate / Archive
// (named confirm) / Assign / Preview-as-candidate, persona + objections + success
// criteria, recent runs, and a durable attributable Activity timeline (audit).
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Loader2,
  Pencil,
  Copy,
  Archive,
  ArchiveRestore,
  UserPlus,
  Eye,
  Play,
  Lock,
} from "lucide-react";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useCan } from "@/auth/AuthContext";
import { apiFetch } from "@/lib/api";
import {
  useScenario,
  useScenarioVerb,
  useUpdateScenario,
  useStartRun,
  LANGUAGE_LABELS,
} from "@/hooks/useCoaching";
import { ScenarioForm } from "@/components/coaching/ScenarioForm";
import { AssignDialog } from "@/components/coaching/AssignDialog";
import { ActivityTimeline } from "@/components/coaching/ActivityTimeline";

export default function CoachingDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const canWrite = useCan("coaching.write");
  const canAssign = useCan("coaching.assign");
  const canRun = useCan("coaching.run");

  const { data, isLoading, isError, refetch } = useScenario(id);
  const duplicate = useScenarioVerb("duplicate");
  const archive = useScenarioVerb("archive");
  const unarchive = useScenarioVerb("unarchive");
  const update = useUpdateScenario(id ?? "");
  const startRun = useStartRun();

  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [preview, setPreview] = useState<{ systemPrompt: string; firstMessage: string } | null>(null);

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10">
        <EmptyState
          title="Scenario not found"
          body="It may have been deleted or you don't have access."
          action={
            <Button size="sm" variant="outline" onClick={() => nav("/coaching")}>
              Back to Coaching
            </Button>
          }
        />
      </div>
    );
  }

  const s = data.scenario;
  const p = s.candidatePersona ?? {};

  function togglePublish() {
    update.mutate(
      { isPublished: !s.isPublished, expectedUpdatedAt: s.updatedAt },
      {
        onSuccess: () => toast.success(s.isPublished ? "Unpublished" : "Published"),
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  function doPreview() {
    apiFetch<{ systemPrompt: string; firstMessage: string }>(
      `/api/coaching/scenarios/${id}/preview`,
      { method: "POST" },
    )
      .then(setPreview)
      .catch((e: Error) => toast.error(e.message));
  }

  function practice() {
    startRun.mutate(
      { scenarioId: id!, mode: "ai_roleplay" },
      {
        onSuccess: (r) => nav(`/coaching/${id}/simulate?runId=${r.run.id}`),
        onError: (e: Error) => toast.error(e.message),
      },
    );
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Coaching", href: "/coaching" }, { label: s.title }]}
        title={s.title}
        subtitle={s.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canRun && (
              <Button size="sm" disabled={startRun.isPending} onClick={practice}>
                {startRun.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                )}
                Practice
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={doPreview}>
              <Eye className="mr-1.5 h-3.5 w-3.5" /> Preview
            </Button>
            {canAssign && (
              <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
                <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Assign
              </Button>
            )}
            {canWrite ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                </Button>
                <Button size="sm" variant="outline" disabled={update.isPending} onClick={togglePublish}>
                  {update.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {s.isPublished ? "Unpublish" : "Publish"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={duplicate.isPending}
                  onClick={() =>
                    duplicate.mutate(id!, {
                      onSuccess: (r) => {
                        toast.success("Duplicated");
                        nav(`/coaching/${r.scenario.id}`);
                      },
                      onError: (e: Error) => toast.error(e.message),
                    })
                  }
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> Duplicate
                </Button>
                {s.archivedAt ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unarchive.isPending}
                    onClick={() =>
                      unarchive.mutate(id!, {
                        onSuccess: () => toast.success("Restored"),
                        onError: (e: Error) => toast.error(e.message),
                      })
                    }
                  >
                    <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" /> Restore
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setArchiveOpen(true)}>
                    <Archive className="mr-1.5 h-3.5 w-3.5" /> Archive
                  </Button>
                )}
              </>
            ) : (
              <Button size="sm" variant="outline" disabled title="Requires coaching.write">
                <Lock className="mr-1.5 h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </div>
        }
      />

      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={s.isPublished ? "default" : "secondary"}>
            {s.isPublished ? "Published" : "Draft"}
          </Badge>
          {s.archivedAt && <Badge variant="destructive">Archived</Badge>}
          <span className="text-xs text-muted-foreground">
            {s.difficulty} · {LANGUAGE_LABELS[s.language]} · {s.estimatedMinutes} min · v{s.version}
          </span>
          {(s.tags ?? []).map((t) => (
            <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <div className="space-y-5 xl:col-span-2">
            <Card title="Candidate persona">
              <dl className="grid grid-cols-2 gap-3 p-4 text-sm">
                <Field label="Name" value={p.candidateName} />
                <Field label="Role" value={p.candidateRole} />
                <Field label="Company" value={p.currentCompany} />
                <Field label="Location" value={p.location} />
                <Field label="Experience" value={p.yearsExperience != null ? `${p.yearsExperience} yrs` : undefined} />
                <Field label="Notice period" value={p.noticePeriodDays != null ? `${p.noticePeriodDays} days` : undefined} />
                <Field label="Speaking style" value={p.speakingStyle} />
                <Field label="Resistance" value={p.resistance} />
              </dl>
              {p.hiddenContext && (
                <div className="border-t border-border p-4 text-sm">
                  <span className="text-xs font-semibold text-muted-foreground">Hidden context</span>
                  <p className="mt-1">{p.hiddenContext}</p>
                </div>
              )}
              {s.openingLine && (
                <div className="border-t border-border p-4 text-sm">
                  <span className="text-xs font-semibold text-muted-foreground">Opening line</span>
                  <p className="mt-1 italic">“{s.openingLine}”</p>
                </div>
              )}
            </Card>

            {(s.objections ?? []).length > 0 && (
              <Card title="Objections">
                <ul className="list-disc space-y-1 p-4 pl-8 text-sm">
                  {s.objections.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              </Card>
            )}

            {(s.successCriteria ?? []).length > 0 && (
              <Card title="Success criteria">
                <ul className="divide-y divide-border">
                  {s.successCriteria.map((c) => (
                    <li key={c.id} className="flex items-center justify-between p-3 text-sm">
                      <span>{c.label}</span>
                      <span className="text-xs text-muted-foreground">weight {c.weight}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Tabs defaultValue="runs">
              <TabsList>
                <TabsTrigger value="runs">Recent runs</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>
              <TabsContent value="runs">
                <Card>
                  {data.recentRuns.length === 0 ? (
                    <EmptyState title="No runs yet" body="Practice this scenario to see attempts here." />
                  ) : (
                    <div className="divide-y divide-border">
                      {data.recentRuns.map((r) => (
                        <button
                          key={r.id}
                          className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/20"
                          onClick={() => nav(`/coaching/${id}/results?runId=${r.id}`)}
                        >
                          <div>
                            <div className="text-sm font-medium">
                              {r.recruiterName ?? r.recruiterEmail}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {r.status} · {r.scoringStatus} ·{" "}
                              {formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}
                            </div>
                          </div>
                          <div className="text-lg font-semibold tabular-nums">
                            {r.cachedOverallScore != null ? Math.round(Number(r.cachedOverallScore)) : "—"}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </TabsContent>
              <TabsContent value="activity">
                <Card>
                  <div className="p-4">
                    <ActivityTimeline events={data.auditEvents} />
                  </div>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          <div className="space-y-5">
            <Card title="Linked rubric">
              <div className="p-4 text-sm">
                {s.targetRubricId ? (
                  <Button variant="link" className="h-auto p-0" onClick={() => nav(`/rubrics`)}>
                    View rubric
                  </Button>
                ) : (
                  <span className="text-muted-foreground">No rubric linked — scoring uses success criteria.</span>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>

      <ScenarioForm open={editOpen} onOpenChange={setEditOpen} editing={s} />
      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        scenarioId={id}
        scenarioTitle={s.title}
      />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive “{s.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived scenarios are hidden from the library and can't be practised. You can restore
              it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                archive.mutate(id!, {
                  onSuccess: () => {
                    toast.success("Scenario archived");
                    refetch();
                  },
                  onError: (e: Error) => toast.error(e.message),
                })
              }
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>AI candidate preview</AlertDialogTitle>
            <AlertDialogDescription>
              This is the compiled persona the AI candidate will use — no call is dialled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
            <div>
              <div className="text-xs font-semibold text-muted-foreground">First message</div>
              <p className="mt-1 italic">“{preview?.firstMessage}”</p>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted-foreground">System prompt</div>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {preview?.systemPrompt}
              </pre>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || "—"}</dd>
    </div>
  );
}
