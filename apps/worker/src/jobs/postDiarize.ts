// Post-diarize worker.
//
// Takes a finished call's mixed-mono WAV dump, re-runs Deepgram with
// diarize=true, and uses the resulting speaker IDs to flip
// `transcript_turns.speaker` from "unknown" → "recruiter" or "candidate"
// where Deepgram is confident. Manual speaker brackets always take
// precedence — we never override a turn that has a manual label.
//
// In a mixed-mono recording Deepgram can't know which speaker is the
// recruiter and which is the candidate. We assume the speaker who talks
// FIRST is the recruiter (recruiter typically opens with "hi this is X
// from J2W") and label accordingly. Calls where this heuristic fails can
// be cleaned up manually via /api/calls/:id/manual-speaker-bracket.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@deepgram/sdk";
import { and, asc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import {
  callSessions,
  db,
  transcriptSpeakerBrackets,
  transcriptTurns,
} from "@j2w/db";
import type { PostDiarizeJob } from "@j2w/ingest-shared";

interface DiarizeResult {
  scanned: number;
  flipped: number;
  skipped: boolean;
  reason?: string;
}

const CONFIDENCE_THRESHOLD = 0.7;
const ALIGN_WINDOW_MS = 2_000;

function resolveLocalRecording(rawUrl: string): string | null {
  if (rawUrl.startsWith("file://")) return fileURLToPath(rawUrl);
  if (
    rawUrl.startsWith("http://") ||
    rawUrl.startsWith("https://") ||
    rawUrl.startsWith("gs://") ||
    rawUrl.startsWith("s3://")
  ) {
    return null;
  }
  // Relative under DUMP_DIR.
  const dumpDir = path.resolve(process.env.DUMP_DIR ?? "./var/audio-dumps");
  return path.resolve(dumpDir, rawUrl);
}

export async function processPostDiarize(
  data: PostDiarizeJob,
  log: Logger,
): Promise<DiarizeResult> {
  const { callId } = data;
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return { scanned: 0, flipped: 0, skipped: true, reason: "no_deepgram_key" };
  }

  const [call] = await db
    .select({ id: callSessions.id, recordingUrl: callSessions.recordingUrl })
    .from(callSessions)
    .where(eq(callSessions.id, callId))
    .limit(1);
  if (!call) return { scanned: 0, flipped: 0, skipped: true, reason: "no_call" };
  if (!call.recordingUrl) return { scanned: 0, flipped: 0, skipped: true, reason: "no_recording_url" };

  const localPath = resolveLocalRecording(call.recordingUrl);
  if (!localPath) {
    return { scanned: 0, flipped: 0, skipped: true, reason: "remote_recording_not_supported_yet" };
  }

  let buf: Buffer;
  try {
    buf = await readFile(localPath);
  } catch (err) {
    log.warn({ err, callId, localPath }, "post-diarize read failed");
    return { scanned: 0, flipped: 0, skipped: true, reason: "read_failed" };
  }

  // Re-run Deepgram with diarize=true on the WAV.
  const dg = createClient(apiKey);
  let alternatives: Array<{
    words?: Array<{ word: string; start: number; end: number; speaker?: number; confidence?: number }>;
  }>;
  try {
    const { result, error } = await dg.listen.prerecorded.transcribeFile(buf, {
      model: "nova-3",
      language: "multi",
      diarize: true,
      punctuate: true,
      smart_format: true,
    });
    if (error) throw error;
    const channels = result?.results?.channels ?? [];
    alternatives = channels[0]?.alternatives ?? [];
  } catch (err) {
    log.warn({ err, callId }, "post-diarize Deepgram call failed");
    return { scanned: 0, flipped: 0, skipped: true, reason: "deepgram_failed" };
  }

  const words = alternatives[0]?.words ?? [];
  if (words.length === 0) {
    return { scanned: 0, flipped: 0, skipped: true, reason: "no_diarized_words" };
  }

  // Build a per-word speaker timeline (start_ms → speaker_id).
  // Then for each existing transcript turn, find the dominant speaker_id
  // within ±ALIGN_WINDOW_MS of the turn's midpoint.
  type WordPoint = { tsMs: number; speaker: number; confidence: number };
  const timeline: WordPoint[] = words
    .filter((w) => w.speaker !== undefined)
    .map((w) => ({
      tsMs: Math.round(w.start * 1000),
      speaker: w.speaker as number,
      confidence: w.confidence ?? 1,
    }));
  if (timeline.length === 0) {
    return { scanned: 0, flipped: 0, skipped: true, reason: "no_speaker_labels" };
  }

  // Speaker-ID → role: assume the FIRST speaker is the recruiter (recruiter
  // typically opens the call). Other speakers are candidate.
  const firstSpeakerId = timeline[0].speaker;
  function roleFor(speakerId: number): "recruiter" | "candidate" {
    return speakerId === firstSpeakerId ? "recruiter" : "candidate";
  }

  // Pull existing turns + manual brackets for this call.
  const turns = await db
    .select({
      id: transcriptTurns.id,
      speaker: transcriptTurns.speaker,
      tsStartMs: transcriptTurns.tsStartMs,
      tsEndMs: transcriptTurns.tsEndMs,
    })
    .from(transcriptTurns)
    .where(and(eq(transcriptTurns.callId, callId), eq(transcriptTurns.isFinal, true)))
    .orderBy(asc(transcriptTurns.tsStartMs));

  const manuals = await db
    .select({
      tsMs: transcriptSpeakerBrackets.tsMs,
      speaker: transcriptSpeakerBrackets.speaker,
    })
    .from(transcriptSpeakerBrackets)
    .where(eq(transcriptSpeakerBrackets.callId, callId));

  function manualSpeakerAt(tsMs: number): "recruiter" | "candidate" | null {
    // Pick the latest manual bracket at or before tsMs.
    let best: { tsMs: number; speaker: "recruiter" | "candidate" } | null = null;
    for (const m of manuals) {
      if (m.tsMs <= tsMs && (!best || m.tsMs > best.tsMs)) {
        best = { tsMs: m.tsMs, speaker: m.speaker };
      }
    }
    return best?.speaker ?? null;
  }

  let flipped = 0;
  for (const t of turns) {
    if (t.speaker !== "unknown") continue; // only flip unknowns

    // Manual brackets win.
    const midMs = Math.floor((t.tsStartMs + t.tsEndMs) / 2);
    const manual = manualSpeakerAt(midMs);
    if (manual) {
      try {
        await db
          .update(transcriptTurns)
          .set({ speaker: manual })
          .where(eq(transcriptTurns.id, t.id));
        flipped += 1;
      } catch (err) {
        log.warn({ err, turnId: t.id }, "manual flip failed");
      }
      continue;
    }

    // Otherwise vote among Deepgram's diarized words within ±ALIGN_WINDOW_MS
    // of the turn's midpoint.
    const lo = midMs - ALIGN_WINDOW_MS;
    const hi = midMs + ALIGN_WINDOW_MS;
    const inWindow = timeline.filter((w) => w.tsMs >= lo && w.tsMs <= hi);
    if (inWindow.length === 0) continue;
    const tally = new Map<number, { count: number; confidenceSum: number }>();
    for (const w of inWindow) {
      const cur = tally.get(w.speaker) ?? { count: 0, confidenceSum: 0 };
      cur.count += 1;
      cur.confidenceSum += w.confidence;
      tally.set(w.speaker, cur);
    }
    let best: { speaker: number; count: number; meanConf: number } | null = null;
    for (const [speaker, v] of tally) {
      const meanConf = v.confidenceSum / v.count;
      if (!best || v.count > best.count) best = { speaker, count: v.count, meanConf };
    }
    if (!best) continue;
    if (best.meanConf < CONFIDENCE_THRESHOLD) continue;
    const role = roleFor(best.speaker);
    try {
      await db
        .update(transcriptTurns)
        .set({ speaker: role })
        .where(eq(transcriptTurns.id, t.id));
      flipped += 1;
    } catch (err) {
      log.warn({ err, turnId: t.id }, "diarize flip failed");
    }
  }

  log.info(
    { callId, scanned: turns.length, flipped, manualBrackets: manuals.length },
    "post-diarize complete",
  );
  return { scanned: turns.length, flipped, skipped: false };
}
