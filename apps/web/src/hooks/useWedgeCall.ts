// Hook for the recruiter wedge call lifecycle: create → capture browser
// mic → stream PCM16 over /ws/ingest-call → consume /ws/session events
// → end.
//
// Distinct from useLiveCall (which is the Vapi-mediated path). The two
// paths share /ws/session for transcripts and suggestions, but the Vapi
// path leans on Vapi's transcriber while this one drives Deepgram
// directly via the API server.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, getStoredToken, getWsBase } from "@/lib/api";
import type {
  Citation,
  SessionServerMessage,
  Speaker,
  TranscriptTurn,
} from "@j2w/shared-types";
import { readTranscriptionSettings } from "./useTranscriptionSettings";
import type { Suggestion } from "./useLiveCall";

// Map the backend's `<provider>_api_key_missing` 503 onto a recruiter-readable
// message so the setup card explains *why* the call couldn't start.
function friendlyCreateError(raw: string): string {
  const m = raw.match(/^(deepgram|sarvam|shunya)_api_key_missing$/);
  if (m) {
    const label = { deepgram: "Deepgram", sarvam: "Sarvam", shunya: "Shunya" }[m[1]];
    return `${label} isn't configured for your workspace. Pick another transcription provider or add the key in Settings → Integrations.`;
  }
  return raw;
}

export interface CreateWedgeCallInput {
  demandId: string;
  prospectId?: string;
  candidateId?: string;
  candidateRefOrPhone?: string;
}

export interface WedgeCallTicket {
  callId: string;
  status: string | undefined;
  startedAt: string | undefined;
  mode: string;
  /** Echoed back by the API: the STT provider/model/language this call uses. */
  transcription?: { provider: string; model: string; language: string };
  wsIngestUrl: string;
  wsSessionUrl: string;
}

interface LiveTranscriptTurn extends TranscriptTurn {
  /** Local UI key. id===-1 for partials; we want to dedupe on text + start. */
  uiKey: string;
}

interface UseWedgeCallState {
  status: "idle" | "creating" | "ready" | "live" | "ending" | "ended" | "error";
  callId: string | null;
  errorMessage: string | null;
  turns: LiveTranscriptTurn[];
  partial: LiveTranscriptTurn | null;
  bytesSent: number;
  startedAt: number | null;
  /** 0–100 derived from /ws/session sentiment.update events. */
  sentiment: number;
  /** Rolling series, last ~48 points, fed to the chart. */
  sentimentSeries: Array<{ t: number; v: number }>;
  /** AI suggestions streamed from suggest.begin/delta/end. */
  suggestions: Suggestion[];
  /** KB citations grounding the latest suggestions, deduped by chunkId. */
  citations: Citation[];
  /** Latest live rubric tick — picked up from rubric.tick events. */
  liveRubric: {
    rubricId: string;
    rubricName: string;
    ts: number;
    scores: Array<{
      criterionId: string;
      score: number;
      band: "fail" | "pass" | "excellent";
      rationale: string;
    }>;
  } | null;
}

const FRAME_INTERVAL_MS = 20;
const TARGET_SAMPLE_RATE = 16000;

function downsampleTo16k(input: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return float32ToInt16(input);
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const sample = input[Math.floor(i * ratio)] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = Math.round(clamped * 0x7fff);
  }
  return out;
}

function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = Math.round(clamped * 0x7fff);
  }
  return out;
}

