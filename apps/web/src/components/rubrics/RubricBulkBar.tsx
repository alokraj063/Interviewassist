// Multi-select bulk action bar. Appears when ≥1 rubric is selected. Offers
// Archive, Set default, and Export — each hits the real /api/rubrics/bulk
// endpoint. Set applies-to is available via the dropdown.
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Archive, Download, Star, X, Loader2 } from "lucide-react";
import { APPLIES_TO_OPTIONS, type RubricAppliesTo } from "@/hooks/useRubrics";

export function RubricBulkBar({
  count,
  busy,
  onClear,
  onArchive,
  onSetDefault,
  onExport,
  onSetAppliesTo,
}: {
  count: number;
  busy: boolean;
  onClear: () => void;
  onArchive: () => void;
  onSetDefault: () => void;
  onExport: () => void;
  onSetAppliesTo: (v: RubricAppliesTo) => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-2 shadow-sm"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onArchive}>
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Archive className="w-3.5 h-3.5 mr-1.5" />}
          Archive
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSetDefault}>
          <Star className="w-3.5 h-3.5 mr-1.5" />
          Set default
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onExport}>
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Export
        </Button>
        <Select onValueChange={(v) => onSetAppliesTo(v as RubricAppliesTo)}>
          <SelectTrigger className="h-8 w-[150px]" aria-label="Set applies-to">
            <SelectValue placeholder="Set applies-to…" />
          </SelectTrigger>
          <SelectContent>
            {APPLIES_TO_OPTIONS.map((o) => (
              <SelectItem key={o} value={o} className="capitalize">
                {o.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear} aria-label="Clear selection">
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
