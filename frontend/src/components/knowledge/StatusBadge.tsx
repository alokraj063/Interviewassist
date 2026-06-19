// Source status as text+icon (never color-only) for a11y.
import { CheckCircle2, Loader2, AlertTriangle, Archive } from "lucide-react";
import type { SourceStatus } from "@/hooks/useKnowledge";
import { cn } from "@/lib/utils";

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  const map: Record<SourceStatus, { Icon: typeof CheckCircle2; label: string; cls: string }> = {
    indexed: { Icon: CheckCircle2, label: "Indexed", cls: "text-success" },
    indexing: { Icon: Loader2, label: "Indexing", cls: "text-info" },
    error: { Icon: AlertTriangle, label: "Error", cls: "text-destructive" },
    deprecated: { Icon: Archive, label: "Deprecated", cls: "text-muted-foreground" },
  };
  const { Icon, label, cls } = map[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", cls)}>
      <Icon className={cn("h-4 w-4", status === "indexing" && "animate-spin")} aria-hidden />
      {label}
    </span>
  );
}
