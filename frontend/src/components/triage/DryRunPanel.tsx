import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FlaskConical, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDryRunRules } from "@/hooks/useTriage";
import type { TriageDryRunResult, TriageRoutingRule } from "@j2w/shared-types";

interface Props {
  flowId: string;
  // The candidate (in-editor) rule set to replay; falls back to the live draft
  // server-side if omitted.
  candidateRules: TriageRoutingRule[];
  onClose: () => void;
}

export function DryRunPanel({ flowId, candidateRules, onClose }: Props) {
  const [windowDays, setWindowDays] = useState(14);
  const [sampleLimit, setSampleLimit] = useState(1000);
  const dryRun = useDryRunRules(flowId);
  const result = dryRun.data;

  function run() {
    dryRun.mutate({
      rules: candidateRules,
      windowDays,
      sampleLimit,
    });
  }

  return (
    <div className="absolute top-3 right-3 w-[380px] max-h-[560px] overflow-y-auto bg-card border border-border rounded-lg shadow-lg z-10">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between sticky top-0 bg-card">
        <div className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
          <FlaskConical className="w-3.5 h-3.5" />
          Dry-run vs history
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} aria-label="Close dry-run">
          <X className="w-3 h-3" />
        </Button>
      </div>

      <div className="p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Replays real classified calls through the rules currently on the canvas and diffs the
          outcomes against the published set.
        </p>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="dry-window" className="text-[11px]">
              Window (days)
            </Label>
            <Input
              id="dry-window"
              type="number"
              min={1}
              max={90}
              value={windowDays}
              onChange={(e) =>
                setWindowDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))
              }
              className="h-8 text-sm mt-1"
            />
          </div>
          <div>
            <Label htmlFor="dry-sample" className="text-[11px]">
              Sample limit
            </Label>
            <Input
              id="dry-sample"
              type="number"
              min={1}
              max={5000}
              value={sampleLimit}
              onChange={(e) =>
                setSampleLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))
              }
              className="h-8 text-sm mt-1"
            />
          </div>
        </div>

        <Button
          size="sm"
          className="w-full h-8 text-xs"
          onClick={run}
          disabled={dryRun.isPending}
        >
          {dryRun.isPending ? "Replaying…" : "Run dry-run"}
        </Button>

        {dryRun.isError && (
          <div className="text-xs text-destructive flex items-start gap-1.5 rounded bg-destructive/10 p-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div>
              <div>
                {dryRun.error instanceof Error ? dryRun.error.message : "Dry-run failed"}
              </div>
              <button
                type="button"
                className="underline mt-1"
                onClick={run}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {result && !dryRun.isPending && <DryRunResults result={result} />}
      </div>
    </div>
  );
}

function DryRunResults({ result }: { result: TriageDryRunResult }) {
  if (result.evaluated === 0) {
    return (
      <div className="text-xs text-muted-foreground border-t border-border pt-3" data-testid="dryrun-result">
        No classified calls in the selected window. Widen the window or wait for traffic.
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="dryrun-result">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Evaluated" value={result.evaluated} />
        <Stat label="Matched" value={result.matched} tone="success" />
        <Stat label="No match" value={result.noMatch} tone={result.noMatch ? "warning" : "default"} />
        <Stat label="Via fallback" value={result.fallback} />
        <Stat
          label="Route differently"
          value={result.wouldRouteDifferently}
          tone={result.wouldRouteDifferently ? "warning" : "default"}
        />
        <Stat label="Projected SLA breaches" value={result.projectedSlaBreaches} />
      </div>

      {result.byDestination.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
            Projected destinations
          </div>
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer>
              <BarChart
                data={result.byDestination}
                layout="vertical"
                margin={{ top: 4, right: 8, left: 4, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="destination"
                  tick={{ fontSize: 10 }}
                  width={90}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground">
        As of {new Date(result.asOf).toLocaleString()}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning";
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : "text-foreground";
  return (
    <div className="rounded bg-muted/50 px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}
