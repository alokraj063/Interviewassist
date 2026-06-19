// Shunya Labs streaming STT bridge.
// Docs: https://docs.shunyalabs.ai/streaming/overview
//
// Upstream protocol (verified against the live wss://asr.shunyalabs.ai API):
//  - Connect WS to wss://asr.shunyalabs.ai/ws (no query params).
//  - The FIRST message MUST be a JSON config; audio sent before it is rejected
//    with {"type":"error","code":"PROTOCOL_ERROR"}. Config carries the api_key,
//    model, language, sample_rate, and dtype:
//      { api_key, model: "zero-indic", language: "hi", sample_rate: 16000,
//        dtype: "int16", chunk_size_sec, silence_threshold_sec }
//    The server replies { "type": "ready", "session_id": ... } when it's ready
//    to accept audio.
//  - Audio is sent as raw binary PCM frames whose encoding matches `dtype`
//    (we send int16 / PCM16 16kHz mono).
//  - End-of-audio is signaled with {"type":"end"} (or text "END", or an empty
//    binary frame).
//  - Results: { type: "partial", text, is_final:false } and
//    { type: "final_segment", text, status, is_final:true }. The server also
//    emits speech_start / speech_end / end_of_transcript / done frames we ignore.
//
// Kept intentionally symmetric with createSarvamBridge so the
// /ws/custom-transcriber + browser-mic single-bridge paths can swap providers
// by string key.
import WebSocket from "ws";
import {
  BridgeEvents,
  type TranscriptionBridge,
  type TranscriptionBridgeOptions,
  type TranscriptionLanguage,
} from "./provider.js";

const SHUNYA_WS_URL = "wss://asr.shunyalabs.ai/ws";

// Shunya wants an ISO-ish language code. The zero-indic model handles Hindi /
// Hinglish code-mix; default our "multi" (Hinglish) to Hindi.
function toShunyaLanguage(lang: TranscriptionLanguage | undefined): string {
  switch (lang) {
    case "en-US":
    case "en-IN":
      return "en";
    case "hi-IN":
      return "hi";
    case "multi":
    default:
      return "hi";
  }
}

export function createShunyaBridge(opts: TranscriptionBridgeOptions): TranscriptionBridge {
  if (!opts.apiKey) {
    throw new Error("shunya apiKey not provided");
  }

  const events = new BridgeEvents();
  const sampleRate = opts.sampleRate ?? 16000;
  // "zero-indic" is the documented streaming model. Ignore the legacy
  // placeholder id ("shunya-streaming-v1") that older clients may still send.
  const model = opts.model && opts.model !== "shunya-streaming-v1" ? opts.model : "zero-indic";
  const language = toShunyaLanguage(opts.language);

  const ws = new WebSocket(SHUNYA_WS_URL, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  ws.binaryType = "nodebuffer";

  let ready = false; // becomes true after the server's {"type":"ready"}
  let closed = false;
  const pending: Buffer[] = [];
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  ws.on("open", () => {
    // The config message must precede any audio. We resolve the ready promise
    // and flush buffered audio only once the server acknowledges with "ready".
    try {
      ws.send(
        JSON.stringify({
          api_key: opts.apiKey,
          model,
          language,
          sample_rate: sampleRate,
          dtype: "int16",
          chunk_size_sec: 2.0,
          silence_threshold_sec: 0.8,
        }),
      );
    } catch (err) {
      opts.log.warn({ err, provider: "shunya" }, "shunya config send failed");
    }
  });

  ws.on("message", (data) => {
    if (closed) return;
    // Shunya sends control + transcript frames as text JSON; audio never flows back.
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : "";
    if (!text) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type.toUpperCase() : "";
    if (type === "READY") {
      ready = true;
      readyResolve?.();
      // Flush any audio buffered while we waited for the config ack.
      while (pending.length > 0) {
        const buf = pending.shift()!;
        sendAudio(buf);
      }
    } else if (type === "PARTIAL" || type === "FINAL_SEGMENT" || type === "FINAL") {
      const raw = typeof parsed.text === "string" ? parsed.text : "";
      const t = raw.trim();
      if (!t) return;
      const isFinal = type === "FINAL" || type === "FINAL_SEGMENT";
      events.emitTranscript({ text: t, isFinal, raw: parsed });
    } else if (type === "ERROR") {
      const message = typeof parsed.message === "string" ? parsed.message : "shunya error";
      opts.log.warn({ provider: "shunya", message }, "shunya upstream error frame");
      events.emitError(new Error(message));
    }
    // speech_start / speech_end / end_of_transcript / done are informational.
  });

  ws.on("error", (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    opts.log.warn({ err: e, provider: "shunya" }, "shunya upstream error");
    if (!ready) readyReject?.(e);
    events.emitError(e);
  });

  ws.on("close", () => {
    closed = true;
    events.emitClose();
  });

  function sendAudio(pcm: Buffer): void {
    if (closed) return;
    try {
      // Raw binary PCM16 (dtype=int16), unmodified.
      ws.send(pcm, { binary: true });
    } catch (err) {
      opts.log.warn({ err, provider: "shunya" }, "shunya send failed");
    }
  }

  return {
    ready: () => readyPromise,
    writeAudio(pcm: Buffer) {
      if (closed) return;
      // Buffer until the server has acked the config with "ready".
      if (!ready) {
        pending.push(pcm);
        return;
      }
      sendAudio(pcm);
    },
    flush() {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "end" }));
      } catch {
        // ignore
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
      } catch {
        // ignore
      }
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
