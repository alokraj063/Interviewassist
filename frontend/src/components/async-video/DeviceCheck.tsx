import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Camera, Mic, Wifi, CheckCircle2, XCircle } from "lucide-react";
import { getApiBase } from "@/lib/api";

type Status = "idle" | "checking" | "ok" | "fail";

/**
 * Candidate device/cam/mic + bandwidth check gate, shown before scored prompts
 * when the campaign requires it. Persists the result to the public
 * device-check endpoint so the recruiter sees real readiness data and
 * abandonment analytics, then unlocks recording.
 */
export function DeviceCheck({
  token,
  onPassed,
}: {
  token: string;
  onPassed: () => void;
}) {
  const [camera, setCamera] = useState<Status>("idle");
  const [mic, setMic] = useState<Status>("idle");
  const [bandwidthKbps, setBandwidthKbps] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const run = async () => {
    setRunning(true);
    setCamera("checking");
    setMic("checking");
    let camOk = false;
    let micOk = false;
    try {
      // Echo cancellation OFF per the wedge audio policy (candidate audio
      // arrives through the device speaker on the recruiter side later).
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      camOk = stream.getVideoTracks().some((t) => t.readyState === "live");
      micOk = stream.getAudioTracks().some((t) => t.readyState === "live");
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      camOk = false;
      micOk = false;
    }
    setCamera(camOk ? "ok" : "fail");
    setMic(micOk ? "ok" : "fail");

    // Bandwidth probe: time a small fetch against the API origin.
    let kbps: number | null = null;
    try {
      const t0 = performance.now();
      const res = await fetch(`${getApiBase()}/health`, { cache: "no-store" });
      await res.text();
      const ms = performance.now() - t0;
      // Coarse heuristic: faster round-trip → higher assumed bandwidth.
      kbps = Math.max(200, Math.round(20000 / Math.max(1, ms / 50)));
    } catch {
      kbps = null;
    }
    setBandwidthKbps(kbps);

    // Persist to the candidate's submission.
    try {
      await fetch(`${getApiBase()}/api/public/async-video/${token}/device-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ camera: camOk, mic: micOk, bandwidthKbps: kbps }),
      });
      setSaved(true);
    } catch {
      // best-effort
    }
    setRunning(false);
  };

  const passed = camera === "ok" && mic === "ok";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Before you record, let's make sure your camera, microphone, and connection are ready.
        Pehle ek quick check kar lete hain.
      </p>

      <div className="rounded-lg overflow-hidden border border-border bg-black aspect-video">
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <CheckRow icon={<Camera className="w-4 h-4" />} label="Camera" status={camera} />
        <CheckRow icon={<Mic className="w-4 h-4" />} label="Microphone" status={mic} />
        <div className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
          <Wifi className="w-4 h-4 text-muted-foreground" />
          <span className="text-muted-foreground">Network</span>
          <span className="ml-auto tabular-nums text-xs">{bandwidthKbps == null ? "—" : `${bandwidthKbps} kbps`}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          {camera === "idle" ? "Run device check" : "Re-run check"}
        </Button>
        <Button size="sm" onClick={onPassed} disabled={!passed || !saved}>
          Continue to recording
        </Button>
        {camera === "fail" && (
          <span className="text-xs text-destructive">
            Camera/mic access blocked. Allow permissions in your browser and re-run.
          </span>
        )}
      </div>
    </div>
  );
}

function CheckRow({ icon, label, status }: { icon: React.ReactNode; label: string; status: Status }) {
  return (
    <div className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto">
        {status === "ok" ? (
          <CheckCircle2 className="w-4 h-4 text-success" />
        ) : status === "fail" ? (
          <XCircle className="w-4 h-4 text-destructive" />
        ) : status === "checking" ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </span>
    </div>
  );
}
