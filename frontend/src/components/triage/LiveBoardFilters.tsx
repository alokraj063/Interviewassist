import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TriageFlow } from "@j2w/shared-types";

export interface LiveFilters {
  status: string; // "" = any
  flowId: string; // "" = any
  slaBreached: boolean;
  q: string;
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "classifying", label: "Classifying" },
  { value: "decided", label: "Decided" },
  { value: "handing_off", label: "Handing off" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

interface Props {
  filters: LiveFilters;
  flows: TriageFlow[];
  onChange: (next: LiveFilters) => void;
}

export function LiveBoardFilters({ filters, flows, onChange }: Props) {
  // Local search input is debounced before it touches the URL/query.
  const [searchInput, setSearchInput] = useState(filters.q);
  useEffect(() => {
    setSearchInput(filters.q);
  }, [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== filters.q) onChange({ ...filters, q: searchInput });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const flowName = flows.find((f) => f.id === filters.flowId)?.name;
  const statusLabel = STATUS_OPTIONS.find((s) => s.value === filters.status)?.label;
  const hasActive =
    !!filters.status || !!filters.flowId || filters.slaBreached || !!filters.q;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            aria-label="Search caller"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search caller…"
            className="h-8 w-[200px] pl-7 text-sm"
          />
        </div>

        <Select
          value={filters.status || "__any"}
          onValueChange={(v) => onChange({ ...filters, status: v === "__any" ? "" : v })}
        >
          <SelectTrigger className="h-8 w-[150px] text-sm" aria-label="Filter by status">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any status</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.flowId || "__any"}
          onValueChange={(v) => onChange({ ...filters, flowId: v === "__any" ? "" : v })}
        >
          <SelectTrigger className="h-8 w-[180px] text-sm" aria-label="Filter by flow">
            <SelectValue placeholder="Any flow" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any flow</SelectItem>
            {flows.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          type="button"
          variant={filters.slaBreached ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          aria-pressed={filters.slaBreached}
          onClick={() => onChange({ ...filters, slaBreached: !filters.slaBreached })}
        >
          SLA breached
        </Button>

        {hasActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onChange({ status: "", flowId: "", slaBreached: false, q: "" })}
          >
            <X className="w-3 h-3 mr-1" />
            Clear all
          </Button>
        )}
      </div>

      {hasActive && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.q && (
            <FilterChip label={`Caller: ${filters.q}`} onClear={() => onChange({ ...filters, q: "" })} />
          )}
          {filters.status && (
            <FilterChip
              label={`Status: ${statusLabel}`}
              onClear={() => onChange({ ...filters, status: "" })}
            />
          )}
          {filters.flowId && (
            <FilterChip
              label={`Flow: ${flowName ?? filters.flowId}`}
              onClear={() => onChange({ ...filters, flowId: "" })}
            />
          )}
          {filters.slaBreached && (
            <FilterChip
              label="SLA breached"
              onClear={() => onChange({ ...filters, slaBreached: false })}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="pill bg-primary/10 text-primary text-[11px] inline-flex items-center gap-1">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove ${label} filter`}
        className="hover:text-destructive"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
