import { useCallback, useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import type { TestCallTicket } from "./useVoiceAgents";

export type TestCallState = "idle" | "connecting" | "active" | "ended" | "error";

export interface TestCallTranscriptLine {
  role: "assistant" | "user";
  text: string;
  ts: number;
}

/**
 * Wraps @vapi-ai/web to start/stop an in-browser test call for a voice agent.
 * The server hands us a short-lived ticket (public key + assistant id or
 * inline config) via POST /api/voice-agents/:id/test-call. We never see the
 * private Vapi key.
 */
export function useVapiTestCall() {
  const vapiRef = useRef<Vapi | null>(null);
  const [state, setState] = useState<TestCallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TestCallTranscriptLine[]>([]);
  const [volume, setVolume] = useState(0);

  const cleanup = useCallback(() => {
    if (vapiRef.current) {
      try {
        vapiRef.current.stop();
      } catch {
        // ignore
      }
      vapiRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(
    async (ticket: TestCallTicket) => {
      setError(null);
      setTranscript([]);
      setState("connecting");
      cleanup();

      const vapi = new Vapi(ticket.publicKey);
      vapiRef.current = vapi;

      vapi.on("call-start", () => setState("active"));
      vapi.on("call-end", () => setState("ended"));
      vapi.on("speech-start", () => {/* noop */});
      vapi.on("speech-end", () => {/* noop */});
      vapi.on("volume-level", (v: number) => setVolume(v));
      vapi.on("message", (msg: unknown) => {
        if (!msg || typeof msg !== "object") return;
        const m = msg as {
          type?: string;
          role?: "assistant" | "user";
          transcript?: string;
          transcriptType?: "partial" | "final";
        };
        if (m.type === "transcript" && m.role && m.transcript && m.transcriptType === "final") {
          setTranscript((prev) => [
            ...prev,
            { role: m.role!, text: m.transcript!, ts: Date.now() },
          ]);
        }
      });
      vapi.on("error", (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      });

      try {
        if (ticket.mode === "assistantId" && ticket.assistantId) {
          await vapi.start(ticket.assistantId);
        } else if (ticket.mode === "inline" && ticket.assistant) {
          await vapi.start(ticket.assistant as Parameters<Vapi["start"]>[0]);
        } else {
          throw new Error("Invalid test-call ticket");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    },
    [cleanup],
  );

  const stop = useCallback(() => {
    cleanup();
    setState("ended");
  }, [cleanup]);

  return { state, error, transcript, volume, start, stop };
}
