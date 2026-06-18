// Heartbeat-backed presence/activity roster. Columns: recruiter, activity
// (text+icon, never color-only), current call link, idle-time, status note,
// pod role. URL-synced activity filter + search + sort + keyset pagination.
// Row → /recruiters/:id drill-down.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Users, X, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { getApiBase, getAccessToken } from "@/lib/api";
import {
  useRoster,
  PRESENCE_ACTIVITIES,
  ROSTER_SORTS,
  type PresenceActivity,
  type RosterSort,
} from "@/hooks/useTeamMonitor";
import { ACTIVITY_META, fmtDuration } from "./labels";
import { SkeletonRows, ErrorState, EmptyFirstRun, EmptyFiltered, Pager } from "./states";

const SORT_LABEL: Record<RosterSort, string> = {
  name: "Name",
  idleTime: "Idle time",
  activity: "Activity",
  lastHeartbeat: "Last heartbeat",
};

export function RosterTable({
  activity,
  q,
  sort,
  onPatch,
}: {
  activity: PresenceActivity | "";
  q: string;
  sort: RosterSort;
  onPatch: (next: { activity?: string; q?: string; sort?: string }) => void;
}) {
  const [searchInput, setSearchInput] = useState(q);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [stack, setStack] = useState<string[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== q) {
        onPatch({ q: searchInput.trim() });
        setCursor(undefined);
        setStack([]);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Reset pagination when filters change.
  useEffect(() => {
    setCursor(undefined);
    setStack([]);
  }, [activity, sort, q]);

  const { data, isLoading, isError, error, refetch } = useRoster({
    activity: activity ? [activity] : undefined,
    q: q || undefined,
    sort,
    cursor,
    limit: 25,
  });

  const rows = data?.rows ?? [];
  const hasFilters = !!activity || q.length > 0;
  const errMsg = useMemo(() => {
    const e = error as { body?: { error?: string }; message?: string } | undefined;
    return e?.body?.error ?? e?.message ?? "Request failed";
  }, [error]);

  function clearFilters() {
    setSearchInput("");
    onPatch({ activity: "", q: "" });
  }

  const csvUrl = `${getApiBase()}/api/team-monitor/roster?limit=100${
    activity ? `&activity=${activity}` : ""
  }&token=${getAccessToken() ?? ""}`;

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4" /> Presence roster
        </div>
      }
      action={
        <div className="flex items-center gap-2">
          <div className="relative w-48">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              aria-label="Search roster"
              placeholder="Name or email…"
              className="pl-8 h-8"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <Select value={activity || "all"} onValueChange={(v) => onPatch({ activity: v === "all" ? "" : v })}>
            <SelectTrigger className="h-8 w-36" aria-label="Filter by activity">
              <SelectValue placeholder="Activity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All activity</SelectItem>
              {PRESENCE_ACTIVITIES.map((a) => (
                <SelectItem key={a} value={a}>
                  {ACTIVITY_META[a].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => onPatch({ sort: v })}>
            <SelectTrigger className="h-8 w-36" aria-label="Sort roster">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROSTER_SORTS.map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-8" onClick={clearFilters}>
              <X className="w-3.5 h-3.5 mr-1" /> Clear
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8" asChild>
            <a href={csvUrl}>
              <Download className="w-3.5 h-3.5 mr-1" /> CSV
            </a>
          </Button>
        </div>
      }
    >
      {isLoading && !data ? (
        <SkeletonRows rows={6} cols={5} />
      ) : isError ? (
        <ErrorState message={errMsg} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        hasFilters ? (
          <EmptyFiltered onClear={clearFilters} />
        ) : (
          <EmptyFirstRun
            title="No recruiters are clocked in yet"
            body="Presence appears here once a recruiter starts a live call or sends a heartbeat from the floor."
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table text-sm w-full">
              <caption className="sr-only">Recruiter presence and current activity</caption>
              <thead>
                <tr>
                  <th scope="col">Recruiter</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Current call</th>
                  <th scope="col" className="text-right">
                    Idle
                  </th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const meta = ACTIVITY_META[r.activity];
                  const Icon = meta.icon;
                  return (
                    <tr key={r.userId}>
                      <td>
                        <Link to={`/recruiters/${r.userId}`} className="font-medium hover:underline">
                          {r.name ?? r.email}
                        </Link>
                        {r.role && (
                          <div className="text-xs text-muted-foreground capitalize">
                            {r.role.replace(/_/g, " ")}
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          className={cn(
                            "pill text-[10px] inline-flex items-center gap-1 border",
                            meta.cls,
                          )}
                        >
                          <Icon className="w-3 h-3" aria-hidden />
                          {meta.label}
                        </span>
                      </td>
                      <td className="text-xs">
                        {r.activeCallId ? (
                          <Link to={`/calls/${r.activeCallId}`} className="hover:underline text-primary">
                            View call
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-xs">
                        {r.activity === "idle" ? fmtDuration(r.idleMs) : "—"}
                      </td>
                      <td className="text-xs text-muted-foreground max-w-[160px] truncate">
                        {r.statusNote ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager
            label={`${rows.length} shown`}
            canPrev={stack.length > 0}
            canNext={!!data?.nextCursor}
            onPrev={() => {
              const next = [...stack];
              next.pop();
              setStack(next);
              setCursor(next[next.length - 1]);
            }}
            onNext={() => {
              if (!data?.nextCursor) return;
              setStack((s) => [...s, data.nextCursor!]);
              setCursor(data.nextCursor);
            }}
          />
        </>
      )}
    </Card>
  );
}
