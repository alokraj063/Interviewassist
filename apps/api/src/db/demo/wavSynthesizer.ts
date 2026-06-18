// Synthesise tiny but valid PCM16 16kHz mono WAV files for the demo seed.
// The audio player on Call Detail reads its displayed duration from
// call_sessions.recording_duration_ms — not from the file — so a short
// physical WAV is fine even when the seed claims a 12-minute call. Header
// shape mirrors apps/api/src/ws/wav-dump.ts so the file is byte-identical to
// what live ingest would produce.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../../env.js";
import { WAV_PHYSICAL_DURATION_SEC } from "./constants.js";

const SAMPLE_RATE = 16000;
const BITS = 16;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = (BITS * CHANNELS) / 8;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;

function riffHeader(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(BYTES_PER_SEC, 28);
  buf.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0xffffffff, 40);
  return buf;
}

function silenceBody(durationSec: number): Buffer {
  return Buffer.alloc(BYTES_PER_SEC * durationSec);
}

function sineBody(durationSec: number, freqHz = 440, amplitude = 0.05): Buffer {
  const total = SAMPLE_RATE * durationSec;
  const buf = Buffer.alloc(total * BYTES_PER_SAMPLE);
  for (let i = 0; i < total; i += 1) {
    const sample = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE));
    buf.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

export interface SynthesiseResult {
  recruiterRel: string | null;
  candidateRel: string | null;
  mime: string;
}

export interface SynthesiseOptions {
  tone?: "silence" | "sine440";
}

let dumpDirReady = false;

function ensureDumpDir(): string | null {
  const dir = path.resolve(env.DUMP_DIR);
  if (dumpDirReady) return dir;
  try {
    mkdirSync(dir, { recursive: true });
    dumpDirReady = true;
    return dir;
  } catch (err) {
    // Degrade: returning null tells the seed to leave recording_url NULL
    // rather than aborting the whole run.
    console.warn(`[demo-seed] WARN: cannot prepare DUMP_DIR (${dir}): ${(err as Error).message}`);
    return null;
  }
}

// Synthesise both legs of a call. Skips writing if the file already exists
// (re-runs are cheap). Returns paths relative to DUMP_DIR for direct storage
// in call_sessions.recording_url. Falls back to nulls on filesystem errors.
export function synthesiseCallWav(
  callId: string,
  options: SynthesiseOptions = {},
): SynthesiseResult {
  const tone = options.tone ?? "silence";
  const dir = ensureDumpDir();
  if (!dir) return { recruiterRel: null, candidateRel: null, mime: "audio/wav" };

  const header = riffHeader();
  const body = tone === "sine440" ? sineBody(WAV_PHYSICAL_DURATION_SEC) : silenceBody(WAV_PHYSICAL_DURATION_SEC);

  const recruiterRel = `${callId}-recruiter.wav`;
  const candidateRel = `${callId}-candidate.wav`;
  const recruiterAbs = path.join(dir, recruiterRel);
  const candidateAbs = path.join(dir, candidateRel);

  for (const abs of [recruiterAbs, candidateAbs]) {
    if (existsSync(abs)) continue;
    try {
      writeFileSync(abs, Buffer.concat([header, body]));
    } catch (err) {
      console.warn(`[demo-seed] WARN: failed to write ${abs}: ${(err as Error).message}`);
      return { recruiterRel: null, candidateRel: null, mime: "audio/wav" };
    }
  }

  return { recruiterRel, candidateRel, mime: "audio/wav" };
}
