import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";

// BullMQ requires maxRetriesPerRequest:null on the IORedis connection.
// The same Redis connection is shared across the Queue (producer) and Worker
// (consumer) instances via the `connection` option.

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return url;
}

export function makeRedis(): IORedis {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null });
}

export const INGEST_QUEUE = "kb-ingest";
export const ACOUSTIC_SENTIMENT_QUEUE = "acoustic-sentiment";
// Offer Letter MySQL sync queues. Demand sync runs every 5 min; funnel poll
// runs every 2 min. Both keyed per-org so multi-tenant deployments fan out.
export const OFFER_LETTER_DEMAND_SYNC_QUEUE = "offer-letter-demand-sync";
export const OFFER_LETTER_FUNNEL_POLL_QUEUE = "offer-letter-funnel-poll";
// Recording lifecycle: prune WAVs older than RECORDING_RETENTION_DAYS.
export const RECORDING_PRUNE_QUEUE = "recording-prune";
// Post-call worker chain. Each step depends on the prior step's output.
// Enqueued sequentially via in-job chaining on success.
export const POST_DIARIZE_QUEUE = "post-diarize";
export const CALL_SUMMARY_QUEUE = "call-summary";
export const RUBRIC_FINALIZE_QUEUE = "rubric-finalize";
// Post-call structured extraction. Reads the call_sessions.summary JSON
// (produced by call_summary) and applies it to the linked prospect row.
export const PROSPECT_OUTCOME_EXTRACT_QUEUE = "prospect-outcome-extract";
// LLM-extracts technical Q&A spans from the transcript, stored on the
// new call_technical_qa table.
export const TECHNICAL_QA_EXTRACT_QUEUE = "technical-qa-extract";
// Resume parser — pulls structured candidate signals out of an uploaded
// CV blob and writes back to the candidates row.
export const RESUME_PARSE_QUEUE = "resume-parse";
// JD-vs-candidate match — runs the JD-match engine to populate
// jd_match_runs for the candidate-against-demand combinations.
export const JD_MATCH_UPDATE_QUEUE = "jd-match-update";

export interface IngestJob {
  documentId: string;
  sourceId: string;
  mime: string;
  filename: string;
  storageKey: string;
  userEmail: string;
}

export interface AcousticSentimentJob {
  callId: string;
  // URL to the recording. Supported: file://, https://, s3://. The worker
  // picks the right loader. Prod deployments persist to S3; dev usually
  // writes a file:// path to a dumped WAV.
  recordingUrl: string;
  recordingMime?: string;
  // Optional provider hint — defaults to "hume" when HUME_API_KEY is set,
  // otherwise falls back to an energy-based heuristic.
  provider?: "hume" | "heuristic";
}

export interface OfferLetterDemandSyncJob {
  // Single-org sync at this scale; pass orgId explicitly so multi-tenant
  // adds don't change the job shape.
  orgId: string;
}

export interface OfferLetterFunnelPollJob {
  orgId: string;
}

export interface RecordingPruneJob {
  // Sweep all calls older than retentionDays whose recording still exists.
  // No payload — the worker reads RECORDING_RETENTION_DAYS from env.
  triggeredAt: string;
}

export interface PostDiarizeJob {
  callId: string;
}

export interface CallSummaryJob {
  callId: string;
}

export interface RubricFinalizeJob {
  callId: string;
}

export interface ProspectOutcomeExtractJob {
  callId: string;
}

export interface TechnicalQaExtractJob {
  callId: string;
}

export interface ResumeParseJob {
  candidateId: string;
  storageKey: string;
  mime: string;
  filename: string;
}

export interface JdMatchUpdateJob {
  // Both forms are useful:
  //   { candidateId, demandId } — score one pair (e.g. on prospect create)
  //   { candidateId } — score the candidate against every open demand
  //   { demandId }    — score every recently-active candidate against the demand
  candidateId?: string;
  demandId?: string;
}

