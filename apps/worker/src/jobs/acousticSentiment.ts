// Acoustic-sentiment worker job.
//
// Pipeline (per job):
//   1. Resolve the recording URL (file://, http(s)://, s3:// — only file://
//      and http(s):// in this iteration).
//   2. Read PCM linear16 mono @ 16kHz (WAV header stripped).
//   3. Split into ~500ms windows per channel file (agent + customer).
//   4. Compute prosodic features per window: RMS energy, zero-crossing rate,
//      rough pitch proxy. Map to valence/arousal via a simple heuristic OR
//      call Hume AI's Expression Measurement API when HUME_API_KEY is set.
//   5. Insert one row per non-silent window into transcript_acoustic_windows.
//
// The heuristic fallback is deliberately crude — good enough to wire the
// frontend + exercise the schema. Production replaces it with Hume (or
// wav2vec2 on a GPU). Keeping the interface pluggable means swapping
// providers doesn't touch the rest of the stack.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { db, transcriptAcousticWindows, callSessions } from "@j2w/db";
import { eq } from "drizzle-orm";
import type { AcousticSentimentJob } from "@j2w/ingest-shared";

// Resolve a `recordingUrl` value (which may be file://, http(s)://, gs://,
// or a relative path under DUMP_DIR) into something `loadPcm` can read.
// Returns a file path for local reads and a URL string otherwise.
function resolveRecordingUrl(rawUrl: string): string {
  if (rawUrl.startsWith("file://") || rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  if (rawUrl.startsWith("gs://") || rawUrl.startsWith("s3://")) {
    // Future: signed-URL fetch. Today the worker doesn't read these.
    return rawUrl;
  }
  // Relative path under DUMP_DIR — the convention as of phase 5.
  const dumpDir = path.resolve(process.env.DUMP_DIR ?? "./var/audio-dumps");
  return "file://" + path.resolve(dumpDir, rawUrl);
}

const WINDOW_MS = 500;
const SAMPLE_RATE = 16_000;
const SAMPLES_PER_WINDOW = (SAMPLE_RATE * WINDOW_MS) / 1000;
// Silence gate: windows under this RMS are considered VAD-inactive and skipped.
const SILENCE_RMS = 0.005;

interface WindowFeatures {
  tsStartMs: number;
  tsEndMs: number;
  rmsEnergy: number;
  f0Mean: number | null;
  zcr: number;
}

interface WindowSentiment {
  valence: number; // [-1, 1]
  arousal: number; // [0, 1]
}

interface Analyzer {
  readonly name: string;
  score(features: WindowFeatures): WindowSentiment;
}

// ---------- Loaders ----------

async function loadPcm(rawUrl: string): Promise<Buffer> {
  const url = resolveRecordingUrl(rawUrl);
  let buf: Buffer;
  if (url.startsWith("file://")) {
    buf = await readFile(fileURLToPath(url));
  } else if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error(`unsupported recording URL scheme: ${url}`);
  }
  // Strip the 44-byte RIFF header when present. The dev dumper uses
  // 0xffffffff-sized WAV containers; probing for "RIFF" at offset 0 is
  // enough here — callers using other containers should transcode first.
  if (buf.length > 44 && buf.slice(0, 4).toString() === "RIFF") {
    return buf.subarray(44);
  }
  return buf;
}

/** Try to load the sibling recruiter-channel WAV alongside a candidate WAV. */
async function tryLoadAgentSibling(candidateUrl: string): Promise<Buffer | null> {
  if (!candidateUrl.startsWith("file://")) return null;
  const candidatePath = fileURLToPath(candidateUrl);
  const recruiterPath = candidatePath.replace(/-candidate\.wav$/, "-recruiter.wav");
  if (recruiterPath === candidatePath) return null;
  try {
    const pcm = await readFile(recruiterPath);
    return pcm.length > 44 && pcm.slice(0, 4).toString() === "RIFF" ? pcm.subarray(44) : pcm;
  } catch {
    return null;
  }
}

// ---------- Feature extraction ----------

function* windowize(pcm: Buffer): Iterable<{ tsStartMs: number; samples: Int16Array }> {
  const totalSamples = Math.floor(pcm.length / 2);
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, totalSamples);
  for (let i = 0; i + SAMPLES_PER_WINDOW <= totalSamples; i += SAMPLES_PER_WINDOW) {
    yield {
      tsStartMs: Math.round((i / SAMPLE_RATE) * 1000),
      samples: view.subarray(i, i + SAMPLES_PER_WINDOW),
    };
  }
}

function rms(samples: Int16Array): number {
  let sq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768; // normalize to [-1, 1]
    sq += v * v;
  }
  return Math.sqrt(sq / samples.length);
}

function zeroCrossingRate(samples: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings++;
  }
  return crossings / samples.length;
}

/**
 * Crude pitch proxy via autocorrelation peak in the typical human voice
 * band (80–400 Hz). Accurate enough for arousal derivation; a real F0
 * tracker (YIN, SWIPE) is the Phase 3 upgrade path.
 */
function roughPitchHz(samples: Int16Array): number | null {
  const minLag = Math.floor(SAMPLE_RATE / 400); // 40
  const maxLag = Math.floor(SAMPLE_RATE / 80); // 200
  let bestLag = 0;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      corr += (samples[i] / 32768) * (samples[i + lag] / 32768);
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestCorr < 0.25 || bestLag === 0) return null; // likely unvoiced
  return SAMPLE_RATE / bestLag;
}

