import { Button } from "@/components/ui/button";
import { ArrowUp, ArrowDown, Pencil, Trash2, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { ITEM_TYPE_LABELS, AUTO_GRADABLE, type Item, type Section, type ItemType } from "@/hooks/useAssessments";

// Section + item list with up/down reorder (no drag lib in the tree → explicit
// buttons, never dead handlers). Items render under their section; ungrouped
// items render under a synthetic "Unsectioned" group.
export function SectionList({
  sections,
  items,
  disabled,
  onEditItem,
  onDeleteItem,
  onMoveItem,
  onDeleteSection,
}: {
  sections: Section[];
  items: Item[];
  disabled?: boolean;
  onEditItem: (item: Item) => void;
  onDeleteItem: (item: Item) => void;
  onMoveItem: (item: Item, dir: -1 | 1) => void;
  onDeleteSection: (section: Section) => void;
}) {
  const groups: Array<{ section: Section | null; items: Item[] }> = [];
  const sorted = [...items].sort((a, b) => a.position - b.position);
  for (const s of [...sections].sort((a, b) => a.position - b.position)) {
    groups.push({ section: s, items: sorted.filter((it) => it.sectionId === s.id) });
  }
  const ungrouped = sorted.filter((it) => !it.sectionId);
  if (ungrouped.length > 0 || sections.length === 0) {
    groups.push({ section: null, items: ungrouped });
  }

  if (items.length === 0 && sections.length === 0) {
    return (
      <div className="p-8 text-sm text-muted-foreground flex flex-col items-center gap-2">
        <Layers className="w-8 h-8 opacity-30" />
        No sections or questions yet. Add a section, then add typed questions.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map(({ section, items: groupItems }, gi) => (
        <div key={section?.id ?? `ungrouped-${gi}`}>
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-semibold">{section ? section.title : "Unsectioned"}</div>
              {section?.timeLimitSeconds ? (
                <div className="text-xs text-muted-foreground">
                  {Math.round(section.timeLimitSeconds / 60)} min limit
                  {section.shuffleItems ? " · shuffled" : ""}
                  {section.poolDrawCount ? ` · draws ${section.poolDrawCount}` : ""}
                </div>
              ) : null}
            </div>
            {section && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDeleteSection(section)}
                disabled={disabled}
                aria-label={`Delete section ${section.title}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
          {groupItems.length === 0 ? (
            <div className="text-xs text-muted-foreground pl-1 pb-2">No questions in this section.</div>
          ) : (
            <ul className="space-y-1.5">
              {groupItems.map((it, i) => (
                <li
                  key={it.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                >
                  <div className="flex flex-col">
                    <button
                      onClick={() => onMoveItem(it, -1)}
                      disabled={disabled || i === 0}
                      aria-label="Move up"
                      className="disabled:opacity-30"
                    >
                      <ArrowUp className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => onMoveItem(it, 1)}
                      disabled={disabled || i === groupItems.length - 1}
                      aria-label="Move down"
                      className="disabled:opacity-30"
                    >
                      <ArrowDown className="w-3 h-3" />
                    </button>
                  </div>
                  <span
                    className={cn(
                      "pill text-[10px]",
                      AUTO_GRADABLE.includes(it.type)
                        ? "bg-success/15 text-success"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {ITEM_TYPE_LABELS[it.type as ItemType]}
                  </span>
                  <span className="flex-1 text-sm truncate" title={it.prompt}>
                    {it.prompt || "(no prompt)"}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">{it.points} pt</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEditItem(it)}
                    disabled={disabled}
                    aria-label="Edit question"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDeleteItem(it)}
                    disabled={disabled}
                    aria-label="Delete question"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
