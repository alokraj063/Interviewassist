import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { TranscriptTurn as TranscriptTurnType } from "@/data/types";
import { TranscriptTurn } from "./TranscriptTurn";

type Filter = "all" | "negative" | "flagged" | "criteria";

export interface TranscriptListProps {
  turns: TranscriptTurnType[];
  selectedTs?: string;
  onSelectTs?: (ts: string) => void;
  showFilters?: boolean;
  className?: string;
}

export function TranscriptList({ turns, selectedTs, onSelectTs, showFilters = true, className }: TranscriptListProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const refs = useRef<Map<string, HTMLDivElement>>(new Map());

  const filtered = useMemo(() => {
    return turns.filter((t) => {
      if (filter === "negative" && t.sentiment !== "negative" && t.sentiment !== "escalated") return false;
      if (filter === "flagged" && !t.flag) return false;
      if (filter === "criteria" && !t.criterion) return false;
      if (query && !t.text.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [turns, filter, query]);

  useEffect(() => {
    if (!selectedTs) return;
    const el = refs.current.get(selectedTs);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedTs]);

  return (
    <div className={cn("space-y-3", className)}>
      {showFilters && (
        <div className="flex items-center gap-2 sticky top-0 bg-background pb-2 border-b border-border">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search transcript…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          {(["all", "negative", "flagged", "criteria"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-2 py-1 text-[11px] rounded font-medium capitalize",
                filter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="text-xs text-muted-foreground py-6 text-center">No turns match this filter.</div>
        )}
        {filtered.map((t, i) => (
          <TranscriptTurn
            key={`${t.ts}-${i}`}
            ref={(el) => {
              if (el) refs.current.set(t.ts, el);
              else refs.current.delete(t.ts);
            }}
            turn={t}
            highlighted={selectedTs === t.ts}
            onClick={() => onSelectTs?.(t.ts)}
          />
        ))}
      </div>
    </div>
  );
}
