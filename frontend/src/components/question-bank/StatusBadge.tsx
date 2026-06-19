// Question status pill. Status is conveyed by TEXT + ICON, not color alone
// (A8 accessibility).
import { CheckCircle2, Clock, FileEdit, XCircle, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type QuestionStatus } from "@/hooks/useQuestionBanks";

const META: Record<QuestionStatus, { icon: typeof Clock; cls: string }> = {
  draft: { icon: FileEdit, cls: "bg-muted text-muted-foreground" },
  in_review: { icon: Clock, cls: "bg-amber-100 text-amber-800" },
  approved: { icon: CheckCircle2, cls: "bg-emerald-100 text-emerald-800" },
  rejected: { icon: XCircle, cls: "bg-rose-100 text-rose-800" },
  archived: { icon: Archive, cls: "bg-slate-100 text-slate-600" },
};

export function StatusBadge({ status }: { status: QuestionStatus }) {
  const m = META[status] ?? META.draft;
  const Icon = m.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        m.cls,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
