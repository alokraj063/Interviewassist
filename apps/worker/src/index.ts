import { eq } from "drizzle-orm";
import { Worker } from "bullmq";
import pino from "pino";
import { db, documents } from "@j2w/db";
import { isOfferLetterConfigured } from "@j2w/offer-letter-db";
import {
  getOfferLetterDemandSyncQueue,
  getOfferLetterFunnelPollQueue,
  getPostDiarizeQueue,
  getRecordingPruneQueue,
  getRubricFinalizeQueue,
  publishIngestEvent,
} from "@j2w/ingest-shared";
import { env } from "./env.js";
import { processIngestJob } from "./ingest.js";
import { processAcousticSentimentJob } from "./jobs/acousticSentiment.js";
import { processCallSummary } from "./jobs/callSummary.js";
import { processProspectOutcomeExtract } from "./jobs/prospectOutcomeExtract.js";
import { processResumeParse } from "./jobs/resumeParse.js";
import { processTechnicalQaExtract } from "./jobs/technicalQaExtract.js";
import {
  listOrgsWithRecruiters,
  processDemandSync,
} from "./jobs/offerLetterDemandSync.js";
import { processFunnelPoll } from "./jobs/offerLetterFunnelPoll.js";
import { processPostDiarize } from "./jobs/postDiarize.js";
import { processRecordingPrune } from "./jobs/recordingPrune.js";
import { processRubricFinalize } from "./jobs/rubricFinalize.js";
import {
  ACOUSTIC_SENTIMENT_QUEUE,
  CALL_SUMMARY_QUEUE,
  INGEST_QUEUE,
  OFFER_LETTER_DEMAND_SYNC_QUEUE,
  OFFER_LETTER_FUNNEL_POLL_QUEUE,
  POST_DIARIZE_QUEUE,
  PROSPECT_OUTCOME_EXTRACT_QUEUE,
  RECORDING_PRUNE_QUEUE,
  RESUME_PARSE_QUEUE,
  RUBRIC_FINALIZE_QUEUE,
  TECHNICAL_QA_EXTRACT_QUEUE,
  makeRedis,
  type AcousticSentimentJob,
  type CallSummaryJob,
  type IngestJob,
  type OfferLetterDemandSyncJob,
  type OfferLetterFunnelPollJob,
  type PostDiarizeJob,
  type ProspectOutcomeExtractJob,
  type RecordingPruneJob,
  type ResumeParseJob,
  type RubricFinalizeJob,
  type TechnicalQaExtractJob,
} from "@j2w/ingest-shared";

const log = pino({
  level: env.NODE_ENV === "development" ? "debug" : "info",
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, singleLine: true } }
      : undefined,
});

const worker = new Worker<IngestJob, { chunkCount: number }>(
  INGEST_QUEUE,
  async (job) => {
    const t0 = Date.now();
    try {
      const result = await processIngestJob(job.data);
      log.info(
        { jobId: job.id, documentId: job.data.documentId, chunkCount: result.chunkCount, ms: Date.now() - t0 },
        "ingest complete",
      );
      return result;
    } catch (err) {
      log.error({ jobId: job.id, err }, "ingest failed");
      throw err;
    }
  },
  {
    connection: makeRedis(),
    // Concurrency cap from the plan — respects embedding API rate limits.
    concurrency: 4,
  },
);

worker.on("failed", async (job, err) => {
  log.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed");
  const maxAttempts = job?.opts.attempts ?? 1;
  if (!job || (job.attemptsMade ?? 0) < maxAttempts) return;
  // Final attempt — mark the document in the DB so the UI can show the error.
  const { documentId, sourceId } = job.data;
  try {
    await db
      .update(documents)
      .set({ status: "error", errorMessage: truncate(err.message, 500) })
      .where(eq(documents.id, documentId));
    await publishIngestEvent({
      sourceId,
      documentId,
      kind: "document.error",
      message: err.message,
      at: new Date().toISOString(),
    });
  } catch (updateErr) {
    log.error({ documentId, updateErr }, "failed to mark document as error");
  }
});

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Phase 2 acoustic-sentiment worker. Runs alongside the KB-ingest worker
// in the same process (different queue → different Worker). Concurrency 2
// because the heuristic path is CPU-bound; raise when swapping to Hume.
const acousticWorker = new Worker<AcousticSentimentJob, { windowCount: number }>(
  ACOUSTIC_SENTIMENT_QUEUE,
  async (job) => {
    const t0 = Date.now();
    try {
      const result = await processAcousticSentimentJob(job.data, log);
      log.info(
        {
          jobId: job.id,
          callId: job.data.callId,
          windowCount: result.windowCount,
          ms: Date.now() - t0,
        },
        "acoustic job complete",
      );
      return result;
    } catch (err) {
      log.error({ jobId: job.id, callId: job.data.callId, err }, "acoustic job failed");
      throw err;
    }
  },
  {
    connection: makeRedis(),
    concurrency: 2,
  },
);

