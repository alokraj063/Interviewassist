import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader, Card } from "@/components/ui-kit";
import { apiFetch } from "@/lib/api";
import {
  useDemand,
  useDemandProspects,
  useDemandSubmissions,
} from "@/hooks/useDemands";
import {
  useDisqualifyProspect,
  usePromoteProspect,
  useUpdateProspectStatus,
  type DisqualificationReason,
  type ProspectStatus,
} from "@/hooks/useProspects";
import { Loader2, Star, ChevronLeft, MapPin, Briefcase, Users, Activity, Sparkles, FileText, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

const PROBING_LABELS: Array<{ key: string; label: string }> = [
  { key: "workMode", label: "Work mode" },
  { key: "noticePeriod", label: "Notice period" },
  { key: "interviewType", label: "Interview type" },
  { key: "feedbackEta", label: "Feedback ETA" },
  { key: "urgency", label: "Urgency" },
  { key: "candidateRole", label: "Candidate role detail" },
  { key: "reportingManagerLocation", label: "Reporting manager location" },
];

const TAXONOMY_LABELS: Array<{ key: string; label: string }> = [
  { key: "industry", label: "Industry" },
  { key: "functionalArea", label: "Functional area" },
  { key: "roleCategory", label: "Role category" },
  { key: "jobRole", label: "Job role" },
];

const STAGE_LABELS: Record<string, string> = {
  applied: "Applied",
  internal_review: "Internal review",
  internal_reject: "Internal reject",
  client_submit: "Client submit",
  client_screen_reject: "Client screen reject",
  l1_scheduled: "L1 scheduled",
  l1_no_show: "L1 no-show",
  l1_reject: "L1 reject",
  l1_select: "L1 select",
  l2_scheduled: "L2 scheduled",
  l2_no_show: "L2 no-show",
  l2_reject: "L2 reject",
  l2_select: "L2 select",
  l3_scheduled: "L3 scheduled",
  l3_no_show: "L3 no-show",
  l3_reject: "L3 reject",
  l3_select: "L3 select",
  final_select: "Final select",
  on_hold: "On hold",
  position_closed: "Position closed",
  panel_unavailable: "Panel unavailable",
  duplicate_profile: "Duplicate profile",
  offer_pending: "Offer pending",
  offer_released: "Offer released",
  offer_accepted: "Offer accepted",
  offer_rejected: "Offer rejected",
  onboarded: "Onboarded",
  exited: "Exited",
  withdrawn: "Withdrawn",
};

const PROSPECT_BUCKETS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "new", label: "New", statuses: ["new"] },
  { key: "contacted", label: "Contacted", statuses: ["contacted"] },
  { key: "interested", label: "Interested", statuses: ["interested"] },
  { key: "qualified", label: "Qualified", statuses: ["qualified"] },
  { key: "submitted", label: "Submitted", statuses: ["submitted"] },
  { key: "disqualified", label: "Disqualified", statuses: ["disqualified", "not_interested", "unreachable", "parked"] },
];

