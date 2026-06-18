import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader, Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader2, Gavel, UserPlus, Download, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { getApiBase, getAccessToken } from "@/lib/api";
import {
  useProctorSession,
  useAckEvent,
  errMessage,
  type LiveState,
} from "@/hooks/useProctor";
import { RiskMeter } from "@/components/proctor/RiskMeter";
import { FeedGrid } from "@/components/proctor/FeedGrid";
import { IdentityPanel } from "@/components/proctor/IdentityPanel";
import { IncidentTimeline } from "@/components/proctor/IncidentTimeline";
import { InterventionBar } from "@/components/proctor/InterventionBar";
import { SyncedScrubber } from "@/components/proctor/SyncedScrubber";
import { ChainOfCustodyTab } from "@/components/proctor/ChainOfCustodyTab";
import { ReviewDialog } from "@/components/proctor/ReviewDialog";
import { AssignDialog } from "@/components/proctor/AssignDialog";

const LIVE_PILL: Record<LiveState, string> = {
  active: "bg-info/15 text-info",
  paused: "bg-warning/15 text-warning",
  ended: "bg-muted text-muted-foreground",
};
const DECISION_PILL: Record<string, string> = {
  clean: "bg-success/15 text-success",
  flagged: "bg-warning/15 text-warning",
  invalidated: "bg-destructive/15 text-destructive",
};

export default function ProctorSessionDetail() {
  const { id } = useParams<{ id: string }>();
  const canReview = useCan("proctoring.review");
  const canIntervene = useCan("proctoring.intervene");
  const canExport = useCan("proctoring.export");
  const ack = useAckEvent();

  const [reviewOpen, setReviewOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [scrubMs, setScrubMs] = useState(0);

  // Live sessions refetch; completed ones don't.
  const { data, isLoading, isError, error, refetch } = useProctorSession(id, undefined);
  const isLive = data?.session.liveState === "active";

  // Apply a refetch interval only while live by toggling the query key off the
  // refetch hook would need a separate instance — simplest is a manual refetch
  // button + react-query background refresh on focus, which suffices here.

  const session = data?.session;
  const events = data?.events ?? [];

  const durationMs = useMemo(() => {
    if (!session) return 0;
    const start = new Date(session.startedAt).getTime();
    const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
    const maxOffset = events.reduce((m, e) => Math.max(m, e.offsetMs ?? 0), 0);
    return Math.max(end - start, maxOffset, 60_000);
  }, [session, events]);

  const exportEvidence = async () => {
    if (!id) return;
    try {
      const token = getAccessToken();
      const res = await fetch(`${getApiBase()}/api/proctor/sessions/${id}/export?format=json`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`export ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `proctor-${id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Evidence manifest exported");
    } catch (e) {
      toast.error("Export failed", { description: errMessage(e) });
    }
  };

  if (isLoading) {
    return (
      <div className="p-10 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading session…
      </div>
    );
  }
  if (isError || !session || !id) {
    return (
      <div className="p-10 space-y-3">
        <p className="text-sm text-destructive">{isError ? errMessage(error) : "Session not found."}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  const candidateName = data?.candidate?.displayName ?? "Unlinked candidate";

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Proctor", href: "/proctor" }, { label: candidateName }]}
        title={candidateName}
        subtitle={`Session ${id.slice(0, 8)}…`}
        actions={
          <>
            {canReview && (
              <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
                <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Assign
              </Button>
            )}
            {canExport && (
              <Button variant="outline" size="sm" onClick={exportEvidence}>
                <Download className="w-3.5 h-3.5 mr-1.5" /> Export evidence
              </Button>
            )}
            {canReview && (
              <Button size="sm" onClick={() => setReviewOpen(true)}>
                <Gavel className="w-3.5 h-3.5 mr-1.5" /> {session.reviewerDecision ? "Re-review" : "Review"}
              </Button>
            )}
          </>
        }
      />

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-56">
            <RiskMeter score={session.riskScore} label={session.riskLabel} size="lg" />
          </div>
          <span className={cn("pill text-[11px] capitalize", LIVE_PILL[session.liveState])}>{session.liveState}</span>
          {session.reviewerDecision && (
            <span className={cn("pill text-[11px] capitalize", DECISION_PILL[session.reviewerDecision])}>
              decision: {session.reviewerDecision}
            </span>
          )}
          {data?.assignedReviewer && (
            <span className="text-xs text-muted-foreground">
              Reviewer: {data.assignedReviewer.name ?? "unnamed"}
            </span>
          )}
          {data?.candidate?.id && (
            <Link to={`/candidates/${data.candidate.id}`} className="text-xs text-primary hover:underline">
              View candidate profile
            </Link>
          )}
        </div>

        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-7 space-y-4">
            <Card title="Live feeds">
              <div className="p-4">
                <FeedGrid
                  streamMode={data?.streamMode ?? "snapshot"}
                  events={events}
                  liveState={session.liveState}
                  onExpand={(which) => toast.info(`${which} feed`, { description: "Expand opens the full-screen feed in live mode." })}
                />
              </div>
            </Card>

            {session.status !== "live" && (
              <Card title="Synced replay">
                <SyncedScrubber events={events} durationMs={durationMs} positionMs={scrubMs} onSeek={setScrubMs} />
              </Card>
            )}

            {canIntervene && session.liveState !== "ended" && (
              <Card title="Intervene">
                <InterventionBar sessionId={id} liveState={session.liveState} />
              </Card>
            )}
          </div>

          <div className="col-span-12 lg:col-span-5 space-y-4">
            <IdentityPanel sessionId={id} identity={data?.identity ?? null} canReview={canReview} />

            <Card>
              <Tabs defaultValue="incidents">
                <div className="px-4 pt-3">
                  <TabsList>
                    <TabsTrigger value="incidents">Incidents ({events.length})</TabsTrigger>
                    <TabsTrigger value="interventions">Interventions ({data?.interventions.length ?? 0})</TabsTrigger>
                    <TabsTrigger value="custody">Chain of custody</TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="incidents" className="mt-0">
                  <IncidentTimeline
                    events={events}
                    activeOffsetMs={scrubMs}
                    onJump={(ms) => setScrubMs(ms ?? 0)}
                    onAck={(eventId) =>
                      ack.mutate(
                        { eventId, sessionId: id },
                        { onError: (e) => toast.error("Ack failed", { description: errMessage(e) }) },
                      )
                    }
                    canReview={canReview}
                  />
                </TabsContent>
                <TabsContent value="interventions" className="mt-0">
                  {(data?.interventions.length ?? 0) === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground">No interventions on this session.</div>
                  ) : (
                    <ul className="divide-y divide-border max-h-[520px] overflow-y-auto">
                      {data!.interventions.map((iv) => (
                        <li key={iv.id} className="px-4 py-2.5 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium capitalize">{iv.kind}</span>
                            <span className="text-xs text-muted-foreground">
                              {iv.actorName ?? (iv.actorUserId ? "reviewer" : "system")}
                            </span>
                          </div>
                          {iv.message && <p className="text-xs text-muted-foreground mt-0.5">{iv.message}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
                <TabsContent value="custody" className="mt-0">
                  <ChainOfCustodyTab sessionId={id} />
                </TabsContent>
              </Tabs>
            </Card>
          </div>
        </div>
      </div>

      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        sessionId={id}
        candidateName={candidateName}
        alreadyDecided={!!session.reviewerDecision}
        onDone={() => refetch()}
      />
      <AssignDialog open={assignOpen} onOpenChange={setAssignOpen} sessionIds={[id]} onDone={() => refetch()} />
    </div>
  );
}
