import { useMemo, useState } from "react";
import { BookOpen, Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Citation } from "@j2w/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKbSearch } from "@/hooks/useKbSearch";
import { PanelShell } from "./PanelShell";

export function KnowledgeCard({
  citations,
  limit = 8,
}: {
  citations: Citation[];
  limit?: number;
}) {
  const search = useKbSearch();
  const [q, setQ] = useState("");
  const [manual, setManual] = useState<Citation[]>([]);

  const display = useMemo(() => {
    const combined = [...manual, ...citations];
    const seen = new Set<number>();
    return combined.filter((c) => (seen.has(c.chunkId) ? false : (seen.add(c.chunkId), true))).slice(0, limit);
  }, [manual, citations, limit]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const query = q.trim();
    if (!query) return;
    try {
      const hits = await search.mutateAsync({ query, limit: 6 });
      setManual(hits);
    } catch (err) {
      toast.error("KB search failed", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <PanelShell title="Knowledge" action={<BookOpen className="w-3.5 h-3.5 text-muted-foreground" />}>
      <form onSubmit={submit} className="p-2 border-b border-border flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask KB (manual test)…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!q.trim() || search.isPending}>
          {search.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Ask"}
        </Button>
      </form>
      {display.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground text-center">
          Citations appear as suggestions ground in your KB, or use the search above to try a query.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {display.map((c) => (
            <a
              key={c.chunkId}
              href={`/knowledge/${c.sourceId}`}
              className="block p-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium line-clamp-2">{c.snippet}</div>
                <span className="pill bg-success/10 text-success text-[10px] tabular-nums shrink-0">
                  {Math.round((c.score ?? 0) * 100)}%
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                {c.corpus && (
                  <span
                    className={
                      c.corpus === "jd"
                        ? "pill bg-info/15 text-info text-[10px]"
                        : c.corpus === "company"
                        ? "pill bg-primary/15 text-primary text-[10px]"
                        : "pill bg-warning/15 text-warning text-[10px]"
                    }
                  >
                    {c.corpus === "question_bank" ? "Q-bank" : c.corpus.toUpperCase()}
                  </span>
                )}
                <span>{c.sourceName ?? c.sourceId}</span>
                {c.documentTitle ? <span>· {c.documentTitle}</span> : null}
              </div>
            </a>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
