import { useCallback, useEffect, useRef, useState } from "react";
import Vapi from "@vapi-ai/web";
import { apiFetch, getStoredToken, getWsBase } from "@/lib/api";
import type {
  Citation,
  SessionServerMessage,
  SuggestionPayload,
  TranscriptTurn,
} from "@j2w/shared-types";
import type { LiveAssistSeed } from "@/lib/liveAssistDemo";
import type { TranslatedTurn, TurnTranslation } from "@/lib/translationConfig";
import type { ScriptedTranslationStep } from "@/lib/liveAssistTranslationDemo";
import { readTranscriptionSettings } from "@/hooks/useTranscriptionSettings";

export type CallState = "idle" | "starting" | "live" | "ending" | "ended";

export interface Suggestion {
  requestId: string;
  triggerTurnId: number;
  text: string;
  payload?: SuggestionPayload;
  latencyMs?: number;
  done: boolean;
}

export interface LiveCall {
  state: CallState;
  callId: string | null;
  error: string | null;
  elapsed: number;

  turns: TranslatedTurn[]; // finals + tail partial (partial has id = -1)
  sentiment: number; // 0-100
  sentimentSeries: Array<{ t: number; v: number }>;
  topics: Array<{ name: string; confidence: number }>;
  compliance: Array<{ id: string; label: string; ok: boolean; ts?: number }>;
  suggestions: Suggestion[];
  citations: Citation[];
  outboundSpeaking: boolean;
  /** Populated by the server when it auto-detects the caller's language.
   *  Null until the provider returns a detection. */
  detectedLanguage: { code: string; confidence: number } | null;
  /** Mirror of the TranslationConfig the server last broadcast via
   *  translation.config. Null when translation is disabled for this call. */
  serverTranslationConfig: import("@j2w/shared-types").TranslationConfig | null;

  start: () => Promise<void>;
  end: () => Promise<void>;
}

export interface UseLiveCallOptions {
  // Seed shown while state === "idle". Cleared the moment `start()` is called.
  seed?: LiveAssistSeed & {
    turns?: TranslatedTurn[];
    translation?: {
      sourceLang: string;
      targetLang: string;
      script: ScriptedTranslationStep[];
    };
  };
}

interface TestCallTicket {
  mode: "inline" | "assistantId";
  publicKey: string;
  assistantId?: string;
  assistant?: Record<string, unknown>;
}

