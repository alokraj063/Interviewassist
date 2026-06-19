import { TrendingUp, TrendingDown } from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine,
} from "recharts";
import { SentimentDot } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { PanelShell } from "./PanelShell";

export function SentimentCard({
  series,
  current,
  trend,
  compact = false,
}: {
  series: { t: number; v: number }[];
  current: number;
  trend: number;
  // Renders a denser layout (no Y-axis, tighter stat tiles) so the card fits
  // the small bottom slot on the Live Assist grid.
  compact?: boolean;
}) {
  const tone = current >= 65 ? "positive" : current >= 40 ? "neutral" : "negative";
  const toneColor =
    tone === "positive" ? "text-success" : tone === "negative" ? "text-destructive" : "text-warning";
  return (
    <PanelShell
      title="Real-time sentiment"
      action={
        <span className="inline-flex items-center gap-1.5 text-xs">
          <SentimentDot sentiment={tone} />
          <span className={cn("font-semibold capitalize", toneColor)}>{tone}</span>
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px]",
              trend >= 0 ? "text-success" : "text-destructive",
            )}
          >
            {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend).toFixed(0)}
          </span>
        </span>
      }
      bodyClass="flex flex-col"
    >
      <div className={cn("flex-1 min-h-0", compact ? "p-1.5" : "p-2")}>
        {series.length < 2 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            waiting for speech…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 8, right: 12, left: compact ? 4 : -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="sentGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" hide />
              {/* Keep the fixed 0–100 domain either way so the y=50 reference
                  line stays centered; in compact mode just hide the tick
                  labels (the numeric score lives in the "Score" tile below)
                  and reclaim the horizontal space for the sparkline. */}
              <YAxis
                domain={[0, 100]}
                hide={compact}
                tick={{ fontSize: 10 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelFormatter={() => ""}
                formatter={(v) => [`${Math.round(v as number)}`, "Sentiment"]}
              />
              <ReferenceLine y={50} stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <Area
                type="monotone"
                dataKey="v"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#sentGrad)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div
        className={cn(
          "shrink-0 grid grid-cols-4 text-xs",
          compact ? "px-2 pb-1.5 gap-1.5" : "px-3 pb-2 gap-2",
        )}
      >
        <Mini label="Score" value={series.length ? Math.round(current).toString() : "—"} compact={compact} />
        <Mini label="Talk ratio" value="—" compact={compact} />
        <Mini label="Silence" value="—" compact={compact} />
        <Mini label="Risk" value={current < 40 && series.length > 3 ? "Escalation" : "Low"} bad={current < 40 && series.length > 3} compact={compact} />
      </div>
    </PanelShell>
  );
}

function Mini({
  label,
  value,
  bad,
  compact,
}: {
  label: string;
  value: string;
  bad?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-md bg-muted/50", compact ? "px-1.5 py-1 leading-tight" : "px-2 py-1.5")}>
      <div className={cn("uppercase text-muted-foreground truncate", compact ? "text-[9px]" : "text-[10px]")}>
        {label}
      </div>
      <div
        className={cn(
          "font-medium truncate",
          bad && "text-destructive",
          compact ? "text-[11px]" : "mt-0.5",
        )}
      >
        {value}
      </div>
    </div>
  );
}
