import { useEffect, useState } from "react";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import {
  Building,
  ChevronDown,
  ChevronRight,
  ThumbsUp,
  ThumbsDown,
  PauseCircle,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";

interface PortalMe {
  client: {
    id: string;
    companyName: string;
    industry: string | null;
  };
  user: { id: string; email: string; name: string | null };
}

interface PortalDemand {
  id: string;
  title: string;
  designation: string | null;
  primaryLocation: string | null;
  numberOfOpenings: number;
  status: string;
  createdAt: string;
  submitted: number;
  awaitingFeedback: number;
  inInterview: number;
  offered: number;
}

interface PortalSubmission {
  id: string;
  currentStage: string;
  submittedAt: string;
  recruiterNote: string | null;
  candidateId: string | null;
  candidateName: string | null;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  currentCompany: string | null;
  totalExperienceYears: string | null;
  expectedCtcLakhs: string | null;
  noticePeriodDays: number | null;
  latestFeedback: {
    decision: "forward" | "hold" | "reject";
    note: string | null;
    createdAt: string;
  } | null;
}

const STAGE_LABEL: Record<string, string> = {
  applied: "Applied",
  internal_review: "Internal review",
  client_submit: "Client review",
  l1_scheduled: "L1 scheduled",
  l2_scheduled: "L2 scheduled",
  l3_scheduled: "L3 scheduled",
  final_select: "Final select",
  offer_pending: "Offer pending",
  offer_released: "Offer released",
  offer_accepted: "Offer accepted",
};

const STAGE_PILL: Record<string, string> = {
  client_submit: "bg-warning/15 text-warning",
  l1_scheduled: "bg-info/15 text-info",
  l2_scheduled: "bg-violet-100 text-violet-700",
  l3_scheduled: "bg-violet-100 text-violet-700",
  final_select: "bg-success/15 text-success",
  offer_pending: "bg-warning/15 text-warning",
  offer_released: "bg-success/15 text-success",
  offer_accepted: "bg-success/15 text-success",
};

const FB_PILL: Record<string, string> = {
  forward: "bg-success/15 text-success",
  hold: "bg-warning/15 text-warning",
  reject: "bg-destructive/15 text-destructive",
};

export default function ClientPortal() {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [demands, setDemands] = useState<PortalDemand[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [expandedDemandId, setExpandedDemandId] = useState<string | null>(null);
  const [demandSubs, setDemandSubs] = useState<Record<string, PortalSubmission[]>>({});
  const [feedbackForId, setFeedbackForId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch<PortalMe>("/api/client-portal/me"),
      apiFetch<{ demands: PortalDemand[] }>("/api/client-portal/demands"),
    ])
      .then(([m, d]) => {
        if (cancelled) return;
        setMe(m);
        setDemands(d.demands);
        if (d.demands.length > 0) setExpandedDemandId(d.demands[0].id);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // 403 client_user_required is the expected response for non-buyer
        // users (recruiters, admins). Render a friendly explainer instead
        // of toasting an error that the recruiter can't act on.
        if (/403/.test(msg) || /client_user_required/.test(msg)) {
          setAccessError("client_user_required");
        } else {
          toast.error("Couldn't load your portal", { description: msg });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSubs = async (demandId: string) => {
    if (demandSubs[demandId]) return;
    try {
      const res = await apiFetch<{
        submissions: PortalSubmission[];
      }>(`/api/client-portal/demands/${demandId}/submissions`);
      setDemandSubs((s) => ({ ...s, [demandId]: res.submissions }));
    } catch (err) {
      toast.error("Couldn't load submissions", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const submitFeedback = async (
    submissionId: string,
    decision: "forward" | "hold" | "reject",
    note: string,
  ) => {
    try {
      await apiFetch(`/api/client-portal/submissions/${submissionId}/feedback`, {
        method: "POST",
        json: { decision, note: note || undefined },
      });
      toast.success(
        decision === "forward"
          ? "Marked: Move forward"
          : decision === "reject"
          ? "Marked: Reject"
          : "Marked: Hold",
      );
      // Refresh the affected demand's submission list
      const affectedDemandId = Object.entries(demandSubs).find(([, subs]) =>
        subs.some((s) => s.id === submissionId),
      )?.[0];
      if (affectedDemandId) {
        const res = await apiFetch<{ submissions: PortalSubmission[] }>(
          `/api/client-portal/demands/${affectedDemandId}/submissions`,
        );
        setDemandSubs((s) => ({ ...s, [affectedDemandId]: res.submissions }));
      }
      setFeedbackForId(null);
    } catch (err) {
      toast.error("Feedback save failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (loading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your portal…
      </div>
    );
  }

  if (accessError === "client_user_required") {
    return (
      <div>
        <PageHeader
          title="Client portal"
          subtitle="The buyer-facing view of submissions for one client."
        />
        <div className="p-10">
          <div className="bg-card border border-border rounded-xl p-6 max-w-xl mx-auto">
            <div className="flex items-start gap-3">
              <Building className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-semibold mb-1">This page is for client users.</div>
                <div className="text-muted-foreground">
                  Your account is logged in as an internal recruiter / admin, so the
                  buyer-side portal isn't visible. To preview it, sign in as a user
                  whose membership has <code>role = client_user</code> and a
                  populated <code>client_id</code>. The recruiter-side equivalent
                  lives under <strong>Demands</strong> and <strong>Submissions</strong>.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="p-10 text-sm text-destructive">
        Your account isn't linked to a client. Ask your recruiter to set it up.
      </div>
    );
  }

  const totalActive = demands.length;
  const totalAwaiting = demands.reduce((s, d) => s + d.awaitingFeedback, 0);
  const totalInterview = demands.reduce((s, d) => s + d.inInterview, 0);
  const totalOffered = demands.reduce((s, d) => s + d.offered, 0);

  return (
    <div>
      <PageHeader
        title={`${me.client.companyName} — Client Portal`}
        subtitle="Review submissions, give feedback, and track your hiring funnel"
      />
      <div className="p-6 space-y-5">
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex items-start gap-3">
          <Building className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold">
              Welcome{me.user.name ? `, ${me.user.name}` : ""}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              You're seeing demands for {me.client.companyName}. Feedback you submit
              here is delivered to your recruiter pod immediately.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Active demands" value={totalActive} />
          <MetricCard
            label="Awaiting your feedback"
            value={totalAwaiting}
            accent={totalAwaiting > 0 ? "warning" : "default"}
          />
          <MetricCard label="In interview" value={totalInterview} />
          <MetricCard label="Offers extended" value={totalOffered} accent="success" />
        </div>

        {demands.length === 0 ? (
          <Card>
            <div className="p-6 text-sm text-muted-foreground">
              No active demands yet — your recruiter will publish here once roles are
              live.
            </div>
          </Card>
        ) : (
          <div className="space-y-3">
            {demands.map((d) => {
              const isExpanded = expandedDemandId === d.id;
              const subs = demandSubs[d.id] ?? [];
              return (
                <Card key={d.id}>
                  <button
                    onClick={() => {
                      const next = isExpanded ? null : d.id;
                      setExpandedDemandId(next);
                      if (next) void loadSubs(next);
                    }}
                    className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{d.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.numberOfOpenings} opening
                        {d.numberOfOpenings !== 1 ? "s" : ""}
                        {d.primaryLocation ? ` · ${d.primaryLocation}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <Stat label="Submitted" value={d.submitted} />
                      <Stat
                        label="Awaiting"
                        value={d.awaitingFeedback}
                        highlight={d.awaitingFeedback > 0}
                      />
                      <Stat label="Interviewing" value={d.inInterview} />
                      <Stat label="Offered" value={d.offered} />
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-border">
                      {subs.length === 0 ? (
                        <div className="p-4 text-sm text-muted-foreground">
                          No submissions visible yet.
                        </div>
                      ) : (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Candidate</th>
                              <th>Experience</th>
                              <th>Current company</th>
                              <th>Expected CTC</th>
                              <th>Notice</th>
                              <th>Stage</th>
                              <th>Latest feedback</th>
                              <th>Submitted</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {subs.map((s) => {
                              const fallbackName =
                                [s.candidateFirstName, s.candidateLastName]
                                  .filter(Boolean)
                                  .join(" ") || "—";
                              const display = s.candidateName ?? fallbackName;
                              return (
                                <tr key={s.id} className="hover:bg-muted/40">
                                  <td>
                                    <span className="text-sm font-medium">{display}</span>
                                  </td>
                                  <td className="text-sm tabular-nums">
                                    {s.totalExperienceYears
                                      ? `${parseFloat(s.totalExperienceYears).toFixed(1)} yrs`
                                      : "—"}
                                  </td>
                                  <td className="text-sm">{s.currentCompany ?? "—"}</td>
                                  <td className="text-sm tabular-nums">
                                    {s.expectedCtcLakhs
                                      ? `${parseFloat(s.expectedCtcLakhs).toFixed(1)} LPA`
                                      : "—"}
                                  </td>
                                  <td className="text-sm tabular-nums">
                                    {s.noticePeriodDays != null ? `${s.noticePeriodDays}d` : "—"}
                                  </td>
                                  <td>
                                    <span
                                      className={cn(
                                        "pill text-[11px]",
                                        STAGE_PILL[s.currentStage] ?? "bg-muted text-muted-foreground",
                                      )}
                                    >
                                      {STAGE_LABEL[s.currentStage] ?? s.currentStage}
                                    </span>
                                  </td>
                                  <td>
                                    {s.latestFeedback ? (
                                      <span
                                        className={cn(
                                          "pill text-[11px] capitalize",
                                          FB_PILL[s.latestFeedback.decision],
                                        )}
                                      >
                                        {s.latestFeedback.decision}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground text-xs">—</span>
                                    )}
                                  </td>
                                  <td className="text-xs text-muted-foreground">
                                    {formatDistanceToNow(new Date(s.submittedAt), {
                                      addSuffix: true,
                                    })}
                                  </td>
                                  <td>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-xs"
                                      onClick={() => setFeedbackForId(s.id)}
                                    >
                                      <MessageSquare className="w-3.5 h-3.5 mr-1" />
                                      Feedback
                                    </Button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {feedbackForId && (
        <FeedbackModal
          submissionId={feedbackForId}
          onClose={() => setFeedbackForId(null)}
          onSubmit={(decision, note) => submitFeedback(feedbackForId, decision, note)}
        />
      )}
    </div>
  );
}

function FeedbackModal({
  submissionId,
  onClose,
  onSubmit,
}: {
  submissionId: string;
  onClose: () => void;
  onSubmit: (decision: "forward" | "hold" | "reject", note: string) => void | Promise<void>;
}) {
  const [decision, setDecision] = useState<"forward" | "hold" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-[480px] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-1">Give feedback</div>
        <div className="text-xs text-muted-foreground mb-4">
          Submission {submissionId.slice(0, 8)}… · Your recruiter is notified the moment
          you submit.
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <Button
            variant={decision === "forward" ? "default" : "outline"}
            size="sm"
            onClick={() => setDecision("forward")}
          >
            <ThumbsUp className="w-3.5 h-3.5 mr-1.5" />
            Forward
          </Button>
          <Button
            variant={decision === "hold" ? "default" : "outline"}
            size="sm"
            onClick={() => setDecision("hold")}
          >
            <PauseCircle className="w-3.5 h-3.5 mr-1.5" />
            Hold
          </Button>
          <Button
            variant={decision === "reject" ? "default" : "outline"}
            size="sm"
            onClick={() => setDecision("reject")}
          >
            <ThumbsDown className="w-3.5 h-3.5 mr-1.5" />
            Reject
          </Button>
        </div>
        <textarea
          className="w-full text-sm border border-border rounded p-2 min-h-[100px]"
          placeholder="Note for your recruiter (optional)…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!decision || submitting}
            onClick={async () => {
              if (!decision) return;
              setSubmitting(true);
              try {
                await onSubmit(decision, note);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className={cn("min-w-[60px] text-center", highlight && "text-warning")}>
      <div className={cn("text-sm font-semibold tabular-nums", highlight && "text-warning")}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
    </div>
  );
}
