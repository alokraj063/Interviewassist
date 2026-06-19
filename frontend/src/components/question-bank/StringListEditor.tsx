// Repeatable string-list editor (evaluation rubric / follow-ups / mistakes).
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";

export function StringListEditor({
  label,
  items,
  onChange,
  placeholder,
  max = 20,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={it}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
              placeholder={placeholder}
              maxLength={500}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={`Remove ${label} item ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {items.length < max && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, ""])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add
          </Button>
        )}
      </div>
    </div>
  );
}
