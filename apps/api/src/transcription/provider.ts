// Shared interface for a streaming transcription "bridge" — a local object
// that manages one upstream WebSocket per call and emits transcripts back
// through simple callbacks. Used by the /ws/custom-transcriber endpoint to
// fan Vapi audio out to Sarvam or Shunya without coupling the endpoint to
// any single provider's protocol.
import type { FastifyBaseLogger } from "fastify";

export type TranscriptionProvider = "sarvam" | "shunya";

export type TranscriptionLanguage = "multi" | "en-US" | "en-IN" | "hi-IN";

export interface TranscriptionBridgeOptions {
  callId?: string;
  model?: string;
  language?: TranscriptionLanguage;
  /** 16000 by default — matches Vapi's custom-transcriber PCM16 frames. */
  sampleRate?: number;
  /**
   * Provider credentials resolved by the caller (env fallback or per-tenant
   * row from tenant_integrations). For Sarvam this is the api-subscription-key;
   * for Shunya the bearer token. Bridges throw if it's empty.
   */
  apiKey: string;
  log: FastifyBaseLogger;
}

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  /** Provider-specific raw frame for debugging / telemetry. */
  raw?: unknown;
}

export interface TranscriptionBridge {
  /** Resolves when the upstream connection is ready to accept audio. */
  ready(): Promise<void>;

  /** Push a PCM16 mono frame upstream. Must be a plain Buffer. */
  writeAudio(pcm: Buffer): void;

  /** Hint to the upstream that the input stream is ending (flushes buffers). */
  flush(): void;

  /** Close the upstream WebSocket and release timers. */
  close(): Promise<void>;

  /** Subscribe to transcript events (interim + final). */
  onTranscript(cb: (evt: TranscriptEvent) => void): void;

  /** Subscribe to provider errors. */
  onError(cb: (err: Error) => void): void;

  /** Subscribe to upstream close. */
  onClose(cb: () => void): void;
}

/**
 * Minimal event-emitter base to keep each provider file short and readable.
 * Not extracting to a shared base class because the upstream clients diverge
 * more than they overlap; this is just a tiny helper used internally.
 */
export class BridgeEvents {
  private transcriptCbs: Array<(evt: TranscriptEvent) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closeCbs: Array<() => void> = [];

  onTranscript(cb: (evt: TranscriptEvent) => void): void {
    this.transcriptCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  emitTranscript(evt: TranscriptEvent): void {
    for (const cb of this.transcriptCbs) {
      try {
        cb(evt);
      } catch {
        // listener errors are isolated
      }
    }
  }
  emitError(err: Error): void {
    for (const cb of this.errorCbs) {
      try {
        cb(err);
      } catch {
        // ignore
      }
    }
  }
  emitClose(): void {
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
    this.transcriptCbs = [];
    this.errorCbs = [];
    this.closeCbs = [];
  }
}
