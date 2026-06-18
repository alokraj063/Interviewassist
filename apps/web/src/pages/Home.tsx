import { useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, MetricCard, Card, EmptyState } from "@/components/ui-kit";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar } from "recharts";
import { ChevronRight, Briefcase, PhoneCall, UserPlus, Send, Star, AlertTriangle, Calendar } from "lucide-react";
import { useDemands } from "@/hooks/useDemands";
import { useCalls } from "@/hooks/useCalls";
import { useAuth } from "@/auth/AuthContext";
import { apiFetch } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

interface ProspectListItem {
  id: string;
  status: string;
  lastContactedAt: string | null;
  candidateName: string | null;
  demandTitle: string | null;
}
interface SubmissionListItem {
  id: string;
  currentStage: string;
  candidateName: string | null;
  demandTitle: string | null;
  updatedAt: string;
}

export default function Home() {
  const nav = useNavigate();
  const { user } = useAuth();
  const today = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

  const { data: demands = [] } = useDemands({ assignedToMe: true });
  const { data: calls = [] } = useCalls();
  const { data: prospects } = useQuery<{ prospects: ProspectListItem[] }>({
    queryKey: ["prospects", "home"],
    queryFn: () => apiFetch("/api/prospects"),
  });
  const { data: submissions } = useQuery<{ submissions: SubmissionListItem[] }>({
    queryKey: ["submissions", "home"],
    queryFn: () => apiFetch("/api/submissions"),
  });

  const myProspects = prospects?.prospects ?? [];
  const mySubmissions = submissions?.submissions ?? [];

  // KPI buckets
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const week0 = new Date(today0); week0.setDate(week0.getDate() - 7);
  const callsToday = calls.filter((c) => new Date(c.startedAt) >= today0).length;
  const callsWeek = calls.filter((c) => new Date(c.startedAt) >= week0).length;
  const submissionsWeek = mySubmissions.filter((s) => new Date(s.updatedAt) >= week0).length;
  const prospectsWeek = myProspects.length;

  const prospectBuckets = countBuckets(myProspects, "status");
  const submissionBuckets = countBuckets(mySubmissions, "currentStage");
  const interviewsScheduled = (submissionBuckets["l1_scheduled"] ?? 0) + (submissionBuckets["l2_scheduled"] ?? 0) + (submissionBuckets["l3_scheduled"] ?? 0);
  const offersExtended = (submissionBuckets["offer_pending"] ?? 0) + (submissionBuckets["offer_released"] ?? 0);

  // 14-day call volume sparkline-ish data
  const last14Days = Array.from({ length: 14 }).map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (13 - i)); d.setHours(0, 0, 0, 0);
    const dEnd = new Date(d); dEnd.setDate(dEnd.getDate() + 1);
    return {
      day: d.toLocaleDateString([], { month: "short", day: "numeric" }),
      calls: calls.filter((c) => {
        const t = new Date(c.startedAt);
        return t >= d && t < dEnd;
      }).length,
    };
  });

  const stalePropsects = myProspects.filter((p) => {
    if (!p.lastContactedAt) return p.status === "new";
    return Date.now() - new Date(p.lastContactedAt).getTime() > 48 * 3600 * 1000 && !["submitted", "disqualified", "not_interested"].includes(p.status);
  });

  const recentCalls = [...calls].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, 8);
  const awaitingFeedback = mySubmissions.filter((s) => s.currentStage === "client_submit").slice(0, 6);

  return (
    <div>
      <PageHeader title={`Hello, ${user?.name?.split(" ")[0] ?? "Recruiter"}`} subtitle={today} />
      <div className="p-6 space-y-5">
        {/* KPIs */}
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Calls today" value={callsToday} hint={`${callsWeek} this week`} />
          <MetricCard label="Active prospects" value={prospectsWeek} hint={`${prospectBuckets["new"] ?? 0} new · ${prospectBuckets["contacted"] ?? 0} contacted`} />
          <MetricCard label="Submissions (7d)" value={submissionsWeek} accent={submissionsWeek > 0 ? "success" : "default"} />
          <MetricCard label="Interviews scheduled" value={interviewsScheduled} hint={`${offersExtended} offers extended`} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Card title="Call volume — last 14 days" action={
            <button onClick={() => nav("/calls")} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              All calls <ChevronRight className="w-3 h-3" />
            </button>
          }>
            <div className="p-4" style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={last14Days} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }} />
                  <Line type="monotone" dataKey="calls" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card title="Prospect status mix">
            <div className="p-4" style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart
                  data={[
                    { name: "New", v: prospectBuckets["new"] ?? 0 },
                    { name: "Contacted", v: prospectBuckets["contacted"] ?? 0 },
                    { name: "Interested", v: prospectBuckets["interested"] ?? 0 },
                    { name: "Qualified", v: prospectBuckets["qualified"] ?? 0 },
                    { name: "Submitted", v: prospectBuckets["submitted"] ?? 0 },
                    { name: "Disqualified", v: prospectBuckets["disqualified"] ?? 0 },
                  ]}
                  layout="vertical"
                  margin={{ top: 5, right: 20, left: 10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
                  <Bar dataKey="v" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {/* Active demands assigned to me */}
          <Card title="Demands assigned to me" action={
            <button onClick={() => nav("/demands")} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              All demands <ChevronRight className="w-3 h-3" />
            </button>
          }>
            {demands.length === 0 ? (
              <EmptyState title="No demands assigned" body="Your account manager will assign demands as they come in." />
            ) : (
              <div className="divide-y divide-border">
                {demands.slice(0, 6).map((d) => (
                  <Link key={d.id} to={`/demands/${d.id}`} className="block p-3 hover:bg-muted/40">
                    <div className="flex items-start gap-2">
                      <Briefcase className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {d.isVip && <Star className="inline w-3 h-3 mr-1 text-warning fill-warning/30" />}
                          {d.title}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {d.clientName ?? "—"} · {d.numberOfOpenings} open
                        </div>
                      </div>
                      <span className={cn(
                        "pill text-[10px]",
                        d.status === "active" ? "bg-success/15 text-success" :
                        d.status === "on_hold" ? "bg-warning/15 text-warning" :
                        "bg-muted text-muted-foreground"
                      )}>{d.status.replace("_", " ")}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {/* Suggested next actions */}
          <Card title="Suggested next actions" action={
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />Auto-derived
            </span>
          }>
            {stalePropsects.length === 0 && demands.length === 0 ? (
              <EmptyState title="You're caught up" body="No stale prospects or pending follow-ups detected." />
            ) : (
              <div className="divide-y divide-border">
                {stalePropsects.length > 0 && (
                  <div className="p-3 flex items-start gap-2">
                    <PhoneCall className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{stalePropsects.length} prospects need follow-up</div>
                      <div className="text-xs text-muted-foreground">Last contact &gt; 48h ago — call before they cool off</div>
                    </div>
                  </div>
                )}
                {(prospectBuckets["qualified"] ?? 0) > 0 && (
                  <div className="p-3 flex items-start gap-2">
                    <Send className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{prospectBuckets["qualified"]} qualified prospects ready to submit</div>
                      <div className="text-xs text-muted-foreground">Open the Demand → Prospects Kanban to push them</div>
                    </div>
                  </div>
                )}
                {awaitingFeedback.length > 0 && (
                  <div className="p-3 flex items-start gap-2">
                    <Calendar className="w-3.5 h-3.5 text-info mt-0.5 shrink-0" />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{awaitingFeedback.length} submissions awaiting client feedback</div>
                      <div className="text-xs text-muted-foreground">Nudge the client portal in next sync call</div>
                    </div>
                  </div>
                )}
                {demands.filter((d) => d.isVip).length > 0 && (
                  <div className="p-3 flex items-start gap-2">
                    <Star className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{demands.filter((d) => d.isVip).length} VIP demand{demands.filter((d) => d.isVip).length !== 1 ? "s" : ""} active</div>
                      <div className="text-xs text-muted-foreground">Prioritise sourcing for these today</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Awaiting client feedback */}
          <Card title="Awaiting client feedback" action={
            <button onClick={() => nav("/demands")} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              All <ChevronRight className="w-3 h-3" />
            </button>
          }>
            {awaitingFeedback.length === 0 ? (
              <EmptyState title="No submissions awaiting feedback" body="All your active submissions have moved to interviews or beyond." />
            ) : (
              <div className="divide-y divide-border">
                {awaitingFeedback.map((s) => (
                  <div key={s.id} className="p-3">
                    <div className="text-sm font-medium truncate">{s.candidateName ?? "Candidate"}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.demandTitle ?? "Demand"} · Updated {formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Recent calls */}
        <Card title="Recent calls" action={
          <button onClick={() => nav("/calls")} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            All calls <ChevronRight className="w-3 h-3" />
          </button>
        }>
          {recentCalls.length === 0 ? (
            <EmptyState
              title="No calls yet"
              body="Start a Live Assist call to get going."
              action={<button onClick={() => nav("/live-assist")} className="text-sm text-primary hover:underline">Open Live Assist</button>}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Candidate / Phone</th>
                  <th>Recruiter</th>
                  <th>Mode</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/40 cursor-pointer" onClick={() => nav(`/calls/${c.id}`)}>
                    <td className="text-sm">{c.candidateRefOrPhone ?? "—"}</td>
                    <td className="text-sm">{c.recruiterName ?? "—"}</td>
                    <td className="text-xs"><span className="pill bg-muted text-foreground capitalize">{c.mode.replace("_", " ")}</span></td>
                    <td className="text-xs text-muted-foreground">
                      {c.startedAt ? formatDistanceToNow(new Date(c.startedAt), { addSuffix: true }) : "—"}
                    </td>
                    <td>
                      <span className={cn("pill capitalize text-[11px]",
                        c.status === "active" ? "bg-success/15 text-success" :
                        c.status === "ended" ? "bg-muted text-muted-foreground" :
                        c.status === "queued" ? "bg-warning/15 text-warning" :
                        "bg-info/15 text-info"
                      )}>{c.status}</span>
                    </td>
                    <td>
                      <button onClick={(e) => { e.stopPropagation(); nav(`/calls/${c.id}`); }} className="text-xs text-primary hover:underline">
                        Open
                      </button>
                    </td>
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

function countBuckets<T extends Record<string, any>>(rows: T[], key: keyof T): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const k = String(row[key]);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}