export function useLiveCall(options: UseLiveCallOptions = {}): LiveCall {
  const { seed } = options;

  const [state, setState] = useState<CallState>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(seed?.elapsed ?? 0);

  const [turns, setTurns] = useState<TranslatedTurn[]>(
    (seed?.turns as TranslatedTurn[] | undefined) ?? [],
  );
  const [outboundSpeaking, setOutboundSpeaking] = useState(false);
  const [sentiment, setSentiment] = useState(seed?.sentiment ?? 50);
  const [sentimentSeries, setSentimentSeries] = useState<Array<{ t: number; v: number }>>(
    seed?.sentimentSeries ?? [],
  );
  const [topics, setTopics] = useState<Array<{ name: string; confidence: number }>>(
    seed?.topics ?? [],
  );
  const [compliance, setCompliance] = useState<LiveCall["compliance"]>(seed?.compliance ?? []);
  const [suggestions, setSuggestions] = useState<Suggestion[]>(seed?.suggestions ?? []);
  const [citations, setCitations] = useState<Citation[]>(seed?.citations ?? []);
  const [detectedLanguage, setDetectedLanguage] = useState<
    { code: string; confidence: number } | null
  >(null);
  const [serverTranslationConfig, setServerTranslationConfig] =
    useState<LiveCall["serverTranslationConfig"]>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const vapiRef = useRef<Vapi | null>(null);
  const callIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Duration ticker
  useEffect(() => {
    if (state !== "live") return;
    const id = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [state]);

  // Declared before `handleMessage` so the useCallback dep array can reference
  // it at render time without hitting a temporal-dead-zone ReferenceError.
  const outboundTimerRef = useRef<number | null>(null);
  const markOutboundSpeaking = useCallback((durationMs: number) => {
    setOutboundSpeaking(true);
    if (outboundTimerRef.current) window.clearTimeout(outboundTimerRef.current);
    outboundTimerRef.current = window.setTimeout(() => {
      setOutboundSpeaking(false);
      outboundTimerRef.current = null;
    }, durationMs);
  }, []);

  const handleMessage = useCallback((msg: SessionServerMessage) => {
    switch (msg.type) {
      case "hello":
        break;
      case "transcript.partial": {
        const t = msg.turn;
        setTurns((prev) => {
          const withoutTail = prev.filter((x) => x.id >= 0 || x.speaker !== t.speaker);
          return [...withoutTail, t];
        });
        break;
      }
      case "transcript.final": {
        const t = msg.turn;
        setTurns((prev) => {
          const withoutPartials = prev.filter((x) => x.id >= 0);
          return [...withoutPartials, t];
        });
        break;
      }
      case "sentiment.update": {
        const v = Math.round(50 + msg.value * 50);
        setSentiment(v);
        setSentimentSeries((prev) => {
          const t = prev.length > 0 ? prev[prev.length - 1].t + 1 : 0;
          return [...prev.slice(-47), { t, v }];
        });
        break;
      }
      case "topics.update":
        setTopics(msg.topics);
        break;
      case "compliance.update":
        setCompliance(msg.items);
        break;
      case "suggestion.begin":
        setSuggestions((prev) => [
          ...prev,
          { requestId: msg.requestId, triggerTurnId: msg.triggerTurnId, text: "", done: false },
        ]);
        break;
      case "suggestion.delta":
        setSuggestions((prev) =>
          prev.map((s) => (s.requestId === msg.requestId ? { ...s, text: s.text + msg.text } : s)),
        );
        break;
      case "suggestion.end":
        setSuggestions((prev) =>
          prev.map((s) =>
            s.requestId === msg.requestId
              ? { ...s, payload: msg.payload, latencyMs: msg.latencyMs, done: true }
              : s,
          ),
        );
        if (msg.payload.citations?.length) {
          setCitations((prev) => [...prev.slice(-19), ...msg.payload.citations].slice(-20));
        }
        break;
      case "translation.partial": {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === msg.turnId
              ? {
                  ...t,
                  translation: {
                    sourceLang: msg.sourceLang as TurnTranslation["sourceLang"],
                    targetLang: msg.targetLang as TurnTranslation["targetLang"],
                    text: msg.text,
                    isFinal: false,
                    confidence: 0,
                  },
                }
              : t,
          ),
        );
        break;
      }
      case "translation.final": {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === msg.turnId
              ? {
                  ...t,
                  translation: {
                    sourceLang: msg.sourceLang as TurnTranslation["sourceLang"],
                    targetLang: msg.targetLang as TurnTranslation["targetLang"],
                    text: msg.text,
                    isFinal: true,
                    confidence: msg.confidence,
                    latencyMs: msg.latencyMs,
                  },
                }
              : t,
          ),
        );
        if (msg.speaker === "recruiter") {
          markOutboundSpeaking(Math.max(1200, msg.text.length * 30));
        }
        break;
      }
      case "translation.config":
        setServerTranslationConfig(msg.config);
        break;
      case "language.detected":
        setDetectedLanguage({ code: msg.code, confidence: msg.confidence });
        break;
      case "call.ended":
        setState("ended");
        break;
      case "error":
        setError(msg.message);
        break;
    }
  }, [markOutboundSpeaking]);

  // Cleanup the outbound timer when the hook unmounts.
  useEffect(() => {
    return () => {
      if (outboundTimerRef.current) window.clearTimeout(outboundTimerRef.current);
    };
  }, []);

  // Scripted translation runner: when the seed includes a `translation.script`,
  // we play extra turns in the transcript while the page sits in idle, so the
  // translation demo keeps feeling live even before a real call starts.
  const scriptStartedRef = useRef(false);
  useEffect(() => {
    const script = seed?.translation?.script;
    if (!script || scriptStartedRef.current) return;
    scriptStartedRef.current = true;

    const timers: number[] = [];
    let cumulative = seed?.elapsed ? seed.elapsed * 1000 : 0;
    const baseStep = 4200;
    let nextId =
      ((seed?.turns ?? []).reduce((max, t) => Math.max(max, t.id), 0) as number) + 1;

    script.forEach((step) => {
      const turnId = nextId++;
      const tsStart = cumulative + step.delayMs;
      const tsEnd = tsStart + baseStep;
      cumulative = tsEnd;

      // Partial appears first (customer/agent starts speaking).
      timers.push(
        window.setTimeout(() => {
          const partial: TranslatedTurn = {
            id: -1,
            callId: "demo-translation-script",
            speaker: step.speaker,
            text: step.partial,
            isFinal: false,
            tsStartMs: tsStart,
            tsEndMs: tsStart,
            sentiment: null,
            translation: {
              sourceLang: (step.speaker === "candidate" ? "es-ES" : "en-US") as TurnTranslation["sourceLang"],
              targetLang: (step.speaker === "candidate" ? "en-US" : "es-ES") as TurnTranslation["targetLang"],
              text: step.partialTranslation,
              isFinal: false,
              confidence: step.confidence * 0.85,
            },
          };
          setTurns((prev) => {
            const withoutTail = prev.filter((x) => x.id >= 0 || x.speaker !== step.speaker);
            return [...withoutTail, partial];
          });
          if (step.speaker === "recruiter") {
            markOutboundSpeaking(2800);
          }
        }, step.delayMs),
      );

      // Final replaces the partial.
      timers.push(
        window.setTimeout(() => {
          const final: TranslatedTurn = {
            id: turnId,
            callId: "demo-translation-script",
            speaker: step.speaker,
            text: step.final,
            isFinal: true,
            tsStartMs: tsStart,
            tsEndMs: tsEnd,
            sentiment: step.speaker === "candidate" ? 0.5 : 0.3,
            translation: {
              sourceLang: (step.speaker === "candidate" ? "es-ES" : "en-US") as TurnTranslation["sourceLang"],
              targetLang: (step.speaker === "candidate" ? "en-US" : "es-ES") as TurnTranslation["targetLang"],
              text: step.finalTranslation,
              isFinal: true,
              confidence: step.confidence,
              latencyMs: 300 + Math.floor(Math.random() * 220),
            },
          };
          setTurns((prev) => {
            const withoutPartials = prev.filter((x) => x.id >= 0);
            return [...withoutPartials, final];
          });
        }, step.delayMs + 1800),
      );
    });

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [seed, markOutboundSpeaking]);

  const clearAll = useCallback(() => {
    setTurns([]);
    setSentiment(50);
    setSentimentSeries([]);
    setTopics([]);
    setCompliance([]);
    setSuggestions([]);
    setCitations([]);
    setElapsed(0);
  }, []);

  const teardownVapi = useCallback(() => {
    if (vapiRef.current) {
      try {
        vapiRef.current.stop();
      } catch {
        // ignore
      }
      vapiRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (state === "live" || state === "starting") return;
    setState("starting");
    setError(null);
    clearAll();

    try {
      // 1) Create the call_session row on our backend so pipelines have a key.
      const startRes = await apiFetch<{ callId: string; startedAt: string }>(
        "/api/calls/start",
        { method: "POST", json: {} },
      );
      const id = startRes.callId;
      setCallId(id);
      callIdRef.current = id;

      // 2) Ask the backend for an inline Vapi assistant config (candidate
      // screening persona — the bot plays the candidate, you are the recruiter).
      // The selected transcription provider drives which `transcriber` block
      // the backend embeds in the Vapi assistant config (deepgram native, or
      // sarvam/shunya via Vapi's custom-transcriber WebSocket bridge).
      const transcription = readTranscriptionSettings();
      const ticket = await apiFetch<TestCallTicket>("/api/live-assist/test-call", {
        method: "POST",
        json: {
          callId: id,
          transcription,
        },
      });

      // 3) Open the /ws/session WebSocket so server-side pipelines can stream
      // sentiment/topics/suggestions/compliance back to us.
      const token = getStoredToken();
      const url = new URL(`${getWsBase()}/ws/session`);
      url.searchParams.set("callId", id);
      if (token) url.searchParams.set("token", token);
      const ws = new WebSocket(url.toString());
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          handleMessage(JSON.parse(e.data) as SessionServerMessage);
        } catch {
          // ignore
        }
      };
      ws.onopen = () => {
        startedAtRef.current = Date.now();
        setState("live");
        setCompliance([
          { id: "disclosure", label: "Recording disclosure", ok: false },
          { id: "identity", label: "Identity verified", ok: false },
          { id: "fees", label: "Fee disclosure", ok: false },
        ]);
      };
      ws.onerror = () => setError("session websocket error");
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
      };

      // 4) Start the Vapi call in the browser. The Vapi assistant plays the
      // role of the candidate; the human at this keyboard is the recruiter.
      // Vapi's role="assistant" maps to speaker="candidate" and role="user"
      // maps to speaker="recruiter".
      const vapi = new Vapi(ticket.publicKey);
      vapiRef.current = vapi;

      vapi.on("call-start", () => {
        startedAtRef.current ??= Date.now();
        setState((prev) => (prev === "live" ? prev : "live"));
      });
      vapi.on("call-end", () => {
        setState((prev) => (prev === "ended" ? prev : "ended"));
      });
      vapi.on("error", (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      vapi.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const m = raw as {
          type?: string;
          role?: "assistant" | "user";
          transcript?: string;
          transcriptType?: "partial" | "final";
        };
        if (m.type !== "transcript" || !m.role || !m.transcript) return;
        const speaker: "recruiter" | "candidate" = m.role === "assistant" ? "candidate" : "recruiter";
        const text = m.transcript.trim();
        if (!text) return;
        const now = Date.now();
        const startedAt = startedAtRef.current ?? now;
        const tsStartMs = Math.max(0, now - startedAt);

        if (m.transcriptType === "final") {
          // Forward to backend — the persist-then-broadcast path on
          // /ws/session is the single source of truth for rendered finals.
          // Appending here too would duplicate each turn in the UI.
          void apiFetch(`/api/calls/${id}/transcripts`, {
            method: "POST",
            json: {
              speaker,
              text,
              tsStartMs,
              tsEndMs: tsStartMs,
            },
          }).catch(() => {
            // pipeline errors are non-fatal
          });
        } else {
          // Show a partial so the UI feels live while the user is speaking.
          const partial: TranscriptTurn = {
            id: -1,
            callId: id,
            speaker,
            text,
            isFinal: false,
            tsStartMs,
            tsEndMs: tsStartMs,
            sentiment: null,
          };
          setTurns((prev) => {
            const withoutTail = prev.filter((x) => x.id >= 0 || x.speaker !== speaker);
            return [...withoutTail, partial];
          });
        }
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
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
      teardownVapi();
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
    }
  }, [state, clearAll, handleMessage, teardownVapi]);

  const end = useCallback(async () => {
    const id = callIdRef.current;
    if (state === "ended" || state === "ending") return;
    setState("ending");
    teardownVapi();
    if (id) {
      try {
        await apiFetch(`/api/calls/${id}/end`, { method: "POST" });
      } catch {
        // continue teardown
      }
    }
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    setState("ended");
  }, [state, teardownVapi]);

  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      teardownVapi();
    };
  }, [teardownVapi]);

  useEffect(() => {
    if (turns.length > 300) setTurns((prev) => prev.slice(-200));
  }, [turns.length]);

  return {
    state,
    callId,
    error,
    elapsed,
    turns,
    sentiment,
    sentimentSeries,
    topics,
    compliance,
    suggestions,
    citations,
    outboundSpeaking,
    detectedLanguage,
    serverTranslationConfig,
    start,
    end,
  };
}

export function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
