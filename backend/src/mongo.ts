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

// Named collection accessors for the live feature (one per former table).
export const collections = {
  users: () => col("users"),
  organizations: () => col("organizations"),
  memberships: () => col("memberships"),
  rolePermissions: () => col("role_permissions"),
  refreshTokens: () => col("refresh_tokens"),
  callSessions: () => col("call_sessions"),
  transcriptTurns: () => col("transcript_turns"),
  suggestions: () => col("suggestions"),
  candidates: () => col("candidates"),
  candidateSkills: () => col("candidate_skills"),
  demands: () => col("demands"),
  demandSkills: () => col("demand_skills"),
  demandAssignments: () => col("demand_assignments"),
  prospects: () => col("prospects"),
  clients: () => col("clients"),
  questionBanks: () => col("question_banks"),
  questionBankQuestions: () => col("question_bank_questions"),
  questionBankDemandLinks: () => col("question_bank_demand_links"),
  aiUsageEvents: () => col("ai_usage_events"),
  skills: () => col("skills"),
  tenantIntegrations: () => col("tenant_integrations"),
};

// Create the indexes the feature relies on. Idempotent.
export async function ensureIndexes(): Promise<void> {
  await collections.users().createIndex({ id: 1 }, { unique: true });
  await collections.users().createIndex({ emailNormalized: 1 });
  await collections.organizations().createIndex({ id: 1 }, { unique: true });
  await collections.memberships().createIndex({ userId: 1, orgId: 1 });
  await collections.rolePermissions().createIndex({ orgId: 1, role: 1 });
  await collections.refreshTokens().createIndex({ tokenHash: 1 });
  await collections.callSessions().createIndex({ id: 1 }, { unique: true });
  await collections.callSessions().createIndex({ orgId: 1 });
  await collections.transcriptTurns().createIndex({ callId: 1 });
  await collections.candidates().createIndex({ id: 1 }, { unique: true });
  await collections.candidates().createIndex({ orgId: 1 });
  await collections.demands().createIndex({ id: 1 }, { unique: true });
  await collections.demands().createIndex({ orgId: 1 });
  await collections.questionBanks().createIndex({ orgId: 1 });
  await collections.questionBankQuestions().createIndex({ bankId: 1 });
  await collections.questionBankDemandLinks().createIndex({ demandId: 1 });
  await collections.questionBankDemandLinks().createIndex({ bankId: 1, demandId: 1 }, { unique: true });
  await collections.aiUsageEvents().createIndex({ orgId: 1, createdAt: -1 });
  await collections.prospects().createIndex({ orgId: 1, demandId: 1 });
}
