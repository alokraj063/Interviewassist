// Live Assist — Usage & cost tab.
// Token usage + USD cost for every LLM call the co-pilot makes
// (plan / next / verify / final / suggestion), aggregated from ai_usage_events.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, Coins, Hash, Activity } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useState } from "react";

interface Row { operation?: string; model?: string; calls: number; totalTokens: number; costUsd: number; }
interface UsageResp {
  ok: boolean;
  days: number;
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  byOperation: Row[];
  byModel: Row[];
  byCall: Array<{ callId: string | null; label: string; calls: number; totalTokens: number; costUsd: number; lastAt: string }>;
  recent: Array<{ operation: string; model: string; callId: string | null; totalTokens: number; costUsd: number; createdAt: string }>;
  pricing: Record<string, { in: number; out: number }>;
}

const OP_LABEL: Record<string, string> = {
  plan: "Question plan", next: "Next question", verify: "Answer check",
  final: "Final score", suggestion: "Live suggestions", embedding: "Embeddings",
};
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(5) : n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString();

export default function LiveAssistUsage() {
  const [days, setDays] = useState(30);
  const { data, isLoading, refetch, isFetching } = useQuery<UsageResp>({
    queryKey: ["assist-usage", days],
    queryFn: () => apiFetch(`/api/assist/usage?days=${days}`),
  });

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <Link to="/live-assist" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Live Assist
          </Link>
          <h1 className="text-xl font-semibold mt-1">Token usage & cost</h1>
          <p className="text-sm text-muted-foreground">Every AI call the co-pilot makes — tokens and estimated USD cost.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={365}>Last year</option>
          </select>
          <button onClick={() => refetch()} className="h-8 px-2 rounded-md border border-border text-sm inline-flex items-center gap-1 hover:bg-muted/50">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="text-sm text-muted-foreground">Loading usage…</div>
      ) : (
        <>
          {/* Totals */}
          <div className="grid grid-cols-3 gap-3">
            <Stat icon={Coins} label="Total cost" value={usd(data.totals.costUsd)} sub={`${data.totals.calls} AI calls`} />
            <Stat icon={Hash} label="Total tokens" value={num(data.totals.totalTokens)} sub={`${num(data.totals.promptTokens)} in · ${num(data.totals.completionTokens)} out`} />
            <Stat icon={Activity} label="Avg cost / call" value={usd(data.totals.calls ? data.totals.costUsd / data.totals.calls : 0)} sub={`over ${data.days} days`} />
          </div>

          {/* By call — the headline call-wise cost breakdown */}
          <Card title="Cost per call">
            <Table headers={["Call (candidate · JD)", "AI calls", "Tokens", "Cost"]} rows={data.byCall.map((r) => [
              r.label, num(r.calls), num(r.totalTokens), usd(r.costUsd),
            ])} empty="No calls yet — start an interview." />
          </Card>

          {/* By operation */}
          <Card title="By operation">
            <Table headers={["Operation", "Calls", "Tokens", "Cost"]} rows={data.byOperation.map((r) => [
              OP_LABEL[r.operation ?? ""] ?? r.operation ?? "—", num(r.calls), num(r.totalTokens), usd(r.costUsd),
            ])} empty="No usage yet — run a call." />
          </Card>

          {/* By model */}
          <Card title="By model">
            <Table headers={["Model", "Calls", "Tokens", "Cost"]} rows={data.byModel.map((r) => [
              r.model ?? "—", num(r.calls), num(r.totalTokens), usd(r.costUsd),
            ])} empty="—" />
          </Card>

          {/* Recent */}
          <Card title="Recent calls">
            <Table headers={["When", "Operation", "Model", "Tokens", "Cost"]} rows={data.recent.map((r) => [
              new Date(r.createdAt).toLocaleString(),
              OP_LABEL[r.operation] ?? r.operation,
              r.model, num(r.totalTokens), usd(r.costUsd),
            ])} empty="No calls yet." />
          </Card>

          <p className="text-[11px] text-muted-foreground">
            Cost is estimated from OpenAI list pricing per 1M tokens (e.g. gpt-4o-mini ${data.pricing["gpt-4o-mini"]?.in}/in · ${data.pricing["gpt-4o-mini"]?.out}/out).
            Deepgram speech-to-text is billed separately by audio minutes and isn't token-based, so it's not shown here.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Coins; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground"><Icon className="w-3.5 h-3.5" />{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-2 border-b border-border text-xs font-semibold uppercase tracking-wide">{title}</div>
      <div className="p-2">{children}</div>
    </div>
  );
}

function Table({ headers, rows, empty }: { headers: string[]; rows: (string | number)[][]; empty: string }) {
  if (rows.length === 0) return <div className="p-3 text-xs text-muted-foreground text-center">{empty}</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {headers.map((h, i) => <th key={h} className={`px-2 py-1.5 font-medium ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-t border-border/60">
            {r.map((c, ci) => <td key={ci} className={`px-2 py-1.5 tabular-nums ${ci === 0 ? "text-left" : "text-right"}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