function extractFeatures(samples: Int16Array, tsStartMs: number): WindowFeatures {
  return {
    tsStartMs,
    tsEndMs: tsStartMs + WINDOW_MS,
    rmsEnergy: rms(samples),
    zcr: zeroCrossingRate(samples),
    f0Mean: roughPitchHz(samples),
  };
}

// ---------- Analyzers ----------

/**
 * Heuristic analyzer. Not a substitute for a real emotion model — it exists
 * so the pipeline has something to write when HUME_API_KEY isn't set, and so
 * the frontend integration is testable end-to-end.
 *
 * Rough mappings, calibrated against typical mic-level speech:
 *   arousal ∝ RMS energy + pitch deviation from neutral
 *   valence ∝ inverse of ZCR (high ZCR = harsh/fricative = often negative)
 *             tempered by pitch range (moderate pitch = positive)
 */
class HeuristicAnalyzer implements Analyzer {
  readonly name = "heuristic-v1";
  private neutralF0 = 150; // rough voice center
  score(f: WindowFeatures): WindowSentiment {
    const arousalFromEnergy = Math.min(1, f.rmsEnergy / 0.1); // 0.1 ≈ conversational
    const pitchDelta = f.f0Mean != null ? Math.abs(f.f0Mean - this.neutralF0) / 150 : 0;
    const arousal = Math.max(0, Math.min(1, 0.6 * arousalFromEnergy + 0.4 * pitchDelta));

    // ZCR in [0, 0.3] typically; treat high ZCR as mildly negative.
    const valenceFromZcr = 1 - Math.min(1, f.zcr / 0.2) * 2; // → [-1, 1]
    // Pitch in a comfortable band is slightly positive; extremes negative.
    const pitchValence =
      f.f0Mean == null
        ? 0
        : f.f0Mean >= 100 && f.f0Mean <= 250
        ? 0.3
        : -0.3;
    const valence = Math.max(-1, Math.min(1, 0.5 * valenceFromZcr + 0.5 * pitchValence));
    return { valence, arousal };
  }
}

/**
 * Hume AI Expression Measurement. Placeholder stub — enabled only when
 * HUME_API_KEY is set. The real integration batches audio windows to
 * Hume's WebSocket API; keeping the shape identical to HeuristicAnalyzer
 * so the worker never branches on provider at the call site.
 *
 * Implementation note: we intentionally do not ship a real Hume client yet
 * (requires buying into their SDK and a streaming WebSocket). This is the
 * integration seam described in PR3's plan; the spike-before-adopt
 * decision gate still applies.
 */
class HumeAnalyzer implements Analyzer {
  readonly name = "hume-pending";
  constructor(_apiKey: string) {
    // reserved — will open a Hume streaming session here.
  }
  score(f: WindowFeatures): WindowSentiment {
    // Until the real client is wired, degrade to the heuristic so the
    // rest of the pipeline stays exercised.
    return new HeuristicAnalyzer().score(f);
  }
}

function pickAnalyzer(job: AcousticSentimentJob): Analyzer {
  const humeKey = process.env.HUME_API_KEY;
  if (job.provider === "heuristic") return new HeuristicAnalyzer();
  if (humeKey) return new HumeAnalyzer(humeKey);
  return new HeuristicAnalyzer();
}

// ---------- Job entry point ----------

export async function processAcousticSentimentJob(
  job: AcousticSentimentJob,
  log: Logger,
): Promise<{ windowCount: number }> {
  const [call] = await db
    .select({ id: callSessions.id })
    .from(callSessions)
    .where(eq(callSessions.id, job.callId));
  if (!call) {
    log.warn({ callId: job.callId }, "acoustic job for unknown call — dropping");
    return { windowCount: 0 };
  }

  const candidatePcm = await loadPcm(job.recordingUrl);
  const recruiterPcm = await tryLoadAgentSibling(job.recordingUrl);
  const analyzer = pickAnalyzer(job);

  // Wipe any prior rows for this call so a recompute overwrites cleanly.
  await db.delete(transcriptAcousticWindows).where(eq(transcriptAcousticWindows.callId, job.callId));

  const rows: Array<typeof transcriptAcousticWindows.$inferInsert> = [];
  for (const pair of [
    { pcm: candidatePcm, speaker: "candidate" as const },
    ...(recruiterPcm ? [{ pcm: recruiterPcm, speaker: "recruiter" as const }] : []),
  ]) {
    for (const { tsStartMs, samples } of windowize(pair.pcm)) {
      const features = extractFeatures(samples, tsStartMs);
      if (features.rmsEnergy < SILENCE_RMS) continue; // skip silence
      const { valence, arousal } = analyzer.score(features);
      rows.push({
        callId: job.callId,
        speaker: pair.speaker,
        tsStartMs: features.tsStartMs,
        tsEndMs: features.tsEndMs,
        valence,
        arousal,
        f0Mean: features.f0Mean,
        rmsEnergy: features.rmsEnergy,
        modelVersion: analyzer.name,
      });
    }
  }

  if (rows.length === 0) {
    log.info({ callId: job.callId }, "acoustic analysis produced no non-silent windows");
    return { windowCount: 0 };
  }

  // Chunked insert to avoid oversized single statements on long calls.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(transcriptAcousticWindows).values(rows.slice(i, i + BATCH));
  }
  log.info(
    { callId: job.callId, windowCount: rows.length, analyzer: analyzer.name },
    "acoustic sentiment complete",
  );
  return { windowCount: rows.length };
}
