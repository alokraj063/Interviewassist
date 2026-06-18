// Live/queued calls list with duration timer, recruiter + candidate + demand
// context, and a per-row supervisor action menu (Supervise drawer + Reassign).
// URL-synced search; keyset pagination. Actions are permission-gated.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Phone, Search, Eye, ArrowLeftRight, Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/auth/AuthContext";
import { useLiveCalls, type LiveCallRow } from "@/hooks/useTeamMonitor";
import { fmtDuration } from "./labels";
import { SkeletonRows, ErrorState, EmptyFirstRun, EmptyFiltered, Pager } from "./states";
import { SuperviseDrawer } from "./SuperviseDrawer";
import { ReassignDialog } from "./ReassignDialog";

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  assigned: "bg-amber-50 text-amber-700 border-amber-200",
  queued: "bg-sky-50 text-sky-700 border-sky-200",
};

export function LiveCallsPanel({
  q,
  onSearch,
}: {
  q: string;
  onSearch: (v: string) => void;
}) {
  const canSupervise = useCan("team_monitor.supervise");
  const canReassign = useCan("team_monitor.reassign");

  const [searchInput, setSearchInput] = useState(q);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [stack, setStack] = useState<string[]>([]);
  const [superviseCall, setSuperviseCall] = useState<LiveCallRow | null>(null);
  const [reassignCall, setReassignCall] = useState<LiveCallRow | null>(null);
  const [, tick] = useState(0);

  // Live duration ticking once a second.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== q) {
        onSearch(searchInput.trim());
        setCursor(undefined);
        setStack([]);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const { data, isLoading, isError, error, refetch } = useLiveCalls({
    q: q || undefined,
    cursor,
    limit: 25,
  });

  const rows = data?.rows ?? [];
  const hasFilters = q.length > 0;
  const errMsg = useMemo(() => {
    const e = error as { body?: { error?: string }; message?: string } | undefined;
    return e?.body?.error ?? e?.message ?? "Request failed";
  }, [error]);

  function clearFilters() {
    setSearchInput("");
    onSearch("");
    setCursor(undefined);
    setStack([]);
  }

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-emerald-600" /> Live calls
        </div>
      }
      action={
        <div className="relative w-56">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            aria-label="Search live calls"
            placeholder="Recruiter, candidate, demand…"
            className="pl-8 h-8"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
      }
    >
      {isLoading && !data ? (
        <SkeletonRows rows={5} cols={4} />
      ) : isError ? (
        <ErrorState message={errMsg} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        hasFilters ? (
          <EmptyFiltered onClear={clearFilters} />
        ) : (
          <EmptyFirstRun
            title="No live or queued calls right now"
            body="Active candidate calls appear here the moment a recruiter starts one. Supervise or reassign them without leaving this page."
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table text-sm w-full">
              <caption className="sr-only">Live and queued calls on the floor</caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Recruiter</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">
                    Duration
                  </th>
                  <th scope="col" className="text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link
                        to={`/calls/${c.id}`}
                        className="font-medium hover:underline flex items-center gap-1.5"
                      >
                        <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                        {c.candidateName ?? "Candidate"}
                      </Link>
                      {c.demandTitle && (
                        <div className="text-xs text-muted-foreground">{c.demandTitle}</div>
                      )}
                    </td>
                    <td className="text-xs">{c.recruiterName ?? "—"}</td>
                    <td>
                      <span
                        className={cn(
                          "pill text-[10px] capitalize border",
                          STATUS_PILL[c.status] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {c.status}
                      </span>
                      {c.supervisionMode && (
                        <span
                          className="pill text-[10px] ml-1.5 bg-violet-50 text-violet-700 border border-violet-200"
                          data-testid="supervising-badge"
                        >
                          Supervising · {c.supervisionMode}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-xs">{fmtDuration(c.durationMs)}</td>
                    <td className="text-right">
                      <TooltipProvider>
                        <div className="inline-flex gap-1">
                          <Action
                            can={canSupervise}
                            disabled={c.status !== "active"}
                            disabledReason={
                              c.status !== "active"
                                ? "Only active calls can be supervised"
                                : "Requires supervisor permission"
                            }
                            label="Supervise"
                            icon={<Eye className="w-3.5 h-3.5" />}
                            onClick={() => setSuperviseCall(c)}
                            testid={`supervise-${c.id}`}
                          />
                          <Action
                            can={canReassign}
                            disabled={c.status === "active" || c.status === "ended"}
                            disabledReason={
                              c.status === "active"
                                ? "Live calls can't be reassigned — use takeover"
                                : "Requires reassign permission"
                            }
                            label="Reassign"
                            icon={<ArrowLeftRight className="w-3.5 h-3.5" />}
                            onClick={() => setReassignCall(c)}
                            testid={`reassign-${c.id}`}
                          />
                        </div>
                      </TooltipProvider>
                    </td>
                  </tr>
                ))}
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

      <SuperviseDrawer
        call={superviseCall}
        open={!!superviseCall}
        onOpenChange={(v) => !v && setSuperviseCall(null)}
      />
      <ReassignDialog
        call={reassignCall}
        open={!!reassignCall}
        onOpenChange={(v) => !v && setReassignCall(null)}
      />
    </Card>
  );
}

function Action({
  can,
  disabled,
  disabledReason,
  label,
  icon,
  onClick,
  testid,
}: {
  can: boolean;
  disabled: boolean;
  disabledReason: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  testid: string;
}) {
  const blocked = !can || disabled;
  const btn = (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={blocked}
      onClick={onClick}
      data-testid={testid}
    >
      {icon}
      <span className="ml-1 hidden sm:inline">{label}</span>
    </Button>
  );
  if (!blocked) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block">{btn}</span>
      </TooltipTrigger>
      <TooltipContent>{!can ? "Requires permission" : disabledReason}</TooltipContent>
    </Tooltip>
  );
}
