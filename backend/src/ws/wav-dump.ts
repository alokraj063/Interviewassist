import { createWriteStream, type WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Minimal WAV (linear16 PCM) dump helper for dev-mode ingest verification.
// Writes a RIFF header with data-size 0xffffffff — most players play these
// fine; audacity/ffmpeg read them as "streaming" and show the full duration.
//
// Channel 0 = recruiter (laptop mic in browser_mixed mode; agent leg in
// desktop_dual_channel). Channel 1 = candidate (system audio leg in
// desktop_dual_channel; never written in browser_mixed mode since the
// candidate's voice is part of the same mic stream as the recruiter's).

const SAMPLE_RATE = 16000;
const BITS = 16;
const CHANNELS = 1;

function riffHeader(): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
  const blockAlign = (CHANNELS * BITS) / 8;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0xffffffff, 40);
  return buf;
}

export class WavDumper {
  private recruiter: WriteStream | null = null;
  private candidate: WriteStream | null = null;
  private recruiterPath: string | null = null;
  private candidatePath: string | null = null;
  constructor(private callId: string, private outDir: string) {
    mkdirSync(outDir, { recursive: true });
  }
  private streamFor(channel: number): WriteStream {
    const which = channel === 0 ? "recruiter" : "candidate";
    const existing = channel === 0 ? this.recruiter : this.candidate;
    if (existing) return existing;
    const file = path.join(this.outDir, `${this.callId}-${which}.wav`);
    const ws = createWriteStream(file);
    ws.write(riffHeader());
    if (channel === 0) {
      this.recruiter = ws;
      this.recruiterPath = file;
    } else {
      this.candidate = ws;
      this.candidatePath = file;
    }
    return ws;
  }
  writeFrame(channel: number, pcm: Buffer): void {
    this.streamFor(channel).write(pcm);
  }
  close(): void {
    this.recruiter?.end();
    this.candidate?.end();
    this.recruiter = null;
    this.candidate = null;
  }
  /** Absolute paths written so far. Null until at least one frame arrived. */
  get paths(): { recruiter: string | null; candidate: string | null } {
    return { recruiter: this.recruiterPath, candidate: this.candidatePath };
  }

  /**
   * Relative paths under `outDir` for storing in `call_sessions.recording_url`.
   * The auth playback endpoint resolves these against the runtime DUMP_DIR
   * (which can differ between dev and prod containers).
   */
  get relativePaths(): { recruiter: string | null; candidate: string | null } {
    return {
      recruiter: this.recruiterPath ? path.relative(this.outDir, this.recruiterPath) : null,
      candidate: this.candidatePath ? path.relative(this.outDir, this.candidatePath) : null,
    };
  }
}