let _queue: Queue<IngestJob> | null = null;
export function getIngestQueue(): Queue<IngestJob> {
  if (!_queue) {
    _queue = new Queue<IngestJob>(INGEST_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _queue;
}

let _acousticQueue: Queue<AcousticSentimentJob> | null = null;
export function getAcousticSentimentQueue(): Queue<AcousticSentimentJob> {
  if (!_acousticQueue) {
    _acousticQueue = new Queue<AcousticSentimentJob>(ACOUSTIC_SENTIMENT_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _acousticQueue;
}

let _events: QueueEvents | null = null;
export function getQueueEvents(): QueueEvents {
  if (!_events) {
    _events = new QueueEvents(INGEST_QUEUE, { connection: makeRedis() });
  }
  return _events;
}

let _demandSyncQueue: Queue<OfferLetterDemandSyncJob> | null = null;
export function getOfferLetterDemandSyncQueue(): Queue<OfferLetterDemandSyncJob> {
  if (!_demandSyncQueue) {
    _demandSyncQueue = new Queue<OfferLetterDemandSyncJob>(
      OFFER_LETTER_DEMAND_SYNC_QUEUE,
      {
        connection: makeRedis(),
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      },
    );
  }
  return _demandSyncQueue;
}

let _funnelPollQueue: Queue<OfferLetterFunnelPollJob> | null = null;
export function getOfferLetterFunnelPollQueue(): Queue<OfferLetterFunnelPollJob> {
  if (!_funnelPollQueue) {
    _funnelPollQueue = new Queue<OfferLetterFunnelPollJob>(
      OFFER_LETTER_FUNNEL_POLL_QUEUE,
      {
        connection: makeRedis(),
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 15_000 },
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      },
    );
  }
  return _funnelPollQueue;
}

let _recordingPruneQueue: Queue<RecordingPruneJob> | null = null;
export function getRecordingPruneQueue(): Queue<RecordingPruneJob> {
  if (!_recordingPruneQueue) {
    _recordingPruneQueue = new Queue<RecordingPruneJob>(RECORDING_PRUNE_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 30 },
        removeOnFail: { count: 30 },
      },
    });
  }
  return _recordingPruneQueue;
}

let _postDiarizeQueue: Queue<PostDiarizeJob> | null = null;
export function getPostDiarizeQueue(): Queue<PostDiarizeJob> {
  if (!_postDiarizeQueue) {
    _postDiarizeQueue = new Queue<PostDiarizeJob>(POST_DIARIZE_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _postDiarizeQueue;
}

let _callSummaryQueue: Queue<CallSummaryJob> | null = null;
export function getCallSummaryQueue(): Queue<CallSummaryJob> {
  if (!_callSummaryQueue) {
    _callSummaryQueue = new Queue<CallSummaryJob>(CALL_SUMMARY_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _callSummaryQueue;
}

let _rubricFinalizeQueue: Queue<RubricFinalizeJob> | null = null;
export function getRubricFinalizeQueue(): Queue<RubricFinalizeJob> {
  if (!_rubricFinalizeQueue) {
    _rubricFinalizeQueue = new Queue<RubricFinalizeJob>(RUBRIC_FINALIZE_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _rubricFinalizeQueue;
}

let _prospectOutcomeQueue: Queue<ProspectOutcomeExtractJob> | null = null;
export function getProspectOutcomeExtractQueue(): Queue<ProspectOutcomeExtractJob> {
  if (!_prospectOutcomeQueue) {
    _prospectOutcomeQueue = new Queue<ProspectOutcomeExtractJob>(
      PROSPECT_OUTCOME_EXTRACT_QUEUE,
      {
        connection: makeRedis(),
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        },
      },
    );
  }
  return _prospectOutcomeQueue;
}

let _technicalQaQueue: Queue<TechnicalQaExtractJob> | null = null;
export function getTechnicalQaExtractQueue(): Queue<TechnicalQaExtractJob> {
  if (!_technicalQaQueue) {
    _technicalQaQueue = new Queue<TechnicalQaExtractJob>(
      TECHNICAL_QA_EXTRACT_QUEUE,
      {
        connection: makeRedis(),
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 200 },
        },
      },
    );
  }
  return _technicalQaQueue;
}

let _resumeParseQueue: Queue<ResumeParseJob> | null = null;
export function getResumeParseQueue(): Queue<ResumeParseJob> {
  if (!_resumeParseQueue) {
    _resumeParseQueue = new Queue<ResumeParseJob>(RESUME_PARSE_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return _resumeParseQueue;
}

let _jdMatchUpdateQueue: Queue<JdMatchUpdateJob> | null = null;
export function getJdMatchUpdateQueue(): Queue<JdMatchUpdateJob> {
  if (!_jdMatchUpdateQueue) {
    _jdMatchUpdateQueue = new Queue<JdMatchUpdateJob>(JD_MATCH_UPDATE_QUEUE, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _jdMatchUpdateQueue;
}
