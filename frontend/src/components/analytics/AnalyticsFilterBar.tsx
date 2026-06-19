// Sticky filter bar: date-range presets + custom from/to, source segment,
// recruiter segment, compare-to-previous toggle. All state is mirrored into the
// URL by the parent (this component only reads filters + emits patches).
import { CANDIDATE_SOURCES } from "@/lib/analyticsSources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X } from "lucide-react";
import {
  RANGE_TOKENS,
  RANGE_LABELS,
  type AnalyticsFilters,
} from "@/hooks/useAnalyticsReports";
import { activeSegmentCount } from "@/lib/analyticsFilters";

const ALL = "__all__";

export function AnalyticsFilterBar({
  filters,
  recruiterOptions,
  onPatch,
  onClearSegments,
}: {
  filters: AnalyticsFilters;
  recruiterOptions: Array<{ id: string; label: string }>;
  onPatch: (patch: Partial<Record<string, string | undefined>>) => void;
  onClearSegments: () => void;
}) {
  const segCount = activeSegmentCount(filters);
  return (
    <div className="sticky top-0 z-10 flex flex-col gap-3 border-b border-border bg-background px-6 py-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* Date range */}
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Date range</Label>
          <Select value={filters.range} onValueChange={(v) => onPatch({ range: v })}>
            <SelectTrigger className="w-[150px]" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_TOKENS.map((t) => (
                <SelectItem key={t} value={t}>
                  {RANGE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filters.range === "custom" && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="from-date" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="from-date"
                type="date"
                className="w-[150px]"
                value={filters.from ? filters.from.slice(0, 10) : ""}
                onChange={(e) =>
                  onPatch({ from: e.target.value ? new Date(e.target.value).toISOString() : undefined })
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="to-date" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="to-date"
                type="date"
                className="w-[150px]"
                value={filters.to ? filters.to.slice(0, 10) : ""}
                onChange={(e) =>
                  onPatch({ to: e.target.value ? new Date(e.target.value).toISOString() : undefined })
                }
              />
            </div>
          </>
        )}

        {/* Source segment */}
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Source</Label>
          <Select
            value={filters.source ?? ALL}
            onValueChange={(v) => onPatch({ source: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-[150px]" aria-label="Source segment">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              {CANDIDATE_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Recruiter segment */}
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Recruiter</Label>
          <Select
            value={filters.recruiterUserId ?? ALL}
            onValueChange={(v) => onPatch({ recruiterUserId: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-[180px]" aria-label="Recruiter segment">
              <SelectValue placeholder="All recruiters" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All recruiters</SelectItem>
              {recruiterOptions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Granularity (drives trends) */}
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Granularity</Label>
          <Select value={filters.granularity} onValueChange={(v) => onPatch({ granularity: v })}>
            <SelectTrigger className="w-[120px]" aria-label="Granularity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Compare toggle */}
        <div className="flex items-center gap-2 pb-1.5">
          <Switch
            id="compare"
            checked={filters.compare}
            onCheckedChange={(v) => onPatch({ compare: v ? "1" : undefined })}
            aria-label="Compare to previous period"
          />
          <Label htmlFor="compare" className="text-xs">
            Compare to previous period
          </Label>
        </div>

        {segCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 pb-1.5"
            onClick={onClearSegments}
            data-testid="clear-segments"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            Clear {segCount} segment{segCount > 1 ? "s" : ""}
          </Button>
        )}
      </div>
    </div>
  );
}
