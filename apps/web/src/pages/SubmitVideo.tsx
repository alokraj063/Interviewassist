// Candidate-facing async-video submission. Token-gated via the link the
// recruiter shared from AsyncVideoDetail. For each prompt the candidate
// records a short clip (MediaRecorder), uploads it to the public upload
// endpoint, and the orchestrator submits the metadata once all prompts are
// recorded.
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Loader2,
  Mic,
  Video,
  Square,
  Send,
  AlertTriangle,
  CheckCircle2,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api";
import { toast } from "sonner";
import { DeviceCheck } from "@/components/async-video/DeviceCheck";

interface CampaignInfo {
  id: string;
  title: string;
  introText: string | null;
  outroText?: string | null;
  prompts: Array<{ id: string; text: string; tag?: string }>;
  maxSecondsPerPrompt: number;
  maxRetakes: number;
  requireDeviceCheck?: boolean;
}

interface QuestionInfo {
  id: string;
  position: number;
  kind: "video" | "audio";
  text: string;
  stimulusText: string | null;
  prepSeconds: number;
  maxSeconds: number;
  maxRetakes: number;
}

interface LoadResponse {
  campaign: CampaignInfo;
  questions?: QuestionInfo[];
  submissionId: string;
  deviceCheck?: { camera: boolean; mic: boolean; checkedAt: string } | null;
  expiresAt: string | null;
}

type RecState =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "uploading" }
  | { kind: "done"; blobKey: string; durationSec: number }
  | { kind: "error"; message: string };

interface PerPromptState {
  rec: RecState;
  retakes: number;
}

