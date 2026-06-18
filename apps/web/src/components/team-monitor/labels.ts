// Shared display metadata for Team Monitor: activity, severity, SLA metrics.
// Activity + severity convey meaning with TEXT + ICON, never color alone (A8).
import {
  Phone,
  Coffee,
  CalendarClock,
  CircleOff,
  Info,
  AlertTriangle,
  AlertOctagon,
  type LucideIcon,
} from "lucide-react";
import type { PresenceActivity, AlertSeverity, SlaMetric } from "@/hooks/useTeamMonitor";

export const ACTIVITY_META: Record<
  PresenceActivity,
  { label: string; icon: LucideIcon; cls: string }
> = {
  on_call: { label: "On call", icon: Phone, cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  idle: { label: "Idle", icon: Coffee, cls: "bg-amber-50 text-amber-700 border-amber-200" },
  in_meeting: {
    label: "In meeting",
    icon: CalendarClock,
    cls: "bg-sky-50 text-sky-700 border-sky-200",
  },
  offline: { label: "Offline", icon: CircleOff, cls: "bg-muted text-muted-foreground border-border" },
};

export const SEVERITY_META: Record<
  AlertSeverity,
  { label: string; icon: LucideIcon; cls: string }
> = {
  info: { label: "Info", icon: Info, cls: "bg-sky-50 text-sky-700 border-sky-200" },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    cls: "bg-amber-50 text-amber-700 border-amber-200",
  },
  critical: {
    label: "Critical",
    icon: AlertOctagon,
    cls: "bg-rose-50 text-rose-700 border-rose-200",
  },
};

export const SLA_METRIC_META: Record<
  SlaMetric,
  { label: string; unit: "ms" | "count" | "pct"; lowerWorse: boolean; help: string }
> = {
  queue_depth: {
    label: "Queue depth",
    unit: "count",
    lowerWorse: false,
    help: "Number of queued (unassigned) calls waiting.",
  },
  call_duration_ms: {
    label: "Call duration",
    unit: "ms",
    lowerWorse: false,
    help: "A live call running longer than this is flagged as an overrun.",
  },
  recruiter_idle_ms: {
    label: "Recruiter idle",
    unit: "ms",
    lowerWorse: false,
    help: "A recruiter idle longer than this is flagged.",
  },
  abandoned_rate: {
    label: "Abandoned rate",
    unit: "pct",
    lowerWorse: false,
    help: "Share of abandoned calls (stored as percent ×100).",
  },
  answer_rate: {
    label: "Answer rate",
    unit: "pct",
    lowerWorse: true,
    help: "Share of calls answered (stored as percent ×100). Lower is worse.",
  },
};

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Convert a stored threshold value to a human display per metric unit.
export function fmtThreshold(metric: SlaMetric, v: number): string {
  const meta = SLA_METRIC_META[metric];
  if (meta.unit === "ms") return fmtDuration(v);
  if (meta.unit === "pct") return `${(v / 100).toFixed(0)}%`;
  return String(v);
}
