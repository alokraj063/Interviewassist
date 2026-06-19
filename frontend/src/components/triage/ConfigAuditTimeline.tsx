import { formatDistanceToNowStrict } from "date-fns";
import {
  Rocket,
  Save,
  RotateCcw,
  Shuffle,
  Tag,
  PhoneOff,
  FlaskConical,
  Settings,
  History,
} from "lucide-react";
import { Card } from "@/components/ui-kit";
import { useTriageAudit } from "@/hooks/useTriage";
import type { TriageAuditAction } from "@j2w/shared-types";

const ACTION_META: Record<TriageAuditAction, { label: string; icon: typeof Save }> = {
  "ruleset.saved_draft": { label: "Saved draft", icon: Save },
  "ruleset.published": { label: "Published version", icon: Rocket },
  "ruleset.rolled_back": { label: "Rolled back", icon: RotateCcw },
  "flow.status_changed": { label: "Flow status changed", icon: Settings },
  "flow.archived": { label: "Flow archived", icon: Settings },
  "session.reassigned": { label: "Reassigned call", icon: Shuffle },
  "session.classification_overridden": { label: "Overrode classification", icon: Tag },
  "session.terminated": { label: "Terminated call", icon: PhoneOff },
  "dryrun.executed": { label: "Ran dry-run", icon: FlaskConical },
};

function describeDiff(diff: Record<string, unknown> | null): string {
  if (!diff) return "";
  const parts: string[] = [];
  if (typeof diff.version === "number") parts.push(`v${diff.version}`);
  if (typeof diff.ruleCount === "number") parts.push(`${diff.ruleCount} rules`);
  if (typeof diff.fromVersion === "number" && typeof diff.toVersion === "number") {
    parts.push(`v${diff.fromVersion} → v${diff.toVersion}`);
  }
  if (typeof diff.from === "string" && typeof diff.to === "string") {
    parts.push(`${diff.from} → ${diff.to}`);
  }
  if (typeof diff.destinationLabel === "string") parts.push(`→ ${diff.destinationLabel}`);
  if (typeof diff.evaluated === "number") parts.push(`${diff.evaluated} events`);
  if (typeof diff.note === "string" && diff.note) parts.push(`"${diff.note}"`);
  return parts.join(" · ");
}

export function ConfigAuditTimeline({ flowId }: { flowId: string }) {
  const { data, isLoading, isError, error, refetch } = useTriageAudit(flowId);

  return (
    <Card title="Configuration audit timeline">
      {isLoading ? (
        <div className="p-6 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded bg-muted animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        <div className="p-6 text-center text-sm">
          <div className="text-destructive mb-2">
            {error instanceof Error ? error.message : "Failed to load audit log"}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-primary hover:underline text-xs"
          >
            Retry
          </button>
        </div>
      ) : !data || data.events.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          <History className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          No configuration changes recorded yet. Publishing a rule set or acting on a live call
          will appear here.
        </div>
      ) : (
        <ol className="p-4 space-y-3">
          {data.events.map((ev) => {
            const meta = ACTION_META[ev.action];
            const Icon = meta?.icon ?? Settings;
            const detail = describeDiff(ev.diff);
            return (
              <li key={ev.id} className="flex items-start gap-3">
                <div className="mt-0.5 w-7 h-7 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-tight">
                    <span className="font-medium">{meta?.label ?? ev.action}</span>
                    {detail && <span className="text-muted-foreground"> · {detail}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {ev.actorName ?? "System"} ·{" "}
                    {formatDistanceToNowStrict(new Date(ev.createdAt), { addSuffix: true })}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
