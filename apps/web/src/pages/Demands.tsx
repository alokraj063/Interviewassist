import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { useDemands, type DemandFilters, type DemandListItem } from "@/hooks/useDemands";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthContext";
import { Briefcase, Loader2, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

const STATUS_LABEL: Record<DemandListItem["status"], string> = {
  draft: "Draft",
  active: "Active",
  on_hold: "On hold",
  closed: "Closed",
  cancelled: "Cancelled",
};

const STATUS_PILL: Record<DemandListItem["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-success/15 text-success",
  on_hold: "bg-warning/15 text-warning",
  closed: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/15 text-destructive",
};

export default function Demands() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const isRecruiterOnly = user?.role === "recruiter" || (user?.role === "delivery_lead" && !can("demands.assign"));

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DemandListItem["status"] | "all">("all");
  const [vipOnly, setVipOnly] = useState(false);
  const [assignedToMe, setAssignedToMe] = useState(isRecruiterOnly);

  const filters: DemandFilters = useMemo(
    () => ({
      q: search.trim() || undefined,
      status: statusFilter === "all" ? undefined : statusFilter,
      isVip: vipOnly ? true : undefined,
      assignedToMe: assignedToMe ? true : undefined,
    }),
    [search, statusFilter, vipOnly, assignedToMe],
  );

  const { data: demands = [], isLoading } = useDemands(filters);

  const counts = useMemo(() => {
    const total = demands.length;
    const active = demands.filter((d) => d.status === "active").length;
    const vip = demands.filter((d) => d.isVip).length;
    const openings = demands.reduce((s, d) => s + d.numberOfOpenings, 0);
    return { total, active, vip, openings };
  }, [demands]);

  return (
    <div>
      <PageHeader
        title="Demands"
        subtitle="Open roles you and your team are sourcing for"
      />
      <div className="p-6 space-y-5">
        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Demands" value={counts.total} hint={`${counts.active} active`} />
          <MetricCard label="VIP demands" value={counts.vip} accent={counts.vip > 0 ? "success" : undefined} />
          <MetricCard label="Open positions" value={counts.openings} />
          <MetricCard
            label="Scope"
            value={assignedToMe ? "Assigned to me" : "All"}
            hint={assignedToMe ? "Switch to view all" : "Switch to my assignments"}
          />
        </div>

        <Card>
          <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title or designation"
                className="pl-8 h-9 w-64"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="on_hold">On hold</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <label className="text-sm flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={vipOnly}
                onChange={(e) => setVipOnly(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              VIP only
            </label>
            <label className="text-sm flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={assignedToMe}
                onChange={(e) => setAssignedToMe(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Assigned to me
            </label>
            <div className="ml-auto text-xs text-muted-foreground">{demands.length} shown</div>
          </div>

          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading demands…
            </div>
          ) : demands.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <Briefcase className="w-6 h-6 mx-auto mb-2 opacity-40" />
              No demands match these filters.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Demand</th>
                  <th>Client</th>
                  <th>Location</th>
                  <th>Experience</th>
                  <th>Salary (LPA)</th>
                  <th>Openings</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last changed</th>
                </tr>
              </thead>
              <tbody>
                {demands.map((d) => (
                  <tr
                    key={d.id}
                    className="hover:bg-muted/40 cursor-pointer"
                    onClick={() => navigate(`/demands/${d.id}`)}
                  >
                    <td>
                      <Link
                        to={`/demands/${d.id}`}
                        className="font-medium text-foreground hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {d.isVip && <Star className="inline w-3.5 h-3.5 mr-1 text-warning fill-warning/30" />}
                        {d.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">{d.designation ?? "—"}</div>
                    </td>
                    <td className="text-sm">{d.clientName ?? "—"}</td>
                    <td className="text-sm">{d.primaryLocation ?? "—"}</td>
                    <td className="text-sm">
                      {d.experienceMinYears ?? "?"}–{d.experienceMaxYears ?? "?"} yrs
                    </td>
                    <td className="text-sm">
                      {d.salaryFrom ?? "?"}–{d.salaryTo ?? "?"}
                    </td>
                    <td className="text-sm">{d.numberOfOpenings}</td>
                    <td>
                      <span className={cn("pill", STATUS_PILL[d.status])}>{STATUS_LABEL[d.status]}</span>
                    </td>
                    <td
                      className="text-xs text-muted-foreground"
                      title={format(new Date(d.createdAt), "PPpp")}
                    >
                      {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                    </td>
                    <td
                      className="text-xs text-muted-foreground"
                      title={`Last detected change: ${format(new Date(d.updatedAt), "PPpp")}. Sync skips the timestamp when nothing has changed in Offer Letter.`}
                    >
                      {formatDistanceToNow(new Date(d.updatedAt), { addSuffix: true })}
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