acousticWorker.on("failed", (job, err) => {
  log.error(
    { jobId: job?.id, callId: job?.data?.callId, attempts: job?.attemptsMade, err: err.message },
    "acoustic job failed (final)",
  );
});

// ---------- Offer Letter MySQL sync workers ----------
const offerLetterReady = isOfferLetterConfigured();

const demandSyncWorker = new Worker<OfferLetterDemandSyncJob>(
  OFFER_LETTER_DEMAND_SYNC_QUEUE,
  async (job) => {
    if (!offerLetterReady) {
      log.warn({ jobId: job.id }, "offer-letter not configured; demand sync skipped");
      return { skipped: true };
    }
    return processDemandSync(job.data, log);
  },
  { connection: makeRedis(), concurrency: 1 },
);

demandSyncWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "demand sync failed");
});

const funnelPollWorker = new Worker<OfferLetterFunnelPollJob>(
  OFFER_LETTER_FUNNEL_POLL_QUEUE,
  async (job) => {
    if (!offerLetterReady) {
      log.warn({ jobId: job.id }, "offer-letter not configured; funnel poll skipped");
      return { skipped: true };
    }
    return processFunnelPoll(job.data, log);
  },
  { connection: makeRedis(), concurrency: 1 },
);

funnelPollWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "funnel poll failed");
});

// Post-diarize worker — runs on call end. Re-runs Deepgram with diarize=true
// over the WAV, flips transcript_turns.speaker for high-confidence labels.
const postDiarizeWorker = new Worker<PostDiarizeJob>(
  POST_DIARIZE_QUEUE,
  async (job) => {
    const result = await processPostDiarize(job.data, log);
    // Chain: rubric finalize after diarization. The rubric scorer reads the
    // (now speaker-labeled) transcript and benefits from clean turn labels.
    if (!result.skipped) {
      await getRubricFinalizeQueue().add(
        `rubric-finalize-${job.data.callId}`,
        { callId: job.data.callId },
        { jobId: `rubric-finalize-${job.data.callId}` },
      );
    }
    return result;
  },
  { connection: makeRedis(), concurrency: 2 },
);
postDiarizeWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "post-diarize failed");
});

// Rubric-finalize worker — scores rubric criteria via LLM and seeds a
// pending QA review row.
const rubricFinalizeWorker = new Worker<RubricFinalizeJob>(
  RUBRIC_FINALIZE_QUEUE,
  async (job) => processRubricFinalize(job.data, log),
  { connection: makeRedis(), concurrency: 2 },
);
rubricFinalizeWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "rubric-finalize failed");
});

// Call-summary worker — produces the recruiter wrap-up JSON consumed by
// the Call Detail Summary tab. Independent of the diarize/rubric chain;
// the API enqueues both on call end. Chains prospect_outcome_extract
// from inside the handler on success.
const callSummaryWorker = new Worker<CallSummaryJob>(
  CALL_SUMMARY_QUEUE,
  async (job) => processCallSummary(job.data, log),
  { connection: makeRedis(), concurrency: 2 },
);
callSummaryWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "call-summary failed");
});

// Prospect-outcome-extract worker — chained from call_summary. Maps the
// structured discoveryFacts onto the linked prospect row. Cheap (no LLM
// call), retries are safe (idempotent overwrite).
const prospectOutcomeWorker = new Worker<ProspectOutcomeExtractJob>(
  PROSPECT_OUTCOME_EXTRACT_QUEUE,
  async (job) => processProspectOutcomeExtract(job.data, log),
  { connection: makeRedis(), concurrency: 4 },
);
prospectOutcomeWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "prospect-outcome-extract failed");
});

// Technical-QA-extract worker — LLM extraction of question/answer spans.
// Independent of the prospect chain; the API enqueues alongside summary.
const technicalQaWorker = new Worker<TechnicalQaExtractJob>(
  TECHNICAL_QA_EXTRACT_QUEUE,
  async (job) => processTechnicalQaExtract(job.data, log),
  { connection: makeRedis(), concurrency: 2 },
);
technicalQaWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "technical-qa-extract failed");
});

