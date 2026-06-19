import { useState } from "react";
import { Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const COMPLIANCE_ITEMS = [
  { id: "interest", label: "Confirmed candidate's interest in the role" },
  { id: "ctc", label: "Discussed compensation range with rationale" },
  { id: "notice", label: "Asked about notice period and flexibility" },
  { id: "location", label: "Validated location preference vs demand" },
  { id: "background", label: "Mentioned mandatory background checks" },
  { id: "next-steps", label: "Closed with explicit next step and ETA" },
];

/**
 * Live Assist right-panel: compliance / script-adherence checklist.
 *
 * Phase 1: recruiter manually ticks items as they cover them. Phase 2 will
 * auto-detect coverage from the transcript via the rubric_finalize worker
 * and pre-fill the checks with confidence levels.
 */
export function CompliancePanel() {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const completedPct = Math.round((checked.size / COMPLIANCE_ITEMS.length) * 100);

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
      <div className="px-4 py-2 border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center justify-between">
        <span>Coverage checklist</span>
        <span className="text-foreground tabular-nums normal-case">{completedPct}%</span>
      </div>
      <div className="divide-y divide-border">
        {COMPLIANCE_ITEMS.map((item) => {
          const isChecked = checked.has(item.id);
          return (
            <button
              key={item.id}
              onClick={() => {
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                });
              }}
              className="w-full p-3 flex items-start gap-3 text-left hover:bg-muted/30 transition-colors"
            >
              <span className={cn(
                "inline-flex items-center justify-center w-5 h-5 rounded border shrink-0 mt-0.5",
                isChecked ? "bg-success border-success text-white" : "border-muted-foreground/40"
              )}>
                {isChecked ? <Check className="w-3 h-3" /> : null}
              </span>
              <span className={cn("text-sm flex-1", isChecked && "text-muted-foreground line-through")}>
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="p-3 border-t border-border bg-muted/20 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="text-[11px] text-muted-foreground">
          Manual checks for now. After-call AI coverage detection lands in Phase 2 and pre-fills these.
        </div>
      </div>
    </div>
  );
}
