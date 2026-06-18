import { Card } from "@/components/ui-kit";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgreement, type Question, type Scorecard } from "@/hooks/useAsyncVideo";

export function AgreementPanel({
  submissionId,
  questions,
  scorecards,
}: {
  submissionId: string;
  questions: Question[];
  scorecards: Scorecard[];
}) {
  const submitted = scorecards.filter((s) => s.submitted);
  const { data, isLoading } = useAgreement(submissionId, submitted.length >= 1);

  if (submitted.length < 2) {
    return (
      <Card title="Inter-rater agreement">
        <div className="p-4 text-sm text-muted-foreground">
          {submitted.length === 0
            ? "No submitted scorecards yet."
            : "Waiting for a second reviewer — agreement appears once ≥2 reviewers submit."}
        </div>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card title="Inter-rater agreement">
        <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Computing…
        </div>
      </Card>
    );
  }

  const agreementPct = data.agreement == null ? null : Math.round(data.agreement * 100);

  return (
    <Card title={`Inter-rater agreement · ${data.reviewerCount} reviewers`}>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Agreement" value={agreementPct == null ? "—" : `${agreementPct}%`} tone={agreementPct != null && agreementPct >= 70 ? "good" : agreementPct != null && agreementPct < 50 ? "bad" : "neutral"} />
          <Stat label="Overall delta" value={data.overallDelta == null ? "—" : data.overallDelta.toFixed(1)} tone={data.overallDelta != null && data.overallDelta > 25 ? "bad" : "neutral"} />
          <Stat label="Overall mean" value={data.overallMean == null ? "—" : data.overallMean.toFixed(1)} tone="neutral" />
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Per-question spread</div>
          {data.perQuestion.map((pq, i) => {
            const q = questions.find((x) => x.id === pq.questionId);
            return (
              <div key={pq.questionId} className="flex items-center justify-between text-xs gap-2">
                <span className="truncate flex-1">{q ? `Q${questions.indexOf(q) + 1}` : `Q${i + 1}`}: {q?.text ?? pq.questionId.slice(0, 8)}</span>
                <span className="tabular-nums text-muted-foreground">
                  mean {pq.mean.toFixed(1)} · spread {pq.spread}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "good" | "bad" | "neutral" }) {
  return (
    <div className="rounded border border-border p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "good" && "text-success",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}
