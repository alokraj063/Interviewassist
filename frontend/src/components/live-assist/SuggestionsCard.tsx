import { Sparkles, BookOpen, Tag, Lightbulb, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Suggestion } from "@/hooks/useLiveCall";
import { PanelShell } from "./PanelShell";

// The backend streams the raw OpenAI JSON response as suggestion.delta tokens,
// so while a suggestion is in flight `s.text` is a partial JSON string like
// `{"suggestion":"Power light on है ले`. Pull just the suggestion field out so
// the user sees readable prose as it streams rather than raw JSON.
function extractStreamingSuggestion(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/"suggestion"\s*:\s*"/);
  if (!m) return "";
  let i = (m.index ?? 0) + m[0].length;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      if (next === "r") { out += "\r"; i += 2; continue; }
      if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        const code = parseInt(hex, 16);
        if (!Number.isFinite(code)) break;
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i++;
  }
  return out;
}

const COMPLIANCE_LABELS: Record<string, string> = {
  recording_disclosure: "Recording disclosure",
  identity_verification: "Identity verification",
  fee_disclosure: "Fee disclosure",
  cancellation_confirmation: "Cancellation confirmation",
};

function humanizeFlag(id: string): string {
  return (
    COMPLIANCE_LABELS[id] ??
    id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function SuggestionsCard({ suggestions }: { suggestions: Suggestion[] }) {
  const reversed = [...suggestions].reverse();
  return (
    <PanelShell
      title="AI suggestions"
      action={
        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <Lightbulb className="w-3 h-3" />
          {reversed.length === 0 ? "Waiting…" : "Updated live"}
        </span>
      }
    >
      {reversed.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground text-center">
          Suggestions appear as the candidate finishes speaking. Upload KB sources on{" "}
          <span className="font-medium">Knowledge</span> first to ground the answers.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {reversed.map((s) => (
            <SuggestionRow key={s.requestId} s={s} />
          ))}
        </div>
      )}
    </PanelShell>
  );
}

function SuggestionRow({ s }: { s: Suggestion }) {
  const body = s.done && s.payload
    ? s.payload.suggestion
    : extractStreamingSuggestion(s.text);

  const topics = s.done ? s.payload?.topics ?? [] : [];
  const complianceFlags = s.done ? s.payload?.complianceFlags ?? [] : [];
  const citations = s.done ? s.payload?.citations ?? [] : [];
  const confidence = s.done ? s.payload?.confidence : undefined;

  const confidenceTone =
    confidence == null
      ? "muted"
      : confidence >= 0.7
        ? "success"
        : confidence >= 0.4
          ? "warning"
          : "destructive";

  return (
    <div className="p-3 flex gap-3">
      <div className="shrink-0 w-7 h-7 rounded-md bg-primary/15 text-primary flex items-center justify-center">
        <Sparkles className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {body || <span className="text-muted-foreground">Thinking…</span>}
          {!s.done && body && <span className="inline-block w-1 h-3.5 ml-0.5 align-middle bg-primary/70 animate-pulse" />}
        </div>

        {topics.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {topics.slice(0, 4).map((t) => (
              <span key={t} className="pill bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 inline-flex items-center gap-1">
                <Tag className="w-2.5 h-2.5" />
                {t}
              </span>
            ))}
          </div>
        )}

        {complianceFlags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {complianceFlags.map((f) => (
              <span key={f} className="pill bg-warning/15 text-warning text-[10px] px-1.5 py-0.5 inline-flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />
                {humanizeFlag(f)}
              </span>
            ))}
          </div>
        )}

        {(citations.length > 0 || confidence != null || s.latencyMs != null) && (
          <div className="mt-2 flex flex-wrap gap-1">
            {citations.slice(0, 3).map((c) => (
              <span key={c.chunkId} className="pill bg-muted text-[10px] text-muted-foreground inline-flex items-center gap-1">
                <BookOpen className="w-2.5 h-2.5" />
                {c.sourceName ?? "KB"} · {Math.round((c.score ?? 0) * 100)}%
              </span>
            ))}
            {confidence != null && (
              <span
                className={cn(
                  "pill text-[10px] tabular-nums",
                  confidenceTone === "success" && "bg-success/15 text-success",
                  confidenceTone === "warning" && "bg-warning/15 text-warning",
                  confidenceTone === "destructive" && "bg-destructive/15 text-destructive",
                  confidenceTone === "muted" && "bg-muted text-muted-foreground",
                )}
                title="Model confidence"
              >
                {Math.round(confidence * 100)}% conf
              </span>
            )}
            {s.latencyMs != null && (
              <span className="pill bg-muted text-[10px] text-muted-foreground tabular-nums">
                {s.latencyMs}ms
              </span>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
