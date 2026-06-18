import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, subtitle, actions, breadcrumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: { label: string; href?: string }[] }) {
  return (
    <div className="px-6 pt-5 pb-4 border-b border-border bg-background">
      {breadcrumbs && (
        <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span>/</span>}
              <span className={i === breadcrumbs.length - 1 ? "text-foreground" : "hover:text-foreground cursor-pointer"}>{b.label}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

export function MetricCard({ label, value, delta, hint, accent }: { label: string; value: ReactNode; delta?: { v: string; positive?: boolean }; hint?: ReactNode; accent?: "default" | "warning" | "danger" | "success" }) {
  const accentClass = accent === "warning" ? "border-l-warning" : accent === "danger" ? "border-l-destructive" : accent === "success" ? "border-l-success" : "border-l-primary";
  return (
    <div className={cn("bg-card border border-border rounded-lg p-4 border-l-2", accentClass)}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-[24px] font-semibold tabular-nums tracking-tight">{value}</div>
        {delta && (
          <div className={cn("text-xs font-medium tabular-nums", delta.positive ? "text-success" : "text-destructive")}>
            {delta.positive ? "↑" : "↓"} {delta.v}
          </div>
        )}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("bg-card border border-border rounded-lg", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {action && <div>{action}</div>}
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

export function Avatar({ initials, size = 28, className, color }: { initials: string; size?: number; className?: string; color?: string }) {
  // deterministic color from initials
  const palette = ["bg-emerald-100 text-emerald-700", "bg-sky-100 text-sky-700", "bg-violet-100 text-violet-700", "bg-amber-100 text-amber-700", "bg-rose-100 text-rose-700", "bg-cyan-100 text-cyan-700", "bg-indigo-100 text-indigo-700", "bg-orange-100 text-orange-700"];
  const idx = (initials.charCodeAt(0) + (initials.charCodeAt(1) || 0)) % palette.length;
  return (
    <span style={{ width: size, height: size, fontSize: Math.floor(size * 0.42) }} className={cn("inline-flex items-center justify-center rounded-full font-semibold shrink-0", color || palette[idx], className)}>
      {initials}
    </span>
  );
}

export function ScoreBadge({ score, band }: { score: number; band: "pass" | "warn" | "fail" }) {
  const cls = band === "pass" ? "bg-success/10 text-success border-success/20" : band === "warn" ? "bg-warning/10 text-warning border-warning/20" : "bg-destructive/10 text-destructive border-destructive/20";
  return <span className={cn("inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums border min-w-[40px]", cls)}>{score}</span>;
}

export function CategoryPill({ category }: { category: string }) {
  const map: Record<string, string> = {
    Identification: "bg-violet-50 text-violet-700 border-violet-200",
    Resolution: "bg-sky-50 text-sky-700 border-sky-200",
    Escalation: "bg-amber-50 text-amber-700 border-amber-200",
    Compliance: "bg-rose-50 text-rose-700 border-rose-200",
    Empathy: "bg-pink-50 text-pink-700 border-pink-200",
    Process: "bg-slate-50 text-slate-700 border-slate-200",
  };
  return <span className={cn("pill border", map[category] || "bg-muted text-muted-foreground border-border")}>{category}</span>;
}

export function SentimentDot({ sentiment }: { sentiment: string }) {
  const map: Record<string, string> = {
    positive: "bg-success",
    neutral: "bg-muted-foreground/40",
    negative: "bg-warning",
    escalated: "bg-destructive",
  };
  return <span className={cn("inline-block w-2 h-2 rounded-full", map[sentiment] || "bg-muted-foreground/40")} />;
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <div className="text-sm font-semibold">{title}</div>
      {body && <div className="text-sm text-muted-foreground mt-1 max-w-md">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
