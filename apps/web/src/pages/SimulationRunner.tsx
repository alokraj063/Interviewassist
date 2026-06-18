// Coaching AI-roleplay runner.
// "Begin AI roleplay" POSTs /runs/:id/ai-call → receives the Vapi public key +
// the scenario-driven candidate assistant → dials via the @vapi-ai/web SDK so the
// recruiter actually converses with an AI candidate. On call-start it links the
// callId; on call-end it completes the run (which enqueues scoring) and navigates
// to results. When VAPI_PUBLIC_KEY is unset the route returns 503 and we offer a
// graceful self-recorded fallback (no white-screen).
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Vapi from "@vapi-ai/web";
import { PageHeader, Card, EmptyState } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Loader2, ChevronLeft, Mic, Square, PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { useRun, usePatchRun, useAiCall } from "@/hooks/useCoaching";

type Phase = "idle" | "connecting" | "live" | "ending";

export default function SimulationRunner() {
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const runId = search.get("runId");
  const nav = useNavigate();

  const { data, isLoading, isError } = useRun(runId ?? undefined);
  const patchRun = usePatchRun();
  const aiCall = useAiCall();
  const vapiRef = useRef<Vapi | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [vapiBlocked, setVapiBlocked] = useState(false);

  useEffect(() => {
    return () => {
      try {
        vapiRef.current?.stop();
      } catch {
        /* noop */
      }
    };
  }, []);

  if (!runId) {
    return (
      <div className="p-10">
        <EmptyState title="Missing run" body="Start a practice run from the scenario page." />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading run…
      </div>
    );
  }
  if (isError || !data || !data.scenario) {
    return (
      <div className="p-10">
        <EmptyState title="Run not found" body="This practice run is unavailable." />
      </div>
    );
  }

  const { run, scenario } = data;

  async function beginAiRoleplay() {
    if (!runId) return;
    setPhase("connecting");
    try {
      const ticket = await aiCall.mutateAsync(runId);
      const vapi = new Vapi(ticket.publicKey);
      vapiRef.current = vapi;
      vapi.on("call-start", () => {
        setPhase("live");
        toast.success("Connected to AI candidate");
      });
      vapi.on("call-end", () => {
        void completeRun();
      });
      vapi.on("error", (err: unknown) => {
        toast.error("Call error", { description: err instanceof Error ? err.message : String(err) });
        setPhase("idle");
      });
      // Cast: the ticket.assistant is the Vapi inline assistant config shape.
      await vapi.start(ticket.assistant as Parameters<Vapi["start"]>[0]);
    } catch (err) {
      const code = (err as { body?: { error?: string } })?.body?.error;
      if (code === "vapi_public_key_missing") {
        setVapiBlocked(true);
        toast.warning("AI roleplay isn't configured (VAPI_PUBLIC_KEY missing). Use self-recorded practice.");
      } else {
        toast.error("Couldn't start AI roleplay", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
      setPhase("idle");
    }
  }

  async function beginSelfRecorded() {
    if (!runId) return;
    setPhase("connecting");
    try {
      await patchRun.mutateAsync({ id: runId, status: "live" });
      setPhase("live");
      toast.info("Self-recorded practice started — speak your pitch, then finish.");
    } catch (err) {
      toast.error("Couldn't start", { description: err instanceof Error ? err.message : String(err) });
      setPhase("idle");
    }
  }

  async function completeRun() {
    if (!runId) return;
    setPhase("ending");
    try {
      vapiRef.current?.stop();
    } catch {
      /* noop */
    }
    try {
      await patchRun.mutateAsync({ id: runId, status: "completed" });
      nav(`/coaching/${id}/results?runId=${runId}`);
    } catch (err) {
      toast.error("Couldn't end run", { description: err instanceof Error ? err.message : String(err) });
      setPhase("live");
    }
  }

  const p = scenario.candidatePersona ?? {};
  const isLive = phase === "live" || run.status === "live";

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to={`/coaching/${id}`} className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="h-4 w-4" />
            </Link>
            Practice: {scenario.title}
          </span>
        }
        subtitle="Talk to the AI candidate. The attempt is recorded and auto-scored against the linked rubric."
      />
      <div className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-12">
        <div className="space-y-3 lg:col-span-7">
          <Card title="Candidate persona">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-sm">
              {Object.entries(p).filter(([, v]) => v != null && v !== "").length === 0 ? (
                <div className="col-span-2 italic text-muted-foreground">No persona configured.</div>
              ) : (
                Object.entries(p)
                  .filter(([, v]) => v != null && v !== "")
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</dt>
                      <dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                    </div>
                  ))
              )}
            </dl>
          </Card>
          {(scenario.objections ?? []).length > 0 && (
            <Card title="Watch for these objections">
              <ul className="list-disc space-y-1 p-4 pl-8 text-sm">
                {scenario.objections.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-3 lg:col-span-5">
          <Card title="Session">
            <div className="space-y-3 p-4">
              <div className="text-xs text-muted-foreground">
                Status: <span className="font-medium capitalize text-foreground">{phase === "idle" ? run.status : phase}</span>
              </div>

              {!isLive && run.status !== "completed" && run.status !== "abandoned" && (
                <>
                  <Button
                    className="w-full"
                    disabled={phase === "connecting"}
                    onClick={() => void beginAiRoleplay()}
                  >
                    {phase === "connecting" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <PhoneCall className="mr-2 h-4 w-4" />
                    )}
                    Begin AI roleplay
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={phase === "connecting"}
                    onClick={() => void beginSelfRecorded()}
                  >
                    <Mic className="mr-2 h-4 w-4" />
                    Self-recorded practice
                  </Button>
                  {vapiBlocked && (
                    <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">
                      AI roleplay needs a Vapi public key (not configured). Self-recorded practice
                      still records and scores your attempt.
                    </p>
                  )}
                </>
              )}

              {isLive && (
                <Button variant="destructive" className="w-full" disabled={phase === "ending"} onClick={() => void completeRun()}>
                  {phase === "ending" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="mr-2 h-4 w-4" />
                  )}
                  End & score
                </Button>
              )}

              {(run.status === "completed" || run.status === "abandoned") && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => nav(`/coaching/${id}/results?runId=${runId}`)}
                >
                  See results
                </Button>
              )}

              <p className="rounded bg-muted p-2 text-xs text-muted-foreground">
                Use headphones in a quiet room. Echo cancellation stays off so the AI candidate
                comes through clearly.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
