// Recording-prune worker. Deletes WAV files older than
// RECORDING_RETENTION_DAYS from the local DUMP_DIR volume and clears the
// recording_url column on the corresponding call_sessions rows.
//
// Runs daily at 03:00 IST as a BullMQ repeating job. Manual invocation is
// also supported (the queue accepts ad-hoc adds).
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull, lt, not, like, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { callSessions, db } from "@j2w/db";
import type { RecordingPruneJob } from "@j2w/ingest-shared";

interface PruneResult {
  scanned: number;
  deletedFiles: number;
  rowsCleared: number;
  errors: number;
}

export async function processRecordingPrune(
  _job: RecordingPruneJob,
  log: Logger,
): Promise<PruneResult> {
  const days = Number(process.env.RECORDING_RETENTION_DAYS ?? 90);
  const dumpDir = path.resolve(process.env.DUMP_DIR ?? "./var/audio-dumps");

  // Cutoff: started_at before now() - retention. Use Postgres-side date math
  // so the truth-value matches the DB's clock, not the worker's.
  const cutoffSql = sql`now() - (${days} || ' days')::interval`;

  const candidates = await db
    .select({
      id: callSessions.id,
      recordingUrl: callSessions.recordingUrl,
      startedAt: callSessions.startedAt,
    })
    .from(callSessions)
    .where(
      and(
        isNotNull(callSessions.recordingUrl),
        lt(callSessions.startedAt, cutoffSql),
        // Skip rows whose URL is a remote scheme — we don't manage retention
        // for those here (future GCS lifecycle policy handles them).
        not(like(callSessions.recordingUrl, "gs://%")),
        not(like(callSessions.recordingUrl, "s3://%")),
        not(like(callSessions.recordingUrl, "http://%")),
        not(like(callSessions.recordingUrl, "https://%")),
      ),
    )
    .limit(500);

  let deletedFiles = 0;
  let rowsCleared = 0;
  let errors = 0;

  for (const row of candidates) {
    const rel = (row.recordingUrl ?? "").replace(/^file:\/\//, "");
    const abs = path.resolve(dumpDir, rel);
    if (!abs.startsWith(dumpDir + path.sep) && abs !== dumpDir) {
      log.warn({ callId: row.id, abs, dumpDir }, "skip prune: path escapes DUMP_DIR");
      errors += 1;
      continue;
    }
    try {
      const s = await stat(abs);
      if (s.isFile()) {
        await unlink(abs);
        deletedFiles += 1;
      }
    } catch (err) {
      // File missing already — proceed to clear the column anyway.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn({ callId: row.id, err }, "unlink failed");
        errors += 1;
        continue;
      }
    }
    try {
      await db
        .update(callSessions)
        .set({ recordingUrl: null })
        .where(eq(callSessions.id, row.id));
      rowsCleared += 1;
    } catch (err) {
      log.warn({ callId: row.id, err }, "clear recording_url failed");
      errors += 1;
    }
  }

  log.info(
    { scanned: candidates.length, deletedFiles, rowsCleared, errors, retentionDays: days },
    "recording prune complete",
  );
  return { scanned: candidates.length, deletedFiles, rowsCleared, errors };
}