export function useWedgeCall() {
  const [state, setState] = useState<UseWedgeCallState>({
    status: "idle",
    callId: null,
    errorMessage: null,
    turns: [],
    partial: null,
    bytesSent: 0,
    startedAt: null,
    sentiment: 50,
    sentimentSeries: [],
    suggestions: [],
    citations: [],
    liveRubric: null,
  });

  const ingestSocketRef = useRef<WebSocket | null>(null);
  const sessionSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const teardown = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* ignore */ }
    processorRef.current = null;
    try { audioContextRef.current?.close(); } catch { /* ignore */ }
    audioContextRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    if (ingestSocketRef.current && ingestSocketRef.current.readyState === WebSocket.OPEN) {
      try { ingestSocketRef.current.close(1000, "client_end"); } catch { /* ignore */ }
    }
    ingestSocketRef.current = null;
    if (sessionSocketRef.current && sessionSocketRef.current.readyState === WebSocket.OPEN) {
      try { sessionSocketRef.current.close(1000, "client_end"); } catch { /* ignore */ }
    }
    sessionSocketRef.current = null;
  }, []);

  useEffect(() => {
    return teardown;
  }, [teardown]);

  const create = useCallback(async (input: CreateWedgeCallInput): Promise<WedgeCallTicket | null> => {
    setState((s) => ({ ...s, status: "creating", errorMessage: null }));
    try {
      // Drive the live call with the recruiter's selected STT provider. The API
      // validates the provider's credentials and 503s with
      // `<provider>_api_key_missing` if it isn't configured for the org.
      const transcription = readTranscriptionSettings();
      const ticket = await apiFetch<WedgeCallTicket>("/api/calls", {
        method: "POST",
        json: {
          ...input,
          mode: "browser_mixed",
          origin: "web",
          transcription,
        },
      });
      setState((s) => ({ ...s, status: "ready", callId: ticket.callId }));
      return ticket;
    } catch (err) {
      // apiFetch surfaces the JSON error body on err.body (message is "HTTP <n>"),
      // so read the `error` code (e.g. "sarvam_api_key_missing") from there.
      const code =
        (err && typeof err === "object" && "body" in err
          ? (err as { body?: { error?: string } }).body?.error
          : undefined) ??
        (err instanceof Error ? err.message : "Failed to create call");
      setState((s) => ({ ...s, status: "error", errorMessage: friendlyCreateError(code) }));
      return null;
    }
  }, []);

  const start = useCallback(async (ticket: WedgeCallTicket) => {
    const token = getStoredToken();
    if (!token) {
      setState((s) => ({ ...s, status: "error", errorMessage: "Not authenticated" }));
      return;
    }

    // Echo cancellation OFF — the candidate's voice reaches the laptop mic
    // via the recruiter's phone speaker; standard echo cancellation would
    // suppress it. See CLAUDE.md "Browser-mic ingest" gotcha.
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Mic permission denied";
      setState((s) => ({ ...s, status: "error", errorMessage: msg }));
      return;
    }
    mediaStreamRef.current = media;

    // Open both sockets. Append the JWT as a query param (Fastify-WS verifies).
    const ingestUrl = ticket.wsIngestUrl + (ticket.wsIngestUrl.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;
    const sessionUrl = ticket.wsSessionUrl + (ticket.wsSessionUrl.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;

    const ingest = new WebSocket(ingestUrl);
    ingest.binaryType = "arraybuffer";
    ingestSocketRef.current = ingest;

    const session = new WebSocket(sessionUrl);
    sessionSocketRef.current = session;

    session.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as SessionServerMessage;
        switch (msg.type) {
          case "transcript.partial": {
            const t = msg.turn;
            setState((s) => ({
              ...s,
              partial: { ...t, uiKey: `partial:${t.tsStartMs}` },
            }));
            break;
          }
          case "transcript.final": {
            const t = msg.turn;
            setState((s) => ({
              ...s,
              partial: null,
              turns: [...s.turns, { ...t, uiKey: `final:${t.id}:${t.tsStartMs}` }],
            }));
            break;
          }
          case "transcript.relabel": {
            // The suggestion engine's logical pass corrected who was speaking.
            setState((s) => ({
              ...s,
              turns: s.turns.map((turn) =>
                turn.id === msg.turnId ? { ...turn, speaker: msg.speaker } : turn,
              ),
            }));
            break;
          }
          case "sentiment.update": {
            const v = Math.round(50 + msg.value * 50);
            setState((s) => {
              const t = s.sentimentSeries.length > 0
                ? s.sentimentSeries[s.sentimentSeries.length - 1].t + 1
                : 0;
              return {
                ...s,
                sentiment: v,
                sentimentSeries: [...s.sentimentSeries.slice(-47), { t, v }],
              };
            });
            break;
          }
          case "suggestion.begin": {
            setState((s) => ({
              ...s,
              suggestions: [
                ...s.suggestions,
                { requestId: msg.requestId, triggerTurnId: msg.triggerTurnId, text: "", done: false },
              ],
            }));
            break;
          }
          case "suggestion.delta": {
            setState((s) => ({
              ...s,
              suggestions: s.suggestions.map((sg) =>
                sg.requestId === msg.requestId ? { ...sg, text: sg.text + msg.text } : sg,
              ),
            }));
            break;
          }
          case "suggestion.end": {
            setState((s) => {
              const next: Suggestion[] = s.suggestions.map((sg) =>
                sg.requestId === msg.requestId
                  ? { ...sg, payload: msg.payload, latencyMs: msg.latencyMs, done: true }
                  : sg,
              );
              const newCitations = msg.payload.citations?.length
                ? [...s.citations.slice(-19), ...msg.payload.citations].slice(-20)
                : s.citations;
              return { ...s, suggestions: next, citations: newCitations };
            });
            break;
          }
          case "rubric.tick": {
            setState((s) => ({
              ...s,
              liveRubric: {
                rubricId: msg.rubricId,
                rubricName: msg.rubricName,
                ts: msg.ts,
                scores: msg.scores,
              },
            }));
            break;
          }
          // topics.update / compliance.update / translation.* / language.detected
          // are intentionally not handled here — the recruiter wedge UI doesn't
          // surface them today.
        }
      } catch {
        // ignore unparsable frames
      }
    };

    await new Promise<void>((resolve, reject) => {
      ingest.onopen = () => resolve();
      ingest.onerror = () => reject(new Error("ingest socket failed to open"));
      setTimeout(() => reject(new Error("ingest socket timeout")), 8000);
    }).catch((err) => {
      setState((s) => ({ ...s, status: "error", errorMessage: err.message }));
      teardown();
      throw err;
    });

    // AudioContext + ScriptProcessorNode capture path. This is the simpler
    // (deprecated but universally supported) approach. AudioWorklet would
    // be lower latency but requires a separate worklet module file.
    const ctx = new AudioContext();
    audioContextRef.current = ctx;
    const source = ctx.createMediaStreamSource(media);
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processorRef.current = processor;

    let bytesSent = 0;
    processor.onaudioprocess = (ev) => {
      if (ingest.readyState !== WebSocket.OPEN) return;
      const channelData = ev.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16k(channelData, ctx.sampleRate);
      const buffer = pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength);
      try {
        ingest.send(buffer);
        bytesSent += pcm16.byteLength;
        if (bytesSent % (TARGET_SAMPLE_RATE * 2) < pcm16.byteLength) {
          // Update UI roughly every second to avoid setState churn per frame.
          setState((s) => ({ ...s, bytesSent }));
        }
      } catch {
        // ignore individual send failures; the WS will surface a close
      }
    };
    source.connect(processor);
    processor.connect(ctx.destination);

    setState((s) => ({ ...s, status: "live", startedAt: Date.now() }));
    // No explicit /start API call — POST /api/calls already created the
    // session in "assigned" state, /ws/ingest-call attaches the audio
    // pipeline, and POST /:id/end closes it. There's no /:id/start route.
  }, [teardown]);

  const end = useCallback(async () => {
    setState((s) => ({ ...s, status: "ending" }));
    const callId = state.callId;
    teardown();
    if (callId) {
      try {
        await apiFetch(`/api/calls/${callId}/end`, { method: "POST" });
      } catch {
        // ignore — UI moves on regardless
      }
    }
    setState((s) => ({ ...s, status: "ended" }));
  }, [state.callId, teardown]);

  const markSpeaker = useCallback(
    async (speaker: Speaker, tsMs: number) => {
      if (!state.callId) return;
      if (speaker !== "recruiter" && speaker !== "candidate") return;
      try {
        await apiFetch(`/api/calls/${state.callId}/manual-speaker-bracket`, {
          method: "POST",
          json: { speaker, tsMs },
        });
      } catch {
        // ignore — non-essential
      }
    },
    [state.callId],
  );

  return {
    state,
    create,
    start,
    end,
    markSpeaker,
  };
}
