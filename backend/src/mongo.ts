// MongoDB data layer — replaces the old Postgres/Drizzle (`@j2w/db`) stack.
//
// Each former SQL table is a Mongo collection. Documents use a string `id`
// field (UUID) as the logical primary key (Mongo's own `_id` is ignored), so
// application code keeps using `row.id` exactly as before. All access goes
// through `col(name)` or the typed `collections` accessors below.
import { MongoClient, type Db, type Collection, type Document } from "mongodb";
import { env } from "./env.js";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(env.MONGO_URL);
  await _client.connect();
  _db = _client.db(env.MONGO_DB);
  return _db;
}

export function mongo(): Db {
  if (!_db) throw new Error("Mongo not connected — call connectMongo() at startup");
  return _db;
}

export function col<T extends Document = Document>(name: string): Collection<T> {
  return mongo().collection<T>(name);
}

export async function closeMongo(): Promise<void> {
  await _client?.close();
  _client = null;
  _db = null;
}

// Strip Mongo's internal `_id` from a returned document (we use `id`).
export function clean<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (!doc) return doc;
  const { _id, ...rest } = doc as Record<string, unknown>;
  void _id;
  return rest as T;
}
export function cleanMany<T extends Record<string, unknown>>(docs: T[]): T[] {
  return docs.map((d) => clean(d) as T);
}

// Collection accessors. Two groups only:
//
//   • `ol*`        — OfferLetter-owned (READ-ONLY). We touch these to honour
//                    the shared session + pull live jobs scoped to the
//                    logged-in recruiter.
//   • `interviews` — the ONE collection this service writes. Every piece of
//                    state for an interview lives inline on the document:
//                    who-spoke-to-whom, the demand snapshot, the transcript
//                    array, and the final AI summary. No side tables.
//
// Legacy accessors (transcriptTurns / suggestions / evaluations /
// aiUsageEvents / callSessions and the old multi-tenant set) are gone. If a
// piece of code still references them it needs to be ported to read/write
// the inline fields on `interviews`.
export const collections = {
  // ── OL-owned (read-only from this service) ──────────────────────────
  olUsers:              () => col("users"),
  olSessions:           () => col("sessions"),
  olJobPostings:        () => col("jobPostings"),
  olJobAssignMappings:  () => col("jobAssignMappings"),
  olClients:            () => col("clients"),
  // Candidate-side OL data — used to source existing candidates + their
  // résumés when the recruiter searches the OfferLetter pool.
  olCandidateProfiles:  () => col("candidateProfiles"),
  olCandidateDocuments: () => col("candidateDocuments"),
  // Human-refined demand calibration (one doc per (jobPostingId, version)).
  olDemandCalibrations: () => col("demand_calibration"),

  // ── Interview-Assist owned (writeable) ──────────────────────────────
  interviews:           () => col("ia_interviews"),
  // Cached, versioned, skill-wise question bank per demand (OL jobPosting id).
  // Keyed by `demandId` so it's generated once per JD and reused across calls.
  questionBanks:        () => col("ia_question_banks"),
  // Raw FreJun webhook deliveries, kept ONLY for idempotency + replay/debug.
  // Telephony providers retry aggressively and deliver out of order, so every
  // handler dedupes against this before mutating an interview.
  frejunEvents:         () => col("ia_frejun_events"),
};

// Indexes for the IA collections — idempotent.
// Lookups against OL collections rely on the indexes OL already creates.
export async function ensureIndexes(): Promise<void> {
  await collections.interviews().createIndex({ id: 1 }, { unique: true });
  await collections.interviews().createIndex({ recruiterUid: 1, startedAt: -1 });
  await collections.questionBanks().createIndex({ demandId: 1 }, { unique: true });
  // FreJun telephony. Sparse because every pre-telephony interview lacks the
  // field; partial-unique so two calls can never bind to one FreJun call.
  await collections.interviews().createIndex(
    { "telephony.frejunCallId": 1 },
    { unique: true, partialFilterExpression: { "telephony.frejunCallId": { $type: "string" } } },
  );
  await collections.frejunEvents().createIndex({ dedupeKey: 1 }, { unique: true });
  // Per-recruiter FreJun OAuth grants + the short-lived pending-grant rows the
  // callback matches on (FreJun does not echo `state`, so this is what ties a
  // redirect back to the recruiter who started it).
  await col("ia_frejun_tokens").createIndex({ olUid: 1 }, { unique: true });
  await col("ia_frejun_oauth_pending").createIndex({ email: 1 }, { unique: true });
  await col("ia_frejun_oauth_pending").createIndex({ createdAt: 1 }, { expireAfterSeconds: 900 });
  // Webhook payloads are debug material, not a system of record — expire them.
  await collections.frejunEvents().createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
}
