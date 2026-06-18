// External-reviewer view for an async-video submission, reached via an
// expiring shareable link (token in the URL). No recruiter chrome, no auth:
// a hiring manager opens the link, watches the (blinded) candidate's clips,
// and submits a scorecard. The public API enforces expiry/revoke and blinds
// candidate PII. Mirrors the SubmitVideo candidate runtime's chrome.
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api";
import { toast } from "sonner";

interface Question {
  id: string;
  position: number;
  text: string;
}
interface Video {
  promptIndex: number;
  durationSec: number;
}
interface ExternalReviewData {
  questions: Question[];
  videos: Video[];
  shareLink: { id: string; label: string | null; canScore: boolean; expiresAt: string };
}

const RECOMMENDATIONS = ["strong_yes", "yes", "maybe", "no", "strong_no"] as const;
type Rec = (typeof RECOMMENDATIONS)[number];

export default function ExternalReview() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ExternalReviewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [reviewerLabel, setReviewerLabel] = useState("");
  const [scores, setScores] = useState<Record<string, number>>({});
  const [recommendation, setRecommendation] = useState<Rec | "">("");
  const [summaryNote, setSummaryNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${getApiBase()}/api/public/async-video/external-review/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `http_${res.status}`);
        }
        return res.json() as Promise<ExternalReviewData>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const activeQuestion = data?.questions[activeIdx];
  const hasClip = useMemo(
    () => !!data && data.videos.some((v) => v.promptIndex === activeIdx),
    [data, activeIdx],
  );

  const submit = async () => {
    if (!data || !token || submitting) return;
    if (!reviewerLabel.trim()) {
      toast.error("Please enter your name before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      const questionScores = data.questions
        .filter((q) => scores[q.id] != null)
        .map((q) => ({ questionId: q.id, score: scores[q.id] }));
      const res = await fetch(
        `${getApiBase()}/api/public/async-video/external-review/${token}/scorecard`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reviewerLabel: reviewerLabel.trim(),
            questionScores,
            recommendation: recommendation || undefined,
            summaryNote: summaryNote.trim() || undefined,
            submitted: true,
          }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `http_${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      toast.error("Couldn't submit your scorecard", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) return <Frame title="Invalid link">No token in URL.</Frame>;
  if (loadError) {
    const gone = loadError === "expired" || loadError === "revoked";
    return (
      <Frame title="This review link is unavailable">
        <div className="flex items-start gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            {gone
              ? "This shared review link has expired or been revoked. Ask the recruiter for a fresh one."
              : `Error: ${loadError}`}
          </div>
        </div>
      </Frame>
    );
  }
  if (!data) {
    return (
      <Frame title="Loading…">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Fetching the submission…
        </div>
      </Frame>
    );
  }
  if (submitted) {
    return (
      <Frame title="Thanks!">
        <div className="flex items-start gap-3 text-sm">
          <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
          <div>Your scorecard was recorded. You can close this tab.</div>
        </div>
      </Frame>
    );
  }

  return (
    <Frame title="Candidate review" subtitle={data.shareLink.label ?? "Shared for external review"}>
      <div className="space-y-4">
        <div className="flex gap-1.5 flex-wrap">
          {data.questions.map((qn, i) => (
            <button
              key={qn.id}
              onClick={() => setActiveIdx(i)}
              className={cn(
                "px-2.5 py-1 rounded text-xs border",
                activeIdx === i ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-muted",
              )}
            >
              Q{i + 1}
            </button>
          ))}
        </div>

        {activeQuestion ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">{activeQuestion.text}</div>
            {hasClip ? (
              <video
                controls
                preload="metadata"
                className="w-full rounded bg-black aspect-video"
                src={`${getApiBase()}/api/public/async-video/external-review/${token}/video/${activeIdx}`}
                data-testid={`ext-video-${activeIdx}`}
              >
                Your browser does not support video playback.
              </video>
            ) : (
              <div className="aspect-video rounded bg-muted flex items-center justify-center text-sm text-muted-foreground">
                No clip recorded for this question
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No questions on this submission.</div>
        )}

        {data.shareLink.canScore && (
          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <label className="text-xs text-muted-foreground">Your name</label>
              <input
                className="mt-1 w-full rounded border border-input bg-background px-3 py-2 text-sm"
                value={reviewerLabel}
                onChange={(e) => setReviewerLabel(e.target.value)}
                placeholder="e.g. Priya (Hiring Manager)"
                aria-label="Your name"
              />
            </div>
            <div className="space-y-2">
              {data.questions.map((qn, i) => (
                <div key={qn.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">Q{i + 1}</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        onClick={() => setScores((prev) => ({ ...prev, [qn.id]: n }))}
                        className={cn(
                          "w-7 h-7 rounded border text-xs",
                          scores[qn.id] === n ? "border-primary bg-primary text-primary-foreground" : "border-input hover:bg-muted",
                        )}
                        aria-label={`Q${i + 1} score ${n}`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Recommendation</label>
              <select
                className="mt-1 w-full rounded border border-input bg-background px-3 py-2 text-sm"
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value as Rec | "")}
                aria-label="Recommendation"
              >
                <option value="">— select —</option>
                {RECOMMENDATIONS.map((r) => (
                  <option key={r} value={r}>{r.replace("_", " ")}</option>
                ))}
              </select>
            </div>
            <Textarea
              value={summaryNote}
              onChange={(e) => setSummaryNote(e.target.value)}
              rows={3}
              placeholder="Overall notes…"
              aria-label="Summary note"
            />
            <Button size="sm" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Star className="w-3.5 h-3.5 mr-1.5" />}
              Submit scorecard
            </Button>
          </div>
        )}
      </div>
    </Frame>
  );
}

function Frame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-muted via-background to-accent-muted py-10 px-4">
      <div className="max-w-2xl mx-auto bg-background border border-border rounded-xl shadow p-6 sm:p-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </div>
        {children}
      </div>
      <div className="text-center text-[11px] text-muted-foreground mt-6">Powered by RecruitAssist</div>
    </div>
  );
}