export default function SubmitVideo() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<LoadResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [perPrompt, setPerPrompt] = useState<Record<string, PerPromptState>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [deviceReady, setDeviceReady] = useState(false);
  const [practiceDone, setPracticeDone] = useState(false);
  // Per-question prep countdown: candidate reads the prompt before recording.
  const [prepRemaining, setPrepRemaining] = useState<number | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startedAtRef = useRef<number>(0);

  // Load campaign
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${getApiBase()}/api/public/async-video/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `http_${res.status}`);
        }
        return res.json() as Promise<LoadResponse>;
      })
      .then((d) => {
        if (cancelled) return;
        // Prefer the normalized questions[] (per-question prep/take/retake) when
        // present; fall back to the legacy prompts jsonb for older campaigns.
        const normalized: LoadResponse =
          d.questions && d.questions.length > 0
            ? {
                ...d,
                campaign: {
                  ...d.campaign,
                  prompts: d.questions
                    .slice()
                    .sort((a, b) => a.position - b.position)
                    .map((qn) => ({ id: qn.id, text: qn.text })),
                },
              }
            : d;
        setData(normalized);
        const init: Record<string, PerPromptState> = {};
        for (const p of normalized.campaign.prompts) {
          init[p.id] = { rec: { kind: "idle" }, retakes: 0 };
        }
        setPerPrompt(init);
        // If a device check was already recorded, skip the gate.
        if (!normalized.campaign.requireDeviceCheck || normalized.deviceCheck) {
          setDeviceReady(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Tick timer
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Cleanup mediastream
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Heartbeat: record the active prompt index so abandonment analytics
  // (drop_off_prompt_index) are real. Fires on prompt change once recording
  // has started (deviceReady + practiceDone).
  useEffect(() => {
    if (!token || !data || !deviceReady || !practiceDone || submitted) return;
    void fetch(`${getApiBase()}/api/public/async-video/${token}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptIndex: activeIdx }),
    }).catch(() => {});
  }, [activeIdx, token, data, deviceReady, practiceDone, submitted]);

  const prompt = data?.campaign.prompts[activeIdx];
  const promptState = prompt ? perPrompt[prompt.id] : null;
  // Per-question prep seconds, sourced from the normalized questions[] when
  // present (falls back to a sensible default for legacy prompt-only campaigns).
  const prepSeconds = useMemo(() => {
    if (!data?.questions || !prompt) return 0;
    return data.questions.find((q) => q.id === prompt.id)?.prepSeconds ?? 0;
  }, [data, prompt]);

  // Reset + run the prep countdown whenever the candidate lands on a fresh,
  // not-yet-recorded prompt. Counts down to 0, then recording is unlocked.
  useEffect(() => {
    if (!deviceReady || !practiceDone) return;
    if (!prompt || !promptState || promptState.rec.kind !== "idle") {
      setPrepRemaining(null);
      return;
    }
    if (prepSeconds <= 0) {
      setPrepRemaining(0);
      return;
    }
    setPrepRemaining(prepSeconds);
    const started = Date.now();
    const t = setInterval(() => {
      const left = Math.max(0, prepSeconds - Math.floor((Date.now() - started) / 1000));
      setPrepRemaining(left);
      if (left <= 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
    // re-arm on prompt change or when this prompt returns to idle (retake)
  }, [activeIdx, prompt?.id, promptState?.rec.kind, prepSeconds, deviceReady, practiceDone]);

  const startRecording = async () => {
    if (!prompt || !promptState) return;
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({
          video: { width: 720, height: 480, facingMode: "user" },
          audio: true,
        });
      }
      const stream = streamRef.current;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      chunksRef.current = [];
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type ?? "video/webm" });
        const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
        void uploadBlob(prompt.id, blob, durationSec);
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setPerPrompt((prev) => ({
        ...prev,
        [prompt.id]: { ...prev[prompt.id], rec: { kind: "recording", startedAt: Date.now() } },
      }));

      // Cap recording at maxSecondsPerPrompt
      if (data && data.campaign.maxSecondsPerPrompt > 0) {
        const cap = data.campaign.maxSecondsPerPrompt * 1000;
        setTimeout(() => {
          try {
            if (recorderRef.current && recorderRef.current.state === "recording") {
              recorderRef.current.stop();
            }
          } catch {
            /* noop */
          }
        }, cap);
      }
    } catch (err) {
      setPerPrompt((prev) => ({
        ...prev,
        [prompt.id]: {
          ...prev[prompt.id],
          rec: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        },
      }));
    }
  };

  const stopRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    } catch {
      /* noop */
    }
  };

  const uploadBlob = async (promptId: string, blob: Blob, durationSec: number) => {
    if (!token) return;
    setPerPrompt((prev) => ({
      ...prev,
      [promptId]: { ...prev[promptId], rec: { kind: "uploading" } },
    }));
    try {
      const fd = new FormData();
      fd.append("file", blob, `${promptId}.webm`);
      fd.append("promptIndex", String(activeIdx));
      fd.append("durationSec", String(durationSec));
      const res = await fetch(
        `${getApiBase()}/api/public/async-video/${token}/upload`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `http_${res.status}`);
      }
      const j = (await res.json()) as { blobKey: string };
      setPerPrompt((prev) => ({
        ...prev,
        [promptId]: { ...prev[promptId], rec: { kind: "done", blobKey: j.blobKey, durationSec } },
      }));
    } catch (err) {
      setPerPrompt((prev) => ({
        ...prev,
        [promptId]: {
          ...prev[promptId],
          rec: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        },
      }));
    }
  };

  const retake = () => {
    if (!prompt || !data) return;
    const cur = perPrompt[prompt.id];
    if (cur.retakes >= data.campaign.maxRetakes) return;
    setPerPrompt((prev) => ({
      ...prev,
      [prompt.id]: { rec: { kind: "idle" }, retakes: cur.retakes + 1 },
    }));
  };

  const submit = async () => {
    if (!data || !token || submitting) return;
    setSubmitting(true);
    try {
      const videos: Array<{
        promptIndex: number;
        blobKey: string;
        durationSec: number;
        recordedAt: string;
      }> = [];
      for (let i = 0; i < data.campaign.prompts.length; i++) {
        const p = data.campaign.prompts[i];
        const ps = perPrompt[p.id];
        if (ps?.rec.kind !== "done") {
          throw new Error(`Prompt ${i + 1} not recorded yet`);
        }
        videos.push({
          promptIndex: i,
          blobKey: ps.rec.blobKey,
          durationSec: ps.rec.durationSec,
          recordedAt: new Date().toISOString(),
        });
      }
      const res = await fetch(
        `${getApiBase()}/api/public/async-video/${token}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videos }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `http_${res.status}`);
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setSubmitted(true);
    } catch (err) {
      toast.error("Couldn't submit your responses", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) return <Frame title="Invalid link">No token in URL.</Frame>;
  if (loadError) {
    const isExpired = loadError === "expired";
    const isUsed = loadError === "already_submitted";
    return (
      <Frame title="Hmm, that didn't work">
        <div className="flex items-start gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            {isExpired
              ? "This invite link has expired. Reach out to your recruiter for a fresh one."
              : isUsed
              ? "Already submitted. Contact your recruiter if you need to retake."
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
          <Loader2 className="w-4 h-4 animate-spin" /> Fetching your prompts…
        </div>
      </Frame>
    );
  }
  if (submitted) {
    return (
      <Frame title="Thanks!">
        <div className="flex items-start gap-3 text-sm">
          <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
          <div>
            <div className="font-medium mb-1">Aapke videos record ho gaye.</div>
            <div className="text-muted-foreground">
              The recruiter will review and reach out. You can close this tab.
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  // Gate 1: device / cam / mic + bandwidth check (per spec B.3). Persists the
  // result so the recruiter sees real readiness data, then unlocks the rest.
  if (!deviceReady) {
    return (
      <Frame
        title={data.campaign.title}
        subtitle="Let's make sure your camera, mic, and connection are ready."
      >
        <DeviceCheck
          token={token}
          onPassed={() => setDeviceReady(true)}
        />
      </Frame>
    );
  }

  // Gate 2: a low-stakes practice question so the candidate gets comfortable
  // before the scored prompts.
  if (!practiceDone) {
    return (
      <Frame title="Practice round" subtitle="This one is not scored — just a warm-up.">
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="font-medium mb-1">Practice prompt</div>
            <div className="text-muted-foreground">
              Say your name and one sentence about what you're looking for in your next role.
            </div>
          </div>
          <p className="text-muted-foreground">
            When you hit a real prompt you'll get a short prep timer to read it, then a Start button to record.
            You can re-record up to {data.campaign.maxRetakes} time{data.campaign.maxRetakes === 1 ? "" : "s"} per prompt.
          </p>
          <Button size="sm" onClick={() => setPracticeDone(true)}>
            I'm ready — start the screening
          </Button>
        </div>
      </Frame>
    );
  }

  const totalPrompts = data.campaign.prompts.length;
  const doneCount = Object.values(perPrompt).filter(
    (s) => s.rec.kind === "done",
  ).length;
  const allDone = doneCount === totalPrompts;
  const elapsedRecSec =
    promptState?.rec.kind === "recording"
      ? Math.round((now - promptState.rec.startedAt) / 1000)
      : 0;
  const cap = data.campaign.maxSecondsPerPrompt;

  return (
    <Frame
      title={data.campaign.title}
      subtitle={data.campaign.introText ?? undefined}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs">
          <div className="text-muted-foreground">
            Prompt {activeIdx + 1} of {totalPrompts} · {doneCount}/{totalPrompts} done
          </div>
          <div className="text-muted-foreground">
            Up to {cap}s per prompt · {data.campaign.maxRetakes} retake
            {data.campaign.maxRetakes === 1 ? "" : "s"} allowed
          </div>
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${(doneCount / Math.max(1, totalPrompts)) * 100}%` }}
          />
        </div>

        {prompt && (
          <div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Mic className="w-3.5 h-3.5" /> Prompt {activeIdx + 1}
              {prompt.tag && <span>· {prompt.tag}</span>}
            </div>
            <div className="text-base mb-3 leading-relaxed">{prompt.text}</div>

            <div className="rounded-lg overflow-hidden border border-border bg-black aspect-video">
              <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {promptState?.rec.kind === "recording" && (
                  <span className="text-destructive">● Recording {elapsedRecSec}s / {cap}s</span>
                )}
                {promptState?.rec.kind === "uploading" && (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading…
                  </span>
                )}
                {promptState?.rec.kind === "done" && (
                  <span className="text-success">Recorded ({promptState.rec.durationSec}s)</span>
                )}
                {promptState?.rec.kind === "error" && (
                  <span className="text-destructive">Error: {promptState.rec.message}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {promptState?.rec.kind === "idle" && prepRemaining != null && prepRemaining > 0 && (
                  <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                    Get ready… recording unlocks in {prepRemaining}s
                  </span>
                )}
                {promptState?.rec.kind === "idle" && (
                  <Button
                    size="sm"
                    onClick={() => void startRecording()}
                    disabled={prepRemaining != null && prepRemaining > 0}
                  >
                    <Video className="w-3.5 h-3.5 mr-1.5" /> Start
                  </Button>
                )}
                {promptState?.rec.kind === "recording" && (
                  <Button size="sm" variant="destructive" onClick={stopRecording}>
                    <Square className="w-3.5 h-3.5 mr-1.5" /> Stop
                  </Button>
                )}
                {promptState?.rec.kind === "done" &&
                  promptState.retakes < data.campaign.maxRetakes && (
                    <Button size="sm" variant="outline" onClick={retake}>
                      <RotateCw className="w-3.5 h-3.5 mr-1.5" /> Retake
                    </Button>
                  )}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={activeIdx === 0}
            onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
          >
            ← Previous prompt
          </Button>
          {activeIdx < totalPrompts - 1 ? (
            <Button size="sm" onClick={() => setActiveIdx((i) => i + 1)}>
              Next prompt →
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!allDone || submitting}
              onClick={() => void submit()}
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                <Send className="w-3.5 h-3.5 mr-1.5" />
              )}
              Submit all {totalPrompts}
            </Button>
          )}
        </div>
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
      <div
        className={cn(
          "max-w-2xl mx-auto bg-background border border-border rounded-xl shadow p-6 sm:p-8",
        )}
      >
        <div className="mb-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
        </div>
        {children}
      </div>
      <div className="text-center text-[11px] text-muted-foreground mt-6">
        Powered by RecruitAssist
      </div>
    </div>
  );
}