export default function DemandDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useDemand(id);
  const { data: prospects = [] } = useDemandProspects(id);
  const { data: submissions = [] } = useDemandSubmissions(id);
  const [tab, setTab] = useState("overview");
  const updateStatus = useUpdateProspectStatus(id);
  const promote = usePromoteProspect(id);
  const disqualify = useDisqualifyProspect(id);

  async function moveProspect(prospectId: string, status: ProspectStatus) {
    try {
      await updateStatus.mutateAsync({ id: prospectId, status });
      toast.success(`Moved to ${status.replace(/_/g, " ")}`);
    } catch {
      toast.error("Couldn't move the prospect.");
    }
  }
  async function promoteProspect(prospectId: string) {
    try {
      const result = await promote.mutateAsync(prospectId);
      toast.success(`Submission ${result.submissionId.slice(0, 8)}… created at internal_review.`);
    } catch (err: unknown) {
      const apiError = err as { body?: { error?: string } };
      if (apiError?.body?.error === "already_submitted") {
        toast.warning("This prospect is already submitted.");
      } else {
        toast.error("Couldn't promote prospect.");
      }
    }
  }
  async function disqualifyProspect(prospectId: string) {
    const reason = window.prompt(
      "Disqualification reason — one of: experience_mismatch, skill_mismatch, location_mismatch, compensation_mismatch, notice_period_mismatch, not_interested, unreachable, duplicate, other",
      "experience_mismatch",
    );
    if (!reason) return;
    try {
      await disqualify.mutateAsync({ id: prospectId, reason: reason as DisqualificationReason });
      toast.success("Prospect disqualified.");
    } catch {
      toast.error("Disqualify failed (was the reason valid?).");
    }
  }

  if (isLoading) {
    return (
      <div className="p-10 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading demand…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-10 text-sm text-destructive">Demand not found or you don't have access to it.</div>
    );
  }

  const { demand, clientName, industryName, jobRoleName, skills, locations, assignments } = data;
  const taxonomy = (demand.metadata?.taxonomy ?? null) as Record<string, string> | null;
  const taxonomyChips = TAXONOMY_LABELS.map((t) => {
    const value = taxonomy?.[t.key];
    if (!value) return null;
    return { label: t.label, value };
  }).filter((x): x is { label: string; value: string } => !!x);
  const probingEntries = demand.probingDetails
    ? PROBING_LABELS.map((p) => {
        const raw = (demand.probingDetails as Record<string, unknown> | null)?.[p.key];
        if (raw === null || raw === undefined || raw === "") return null;
        return { label: p.label, value: String(raw) };
      }).filter((x): x is { label: string; value: string } => !!x)
    : [];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/demands" className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="w-4 h-4" />
            </Link>
            {demand.isVip && <Star className="w-4 h-4 text-warning fill-warning/30" />}
            {demand.title}
          </span>
        }
        subtitle={`${clientName ?? "—"} · ${demand.primaryLocation ?? "Remote / TBD"}`}
      />
      <div className="px-6 pt-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview"><Briefcase className="w-3.5 h-3.5 mr-1.5" />Overview</TabsTrigger>
            <TabsTrigger value="jd"><FileText className="w-3.5 h-3.5 mr-1.5" />JD</TabsTrigger>
            <TabsTrigger value="prospects"><Users className="w-3.5 h-3.5 mr-1.5" />Prospects ({prospects.length})</TabsTrigger>
            <TabsTrigger value="submissions"><Users className="w-3.5 h-3.5 mr-1.5" />Submissions ({submissions.length})</TabsTrigger>
            <TabsTrigger value="activity"><Activity className="w-3.5 h-3.5 mr-1.5" />Activity</TabsTrigger>
            <TabsTrigger value="insights"><Sparkles className="w-3.5 h-3.5 mr-1.5" />Insights</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Card title="Role">
                <dl className="text-sm grid grid-cols-2 gap-y-2 p-4">
                  <dt className="text-muted-foreground">Demand ID</dt>
                  <dd className="font-mono text-xs flex flex-wrap items-baseline gap-x-3">
                    <span title={demand.id}>{demand.id.slice(0, 8)}…</span>
                    {demand.externalOfferLetterDemandId != null && (
                      <span
                        className="text-muted-foreground"
                        title="Offer Letter job_postings.id — use this when tracing back to the source database"
                      >
                        OL #{demand.externalOfferLetterDemandId}
                      </span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Title</dt><dd>{demand.title}</dd>
                  <dt className="text-muted-foreground">Designation</dt><dd>{demand.designation ?? "—"}</dd>
                  <dt className="text-muted-foreground">Job role</dt><dd>{taxonomy?.jobRole ?? jobRoleName ?? "—"}</dd>
                  <dt className="text-muted-foreground">Industry</dt><dd>{taxonomy?.industry ?? industryName ?? "—"}</dd>
                  <dt className="text-muted-foreground">Status</dt><dd>{demand.status}</dd>
                  <dt className="text-muted-foreground">VIP</dt><dd>{demand.isVip ? "Yes" : "No"}</dd>
                  <dt className="text-muted-foreground">Group / sub</dt><dd>{[demand.groupName, demand.subGroupName].filter(Boolean).join(" / ") || "—"}</dd>
                  <dt
                    className="text-muted-foreground"
                    title="Demand creation timestamp from the Offer Letter database (preserved on first sync)."
                  >
                    Created
                  </dt>
                  <dd title={format(new Date(demand.createdAt), "PPpp")}>
                    {formatDistanceToNow(new Date(demand.createdAt), { addSuffix: true })}
                  </dd>
                  <dt
                    className="text-muted-foreground"
                    title="Last time the sync detected a change to this demand. Sync runs every few minutes; the timestamp only advances on real changes."
                  >
                    Last changed
                  </dt>
                  <dd title={format(new Date(demand.updatedAt), "PPpp")}>
                    {formatDistanceToNow(new Date(demand.updatedAt), { addSuffix: true })}
                  </dd>
                </dl>
              </Card>
              <Card title="Numbers">
                <dl className="text-sm grid grid-cols-2 gap-y-2 p-4">
                  <dt className="text-muted-foreground">Openings</dt><dd>{demand.numberOfOpenings}</dd>
                  <dt className="text-muted-foreground">Max submissions</dt><dd>{demand.maxSubmissions ?? "—"}</dd>
                  <dt className="text-muted-foreground">Experience</dt><dd>{demand.experienceMinYears ?? "?"}–{demand.experienceMaxYears ?? "?"} yrs</dd>
                  <dt className="text-muted-foreground">Salary band</dt><dd>₹{demand.salaryFrom ?? "?"}–{demand.salaryTo ?? "?"} LPA</dd>
                  <dt className="text-muted-foreground">Requested by</dt><dd>{demand.requestedBy ?? "—"}</dd>
                  <dt className="text-muted-foreground">Requested</dt><dd>{demand.requestedDate ?? "—"}</dd>
                  <dt className="text-muted-foreground">Closure target</dt><dd>{demand.expectedClosureDate ?? "—"}</dd>
                  <dt className="text-muted-foreground">Client ticket</dt><dd>{demand.clientInternalTicketId ?? "—"}</dd>
                </dl>
              </Card>
              {taxonomyChips.length > 0 && (
                <Card title="Taxonomy">
                  <div className="p-4 flex flex-wrap gap-2">
                    {taxonomyChips.map((c) => (
                      <span
                        key={c.label}
                        className="pill bg-muted text-muted-foreground"
                        title={c.label}
                      >
                        <span className="font-medium text-foreground">{c.label}:</span>
                        <span className="ml-1">{c.value}</span>
                      </span>
                    ))}
                  </div>
                </Card>
              )}
              <Card title="Locations">
                <div className="p-4 flex flex-wrap gap-2">
                  {locations.length === 0 && <span className="text-sm text-muted-foreground">No locations set.</span>}
                  {locations.map((l) => (
                    <span key={l.locationId} className="pill bg-muted text-muted-foreground">
                      <MapPin className="inline w-3 h-3 mr-1" />
                      {l.city}{l.state ? `, ${l.state}` : ""}
                    </span>
                  ))}
                </div>
              </Card>
              <Card title="Recruiters assigned">
                <div className="p-4 space-y-2">
                  {assignments.length === 0 && <div className="text-sm text-muted-foreground">No recruiters assigned yet.</div>}
                  {assignments.map((a) => (
                    <div key={a.recruiterId} className="flex items-center justify-between text-sm">
                      <div>
                        <div>{a.recruiterName ?? a.recruiterEmail}</div>
                        <div className="text-xs text-muted-foreground">Assigned {formatDistanceToNow(new Date(a.assignedAt), { addSuffix: true })}</div>
                      </div>
                      <span className="pill bg-success/15 text-success">{a.status}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="jd" className="pt-4">
            <Card title="Job description">
              <div className="p-4 text-sm whitespace-pre-line leading-relaxed">
                {demand.description ?? <span className="text-muted-foreground">No description provided.</span>}
              </div>
            </Card>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Card title="Responsibilities">
                <div className="p-4 text-sm whitespace-pre-line leading-relaxed">
                  {demand.responsibilities ?? <span className="text-muted-foreground">No responsibilities listed.</span>}
                </div>
              </Card>
              <Card title="Skills">
                <div className="p-4 space-y-3">
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1.5">Must-have</div>
                    <div className="flex flex-wrap gap-1.5">
                      {skills.filter((s) => s.isMandatory).length === 0 && <span className="text-sm text-muted-foreground">None set.</span>}
                      {skills.filter((s) => s.isMandatory).map((s) => (
                        <span key={s.skillId} className="pill bg-primary/15 text-primary">{s.name}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase text-muted-foreground mb-1.5">Nice-to-have</div>
                    <div className="flex flex-wrap gap-1.5">
                      {skills.filter((s) => !s.isMandatory).length === 0 && <span className="text-sm text-muted-foreground">None set.</span>}
                      {skills.filter((s) => !s.isMandatory).map((s) => (
                        <span key={s.skillId} className="pill bg-muted text-muted-foreground">{s.name}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
            {probingEntries.length > 0 && (
              <Card title="Probing details" className="mt-4">
                <dl className="text-sm grid grid-cols-2 gap-y-2 p-4">
                  {probingEntries.map((p) => (
                    <span key={p.label} className="contents">
                      <dt className="text-muted-foreground">{p.label}</dt>
                      <dd>{p.value}</dd>
                    </span>
                  ))}
                </dl>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="prospects" className="pt-4">
            <div className="grid grid-cols-6 gap-3">
              {PROSPECT_BUCKETS.map((bucket) => {
                const inBucket = prospects.filter((p) => bucket.statuses.includes(p.status));
                return (
                  <Card key={bucket.key} title={`${bucket.label} (${inBucket.length})`}>
                    <div className="p-2 space-y-2 max-h-[60vh] overflow-y-auto">
                      {inBucket.length === 0 && (
                        <div className="text-xs text-muted-foreground p-2">Empty</div>
                      )}
                      {inBucket.map((p) => (
                        <div key={p.id} className="border border-border rounded-md p-2 text-xs space-y-1 bg-card">
                          <Link to={`/candidates/${p.candidateId}`} className="font-medium text-foreground hover:underline block">
                            {p.candidateName ?? "—"}
                          </Link>
                          <div className="text-muted-foreground">
                            {p.currentTitle} · {p.currentCompany}
                          </div>
                          <div className="text-muted-foreground">
                            Recruiter: {p.recruiterName ?? p.recruiterEmail}
                          </div>
                          {p.lastContactedAt && (
                            <div className="text-muted-foreground">
                              Last touch {formatDistanceToNow(new Date(p.lastContactedAt), { addSuffix: true })}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-1 pt-1.5">
                            {bucket.key !== "submitted" && bucket.key !== "disqualified" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-1.5 text-[10px]"
                                onClick={() => promoteProspect(p.id)}
                              >
                                <ArrowRight className="w-3 h-3 mr-0.5" />Promote
                              </Button>
                            )}
                            {bucket.key === "new" && (
                              <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => moveProspect(p.id, "contacted")}>
                                Contacted
                              </Button>
                            )}
                            {bucket.key === "contacted" && (
                              <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => moveProspect(p.id, "interested")}>
                                Interested
                              </Button>
                            )}
                            {bucket.key === "interested" && (
                              <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => moveProspect(p.id, "qualified")}>
                                Qualified
                              </Button>
                            )}
                            {bucket.key !== "disqualified" && bucket.key !== "submitted" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-1.5 text-[10px] text-destructive border-destructive/40 hover:bg-destructive/10"
                                onClick={() => disqualifyProspect(p.id)}
                              >
                                <X className="w-3 h-3 mr-0.5" />DQ
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="submissions" className="pt-4">
            <Card>
              {submissions.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No submissions yet on this demand.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Current title</th>
                      <th>Recruiter</th>
                      <th>Stage</th>
                      <th>Submitted</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((s) => (
                      <tr key={s.id} className="hover:bg-muted/40">
                        <td>{s.candidateName ?? "—"}</td>
                        <td className="text-sm text-muted-foreground">
                          {s.currentTitle ?? "—"}
                          {s.currentCompany ? ` @ ${s.currentCompany}` : ""}
                        </td>
                        <td className="text-sm">{s.recruiterName ?? "—"}</td>
                        <td>
                          <span className={cn(
                            "pill",
                            s.currentStage.includes("reject") || s.currentStage.includes("withdrawn") || s.currentStage.includes("exited")
                              ? "bg-destructive/15 text-destructive"
                              : s.currentStage.includes("offer") || s.currentStage.includes("onboarded") || s.currentStage.includes("select")
                                ? "bg-success/15 text-success"
                                : "bg-muted text-muted-foreground",
                          )}>
                            {STAGE_LABELS[s.currentStage] ?? s.currentStage}
                          </span>
                        </td>
                        <td className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(s.submittedAt), { addSuffix: true })}
                        </td>
                        <td className="text-sm">{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="activity" className="pt-4">
            <Card>
              <div className="p-6 text-sm text-muted-foreground">
                Activity timeline coming soon. The audit log will show every prospect status change, submission stage transition, recruiter assignment, and call associated with this demand.
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="insights" className="pt-4">
            <DemandInsightsTab demandId={id ?? null} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

interface InsightsResponse {
  stageFunnel: Array<{ stage: string; n: number }>;
  recruiterLeaderboard: Array<{
    recruiterUserId: string | null;
    recruiterName: string | null;
    recruiterEmail: string | null;
    total: number;
    active: number;
  }>;
  sourceMix: Array<{ source: string; n: number }>;
  avgTimeToSubmitHours: number | null;
}

function DemandInsightsTab({ demandId }: { demandId: string | null }) {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!demandId) return;
    let cancelled = false;
    apiFetch<InsightsResponse>(`/api/demands/${demandId}/insights`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [demandId]);

  if (loading) {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground">Loading insights…</div>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <div className="p-6 text-sm text-muted-foreground">No insights available.</div>
      </Card>
    );
  }
  const total = data.stageFunnel.reduce((s, x) => s + x.n, 0);
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-6 space-y-3">
        <Card title="Stage funnel">
          {data.stageFunnel.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No submissions yet.</div>
          ) : (
            <ul className="divide-y divide-border">
              {data.stageFunnel
                .sort((a, b) => b.n - a.n)
                .map((s) => (
                  <li key={s.stage} className="px-4 py-2 flex items-center justify-between">
                    <span className="text-sm capitalize">{s.stage.replace(/_/g, " ")}</span>
                    <span className="text-sm tabular-nums">
                      {s.n}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({total > 0 ? Math.round((s.n / total) * 100) : 0}%)
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
        <Card title="Time-to-submit">
          <div className="p-4 text-sm">
            {data.avgTimeToSubmitHours == null
              ? "Not enough data yet."
              : `Average ${data.avgTimeToSubmitHours.toFixed(1)} hours from prospect creation to submission.`}
          </div>
        </Card>
      </div>
      <div className="col-span-6 space-y-3">
        <Card title="Recruiter leaderboard">
          {data.recruiterLeaderboard.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No submissions yet.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Recruiter</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Active</th>
                </tr>
              </thead>
              <tbody>
                {data.recruiterLeaderboard.slice(0, 10).map((r) => (
                  <tr key={r.recruiterUserId ?? "unknown"}>
                    <td>
                      {r.recruiterUserId ? (
                        <Link to={`/recruiters/${r.recruiterUserId}`} className="hover:underline">
                          {r.recruiterName ?? r.recruiterEmail ?? "—"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-right tabular-nums">{r.total}</td>
                    <td className="text-right tabular-nums">{r.active}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Source mix">
          {data.sourceMix.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No source data.</div>
          ) : (
            <ul className="divide-y divide-border">
              {data.sourceMix
                .sort((a, b) => b.n - a.n)
                .map((s) => (
                  <li key={s.source} className="px-4 py-2 flex items-center justify-between">
                    <span className="text-sm capitalize">{s.source.replace(/_/g, " ")}</span>
                    <span className="text-sm tabular-nums">{s.n}</span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
