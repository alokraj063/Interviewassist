import { useNavigate } from "react-router-dom";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  Archive,
  Clock,
  ArrowUp,
  ArrowDown,
  FileText,
  Link2,
  Cloud,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { CORPUS_LABELS, type KbSourceRow, type SourceSort } from "@/hooks/useKnowledge";

function StatusCell({ row }: { row: KbSourceRow }) {
  const map: Record<KbSourceRow["status"], { icon: typeof CheckCircle2; label: string; cls: string }> = {
    indexed: { icon: CheckCircle2, label: "Indexed", cls: "text-success" },
    indexing: { icon: Loader2, label: "Indexing", cls: "text-info" },
    error: { icon: AlertCircle, label: "Error", cls: "text-destructive" },
    deprecated: { icon: Archive, label: "Deprecated", cls: "text-muted-foreground" },
  };
  const s = map[row.status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.cls)}>
      <Icon className={cn("h-3.5 w-3.5", row.status === "indexing" && "animate-spin")} aria-hidden />
      {s.label}
      {row.isStale && (
        <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
          <Clock className="h-3 w-3" aria-hidden /> Stale
        </span>
      )}
    </span>
  );
}

function SourceIcon({ type }: { type: string }) {
  const Icon = type === "URL" ? Link2 : type === "Upload" ? FileText : type === "Confluence" ? FileText : Cloud;
  return <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

function SortHeader({
  label,
  col,
  sort,
  dir,
  onSort,
  align,
}: {
  label: string;
  col: SourceSort;
  sort: SourceSort;
  dir: "asc" | "desc";
  onSort: (c: SourceSort) => void;
  align?: "right";
}) {
  const active = sort === col;
  return (
    <th className={cn(align === "right" && "text-right")}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={() => onSort(col)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
}

export function SourcesTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
  sort,
  dir,
  onSort,
  selectable,
}: {
  rows: KbSourceRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  sort: SourceSort;
  dir: "asc" | "desc";
  onSort: (c: SourceSort) => void;
  selectable: boolean;
}) {
  const nav = useNavigate();
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <table className="data-table">
      <thead>
        <tr>
          {selectable && (
            <th className="w-8">
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => onToggleAll(rows.map((r) => r.id))}
                aria-label="Select all sources"
              />
            </th>
          )}
          <SortHeader label="Source" col="name" sort={sort} dir={dir} onSort={onSort} />
          <th>Collection</th>
          <th>Status</th>
          <SortHeader label="Documents" col="created" sort={sort} dir={dir} onSort={onSort} />
          <SortHeader label="Last indexed" col="updated" sort={sort} dir={dir} onSort={onSort} />
          <SortHeader label="Retrievals (7d)" col="retrievals" sort={sort} dir={dir} onSort={onSort} align="right" />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            role="button"
            tabIndex={0}
            className="cursor-pointer hover:bg-muted/20"
            onClick={() => nav(`/knowledge/sources/${r.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                nav(`/knowledge/sources/${r.id}`);
              }
            }}
          >
            {selectable && (
              <td onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={selected.has(r.id)}
                  onCheckedChange={() => onToggle(r.id)}
                  aria-label={`Select ${r.name}`}
                />
              </td>
            )}
            <td>
              <div className="flex items-center gap-2">
                <SourceIcon type={r.type} />
                <a
                  href={`/knowledge/sources/${r.id}`}
                  className="font-medium hover:underline"
                  onClick={(e) => e.preventDefault()}
                >
                  {r.name}
                </a>
              </div>
            </td>
            <td className="text-xs text-muted-foreground">
              {r.corpus ? CORPUS_LABELS[r.corpus] : "—"}
            </td>
            <td>
              <StatusCell row={r} />
            </td>
            <td className="tabular-nums">{r.documentCount}</td>
            <td className="text-xs text-muted-foreground">
              {r.lastIndexedAt
                ? formatDistanceToNow(new Date(r.lastIndexedAt), { addSuffix: true })
                : "—"}
            </td>
            <td className="text-right tabular-nums">{r.retrievals7d.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
