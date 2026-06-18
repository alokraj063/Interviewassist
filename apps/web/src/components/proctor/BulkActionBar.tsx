import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { UserPlus, CheckCircle2, Download, X } from "lucide-react";
import { getApiBase, getAccessToken } from "@/lib/api";
import { AssignDialog } from "./AssignDialog";
import { errMessage, useReviewSession, type SessionRow } from "@/hooks/useProctor";

/**
 * Multi-select bulk bar for the roster:
 *   - Assign to reviewer (bulk)
 *   - Mark clean (low-risk only — guards against bulk-clearing high-risk rows)
 *   - Export evidence (downloads each selected session's JSON manifest)
 */
export function BulkActionBar({
  selected,
  rows,
  canReview,
  canExport,
  onClear,
  onDone,
}: {
  selected: Set<string>;
  rows: SessionRow[];
  canReview: boolean;
  canExport: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const review = useReviewSession();
  const [assignOpen, setAssignOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const ids = Array.from(selected);
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const lowRiskCleanable = selectedRows.filter((r) => r.riskScore < 35 && r.status === "completed" && !r.reviewerDecision);

  const markClean = async () => {
    if (lowRiskCleanable.length === 0) {
      toast.info("No low-risk un-decided sessions selected", {
        description: "Mark-clean is limited to risk < 35 to avoid clearing flagged rows in bulk.",
      });
      return;
    }
    setBusy(true);
    let ok = 0;
    try {
      for (const r of lowRiskCleanable) {
        try {
          await review.mutateAsync({ sessionId: r.id, decision: "clean" });
          ok += 1;
        } catch (e) {
          toast.error("Mark-clean failed", { description: errMessage(e) });
        }
      }
      toast.success(`Marked ${ok}/${lowRiskCleanable.length} clean`);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const exportEvidence = async () => {
    setBusy(true);
    let ok = 0;
    try {
      const token = getAccessToken();
      for (const id of ids) {
        try {
          const res = await fetch(`${getApiBase()}/api/proctor/sessions/${id}/export?format=json`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
          });
          if (!res.ok) throw new Error(`export ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `proctor-${id}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          ok += 1;
        } catch {
          /* per-item failure surfaced below */
        }
      }
      toast.success(`Exported ${ok}/${ids.length} evidence manifest${ids.length > 1 ? "s" : ""}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sticky bottom-4 z-20 mx-auto flex w-fit items-center gap-3 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
      <span className="text-sm font-medium">{selected.size} selected</span>
      {canReview && (
        <>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAssignOpen(true)}>
            <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Assign
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={markClean}>
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> Mark clean ({lowRiskCleanable.length})
          </Button>
        </>
      )}
      {canExport && (
        <Button size="sm" variant="outline" disabled={busy} onClick={exportEvidence}>
          <Download className="w-3.5 h-3.5 mr-1.5" /> Export
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
        <X className="w-4 h-4" />
      </Button>

      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        sessionIds={ids}
        onDone={onDone}
      />
    </div>
  );
}
