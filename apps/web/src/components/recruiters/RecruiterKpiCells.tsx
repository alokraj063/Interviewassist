// Shared cell renderers for the recruiters leaderboard + detail surfaces:
// goal-attainment ring, capacity/load bar with explicit over-allocation
// warning (icon + text, role=status — never color-only), an SLA-breach badge,
// and a trend sparkline. All take plain numbers from the live KPI payload.
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "@/components/Sparkline";

export const ROLE_LABEL: Record<string, string> = {
  recruiter: "Recruiter",
  delivery_lead: "Delivery Lead",
  account_manager: "Account Manager",
  business_head: "Business Head",
};

export const ROLE_PILL: Record<string, string> = {
  recruiter: "bg-info/15 text-info",
  delivery_lead: "bg-primary/15 text-primary",
  account_manager: "bg-warning/15 text-warning",
  business_head: "bg-success/15 text-success",
};

export function fmtBps(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/** Goal-attainment ring. null target → an em-dash. */
export function GoalAttainmentRing({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground text-xs">—</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  const band = pct >= 100 ? "text-success" : pct >= 70 ? "text-warning" : "text-destructive";
  const ring = pct >= 100 ? "stroke-success" : pct >= 70 ? "stroke-warning" : "stroke-destructive";
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Goal attainment ${pct}%`}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={r} fill="none" className="stroke-muted" strokeWidth="3" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          className={ring}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
          transform="rotate(-90 12 12)"
        />
      </svg>
      <span className={cn("text-xs font-medium tabular-nums", band)}>{pct}%</span>
    </span>
  );
}

/** Capacity/load bar. overAllocated surfaces a text+icon status badge. */
export function LoadCell({
  active,
  max,
  pct,
  overAllocated,
}: {
  active: number;
  max: number;
  pct: number;
  overAllocated: boolean;
}) {
  const barColor = overAllocated ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary";
  return (
    <div className="flex flex-col gap-1 min-w-[96px]">
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
          <div className={cn("h-full rounded-full", barColor)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {active}/{max}
        </span>
      </div>
      {overAllocated && (
        <span
          role="status"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive"
        >
          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
          Over capacity {active}/{max}
        </span>
      )}
    </div>
  );
}

export function SlaBreachBadge({ count }: { count: number }) {
  if (!count) return <span className="text-muted-foreground text-xs tabular-nums">0</span>;
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-destructive/10 text-destructive"
    >
      <AlertTriangle className="w-3 h-3" aria-hidden="true" />
      {count}
    </span>
  );
}

export function TrendSpark({ data }: { data: number[] }) {
  if (!data || data.length < 2) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return <Sparkline data={data} width={72} height={20} />;
}