// Resume-parse worker — async reparse for an existing candidate's stored
// resume blob. The user-driven upload paths in apps/api parse inline; this
// queue handles model-upgrade reparse, retry-after-failure, and bulk
// reparse from the platform admin UI.
const resumeParseWorker = new Worker<ResumeParseJob>(
  RESUME_PARSE_QUEUE,
  async (job) => processResumeParse(job.data, log),
  { connection: makeRedis(), concurrency: 2 },
);
resumeParseWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "resume-parse failed");
});

// Recording-prune worker. Daily sweep at 03:00 IST.
const recordingPruneWorker = new Worker<RecordingPruneJob>(
  RECORDING_PRUNE_QUEUE,
  async (job) => processRecordingPrune(job.data, log),
  { connection: makeRedis(), concurrency: 1 },
);
recordingPruneWorker.on("failed", (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, "recording prune failed");
});

async function scheduleRecordingPrune(): Promise<void> {
  const queue = getRecordingPruneQueue();
  // 03:00 IST is 21:30 UTC. Use a cron expression so we get exactly one
  // run per day regardless of how many worker replicas exist (BullMQ dedupes
  // repeats on key).
  await queue.add(
    "recording-prune",
    { triggeredAt: new Date().toISOString() },
    { repeat: { pattern: "30 21 * * *", key: "recording-prune-daily" } },
  );
}

void scheduleRecordingPrune().catch((err) =>
  log.error({ err }, "failed to schedule recording prune"),
);

// Schedule periodic runs for every org that has at least one active
// recruiter. BullMQ's `repeat.every` adds the job once and lets the queue
// handle the cadence; calling addRepeated multiple times is idempotent
// (BullMQ dedupes on key).
async function scheduleSyncJobs(): Promise<void> {
  if (!offerLetterReady) {
    log.info("offer-letter not configured; skipping periodic sync schedule");
    return;
  }
  const orgs = await listOrgsWithRecruiters();
  if (orgs.length === 0) {
    log.info("no orgs with active recruiters; skipping schedule");
    return;
  }
  const demandQ = getOfferLetterDemandSyncQueue();
  const funnelQ = getOfferLetterFunnelPollQueue();
  // BullMQ repeat-job keys reject ":" — use "-" as the separator.
  for (const orgId of orgs) {
    await demandQ.add(
      `demand-sync-${orgId}`,
      { orgId },
      { repeat: { every: 5 * 60 * 1000, key: `demand-sync-${orgId}` } },
    );
    await funnelQ.add(
      `funnel-poll-${orgId}`,
      { orgId },
      { repeat: { every: 2 * 60 * 1000, key: `funnel-poll-${orgId}` } },
    );
  }
  log.info({ orgCount: orgs.length }, "scheduled offer-letter sync jobs");
}

void scheduleSyncJobs().catch((err) => log.error({ err }, "failed to schedule sync jobs"));

const allWorkers = [
  worker,
  acousticWorker,
  demandSyncWorker,
  funnelPollWorker,
  postDiarizeWorker,
  rubricFinalizeWorker,
  callSummaryWorker,
  prospectOutcomeWorker,
  technicalQaWorker,
  resumeParseWorker,
  recordingPruneWorker,
];

process.on("SIGINT", async () => {
  log.info("shutting down");
  await Promise.all(allWorkers.map((w) => w.close()));
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await Promise.all(allWorkers.map((w) => w.close()));
  process.exit(0);
});

log.info(
  `worker listening on queues "${INGEST_QUEUE}", "${ACOUSTIC_SENTIMENT_QUEUE}", ` +
    `"${OFFER_LETTER_DEMAND_SYNC_QUEUE}", "${OFFER_LETTER_FUNNEL_POLL_QUEUE}", ` +
    `"${POST_DIARIZE_QUEUE}", "${RUBRIC_FINALIZE_QUEUE}", "${CALL_SUMMARY_QUEUE}", ` +
    `"${PROSPECT_OUTCOME_EXTRACT_QUEUE}", "${TECHNICAL_QA_EXTRACT_QUEUE}", ` +
    `"${RESUME_PARSE_QUEUE}", "${RECORDING_PRUNE_QUEUE}" ` +
    `(redis: ${env.REDIS_URL}, offerLetter: ${offerLetterReady ? "configured" : "OFF"})`,
);
