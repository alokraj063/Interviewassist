import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { useCandidates, type CandidatesFilters } from "@/hooks/useCandidates";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Search, UserSearch } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function Candidates() {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<string>("all");

  const filters: CandidatesFilters = useMemo(
    () => ({
      q: search.trim() || undefined,
      source: source === "all" ? undefined : source,
    }),
    [search, source],
  );

  const { data: candidates = [], isLoading } = useCandidates(filters);

  return (
    <div>
      <PageHeader
        title="Candidates"
        subtitle="Search the org's candidate pool. Dedup-aware on email and phone."
        actions={
          <Button size="sm" onClick={() => nav("/candidates/new")}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            New candidate
          </Button>
        }
      />
      <div className="p-6 space-y-5">
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Total in view" value={candidates.length} />
          <MetricCard
            label="With LinkedIn"
            value={candidates.filter((c) => c.email?.includes("@")).length}
            hint="Indicative — needs profile-completeness score"
          />
          <MetricCard
            label="Recently added"
            value={candidates.filter((c) => Date.now() - new Date(c.createdAt).getTime() < 7 * 86400_000).length}
            hint="Last 7 days"
          />
        </div>
        <Card>
          <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, title, or company"
                className="pl-8 h-9 w-72"
              />
            </div>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="all">All sources</option>
              <option value="naukri">Naukri</option>
              <option value="linkedin">LinkedIn</option>
              <option value="referral">Referral</option>
              <option value="direct">Direct</option>
              <option value="internal_db">Internal DB</option>
              <option value="imported">Imported</option>
              <option value="other">Other</option>
            </select>
            <div className="ml-auto text-xs text-muted-foreground">{candidates.length} shown</div>
          </div>
          {isLoading ? (
            <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <UserSearch className="w-6 h-6 mx-auto mb-2 opacity-40" />
              No candidates match these filters.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Current role</th>
                  <th>Experience</th>
                  <th>Current CTC</th>
                  <th>Expected</th>
                  <th>Notice</th>
                  <th>Location</th>
                  <th>Source</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id} className="hover:bg-muted/40">
                    <td>
                      <Link to={`/candidates/${c.id}`} className="font-medium text-foreground hover:underline">
                        {c.displayName ?? "—"}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {c.email ?? "—"}{c.phone ? ` · ${c.phone}` : ""}
                      </div>
                    </td>
                    <td className="text-sm">
                      {c.currentTitle ?? "—"}
                      {c.currentCompany && (
                        <div className="text-xs text-muted-foreground">@ {c.currentCompany}</div>
                      )}
                    </td>
                    <td className="text-sm">{c.totalExperienceYears ?? "—"} yrs</td>
                    <td className="text-sm">{c.currentCtcLakhs ?? "—"}</td>
                    <td className="text-sm">{c.expectedCtcLakhs ?? "—"}</td>
                    <td className="text-sm">{c.noticePeriodDays ?? "—"} d</td>
                    <td className="text-sm">{c.currentLocation ?? "—"}</td>
                    <td className="text-sm">{c.source}</td>
                    <td className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
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
