import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Card, MetricCard } from "@/components/ui-kit";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Database, Search, Loader2, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ConnectorPreview {
  externalId: string;
  source: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  skills: string[];
  rawProfileUrl: string | null;
  fetchedAt: string;
}

interface InternalCandidate {
  id: string;
  displayName: string | null;
  email: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  totalExperienceYears: string | null;
  expectedCtcLakhs: string | null;
  noticePeriodDays: number | null;
  currentLocation: string | null;
  source: string;
}

const TABS = [
  { key: "naukri", label: "Naukri" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "mock", label: "Mock pool" },
  { key: "internal_db", label: "Internal DB" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function Sourcing() {
  const params = useParams<{ source?: string }>();
  const nav = useNavigate();
  const initialTab: TabKey = (TABS.find((t) => t.key === params.source)?.key as TabKey) ?? "naukri";
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConnectorPreview[]>([]);
  const [internalRows, setInternalRows] = useState<InternalCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  const isInternal = tab === "internal_db";

  const runSearch = async () => {
    setLoading(true);
    try {
      if (isInternal) {
        const res = await apiFetch<{ candidates: InternalCandidate[] }>(
          `/api/candidates${query ? `?q=${encodeURIComponent(query)}` : ""}`,
        );
        setInternalRows(res.candidates);
      } else {
        const params = new URLSearchParams({ source: tab, limit: "20" });
        if (query) params.set("q", query);
        const res = await apiFetch<{ results: ConnectorPreview[] }>(
          `/api/sourcing/search?${params.toString()}`,
        );
        setResults(res.results);
      }
    } catch (err) {
      toast.error("Search failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setQuery("");
    setResults([]);
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const importOne = async (p: ConnectorPreview) => {
    setImporting(p.externalId);
    try {
      const res = await apiFetch<{ candidate: InternalCandidate; deduped: boolean }>(
        "/api/sourcing/import",
        {
          method: "POST",
          json: {
            source: p.source,
            externalId: p.externalId,
            displayName: p.displayName,
            email: p.email,
            phone: p.phone,
            currentTitle: p.currentTitle,
            currentCompany: p.currentCompany,
            totalExperienceYears: p.totalExperienceYears,
            expectedCtcLakhs: p.expectedCtcLakhs,
            noticePeriodDays: p.noticePeriodDays,
            currentLocation: p.currentLocation,
            rawProfileUrl: p.rawProfileUrl,
          },
        },
      );
      if (res.deduped) {
        toast.info("Already in your pool — opening profile");
      } else {
        toast.success("Imported to internal DB");
      }
      nav(`/candidates/${res.candidate.id}`);
    } catch (err) {
      toast.error("Import failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setImporting(null);
    }
  };

  const summary = useMemo(() => {
    if (isInternal) return { total: internalRows.length };
    return { total: results.length };
  }, [isInternal, internalRows.length, results.length]);

  return (
    <div>
      <PageHeader
        title="Sourcing"
        subtitle="Pull candidate previews from connected sources or your internal pool. One click to import."
      />
      <div className="px-6 pt-4 border-b border-border bg-background flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              nav(`/sourcing${t.key === "naukri" ? "" : `/${t.key}`}`);
            }}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px",
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <MetricCard label="Active source" value={tab.replace(/_/g, " ")} />
          <MetricCard label="Results" value={summary.total} />
          <MetricCard label="Connector" value={isInternal ? "Internal DB" : "Mock-backed"} />
        </div>
        <Card>
          <div className="p-3 border-b border-border flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                }}
                placeholder={isInternal ? "Search internal pool…" : "Search this source…"}
                className="pl-9"
              />
            </div>
            <Button onClick={() => void runSearch()} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
            </Button>
          </div>
          {isInternal ? (
            internalRows.length === 0 ? (
              <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
                <Database className="w-8 h-8 opacity-30" />
                <div>No candidates match.</div>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Title @ Company</th>
                    <th className="text-right">Exp</th>
                    <th className="text-right">Expected CTC</th>
                    <th>Location</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {internalRows.map((c) => (
                    <tr
                      key={c.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => nav(`/candidates/${c.id}`)}
                    >
                      <td className="text-sm font-medium">{c.displayName ?? c.email ?? "—"}</td>
                      <td className="text-xs">
                        {c.currentTitle ?? "—"}
                        {c.currentCompany ? ` @ ${c.currentCompany}` : ""}
                      </td>
                      <td className="text-right tabular-nums">
                        {c.totalExperienceYears
                          ? `${parseFloat(c.totalExperienceYears).toFixed(1)}y`
                          : "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {c.expectedCtcLakhs
                          ? `${parseFloat(c.expectedCtcLakhs).toFixed(1)} LPA`
                          : "—"}
                      </td>
                      <td className="text-xs">{c.currentLocation ?? "—"}</td>
                      <td className="text-xs">
                        <span className="pill bg-muted text-muted-foreground text-[10px] capitalize">
                          {c.source.replace(/_/g, " ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : results.length === 0 ? (
            <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
              <Search className="w-8 h-8 opacity-30" />
              <div>{loading ? "Searching…" : "No results yet — refine the query and search."}</div>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Title @ Company</th>
                  <th className="text-right">Exp</th>
                  <th className="text-right">Expected</th>
                  <th>Location</th>
                  <th>Skills</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((p) => (
                  <tr key={p.externalId} className="hover:bg-muted/30">
                    <td>
                      <div className="text-sm font-medium">{p.displayName}</div>
                      {p.rawProfileUrl && (
                        <a
                          href={p.rawProfileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-primary hover:underline"
                        >
                          source profile ↗
                        </a>
                      )}
                    </td>
                    <td className="text-xs">
                      {p.currentTitle ?? "—"}
                      {p.currentCompany ? ` @ ${p.currentCompany}` : ""}
                    </td>
                    <td className="text-right tabular-nums">
                      {p.totalExperienceYears != null ? `${p.totalExperienceYears}y` : "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {p.expectedCtcLakhs != null ? `${p.expectedCtcLakhs} LPA` : "—"}
                    </td>
                    <td className="text-xs">{p.currentLocation ?? "—"}</td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {p.skills.slice(0, 3).map((s) => (
                          <span
                            key={s}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                          >
                            {s}
                          </span>
                        ))}
                        {p.skills.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{p.skills.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={importing === p.externalId}
                        onClick={() => void importOne(p)}
                      >
                        {importing === p.externalId ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <>
                            <Plus className="w-3.5 h-3.5 mr-1" /> Import
                          </>
                        )}
                      </Button>
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
