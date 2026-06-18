import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ITEM_TYPE_LABELS, type ItemType, type ResultsResponse } from "@/hooks/useAssessments";

// Per-item psychometrics from /results: p-value (difficulty), discrimination
// (point-biserial), and distractor selection counts. Items with poor
// discrimination are flagged. All values trace to real graded attempts.
export function ItemAnalysisTable({ items }: { items: ResultsResponse["items"] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (items.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No items to analyze.</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="w-8"></th>
          <th>Item</th>
          <th>Type</th>
          <th>n</th>
          <th>p-value</th>
          <th>Discrimination</th>
          <th>Flag</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const hasDistractors = it.distractors.length > 0;
          const open = expanded.has(it.itemId);
          return (
            <Fragment key={it.itemId}>
              <tr className="hover:bg-muted/30">
                <td>
                  {hasDistractors ? (
                    <button
                      onClick={() => toggle(it.itemId)}
                      aria-label={open ? "Collapse distractors" : "Expand distractors"}
                    >
                      {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                  ) : null}
                </td>
                <td className="max-w-md truncate" title={it.prompt}>
                  {it.prompt || "(untitled)"}
                </td>
                <td className="text-xs text-muted-foreground">
                  {ITEM_TYPE_LABELS[it.type as ItemType] ?? it.type}
                </td>
                <td className="tabular-nums">{it.n}</td>
                <td className="tabular-nums">{it.pValue == null ? "—" : it.pValue.toFixed(2)}</td>
                <td className="tabular-nums">
                  {it.discrimination == null ? "—" : it.discrimination.toFixed(2)}
                </td>
                <td>
                  {it.flagged ? (
                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="w-3.5 h-3.5" /> review
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
              {open && hasDistractors && (
                <tr>
                  <td></td>
                  <td colSpan={6} className="bg-muted/20">
                    <div className="py-2 space-y-1.5">
                      <div className="text-xs font-medium text-muted-foreground">Distractor analysis</div>
                      {it.distractors.map((d) => {
                        const maxCount = Math.max(1, ...it.distractors.map((x) => x.count));
                        return (
                          <div key={d.optionId} className="flex items-center gap-2 text-xs">
                            <span className={cn("w-48 truncate", d.correct && "font-semibold text-success")}>
                              {d.label} {d.correct ? "✓" : ""}
                            </span>
                            <div className="flex-1 h-3 bg-muted rounded overflow-hidden">
                              <div
                                className={cn("h-full rounded", d.correct ? "bg-success/60" : "bg-destructive/40")}
                                style={{ width: `${(d.count / maxCount) * 100}%` }}
                              />
                            </div>
                            <span className="tabular-nums w-8 text-right">{d.count}</span>
                          </div>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
