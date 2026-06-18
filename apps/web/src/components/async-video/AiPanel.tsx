import { Card } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAiArtifacts, useTranscribe, type AiArtifact } from "@/hooks/useAsyncVideo";

const STATUS_PILL: Record<string, string> = {
  ready: "bg-success/15 text-success",
  queued: "bg-muted text-muted-foreground",
  running: "bg-info/15 text-info",
  failed: "bg-destructive/15 text-destructive",
  skipped: "bg-warning/15 text-warning",
};

export function AiPanel({ submissionId, canReview }: { submissionId: string; canReview: boolean }) {
  const aiQ = useAiArtifacts(submissionId);
  const transcribe = useTranscribe(submissionId);

  const runAi = async () => {
    try {
      await transcribe.mutateAsync();
      toast.success("AI transcription complete");
    } catch (err) {
      const status = (err as { status?: number; body?: { error?: string } }).status;
      const code = (err as { body?: { error?: string } }).body?.error;
      if (status === 503 || code === "openai_not_configured") {
        toast.warning("AI not configured", {
          description: "Set OPENAI_API_KEY to enable real Whisper transcription. Artifacts marked skipped.",
        });
      } else {
        toast.error("AI request failed", { description: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const summary = aiQ.data?.artifacts.find((a) => a.kind === "summary");
  const skills = aiQ.data?.artifacts.find((a) => a.kind === "skills");
  const transcripts = aiQ.data?.artifacts.filter((a) => a.kind === "transcript") ?? [];

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-500" /> AI assist
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
            AI — assistive, not sole input
          </span>
        </span>
      }
    >
      <div className="p-4 space-y-3">
        {!aiQ.data?.configured && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 text-warning-foreground px-3 py-2 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>OpenAI not configured. AI artifacts run on a labeled stub; set OPENAI_API_KEY for real transcription + summary.</span>
          </div>
        )}

        {canReview && (
          <Button size="sm" variant="outline" onClick={() => void runAi()} disabled={transcribe.isPending}>
            {transcribe.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
            Transcribe with AI
          </Button>
        )}

        {aiQ.isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : (
          <div className="space-y-3">
            <ArtifactBlock title="Summary" artifact={summary}>
              {summary?.content ? <p className="text-sm">{(summary.content as { summary?: string }).summary}</p> : null}
            </ArtifactBlock>
            <ArtifactBlock title="Skills" artifact={skills}>
              {skills?.content ? (
                <div className="flex flex-wrap gap-1.5">
                  {((skills.content as { skills?: string[] }).skills ?? []).map((s) => (
                    <span key={s} className="text-xs px-2 py-0.5 rounded bg-muted">{s}</span>
                  ))}
                </div>
              ) : null}
            </ArtifactBlock>
            <ArtifactBlock title={`Transcripts (${transcripts.length})`} artifact={transcripts[0]}>
              {transcripts.length > 0 ? (
                <div className="text-xs text-muted-foreground space-y-1">
                  {transcripts.slice(0, 1).map((t) => (
                    <p key={t.id} className="line-clamp-3">{(t.content as { text?: string }).text}</p>
                  ))}
                </div>
              ) : null}
            </ArtifactBlock>
          </div>
        )}
      </div>
    </Card>
  );
}

function ArtifactBlock({ title, artifact, children }: { title: string; artifact?: AiArtifact; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{title}</span>
        {artifact ? (
          <span className="flex items-center gap-1.5 text-[10px]">
            <span className={cn("px-1.5 py-0.5 rounded capitalize", STATUS_PILL[artifact.status])}>{artifact.status}</span>
            {artifact.provider ? <span className="text-muted-foreground">{artifact.provider}{artifact.model ? ` · ${artifact.model}` : ""}</span> : null}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">not generated</span>
        )}
      </div>
      {children ?? <p className="text-xs text-muted-foreground italic">No content yet.</p>}
    </div>
  );
}
