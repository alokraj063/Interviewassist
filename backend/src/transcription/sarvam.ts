// Sarvam AI streaming STT bridge.
// Docs: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api
//
// Upstream protocol (verified against the live wss://api.sarvam.ai API):
//  - Connect WS to wss://api.sarvam.ai/speech-to-text/ws with connection
//    params in the query string (model, language-code, sample_rate, etc.).
//  - Authenticate with header `api-subscription-key: <key>`.
//  - Send audio as JSON frames where `audio` is an OBJECT (AudioContent), not a
//    bare base64 string: { audio: { data: <base64>, sample_rate, encoding } }.
//  - Receive JSON frames:
//      { type: "data",   data: { transcript, language_code, ... } }  ← finalized segment
//      { type: "events", data: { signal_type: "START_SPEECH"|"END_SPEECH" } }  ← VAD
//      { type: "error",  data: { message } }
//    There are no interim/partial transcripts in this mode — each "data" frame
//    (emitted after an END_SPEECH) is a final utterance segment.
//
// We hide the framing details behind the TranscriptionBridge interface so the
// Vapi-facing /ws/custom-transcriber endpoint can treat all providers uniformly.
import WebSocket from "ws";
import {
  BridgeEvents,
  type TranscriptionBridge,
  type TranscriptionBridgeOptions,
  type TranscriptionLanguage,
} from "./provider.js";

const SARVAM_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";

// Sarvam language codes differ slightly from our internal labels; re-map here.
function toSarvamLanguage(lang: TranscriptionLanguage | undefined): string {
  switch (lang) {
    case "hi-IN":
      return "hi-IN";
    case "en-IN":
      return "en-IN";
    case "en-US":
      return "en-IN"; // Sarvam favors Indic region codes
    case "multi":
    default:
      return "hi-IN"; // codemix mode on hi-IN handles Hinglish best
  }
}

// "codemix" mode is the right pick for Hinglish; "transcribe" is pure text.
function toSarvamMode(lang: TranscriptionLanguage | undefined): string {
  if (!lang || lang === "multi") return "codemix";
  return "transcribe";
}

export function createSarvamBridge(opts: TranscriptionBridgeOptions): TranscriptionBridge {
  if (!opts.apiKey) {
    throw new Error("sarvam apiKey not provided");
  }

  const events = new BridgeEvents();
  const sampleRate = opts.sampleRate ?? 16000;
  const model = opts.model || "saaras:v3";
  const language = toSarvamLanguage(opts.language);
  const mode = toSarvamMode(opts.language);

  const url = new URL(SARVAM_WS_URL);
  url.searchParams.set("model", model);
  url.searchParams.set("mode", mode);
  url.searchParams.set("language-code", language);
  url.searchParams.set("sample_rate", String(sampleRate));
  url.searchParams.set("input_audio_codec", "pcm_s16le");
  url.searchParams.set("high_vad_sensitivity", "true");
  url.searchParams.set("vad_signals", "true");

  const ws = new WebSocket(url, {
    headers: { "api-subscription-key": opts.apiKey },
  });

  let open = false;
  let closed = false;
  const pending: Buffer[] = [];
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  ws.on("open", () => {
    open = true;
    readyResolve?.();
    // Flush any audio that arrived before the socket opened.
    while (pending.length > 0) {
      const buf = pending.shift()!;
      sendAudio(buf);
    }
  });

  ws.on("message", (data) => {
    if (closed) return;
    let text: string;
    try {
      text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    } catch {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    // Sarvam streams finalized segments as { type: "data", data: { transcript } }
    // after each END_SPEECH. "events" frames are VAD signals; "error" frames are
    // pipeline validation errors.
    if (type === "data") {
      const seg = (parsed.data ?? {}) as { transcript?: unknown };
      const t = (typeof seg.transcript === "string" ? seg.transcript : "").trim();
      if (!t) return;
      events.emitTranscript({ text: t, isFinal: true, raw: parsed });
    } else if (type === "error") {
      const msg =
        (parsed.data as { message?: unknown } | undefined)?.message ?? "sarvam pipeline error";
      opts.log.warn({ provider: "sarvam", msg }, "sarvam upstream error frame");
    }
  });

  ws.on("error", (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    opts.log.warn({ err: e, provider: "sarvam" }, "sarvam upstream error");
    if (!open) readyReject?.(e);
    events.emitError(e);
  });

  ws.on("close", () => {
    closed = true;
    events.emitClose();
  });

  function sendAudio(pcm: Buffer): void {
    if (closed) return;
    try {
      // `audio` must be an AudioContent object (not a bare base64 string).
      const payload = JSON.stringify({
        audio: {
          data: pcm.toString("base64"),
          sample_rate: String(sampleRate),
          encoding: "audio/wav",
        },
      });
      ws.send(payload);
    } catch (err) {
      opts.log.warn({ err, provider: "sarvam" }, "sarvam send failed");
    }
  }

  return {
    ready: () => readyPromise,
    writeAudio(pcm: Buffer) {
      if (closed) return;
      if (!open) {
        pending.push(pcm);
        return;
      }
      sendAudio(pcm);
    },
    flush() {
      if (!open || closed) return;
      try {
        ws.send(JSON.stringify({ type: "flush" }));
      } catch {
        // ignore
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
    onTranscript: (cb) => events.onTranscript(cb),
    onError: (cb) => events.onError(cb),
    onClose: (cb) => events.onClose(cb),
  };
}
