import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { X, Search } from "lucide-react";
import type { SessionFilters } from "@/hooks/useProctor";

const STATUSES = ["live", "completed", "abandoned"] as const;
const LIVE_STATES = ["active", "paused", "ended"] as const;
const DECISIONS = ["clean", "flagged", "invalidated"] as const;

interface Props {
  filters: SessionFilters;
  // patch merges into the URL search params; passing undefined clears a key.
  patch: (next: Partial<SessionFilters & { cursor?: undefined }>) => void;
  clearAll: () => void;
  hasFilters: boolean;
  showAssignedToMe?: boolean;
}

export function SessionFilters({ filters, patch, clearAll, hasFilters, showAssignedToMe = true }: Props) {
  // Local debounced search state so we don't refetch on every keystroke.
  const [search, setSearch] = useState(filters.q ?? "");
  useEffect(() => {
    setSearch(filters.q ?? "");
  }, [filters.q]);
  useEffect(() => {
    const handle = setTimeout(() => {
      if ((search.trim() || undefined) !== (filters.q || undefined)) {
        patch({ q: search.trim() || undefined, cursor: undefined });
      }
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const minRisk = filters.minRisk ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Search candidates"
            placeholder="Search candidate…"
            className="w-56 h-9 pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div>
          <Label className="text-[11px] text-muted-foreground">Status</Label>
          <Select
            value={filters.status ?? "all"}
            onValueChange={(v) => patch({ status: v === "all" ? undefined : (v as SessionFilters["status"]), cursor: undefined })}
          >
            <SelectTrigger className="w-36 h-9" aria-label="Status filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-[11px] text-muted-foreground">Live state</Label>
          <Select
            value={filters.liveState ?? "all"}
            onValueChange={(v) => patch({ liveState: v === "all" ? undefined : (v as SessionFilters["liveState"]), cursor: undefined })}
          >
            <SelectTrigger className="w-32 h-9" aria-label="Live state filter">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any state</SelectItem>
              {LIVE_STATES.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-[11px] text-muted-foreground">Decision</Label>
          <Select
            value={filters.decision ?? "all"}
            onValueChange={(v) => patch({ decision: v === "all" ? undefined : (v as SessionFilters["decision"]), cursor: undefined })}
          >
            <SelectTrigger className="w-32 h-9" aria-label="Decision filter">
              <SelectValue placeholder="Any" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any decision</SelectItem>
              {DECISIONS.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-[11px] text-muted-foreground">Sort</Label>
          <Select
            value={filters.sort ?? "recent"}
            onValueChange={(v) => patch({ sort: v as SessionFilters["sort"], cursor: undefined })}
          >
            <SelectTrigger className="w-32 h-9" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Most recent</SelectItem>
              <SelectItem value="risk">Highest risk</SelectItem>
              <SelectItem value="sla">SLA due</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="w-40">
          <Label className="text-[11px] text-muted-foreground">Min risk: {minRisk}</Label>
          <Slider
            aria-label="Minimum risk score"
            value={[minRisk]}
            min={0}
            max={100}
            step={5}
            onValueChange={([v]) => patch({ minRisk: v > 0 ? v : undefined, cursor: undefined })}
            className="mt-2.5"
          />
        </div>

        {showAssignedToMe && (
          <label className="flex items-center gap-2 text-sm h-9">
            <Switch
              checked={!!filters.assignedToMe}
              onCheckedChange={(c) => patch({ assignedToMe: c || undefined, cursor: undefined })}
              aria-label="Assigned to me"
            />
            Assigned to me
          </label>
        )}
      </div>

      {hasFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.status && <Chip label={`status: ${filters.status}`} onClear={() => patch({ status: undefined, cursor: undefined })} />}
          {filters.liveState && <Chip label={`state: ${filters.liveState}`} onClear={() => patch({ liveState: undefined, cursor: undefined })} />}
          {filters.decision && <Chip label={`decision: ${filters.decision}`} onClear={() => patch({ decision: undefined, cursor: undefined })} />}
          {filters.minRisk ? <Chip label={`min risk ≥ ${filters.minRisk}`} onClear={() => patch({ minRisk: undefined, cursor: undefined })} /> : null}
          {filters.assignedToMe && <Chip label="assigned to me" onClear={() => patch({ assignedToMe: undefined, cursor: undefined })} />}
          {filters.q && <Chip label={`"${filters.q}"`} onClear={() => patch({ q: undefined, cursor: undefined })} />}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs">
      {label}
      <button type="button" onClick={onClear} aria-label={`Remove ${label}`} className="hover:text-destructive">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
