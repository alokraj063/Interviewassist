import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// bytea column — Postgres binary primitive. Used for AES-GCM ciphertext blobs
// in tenant_integrations.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// pgvector column type. Stores numeric arrays; Postgres does the math.
// Dimension is fixed to 1536 to match OpenAI text-embedding-3-small.
export const vector = customType<{ data: number[]; driverData: string; config: { dim: number } }>({
  dataType(config) {
    const dim = config?.dim ?? 1536;
    return `vector(${dim})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns the literal "[1,2,3]" string
    return value
      .slice(1, -1)
      .split(",")
      .map((n) => Number(n));
  },
});

// citext column — Postgres case-insensitive text, used for emails.
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

// inet column — Postgres IP/CIDR primitive.
const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

// RecruitAssist role taxonomy. Replaces the contact-center agent/team_lead/
// manager triple. `client_user` and `proctor` are placeholders for future
// modules (client portal + proctor cockpit). The chain of command is walked
// via memberships.reporting_to_user_id (up to 4 levels).
export const ROLES = [
  "recruiter",
  "delivery_lead",
  "account_manager",
  "business_head",
  "qa_reviewer",
  "admin",
  "client_user",
  "proctor",
] as const;
export type Role = (typeof ROLES)[number];

// ---------- Organizations ----------
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  subdomain: text("subdomain").unique(),
  defaultLocale: text("default_locale").default("en-IN"),
  defaultTimezone: text("default_timezone").default("Asia/Kolkata"),
  fiscalYearStart: text("fiscal_year_start"),
  businessHours: jsonb("business_hours"),
  sessionTimeoutMinutes: integer("session_timeout_minutes").notNull().default(480),
  mfaRequired: boolean("mfa_required").notNull().default(false),
  allowedEmailDomains: text("allowed_email_domains").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Users ----------
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  passwordHash: text("password_hash"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  jobTitle: text("job_title"),
  timezone: text("timezone"),
  locale: text("locale"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  mfaSecret: text("mfa_secret"),
  mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),
  telephonyExtId: text("telephony_ext_id").unique(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  // Super-admin flag. Platform admins have no membership; they administrate
  // tenants from /platform/* routes. See apps/api/src/routes/platform/.
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Memberships ----------
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    status: text("status", { enum: ["invited", "active", "suspended"] }).notNull().default("active"),
    invitedBy: uuid("invited_by").references(() => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    // Self-FK for the recruiter org chart. NULL = top of chain. Walked up
    // to 4 hops by getReportingChain() in apps/api/src/auth/.
    reportingToUserId: uuid("reporting_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Tie a client_user membership to a specific client (the buyer the
    // user belongs to). NULL for every other role. Used by the client
    // portal to scope demands + submissions.
    clientId: uuid("client_id").references((): typeof clients.id => clients.id, {
      onDelete: "cascade",
    }),
  },
  (t) => ({
    byOrg: index("memberships_org_idx").on(t.orgId),
    userOrg: uniqueIndex("memberships_user_org_key").on(t.userId, t.orgId),
    byReportingTo: index("memberships_reporting_to_idx").on(t.reportingToUserId),
    byClient: index("memberships_client_idx").on(t.clientId),
  }),
);

// ---------- Role permissions ----------
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    permission: text("permission").notNull(),
  },
  (t) => ({
    lookup: index("role_permissions_lookup_idx").on(t.orgId, t.role),
    uniq: uniqueIndex("role_permissions_uniq").on(t.orgId, t.role, t.permission),
  }),
);

// ---------- Teams ----------
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    managerUserId: uuid("manager_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("teams_org_idx").on(t.orgId),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .references(() => teams.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.userId] }),
  }),
);

// ---------- Invitations ----------
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    email: citext("email").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgEmail: index("invitations_org_email_idx").on(t.orgId, t.email),
  }),
);

// ---------- Email verification / Password reset / Refresh tokens ----------
export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    ip: inet("ip"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
  },
  (t) => ({
    byUser: index("refresh_tokens_user_idx").on(t.userId),
  }),
);

export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("mfa_recovery_codes_uniq").on(t.userId, t.codeHash),
  }),
);

// ---------- IP allowlist ----------
export const ipAllowlist = pgTable(
  "ip_allowlist",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    cidr: text("cidr").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("ip_allowlist_org_idx").on(t.orgId),
  }),
);

// ---------- Audit log ----------
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("audit_log_org_idx").on(t.orgId, t.createdAt),
    byActor: index("audit_log_actor_idx").on(t.actorUserId, t.createdAt),
  }),
);

// ---------- Notification preferences ----------
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    event: text("event").notNull(),
    inApp: boolean("in_app").notNull().default(true),
    email: boolean("email").notNull().default(true),
    sms: boolean("sms").notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.event] }),
  }),
);

// ---------- Existing tables ----------
export const kbSources = pgTable("kb_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: text("type", { enum: ["URL", "Upload", "Confluence", "SharePoint"] }).notNull(),
  status: text("status", { enum: ["indexing", "indexed", "error", "deprecated"] })
    .notNull()
    .default("indexing"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
  orgId: uuid("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  // Vapi query-tool id created when this source is attached to a voice agent.
  // One tool per source (holds all the source's document fileIds).
  vapiToolId: text("vapi_tool_id"),
  // Knowledge-Base enterprise additions (migration 0038). Forward-declared via
  // sql column refs in kbCollections below — added here so list serializers can
  // project collection/staleness/freshness without a second migration.
  collectionId: uuid("collection_id"),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  lastRetrievedAt: timestamp("last_retrieved_at", { withTimezone: true }),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .references(() => kbSources.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title"),
    uri: text("uri"),
    mime: text("mime"),
    bytes: bigint("bytes", { mode: "number" }),
    sha256: text("sha256").unique(),
    storageKey: text("storage_key").notNull(),
    status: text("status", { enum: ["pending", "parsing", "embedding", "indexed", "error"] })
      .notNull()
      .default("pending"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Vapi file id returned by POST /file, so the query tool can reference it.
    vapiFileId: text("vapi_file_id"),
  },
  (t) => ({
    bySource: index("documents_source_idx").on(t.sourceId),
  }),
);

// Three corpora share the chunks table. The suggestion engine filters by
// corpus when retrieving for a live call (jd + company for general
// retrieval; question_bank for technical probes).
export const CHUNK_CORPORA = ["jd", "company", "question_bank"] as const;
export type ChunkCorpus = (typeof CHUNK_CORPORA)[number];

export const chunks = pgTable(
  "chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .references(() => documents.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: uuid("source_id").notNull(),
    ord: integer("ord").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count"),
    embedding: vector("embedding", { dim: 1536 }).notNull(),
    corpus: text("corpus", { enum: CHUNK_CORPORA }).notNull().default("company"),
  },
  (t) => ({
    bySource: index("chunks_source_idx").on(t.sourceId),
    byCorpus: index("chunks_corpus_idx").on(t.corpus),
  }),
);

// Modes the recruiter (or autonomous agent) can use to run a call. The
// browser_mixed default is the wedge path: laptop-mic captures the
// candidate's voice through the recruiter's phone speaker as a single
// mixed mono stream; transcript_turns.speaker stays 'unknown' until the
// post-diarize worker can label retroactively.
export const CALL_MODES = [
  "browser_mixed",
  "desktop_dual_channel",
  "vapi_outbound",
  "vapi_inbound",
  "bridge",
] as const;
export type CallMode = (typeof CALL_MODES)[number];

export const callSessions = pgTable(
  "call_sessions",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    recruiterUserId: uuid("recruiter_user_id").references(() => users.id, { onDelete: "set null" }),
    voiceAgentId: uuid("voice_agent_id").references((): typeof voiceAgents.id => voiceAgents.id, {
      onDelete: "set null",
    }),
    // Tenant-side reference to the candidate (FK below) plus a free-text
    // identifier for the outbound case where the candidate row may not
    // exist yet (manual recruiter dial-in).
    candidateRefOrPhone: text("candidate_ref_or_phone"),
    demandId: uuid("demand_id").references((): typeof demands.id => demands.id, {
      onDelete: "set null",
    }),
    prospectId: uuid("prospect_id").references((): typeof prospects.id => prospects.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references((): typeof candidates.id => candidates.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["queued", "assigned", "active", "ended"] })
      .notNull()
      .default("queued"),
    origin: text("origin", { enum: ["web", "telephony", "desktop", "vapi", "bridge"] }),
    mode: text("mode", { enum: CALL_MODES }).notNull().default("browser_mixed"),
    // Per-call STT selection for the live human-recruiter call (the wedge).
    // Distinct from voice_agents.transcriber_* (autonomous Vapi screener config).
    // The ingest WebSocket reads these back to pick the upstream STT bridge.
    transcriberProvider: text("transcriber_provider", { enum: ["deepgram", "sarvam", "shunya"] })
      .notNull()
      .default("deepgram"),
    transcriberModel: text("transcriber_model").notNull().default("nova-3"),
    transcriberLanguage: text("transcriber_language").notNull().default("multi"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    summary: jsonb("summary"),
    // Persisted on Vapi call-end and by the /ws/ingest-call handler when
    // it finalizes a WAV dump.
    recordingUrl: text("recording_url"),
    recordingDurationMs: integer("recording_duration_ms"),
    recordingMime: text("recording_mime"),
  },
  (t) => ({
    byRecruiterActive: index("call_sessions_recruiter_active_idx").on(t.recruiterUserId, t.status),
  }),
);

export const transcriptTurns = pgTable(
  "transcript_turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    // Mixed-mono browser-mic captures land with speaker='unknown'; the
    // post_diarize worker flips to recruiter/candidate where Deepgram's
    // diarization confidence is high. Two-channel desktop captures and
    // Vapi calls write the speaker definitively. 'mixed' is reserved for
    // overlapping turns we can't split.
    speaker: text("speaker", { enum: ["recruiter", "candidate", "unknown", "mixed"] }).notNull(),
    text: text("text").notNull(),
    isFinal: boolean("is_final").notNull().default(false),
    tsStartMs: integer("ts_start_ms").notNull(),
    tsEndMs: integer("ts_end_ms").notNull(),
    sentiment: real("sentiment"),
    // Which model produced `sentiment`. "afinn" is the live English-biased
    // score; a GPT-4o multilingual rescore on call-end overwrites it with
    // something like "gpt-4o-2024-08-06/multilingual".
    sentimentModel: text("sentiment_model"),
  },
  (t) => ({
    byCall: index("transcript_turns_call_idx").on(t.callId, t.tsStartMs),
  }),
);

export const suggestions = pgTable("suggestions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  callId: uuid("call_id").notNull(),
  triggerTurnId: bigint("trigger_turn_id", { mode: "number" }),
  kind: text("kind"),
  content: jsonb("content"),
  citations: jsonb("citations"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Voice agents (Vapi-backed AI voice agents) ----------
export const VOICE_AGENT_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type VoiceAgentStatus = (typeof VOICE_AGENT_STATUSES)[number];

export const VOICE_AGENT_KINDS = ["specialist", "triage"] as const;
export type VoiceAgentKind = (typeof VOICE_AGENT_KINDS)[number];

export const voiceAgents = pgTable(
  "voice_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    // 'specialist' = ordinary autonomous voice agent; 'triage' = front-door
    // classifier that routes via the routeCall tool. Both share the same row
    // shape and Vapi deploy pipeline.
    kind: text("kind", { enum: VOICE_AGENT_KINDS }).notNull().default("specialist"),
    status: text("status", { enum: VOICE_AGENT_STATUSES }).notNull().default("draft"),
    purpose: text("purpose").notNull().default(""),

    // Prompt + opening line
    systemPrompt: text("system_prompt").notNull().default(""),
    firstMessage: text("first_message").notNull().default("Hello! How can I help you today?"),

    // Primary language. "multi" = Hinglish-ready (Deepgram multilingual).
    language: text("language").notNull().default("multi"),

    // STT / LLM / TTS provider triple. Vapi owns the keys; we only store IDs.
    transcriberProvider: text("transcriber_provider").notNull().default("deepgram"),
    transcriberModel: text("transcriber_model").notNull().default("nova-3"),
    transcriberLanguage: text("transcriber_language").notNull().default("multi"),

    llmProvider: text("llm_provider").notNull().default("openai"),
    llmModel: text("llm_model").notNull().default("gpt-4o"),
    llmTemperature: real("llm_temperature").notNull().default(0.5),

    voiceProvider: text("voice_provider").notNull().default("11labs"),
    voiceId: text("voice_id").notNull().default(""),
    // Provider-specific voice tuning (ElevenLabs: model/speed/stability/
    // similarityBoost/fallbackPlan). Null means "use Vapi defaults".
    voiceConfig: jsonb("voice_config").$type<{
      model?: string;
      speed?: number;
      stability?: number;
      similarityBoost?: number;
      fallbackPlan?: {
        voices: Array<{
          provider: string;
          voiceId: string;
          model?: string;
          stability?: number;
          similarityBoost?: number;
        }>;
      };
    }>(),

    // Transcriber VAD / endpointing (ms of silence that ends the utterance).
    transcriberEndpointing: integer("transcriber_endpointing"),

    // Voice agent scripts. `firstMessage` is the opening line; these cover
    // voicemail + farewell. `endCallPhrases` hangs up the call when the caller
    // says one of them.
    voicemailMessage: text("voicemail_message"),
    endCallMessage: text("end_call_message"),
    endCallPhrases: jsonb("end_call_phrases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    // Vapi event subscription lists. Browser SDK (clientMessages) vs.
    // serverUrl webhook (serverMessages). Empty = Vapi defaults.
    clientMessages: jsonb("client_messages").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    serverMessages: jsonb("server_messages").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    // Vapi's native plans. Stored as-is so new Vapi fields don't require schema
    // changes — we pass-through on deploy.
    artifactPlan: jsonb("artifact_plan").$type<Record<string, unknown>>(),
    startSpeakingPlan: jsonb("start_speaking_plan").$type<Record<string, unknown>>(),
    stopSpeakingPlan: jsonb("stop_speaking_plan").$type<Record<string, unknown>>(),
    // Vapi's compliancePlan (hipaaEnabled, pciEnabled) — structurally distinct
    // from our prompt-level `compliance` (disclosures/prohibited).
    compliancePlan: jsonb("compliance_plan").$type<{
      hipaaEnabled?: boolean;
      pciEnabled?: boolean;
    }>(),

    // Persona knobs surfaced in the Configuration → Persona UI.
    tone: text("tone").notNull().default("friendly"),
    personality: jsonb("personality").$type<{
      warmth?: number;
      conciseness?: number;
      formality?: number;
      patience?: number;
      proactiveness?: number;
    }>(),

    // Tools (Vapi "functions") — array of { name, description, parameters, fulfillmentUrl }
    tools: jsonb("tools").$type<
      Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        fulfillmentUrl?: string;
      }>
    >().notNull().default(sql`'[]'::jsonb`),

    // Links to kb_sources rows that the agent can draw answers from.
    knowledgeSourceIds: jsonb("knowledge_source_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    // Compliance: disclosures prepended to first message, prohibited phrases in system prompt.
    compliance: jsonb("compliance").$type<{
      disclosures?: string[];
      prohibited?: string[];
      piiRedaction?: boolean;
    }>(),

    // Escalation to human agent: phone number + free-text rules that get baked into prompt.
    escalation: jsonb("escalation").$type<{
      handoffPhone?: string;
      rules?: string[];
    }>(),

    maxDurationSec: integer("max_duration_sec").notNull().default(600),

    // Recruiter-context links. Voice agents (autonomous AI screeners) can
    // be either generic (org-level) or scoped to a specific demand. The
    // linked rubric is used by the post-call rubric_finalize worker to
    // score the screener's call against the same rubric a human recruiter
    // would be evaluated on.
    demandId: uuid("demand_id").references((): typeof demands.id => demands.id, {
      onDelete: "set null",
    }),
    linkedRubricId: uuid("linked_rubric_id").references((): typeof callRubrics.id => callRubrics.id, {
      onDelete: "set null",
    }),

    // Vapi bookkeeping — populated on first deploy.
    vapiAssistantId: text("vapi_assistant_id"),
    vapiPhoneId: text("vapi_phone_id"),
    phoneNumber: text("phone_number"),
    // ID of the single `knowledge_query` query-tool on Vapi that fans across
    // all of this agent's selected KB sources (one tool, N `knowledgeBases`
    // entries). One tool per agent, reused across redeploys.
    vapiKbToolId: text("vapi_kb_tool_id"),
    // Triage-only: id of the Vapi squad whose member set is rebuilt from the
    // current routing rules so transferToAssistant can switch members.
    vapiSquadId: text("vapi_squad_id"),
    // Triage-only routing config — vocabulary the classifier knows about,
    // a fallback destination, and confidence threshold below which the
    // classifier should hand off to a human regardless of intent. Free-form
    // jsonb so we can iterate without migrations.
    routing: jsonb("routing").$type<{
      intentVocabulary?: string[];
      defaultDestinationRef?: string;
      confidenceThreshold?: number;
    }>(),
    lastDeployedAt: timestamp("last_deployed_at", { withTimezone: true }),

    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("voice_agents_org_idx").on(t.orgId, t.status),
    byVapiAssistant: uniqueIndex("voice_agents_vapi_assistant_key").on(t.vapiAssistantId),
  }),
);

export const voiceAgentDeployments = pgTable(
  "voice_agent_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .references(() => voiceAgents.id, { onDelete: "cascade" })
      .notNull(),
    deployedByUserId: uuid("deployed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).defaultNow().notNull(),
    // Snapshot of the Vapi payload we sent — useful for rollback/debug.
    vapiConfigSnapshot: jsonb("vapi_config_snapshot").notNull(),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    errorMessage: text("error_message"),
  },
  (t) => ({
    byAgent: index("voice_agent_deployments_agent_idx").on(t.agentId, t.deployedAt),
  }),
);

// ---------- AI triage routing ----------
// One row per branch in a triage flow: which intent goes where, with what
// handoff mode and conditions. UI position is stored so the visual flow
// builder restores layout. See apps/api/src/routes/triage.ts for usage.
export const TRIAGE_DESTINATION_TYPES = [
  "human_team",
  "voice_agent",
  "external_pstn",
  "voicemail",
] as const;
export type TriageDestinationType = (typeof TRIAGE_DESTINATION_TYPES)[number];

export const TRIAGE_HANDOFF_MODES = ["warm", "cold", "voicemail"] as const;
export type TriageHandoffMode = (typeof TRIAGE_HANDOFF_MODES)[number];

export const triageRoutingRules = pgTable(
  "triage_routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    triageAgentId: uuid("triage_agent_id")
      .references(() => voiceAgents.id, { onDelete: "cascade" })
      .notNull(),
    priority: integer("priority").notNull(),
    intent: text("intent").notNull(),
    conditions: jsonb("conditions").$type<{
      minConfidence?: number;
      sentimentLt?: number;
      language?: string;
    }>(),
    destinationType: text("destination_type", { enum: TRIAGE_DESTINATION_TYPES }).notNull(),
    destinationRef: text("destination_ref").notNull(),
    destinationLabel: text("destination_label").notNull(),
    handoffMode: text("handoff_mode", { enum: TRIAGE_HANDOFF_MODES })
      .notNull()
      .default("warm"),
    enabled: boolean("enabled").notNull().default(true),
    uiPosition: jsonb("ui_position").$type<{ x: number; y: number }>(),
    // SLA target seconds from triage_started to handoff_completed for this rule.
    slaTargetSec: integer("sla_target_sec"),
    // Capacity / load-balancing knobs for human_team destinations.
    routingStrategy: text("routing_strategy", {
      enum: ["first_idle", "round_robin", "weighted", "least_loaded"],
    })
      .notNull()
      .default("first_idle"),
    weight: integer("weight").notNull().default(1), // for weighted strategy
    maxConcurrent: integer("max_concurrent"), // capacity ceiling, null = unlimited
    requiredSkill: text("required_skill"), // skill-match filter, null = any
    // FK to the frozen rule set this rule was published into (nullable: a live
    // draft rule has no rule-set until first publish freezes a snapshot).
    ruleSetId: uuid("rule_set_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTriageAgent: index("triage_routing_rules_lookup_idx").on(
      t.orgId,
      t.triageAgentId,
      t.priority,
    ),
    byRuleSet: index("triage_routing_rules_rule_set_idx").on(t.ruleSetId),
  }),
);

// Audit trail of every routing decision a call passes through. The supervisor
// live-feed and analytics charts both query this; one row per stage.
export const CALL_ROUTING_EVENT_KINDS = [
  "triage_started",
  "classified",
  "route_decision",
  "handoff_initiated",
  "handoff_accepted",
  "handoff_failed",
  "handoff_completed",
] as const;
export type CallRoutingEventKind = (typeof CALL_ROUTING_EVENT_KINDS)[number];

export const callRoutingEvents = pgTable(
  "call_routing_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: CALL_ROUTING_EVENT_KINDS }).notNull(),
    fromRef: jsonb("from_ref").$type<{ type: string; id: string; label?: string }>(),
    toRef: jsonb("to_ref").$type<{ type: string; id: string; label?: string }>(),
    classification: jsonb("classification").$type<{
      intent: string;
      confidence: number;
      sentiment?: number;
      language?: string;
      urgency?: "low" | "normal" | "high";
      entities?: Record<string, string>;
      reason?: string;
    }>(),
    ruleId: uuid("rule_id").references(() => triageRoutingRules.id, {
      onDelete: "set null",
    }),
    providerData: jsonb("provider_data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_routing_events_call_seq_idx").on(t.callId, t.seq),
    byOrg: index("call_routing_events_org_at_idx").on(t.orgId, t.createdAt),
  }),
);

// ---------- QA review persistence ----------
// Per-reviewer decision on an AI-scored call. Multiple rows per call are
// allowed (second reviewer, re-review); inter-rater agreement is derived by
// GROUP BY call_id HAVING count > 1. Renamed from qa_reviews in 0010 to
// match the recruiter-call vocabulary.
export const callQaReviews = pgTable(
  "call_qa_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    // Nullable since 0011: the rubric-finalize worker seeds a queue row
    // before any reviewer has claimed the call. The QA route stamps this on
    // the first grading action.
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    decision: text("decision", { enum: ["accept", "override", "escalate"] }).notNull(),
    note: text("note"),
    // Per-criterion overrides keyed by criterionId -> {aiScore, reviewerScore, reason}
    criterionOverrides: jsonb("criterion_overrides")
      .$type<Record<string, { aiScore: number; reviewerScore: number; reason: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Reviewer-final weighted score after overrides (cached for fast aggregation).
    reviewerScore: integer("reviewer_score"),
    aiScore: numeric("ai_score"),
    timeSpentMs: integer("time_spent_ms"),
    // --- qa-review enterprise (migration 0035, additive) ---
    // Links a review back to the queue item that scheduled it (blind double-review).
    queueItemId: uuid("queue_item_id"),
    // Which blind slot this review filled (1=primary, 2=secondary, 3=tiebreak).
    reviewSlot: integer("review_slot").notNull().default(1),
    // |reviewerScore - gold| when a published gold answer exists for the call.
    goldVariance: integer("gold_variance"),
    // Soft-archive.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_qa_reviews_call_idx").on(t.callId, t.createdAt),
    byReviewer: index("call_qa_reviews_reviewer_idx").on(t.reviewerUserId, t.createdAt),
    byOrg: index("call_qa_reviews_org_idx").on(t.orgId, t.createdAt),
    byQueueItem: index("call_qa_reviews_queue_item_idx").on(t.queueItemId),
  }),
);

// Backwards-compat re-export for any code that hasn't switched yet (Phase 4
// rewires consumers; remove once all references are gone).
export const qaReviews = callQaReviews;

// Per-window acoustic-sentiment results produced by the Phase 2 worker job.
// Each row is ~500ms of audio for one speaker channel with prosodic features
// + derived valence/arousal. Many rows per call.
export const transcriptAcousticWindows = pgTable(
  "transcript_acoustic_windows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    speaker: text("speaker", { enum: ["recruiter", "candidate", "unknown", "mixed"] }).notNull(),
    tsStartMs: integer("ts_start_ms").notNull(),
    tsEndMs: integer("ts_end_ms").notNull(),
    valence: real("valence").notNull(), // [-1, 1] — negative=upset, positive=happy
    arousal: real("arousal").notNull(), // [0, 1] — calm → energetic/stressed
    f0Mean: real("f0_mean"), // pitch Hz (null when VAD says silence)
    rmsEnergy: real("rms_energy"), // normalized loudness
    modelVersion: text("model_version").notNull(),
  },
  (t) => ({
    byCall: index("acoustic_windows_call_idx").on(t.callId, t.tsStartMs),
  }),
);

// Cached output of the resolution-vs-KB LLM pipeline. Keyed by callId because
// there's at most one canonical analysis per call; `payload` holds the
// ResolutionAnalysis shape the frontend expects.
export const qaResolutionAnalyses = pgTable("qa_resolution_analyses", {
  callId: uuid("call_id")
    .primaryKey()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .references(() => organizations.id, { onDelete: "cascade" })
    .notNull(),
  payload: jsonb("payload").notNull(),
  modelVersion: text("model_version").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Live translation ----------
// Workspace defaults feed the Settings → Translation page and serve as the
// fallback when a call starts without an explicit override.
export const workspaceTranslationSettings = pgTable(
  "workspace_translation_settings",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("mock"),
    model: text("model").notNull().default("mock-v1"),
    defaultSourceLang: text("default_source_lang").notNull().default("auto"),
    defaultTargetLang: text("default_target_lang").notNull().default("en-US"),
    latencyMode: text("latency_mode", { enum: ["realtime", "balanced", "accurate"] })
      .notNull()
      .default("balanced"),
    preserveTone: boolean("preserve_tone").notNull().default(true),
    voiceCloning: boolean("voice_cloning").notNull().default(false),
    confidenceThreshold: real("confidence_threshold").notNull().default(0.6),
    lowConfidenceAction: text("low_confidence_action", {
      enum: ["show-warning", "insert-original", "drop"],
    })
      .notNull()
      .default("show-warning"),
    glossaryId: uuid("glossary_id"),
    redactPII: boolean("redact_pii").notNull().default(false),
    profanityFilter: boolean("profanity_filter").notNull().default(false),
    customPhrases: text("custom_phrases").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

// One row per translated turn. `provider` captures which adapter produced the
// translation so we can attribute cost and debug regressions per vendor.
export const callTranslations = pgTable(
  "call_translations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    turnId: bigint("turn_id", { mode: "number" })
      .references(() => transcriptTurns.id, { onDelete: "cascade" })
      .notNull(),
    speaker: text("speaker", { enum: ["recruiter", "candidate", "unknown", "mixed"] }).notNull(),
    sourceLang: text("source_lang").notNull(),
    sourceText: text("source_text").notNull(),
    targetLang: text("target_lang").notNull(),
    targetText: text("target_text").notNull(),
    confidence: real("confidence").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    provider: text("provider").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_translations_call_idx").on(t.callId, t.createdAt),
    byTurn: uniqueIndex("call_translations_turn_key").on(t.turnId),
  }),
);

export const translationGlossaries = pgTable(
  "translation_glossaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("translation_glossaries_org_idx").on(t.orgId),
  }),
);

export const translationGlossaryEntries = pgTable(
  "translation_glossary_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    glossaryId: uuid("glossary_id")
      .references(() => translationGlossaries.id, { onDelete: "cascade" })
      .notNull(),
    sourceText: text("source_text").notNull(),
    targetText: text("target_text").notNull(),
    // Null = applies to any direction. Both set = scoped pair.
    sourceLang: text("source_lang"),
    targetLang: text("target_lang"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byGlossary: index("translation_glossary_entries_glossary_idx").on(t.glossaryId),
  }),
);

// ---------- Tenant integrations ----------
// Per-tenant credentials for external providers (Vapi, Deepgram, Sarvam,
// Shunya). `ciphertext` is a single bytea blob laid out as:
//   nonce(12) || ciphertext || authTag(16)
// produced by AES-256-GCM keyed off env.INTEGRATIONS_KEK. The plaintext is a
// JSON object whose shape is provider-specific (see TenantIntegrationSecret
// in apps/api/src/integrations/encryption.ts).
export const TENANT_INTEGRATION_PROVIDERS = ["vapi", "deepgram", "sarvam", "shunya", "rekognition"] as const;
export type TenantIntegrationProvider = (typeof TENANT_INTEGRATION_PROVIDERS)[number];

export const tenantIntegrations = pgTable(
  "tenant_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    provider: text("provider", { enum: TENANT_INTEGRATION_PROVIDERS }).notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("tenant_integrations_org_provider_key").on(t.orgId, t.provider),
  }),
);

// =====================================================================
// ATS / recruiter-domain tables (added in 0010_recruitassist_foundation)
// =====================================================================

// ---------- Taxonomy lookup tables ----------

export const industries = pgTable("industries", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const functionalAreas = pgTable("functional_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const roleCategories = pgTable("role_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const jobRoles = pgTable(
  "job_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    roleCategoryId: uuid("role_category_id").references(() => roleCategories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("job_roles_name_category_key").on(t.name, t.roleCategoryId),
  }),
);

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: citext("name").notNull().unique(),
  // Array of alternate names ("ReactJS", "React.js"). Used by skill matching.
  aliases: jsonb("aliases").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    city: text("city").notNull(),
    state: text("state"),
    country: text("country").notNull().default("India"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("locations_city_state_country_key").on(t.city, t.state, t.country),
  }),
);

export const disqualificationReasons = pgTable("disqualification_reasons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ---------- Clients & client-recruiter eligibility ----------

export const CLIENT_STATUSES = ["active", "paused", "closed"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    companyName: text("company_name").notNull(),
    slug: text("slug"),
    industry: text("industry"),
    tier: text("tier"),
    bhUserId: uuid("bh_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", { enum: CLIENT_STATUSES }).notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    externalOfferLetterClientId: integer("external_offer_letter_client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("clients_org_idx").on(t.orgId, t.status),
  }),
);

export const clientRecruiters = pgTable(
  "client_recruiters",
  {
    clientId: uuid("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    recruiterId: uuid("recruiter_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clientId, t.recruiterId] }),
    byRecruiter: index("client_recruiters_recruiter_idx").on(t.recruiterId),
  }),
);

// ---------- Demands (the role to fill) ----------

export const DEMAND_STATUSES = ["draft", "active", "on_hold", "closed", "cancelled"] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export const demands = pgTable(
  "demands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    clientId: uuid("client_id")
      .references(() => clients.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),

    title: text("title").notNull(),
    designation: text("designation"),
    description: text("description"),
    responsibilities: text("responsibilities"),

    experienceMinYears: numeric("experience_min_years"),
    experienceMaxYears: numeric("experience_max_years"),
    salaryFrom: numeric("salary_from"),
    salaryTo: numeric("salary_to"),
    numberOfOpenings: integer("number_of_openings").notNull().default(1),
    maxSubmissions: integer("max_submissions"),
    primaryLocation: text("primary_location"),

    status: text("status", { enum: DEMAND_STATUSES }).notNull().default("draft"),
    isVip: boolean("is_vip").notNull().default(false),
    clientInternalTicketId: text("client_internal_ticket_id"),
    requestedBy: text("requested_by"),
    requestedDate: date("requested_date"),
    expectedClosureDate: date("expected_closure_date"),
    groupName: text("group_name"),
    subGroupName: text("sub_group_name"),
    poOpportunityMrr: numeric("po_opportunity_mrr"),
    potentialGm: numeric("potential_gm"),

    industryId: uuid("industry_id").references(() => industries.id, { onDelete: "set null" }),
    functionalAreaId: uuid("functional_area_id").references(() => functionalAreas.id, {
      onDelete: "set null",
    }),
    roleCategoryId: uuid("role_category_id").references(() => roleCategories.id, {
      onDelete: "set null",
    }),
    jobRoleId: uuid("job_role_id").references(() => jobRoles.id, { onDelete: "set null" }),

    // Probing-call output: work mode, candidate role detail, interview type,
    // notice period acceptable, feedback ETA, urgency, project size/count,
    // reporting manager location.
    probingDetails: jsonb("probing_details").$type<{
      workMode?: "onsite" | "hybrid" | "remote";
      interviewType?: string;
      acceptableNoticePeriodDays?: number;
      feedbackEtaDays?: number;
      urgency?: "low" | "normal" | "high";
      projectSize?: number;
      projectCount?: number;
      reportingManagerLocation?: string;
      [key: string]: unknown;
    }>(),
    mandatoryChecks: jsonb("mandatory_checks").$type<string[]>().notNull().default(sql`'[]'::jsonb`),

    externalOfferLetterDemandId: integer("external_offer_letter_demand_id"),
    externalDataHash: text("external_data_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgStatus: index("demands_org_status_idx").on(t.orgId, t.status),
    byClient: index("demands_client_idx").on(t.clientId),
  }),
);

export const demandSkills = pgTable(
  "demand_skills",
  {
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    skillId: uuid("skill_id")
      .references(() => skills.id, { onDelete: "cascade" })
      .notNull(),
    isMandatory: boolean("is_mandatory").notNull().default(false),
    weight: numeric("weight").notNull().default("1.0"),
    source: text("source").notNull().default("manual"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.demandId, t.skillId] }),
    bySkill: index("demand_skills_skill_idx").on(t.skillId),
  }),
);

export const demandLocations = pgTable(
  "demand_locations",
  {
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    locationId: uuid("location_id")
      .references(() => locations.id, { onDelete: "cascade" })
      .notNull(),
    source: text("source").notNull().default("manual"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.demandId, t.locationId] }),
  }),
);

export const demandAssignments = pgTable(
  "demand_assignments",
  {
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    recruiterId: uuid("recruiter_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["active", "released"] }).notNull().default("active"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // Live pipeline this recruiter has on this demand: count of non-
    // terminal applied_jobs rows in the Offer Letter MySQL, refreshed by
    // every demand-sync run. Used to sort the recruiter home view so
    // demands with active candidates surface above cold assignments.
    activeCandidatesCount: integer("active_candidates_count").notNull().default(0),
    lastRecruiterActivityAt: timestamp("last_recruiter_activity_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.demandId, t.recruiterId, t.assignedAt] }),
    byRecruiterActive: index("demand_assignments_recruiter_active_idx").on(t.recruiterId),
  }),
);

// ---------- Candidates ----------

export const CANDIDATE_SOURCES = [
  "naukri",
  "linkedin",
  "referral",
  "direct",
  "internal_db",
  "imported",
  "other",
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    email: citext("email"),
    phone: text("phone"),
    emailNormalized: citext("email_normalized"),
    phoneE164Normalized: text("phone_e164_normalized"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    currentTitle: text("current_title"),
    currentCompany: text("current_company"),
    totalExperienceYears: numeric("total_experience_years"),
    currentCtcLakhs: numeric("current_ctc_lakhs"),
    expectedCtcLakhs: numeric("expected_ctc_lakhs"),
    noticePeriodDays: integer("notice_period_days"),
    noticePeriodNegotiable: boolean("notice_period_negotiable"),
    currentLocation: text("current_location"),
    preferredLocations: text("preferred_locations").array().notNull().default(sql`'{}'::text[]`),
    linkedinUrl: text("linkedin_url"),
    naukriProfileUrl: text("naukri_profile_url"),
    githubUrl: text("github_url"),
    summary: text("summary"),
    resumeBlobKey: text("resume_blob_key"),
    parsedResumeJson: jsonb("parsed_resume_json").$type<Record<string, unknown>>(),
    consentSnapshotJson: jsonb("consent_snapshot_json").$type<Record<string, unknown>>(),
    source: text("source", { enum: CANDIDATE_SOURCES }).notNull().default("direct"),
    sourceMetadata: jsonb("source_metadata").$type<Record<string, unknown>>(),
    externalOfferLetterUserId: integer("external_offer_letter_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("candidates_org_idx").on(t.orgId, t.createdAt),
  }),
);

export const candidateSkills = pgTable(
  "candidate_skills",
  {
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    skillId: uuid("skill_id")
      .references(() => skills.id, { onDelete: "cascade" })
      .notNull(),
    proficiencyLevel: integer("proficiency_level"),
    yearsOfExperience: numeric("years_of_experience"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.candidateId, t.skillId] }),
    bySkill: index("candidate_skills_skill_idx").on(t.skillId),
  }),
);

export const candidateExperiences = pgTable(
  "candidate_experiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    companyName: text("company_name").notNull(),
    title: text("title"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    isCurrent: boolean("is_current").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCandidate: index("candidate_experiences_candidate_idx").on(t.candidateId, t.startDate),
  }),
);

export const candidateQualifications = pgTable(
  "candidate_qualifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    degree: text("degree"),
    institution: text("institution"),
    fieldOfStudy: text("field_of_study"),
    yearOfCompletion: integer("year_of_completion"),
    marksOrGrade: text("marks_or_grade"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCandidate: index("candidate_qualifications_candidate_idx").on(t.candidateId),
  }),
);

export const candidateResumes = pgTable(
  "candidate_resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    blobKey: text("blob_key").notNull(),
    sha256: text("sha256"),
    bytes: integer("bytes"),
    mime: text("mime"),
    originalFilename: text("original_filename"),
    parsedResumeJson: jsonb("parsed_resume_json").$type<Record<string, unknown>>(),
    modelUsed: text("model_used"),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCandidate: index("candidate_resumes_candidate_idx").on(t.candidateId, t.createdAt),
  }),
);

// ---------- Prospects (pre-submission workspace) ----------

export const PROSPECT_STATUSES = [
  "new",
  "contacted",
  "interested",
  "not_interested",
  "unreachable",
  "qualified",
  "disqualified",
  "submitted",
  "parked",
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const DISQUALIFICATION_REASON_CODES = [
  "experience_mismatch",
  "skill_mismatch",
  "location_mismatch",
  "compensation_mismatch",
  "notice_period_mismatch",
  "not_interested",
  "unreachable",
  "duplicate",
  "other",
] as const;
export type DisqualificationReasonCode = (typeof DISQUALIFICATION_REASON_CODES)[number];

export const prospects = pgTable(
  "prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    recruiterId: uuid("recruiter_id")
      .references(() => users.id, { onDelete: "set null" })
      .notNull(),
    status: text("status", { enum: PROSPECT_STATUSES }).notNull().default("new"),
    interestLevel: integer("interest_level"),
    disqualificationReason: text("disqualification_reason", {
      enum: DISQUALIFICATION_REASON_CODES,
    }),
    notes: text("notes"),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRecruiterStatus: index("prospects_recruiter_status_idx").on(t.recruiterId, t.status),
    byDemandStatus: index("prospects_demand_status_idx").on(t.demandId, t.status),
    uniq: uniqueIndex("prospects_demand_candidate_recruiter_key").on(
      t.demandId,
      t.candidateId,
      t.recruiterId,
    ),
  }),
);

export const PROSPECT_CALL_OUTCOMES = [
  "connected",
  "no_answer",
  "busy",
  "wrong_number",
  "voicemail",
  "callback_requested",
] as const;
export type ProspectCallOutcome = (typeof PROSPECT_CALL_OUTCOMES)[number];

export const prospectCalls = pgTable(
  "prospect_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prospectId: uuid("prospect_id")
      .references(() => prospects.id, { onDelete: "cascade" })
      .notNull(),
    recruiterId: uuid("recruiter_id")
      .references(() => users.id, { onDelete: "set null" })
      .notNull(),
    callSessionId: uuid("call_session_id").references(() => callSessions.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome", { enum: PROSPECT_CALL_OUTCOMES }).notNull().default("connected"),
    durationSeconds: integer("duration_seconds"),
    summary: text("summary"),
    nextStep: text("next_step"),
    nextStepAt: timestamp("next_step_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byProspect: index("prospect_calls_prospect_idx").on(t.prospectId, t.createdAt),
  }),
);

// ---------- Submissions + downstream stages ----------

export const SUBMISSION_STAGES = [
  "applied",
  "internal_review",
  "internal_reject",
  "client_submit",
  "client_screen_reject",
  "l1_scheduled",
  "l1_no_show",
  "l1_reject",
  "l1_select",
  "l2_scheduled",
  "l2_no_show",
  "l2_reject",
  "l2_select",
  "l3_scheduled",
  "l3_no_show",
  "l3_reject",
  "l3_select",
  "final_select",
  "on_hold",
  "position_closed",
  "panel_unavailable",
  "duplicate_profile",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "offer_rejected",
  "onboarded",
  "exited",
  "withdrawn",
] as const;
export type SubmissionStage = (typeof SUBMISSION_STAGES)[number];

export type SubmissionStageBucket =
  | "pre_submit"
  | "client_pipeline"
  | "interview"
  | "offer"
  | "post_offer"
  | "terminal";

export interface SubmissionStageMetadata {
  isTerminal: boolean;
  requiresReason: boolean;
  /** Order along the recruitment funnel for sorting/visualization. */
  progressOrder: number;
  bucket: SubmissionStageBucket;
  /**
   * Step number in the J2W Offer Letter MySQL workflow that this stage maps
   * to, for the future sync adapter. Null for stages we don't sync.
   */
  mapsToOfferLetterStep: number | null;
}

// Source of truth for stage transition validation. The DB CHECK only
// enforces "value is in the universe"; the application layer
// (apps/api/src/routes/submissions.ts) consults this map to allow/reject
// transitions and demand reasons.
export const STAGE_METADATA: Record<SubmissionStage, SubmissionStageMetadata> = {
  applied:               { isTerminal: false, requiresReason: false, progressOrder: 0,  bucket: "pre_submit",      mapsToOfferLetterStep: null },
  internal_review:       { isTerminal: false, requiresReason: false, progressOrder: 5,  bucket: "pre_submit",      mapsToOfferLetterStep: null },
  internal_reject:       { isTerminal: true,  requiresReason: true,  progressOrder: 6,  bucket: "terminal",        mapsToOfferLetterStep: null },
  client_submit:         { isTerminal: false, requiresReason: false, progressOrder: 10, bucket: "client_pipeline", mapsToOfferLetterStep: 7 },
  client_screen_reject:  { isTerminal: true,  requiresReason: true,  progressOrder: 11, bucket: "terminal",        mapsToOfferLetterStep: null },
  l1_scheduled:          { isTerminal: false, requiresReason: false, progressOrder: 20, bucket: "interview",       mapsToOfferLetterStep: null },
  l1_no_show:            { isTerminal: false, requiresReason: true,  progressOrder: 21, bucket: "interview",       mapsToOfferLetterStep: null },
  l1_reject:             { isTerminal: true,  requiresReason: true,  progressOrder: 22, bucket: "terminal",        mapsToOfferLetterStep: null },
  l1_select:             { isTerminal: false, requiresReason: false, progressOrder: 23, bucket: "interview",       mapsToOfferLetterStep: null },
  l2_scheduled:          { isTerminal: false, requiresReason: false, progressOrder: 30, bucket: "interview",       mapsToOfferLetterStep: null },
  l2_no_show:            { isTerminal: false, requiresReason: true,  progressOrder: 31, bucket: "interview",       mapsToOfferLetterStep: null },
  l2_reject:             { isTerminal: true,  requiresReason: true,  progressOrder: 32, bucket: "terminal",        mapsToOfferLetterStep: null },
  l2_select:             { isTerminal: false, requiresReason: false, progressOrder: 33, bucket: "interview",       mapsToOfferLetterStep: null },
  l3_scheduled:          { isTerminal: false, requiresReason: false, progressOrder: 40, bucket: "interview",       mapsToOfferLetterStep: null },
  l3_no_show:            { isTerminal: false, requiresReason: true,  progressOrder: 41, bucket: "interview",       mapsToOfferLetterStep: null },
  l3_reject:             { isTerminal: true,  requiresReason: true,  progressOrder: 42, bucket: "terminal",        mapsToOfferLetterStep: null },
  l3_select:             { isTerminal: false, requiresReason: false, progressOrder: 43, bucket: "interview",       mapsToOfferLetterStep: null },
  final_select:          { isTerminal: false, requiresReason: false, progressOrder: 50, bucket: "interview",       mapsToOfferLetterStep: null },
  on_hold:               { isTerminal: false, requiresReason: true,  progressOrder: 55, bucket: "client_pipeline", mapsToOfferLetterStep: null },
  position_closed:       { isTerminal: true,  requiresReason: true,  progressOrder: 56, bucket: "terminal",        mapsToOfferLetterStep: null },
  panel_unavailable:     { isTerminal: false, requiresReason: true,  progressOrder: 57, bucket: "interview",       mapsToOfferLetterStep: null },
  duplicate_profile:     { isTerminal: true,  requiresReason: false, progressOrder: 60, bucket: "terminal",        mapsToOfferLetterStep: null },
  offer_pending:         { isTerminal: false, requiresReason: false, progressOrder: 70, bucket: "offer",           mapsToOfferLetterStep: null },
  offer_released:        { isTerminal: false, requiresReason: false, progressOrder: 71, bucket: "offer",           mapsToOfferLetterStep: null },
  offer_accepted:        { isTerminal: false, requiresReason: false, progressOrder: 72, bucket: "offer",           mapsToOfferLetterStep: null },
  offer_rejected:        { isTerminal: true,  requiresReason: true,  progressOrder: 73, bucket: "terminal",        mapsToOfferLetterStep: null },
  onboarded:             { isTerminal: false, requiresReason: false, progressOrder: 80, bucket: "post_offer",      mapsToOfferLetterStep: null },
  exited:                { isTerminal: true,  requiresReason: true,  progressOrder: 81, bucket: "terminal",        mapsToOfferLetterStep: null },
  withdrawn:             { isTerminal: true,  requiresReason: true,  progressOrder: 90, bucket: "terminal",        mapsToOfferLetterStep: null },
};

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    currentStage: text("current_stage", { enum: SUBMISSION_STAGES }).notNull().default("internal_review"),
    previousStage: text("previous_stage", { enum: SUBMISSION_STAGES }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    recruiterNote: text("recruiter_note"),
    status: text("status", { enum: ["active", "withdrawn", "closed"] }).notNull().default("active"),
    externalOfferLetterAppliedJobsId: integer("external_offer_letter_applied_jobs_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgStage: index("submissions_org_stage_idx").on(t.orgId, t.currentStage),
    byDemand: index("submissions_demand_idx").on(t.demandId),
    byCandidate: index("submissions_candidate_idx").on(t.candidateId),
    byRecruiter: index("submissions_recruiter_idx").on(t.submittedByUserId),
    activeKey: uniqueIndex("submissions_active_demand_candidate_key").on(t.demandId, t.candidateId),
  }),
);

export const submissionStageTransitions = pgTable(
  "submission_stage_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    submissionId: uuid("submission_id")
      .references(() => submissions.id, { onDelete: "cascade" })
      .notNull(),
    fromStage: text("from_stage", { enum: SUBMISSION_STAGES }),
    toStage: text("to_stage", { enum: SUBMISSION_STAGES }).notNull(),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reasonText: text("reason_text"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("submission_stage_transitions_submission_idx").on(t.submissionId, t.createdAt),
  }),
);

export const INTERVIEW_LEVELS = ["l1", "l2", "l3", "l4", "l5", "l6", "hr", "final"] as const;
export const INTERVIEW_MODES = ["in_person", "video", "phone"] as const;
export const INTERVIEW_OUTCOMES = [
  "pending",
  "select",
  "reject",
  "no_show",
  "reschedule",
  "on_hold",
  "panel_unavailable",
  "position_closed",
] as const;

export const interviews = pgTable(
  "interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .references(() => submissions.id, { onDelete: "cascade" })
      .notNull(),
    level: text("level", { enum: INTERVIEW_LEVELS }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    mode: text("mode", { enum: INTERVIEW_MODES }),
    venue: text("venue"),
    interviewerName: text("interviewer_name"),
    clientSpoc: text("client_spoc"),
    outcome: text("outcome", { enum: INTERVIEW_OUTCOMES }).notNull().default("pending"),
    feedbackText: text("feedback_text"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("interviews_submission_idx").on(t.submissionId, t.scheduledAt),
  }),
);

export const selections = pgTable("selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .references(() => submissions.id, { onDelete: "cascade" })
    .unique()
    .notNull(),
  selectedAt: timestamp("selected_at", { withTimezone: true }).defaultNow().notNull(),
  tentativeDojDate: date("tentative_doj_date"),
  currentCtcLakhs: numeric("current_ctc_lakhs"),
  offeredCtcLakhs: numeric("offered_ctc_lakhs"),
  poValueLakhs: numeric("po_value_lakhs"),
  marginLakhs: numeric("margin_lakhs"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const OFFER_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "released",
  "accepted",
  "onboarded",
  "exited",
  "terminated",
  "rejected",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    selectionId: uuid("selection_id")
      .references(() => selections.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status", { enum: OFFER_STATUSES }).notNull().default("draft"),
    joiningDate: date("joining_date"),
    clientOnboardDate: date("client_onboard_date"),
    poValueLakhs: numeric("po_value_lakhs"),
    marginLakhs: numeric("margin_lakhs"),
    employeeType: text("employee_type"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySelection: index("offers_selection_idx").on(t.selectionId),
  }),
);

// ---------- Rubrics + JD-match runs + question banks ----------

export const RUBRIC_PURPOSES = [
  "general_screen",
  "technical_screen",
  "senior_technical",
  "hr_screen",
  "outbound_pitch",
] as const;
export type RubricPurpose = (typeof RUBRIC_PURPOSES)[number];

export const RUBRIC_CRITERION_KINDS = [
  "script_adherence",
  "jd_coverage",
  "technical_depth",
  "salary_handling",
  "positioning",
  "candidate_experience",
  "compliance_disclosure",
  "custom",
] as const;
export type RubricCriterionKind = (typeof RUBRIC_CRITERION_KINDS)[number];

export interface RubricCriterion {
  id: string;
  name: string;
  description?: string;
  weight: number;
  bandThresholds: { fail: number; pass: number; excellent: number };
  autoScoreEnabled: boolean;
  kind: RubricCriterionKind;
}

// ---------- PAGE:rubrics enums + extended criterion shape ----------
// Declared above callRubrics so the table's column enums can reference them at
// module-init time (const is not hoisted). The tables themselves live in the
// `// >>> PAGE:rubrics START … END` block at EOF.

// Human-authored behavioral descriptor per band (B: behaviorally-anchored).
export interface RubricBandAnchor {
  fail: string;
  pass: string;
  excellent: string;
}
// Backwards-compatible superset of RubricCriterion: adds behavioral anchors,
// required-evidence, and a normalized-weight contract.
export interface RubricCriterionV2 {
  id: string;
  name: string;
  description?: string;
  weight: number; // raw weight; normalized at publish
  kind: RubricCriterionKind;
  bandThresholds: { fail: number; pass: number; excellent: number };
  anchors?: RubricBandAnchor;
  minEvidenceQuotes?: number; // 0..3 required evidence quotes
  autoScoreEnabled: boolean;
}

export const RUBRIC_STATUSES = ["draft", "published", "archived"] as const;
export type RubricStatus = (typeof RUBRIC_STATUSES)[number];

export const RUBRIC_APPLIES_TO = ["call", "coaching", "async_video", "assessment"] as const;
export type RubricAppliesTo = (typeof RUBRIC_APPLIES_TO)[number];

export const RUBRIC_AUDIT_ACTIONS = [
  "created", "updated", "published", "unpublished",
  "archived", "restored", "set_default", "cleared_default",
  "duplicated", "imported", "deleted",
] as const;
export type RubricAuditAction = (typeof RUBRIC_AUDIT_ACTIONS)[number];

export const callRubrics = pgTable(
  "call_rubrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    purpose: text("purpose", { enum: RUBRIC_PURPOSES }).notNull().default("general_screen"),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    criteria: jsonb("criteria").$type<RubricCriterion[]>().notNull().default(sql`'[]'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    // ---- PAGE:rubrics additive columns (immutable versions + lifecycle) ----
    // Lifecycle status. 'draft' = editable head not yet pinned; 'published' =
    // has a frozen call_rubric_versions snapshot; 'archived' = soft-deleted.
    status: text("status", { enum: RUBRIC_STATUSES }).notNull().default("draft"),
    // Which downstream surfaces this rubric applies to.
    appliesTo: text("applies_to", { enum: RUBRIC_APPLIES_TO })
      .array()
      .notNull()
      .default(sql`ARRAY['call']::text[]`),
    // Points into call_rubric_versions.version; NULL until first publish.
    publishedVersion: integer("published_version"),
    description: text("description"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("call_rubrics_org_idx").on(t.orgId, t.purpose),
    byUpdated: index("call_rubrics_org_updated_idx").on(t.orgId, t.updatedAt),
    byStatus: index("call_rubrics_org_status_idx").on(t.orgId, t.status),
    byName: index("call_rubrics_org_name_idx").on(t.orgId, t.name),
  }),
);

export const callRubricScores = pgTable(
  "call_rubric_scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    rubricId: uuid("rubric_id")
      .references(() => callRubrics.id, { onDelete: "cascade" })
      .notNull(),
    criterionId: text("criterion_id").notNull(),
    score: numeric("score").notNull(),
    band: text("band", { enum: ["fail", "pass", "excellent"] }),
    evidenceQuotes: jsonb("evidence_quotes")
      .$type<Array<{ tsStartMs: number; tsEndMs: number; text: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rationale: text("rationale"),
    confidence: numeric("confidence"),
    modelVersion: text("model_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_rubric_scores_call_idx").on(t.callId),
    uniq: uniqueIndex("call_rubric_scores_call_criterion_key").on(t.callId, t.criterionId),
  }),
);

export const TECHNICAL_QA_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type TechnicalQaDifficulty = (typeof TECHNICAL_QA_DIFFICULTIES)[number];

export const TECHNICAL_QA_EVALUATIONS = [
  "correct",
  "partially_correct",
  "incorrect",
  "no_answer",
] as const;
export type TechnicalQaEvaluation = (typeof TECHNICAL_QA_EVALUATIONS)[number];

// LLM-extracted technical question/answer spans from a recruiter-candidate
// call. Surfaces in the QA reviewer drawer + Call Detail "Q&A" tab.
export const callTechnicalQa = pgTable(
  "call_technical_qa",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    questionIndex: integer("question_index").notNull(),
    skill: text("skill"),
    difficulty: text("difficulty", { enum: TECHNICAL_QA_DIFFICULTIES }),
    question: text("question").notNull(),
    answer: text("answer"),
    evaluation: text("evaluation", { enum: TECHNICAL_QA_EVALUATIONS }),
    tsQuestionStartMs: integer("ts_question_start_ms"),
    tsAnswerEndMs: integer("ts_answer_end_ms"),
    rationale: text("rationale"),
    confidence: numeric("confidence"),
    modelVersion: text("model_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_technical_qa_call_idx").on(t.callId, t.questionIndex),
    bySkill: index("call_technical_qa_skill_idx").on(t.skill),
    uniq: uniqueIndex("call_technical_qa_call_question_key").on(t.callId, t.questionIndex),
  }),
);

export const JD_MATCH_VERDICTS = [
  "strong_match",
  "partial_match",
  "weak_match",
  "no_match",
] as const;
export type JdMatchVerdict = (typeof JD_MATCH_VERDICTS)[number];

export const jdMatchRuns = pgTable(
  "jd_match_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id")
      .references(() => candidates.id, { onDelete: "cascade" })
      .notNull(),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    triggeredBy: text("triggered_by", {
      enum: ["manual", "submission", "post_call", "batch"],
    })
      .notNull()
      .default("manual"),
    modelVersion: text("model_version").notNull(),
    overallScore: numeric("overall_score").notNull(),
    mustHavesScore: numeric("must_haves_score"),
    niceToHavesScore: numeric("nice_to_haves_score"),
    experienceFitScore: numeric("experience_fit_score"),
    compensationFitScore: numeric("compensation_fit_score"),
    locationFitScore: numeric("location_fit_score"),
    noticePeriodFitScore: numeric("notice_period_fit_score"),
    semanticScore: numeric("semantic_score"),
    explanation: jsonb("explanation").notNull().default(sql`'[]'::jsonb`),
    gaps: jsonb("gaps").notNull().default(sql`'[]'::jsonb`),
    strengths: jsonb("strengths").notNull().default(sql`'[]'::jsonb`),
    verdict: text("verdict", { enum: JD_MATCH_VERDICTS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byDemand: index("jd_match_runs_demand_idx").on(t.demandId, t.overallScore),
    byCandidate: index("jd_match_runs_candidate_idx").on(t.candidateId, t.createdAt),
  }),
);

export const SUBMISSION_CLIENT_FEEDBACK_DECISIONS = ["forward", "hold", "reject"] as const;
export type SubmissionClientFeedbackDecision =
  (typeof SUBMISSION_CLIENT_FEEDBACK_DECISIONS)[number];

export const submissionClientFeedback = pgTable(
  "submission_client_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .references(() => submissions.id, { onDelete: "cascade" })
      .notNull(),
    clientUserId: uuid("client_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    decision: text("decision", { enum: SUBMISSION_CLIENT_FEEDBACK_DECISIONS }).notNull(),
    note: text("note"),
    proposedInterviewSlots: jsonb("proposed_interview_slots").$type<
      Array<{ slotIso: string; durationMins: number; note?: string }>
    >(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("submission_client_feedback_submission_idx").on(
      t.submissionId,
      t.createdAt,
    ),
    byUser: index("submission_client_feedback_user_idx").on(t.clientUserId),
  }),
);

export const VOICE_AGENT_CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
] as const;
export type VoiceAgentCampaignStatus = (typeof VOICE_AGENT_CAMPAIGN_STATUSES)[number];

export const VOICE_AGENT_TARGET_STATUSES = [
  "queued",
  "dialing",
  "connected",
  "completed",
  "failed",
  "no_answer",
  "cancelled",
] as const;
export type VoiceAgentTargetStatus = (typeof VOICE_AGENT_TARGET_STATUSES)[number];

export const voiceAgentCampaigns = pgTable(
  "voice_agent_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    voiceAgentId: uuid("voice_agent_id")
      .references((): typeof voiceAgents.id => voiceAgents.id, { onDelete: "cascade" })
      .notNull(),
    demandId: uuid("demand_id").references((): typeof demands.id => demands.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    notes: text("notes"),
    status: text("status", { enum: VOICE_AGENT_CAMPAIGN_STATUSES }).notNull().default("draft"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    ratePerMinute: integer("rate_per_minute").notNull().default(10),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("voice_agent_campaigns_org_idx").on(t.orgId, t.status, t.createdAt),
    byAgent: index("voice_agent_campaigns_agent_idx").on(t.voiceAgentId),
  }),
);

export const voiceAgentCallTargets = pgTable(
  "voice_agent_call_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .references(() => voiceAgentCampaigns.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    phone: text("phone").notNull(),
    status: text("status", { enum: VOICE_AGENT_TARGET_STATUSES }).notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    callId: uuid("call_id").references((): typeof callSessions.id => callSessions.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("voice_agent_call_targets_campaign_idx").on(
      t.campaignId,
      t.status,
      t.createdAt,
    ),
    byCandidate: index("voice_agent_call_targets_candidate_idx").on(t.candidateId),
  }),
);

export const MESSAGING_CHANNELS = ["whatsapp", "sms", "email"] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

export const MESSAGING_PROVIDERS = ["mock", "exotel", "twilio", "whatsapp_business"] as const;
export type MessagingProvider = (typeof MESSAGING_PROVIDERS)[number];

export const MESSAGING_STATUSES = ["queued", "sent", "delivered", "failed", "read"] as const;
export type MessagingStatus = (typeof MESSAGING_STATUSES)[number];

export const messagingEvents = pgTable(
  "messaging_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    recruiterUserId: uuid("recruiter_user_id").references(() => users.id, { onDelete: "set null" }),
    channel: text("channel", { enum: MESSAGING_CHANNELS }).notNull(),
    provider: text("provider", { enum: MESSAGING_PROVIDERS }).notNull().default("mock"),
    direction: text("direction", { enum: ["outbound", "inbound"] }).notNull().default("outbound"),
    toAddress: text("to_address").notNull(),
    templateId: text("template_id"),
    body: text("body").notNull(),
    status: text("status", { enum: MESSAGING_STATUSES }).notNull().default("queued"),
    errorMessage: text("error_message"),
    remoteId: text("remote_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => ({
    byCandidate: index("messaging_events_candidate_idx").on(t.candidateId, t.createdAt),
    byOrg: index("messaging_events_org_idx").on(t.orgId, t.createdAt),
  }),
);

export const PROCTOR_SESSION_STATUSES = ["live", "completed", "abandoned"] as const;
export type ProctorSessionStatus = (typeof PROCTOR_SESSION_STATUSES)[number];

export const PROCTOR_REVIEWER_DECISIONS = ["clean", "flagged", "invalidated"] as const;
export type ProctorReviewerDecision = (typeof PROCTOR_REVIEWER_DECISIONS)[number];

export const PROCTOR_EVENT_SEVERITIES = ["low", "medium", "high"] as const;
export type ProctorEventSeverity = (typeof PROCTOR_EVENT_SEVERITIES)[number];

// Live operational state of a session (paused/active/ended). Declared here so
// the additive column on proctorSessions below can reference it.
export const PROCTOR_LIVE_STATES = ["active", "paused", "ended"] as const;
export type ProctorLiveState = (typeof PROCTOR_LIVE_STATES)[number];

export const proctorSessions = pgTable(
  "proctor_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    assessmentAttemptId: uuid("assessment_attempt_id").references(
      (): typeof assessmentAttempts.id => assessmentAttempts.id,
      { onDelete: "cascade" },
    ),
    asyncVideoSubmissionId: uuid("async_video_submission_id").references(
      (): typeof asyncVideoSubmissions.id => asyncVideoSubmissions.id,
      { onDelete: "cascade" },
    ),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    status: text("status", { enum: PROCTOR_SESSION_STATUSES }).notNull().default("live"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    flagCount: integer("flag_count").notNull().default(0),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewerDecision: text("reviewer_decision", { enum: PROCTOR_REVIEWER_DECISIONS }),
    reviewerNotes: text("reviewer_notes"),
    // --- PAGE:proctor additive columns ---
    // Live operational state (distinct from the lifecycle `status`): a live
    // session can be active or paused; ended is set on terminate/end.
    liveState: text("live_state", { enum: PROCTOR_LIVE_STATES }).notNull().default("active"),
    // 0-100, server-computed from weighted instrumentation signals.
    riskScore: integer("risk_score").notNull().default(0),
    policyId: uuid("policy_id").references(
      (): typeof proctorPolicies.id => proctorPolicies.id,
      { onDelete: "set null" },
    ),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown> | null>(),
    assignedReviewerUserId: uuid("assigned_reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewSlaDueAt: timestamp("review_sla_due_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgStatus: index("proctor_sessions_org_status_idx").on(t.orgId, t.status, t.startedAt),
    byAttempt: index("proctor_sessions_attempt_idx").on(t.assessmentAttemptId),
    byAsyncVideo: index("proctor_sessions_av_idx").on(t.asyncVideoSubmissionId),
    byOrgRisk: index("proctor_sessions_org_risk_idx").on(t.orgId, t.riskScore, t.startedAt, t.id),
    byOrgLive: index("proctor_sessions_org_live_idx").on(t.orgId, t.liveState, t.startedAt),
    byAssigned: index("proctor_sessions_assigned_idx").on(t.assignedReviewerUserId, t.reviewSlaDueAt),
  }),
);

export const proctorEvents = pgTable(
  "proctor_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .references(() => proctorSessions.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: PROCTOR_EVENT_SEVERITIES }).notNull().default("low"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    flagged: boolean("flagged").notNull().default(true),
    reviewerAcked: boolean("reviewer_acked").notNull().default(false),
    // --- PAGE:proctor additive columns ---
    // ms from session.startedAt — enables the scrubber's jump-to-moment.
    offsetMs: integer("offset_ms"),
    // optional webcam/screen snapshot blob captured at the moment of the event.
    evidenceBlobKey: text("evidence_blob_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySession: index("proctor_events_session_idx").on(t.sessionId, t.createdAt),
    bySeverity: index("proctor_events_severity_idx").on(t.severity, t.flagged, t.createdAt),
  }),
);

export const ASYNC_VIDEO_SUBMISSION_STATUSES = [
  "invited",
  "started",
  "submitted",
  "reviewed",
  "expired",
] as const;
export type AsyncVideoSubmissionStatus = (typeof ASYNC_VIDEO_SUBMISSION_STATUSES)[number];

export const ASYNC_VIDEO_REVIEWER_DECISIONS = ["forward", "hold", "reject"] as const;
export type AsyncVideoReviewerDecision = (typeof ASYNC_VIDEO_REVIEWER_DECISIONS)[number];

// PAGE:async-video enrichment — campaign lifecycle statuses (extends the legacy
// is_published boolean with a proper draft/published/archived state machine).
export const ASYNC_VIDEO_CAMPAIGN_STATUSES = ["draft", "published", "archived"] as const;
export type AsyncVideoCampaignStatus = (typeof ASYNC_VIDEO_CAMPAIGN_STATUSES)[number];

export const asyncVideoCampaigns = pgTable(
  "async_video_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    demandId: uuid("demand_id").references((): typeof demands.id => demands.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    introText: text("intro_text"),
    prompts: jsonb("prompts")
      .$type<Array<{ id: string; text: string; tag?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    maxSecondsPerPrompt: integer("max_seconds_per_prompt").notNull().default(120),
    maxRetakes: integer("max_retakes").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(false),
    // --- PAGE:async-video additive columns ---
    status: text("status", { enum: ASYNC_VIDEO_CAMPAIGN_STATUSES }).notNull().default("draft"),
    outroText: text("outro_text"),
    introVideoBlobKey: text("intro_video_blob_key"),
    blindReview: boolean("blind_review").notNull().default(false),
    requireDeviceCheck: boolean("require_device_check").notNull().default(true),
    version: integer("version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("async_video_campaigns_org_idx").on(t.orgId, t.isPublished, t.createdAt),
    byOrgStatus: index("async_video_campaigns_org_status_idx").on(t.orgId, t.status, t.createdAt),
  }),
);

export const asyncVideoSubmissions = pgTable(
  "async_video_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    campaignId: uuid("campaign_id")
      .references(() => asyncVideoCampaigns.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    inviteToken: text("invite_token").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", { enum: ASYNC_VIDEO_SUBMISSION_STATUSES }).notNull().default("invited"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    videos: jsonb("videos")
      .$type<Array<{ promptIndex: number; blobKey: string; durationSec: number; recordedAt: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    reviewerDecision: text("reviewer_decision", { enum: ASYNC_VIDEO_REVIEWER_DECISIONS }),
    reviewerNotes: text("reviewer_notes"),
    reviewerScore: integer("reviewer_score"),
    // --- PAGE:async-video additive columns ---
    shortlisted: boolean("shortlisted").notNull().default(false),
    dropOffPromptIndex: integer("drop_off_prompt_index"),
    deviceCheck: jsonb("device_check").$type<{
      camera: boolean;
      mic: boolean;
      bandwidthKbps: number | null;
      checkedAt: string;
    } | null>(),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("async_video_submissions_campaign_idx").on(t.campaignId, t.status, t.createdAt),
    byCandidate: index("async_video_submissions_candidate_idx").on(t.candidateId, t.createdAt),
    byOrgStatus: index("async_video_submissions_org_status_idx").on(t.orgId, t.status, t.createdAt),
    byShortlist: index("async_video_submissions_shortlist_idx").on(t.orgId, t.shortlisted, t.createdAt),
  }),
);

export const ASSESSMENT_ATTEMPT_STATUSES = [
  "invited",
  "started",
  "submitted",
  "reviewed",
  "expired",
  "revoked",
] as const;
export type AssessmentAttemptStatus = (typeof ASSESSMENT_ATTEMPT_STATUSES)[number];

export const ASSESSMENT_TEMPLATE_STATUSES = ["draft", "published", "archived"] as const;
export type AssessmentTemplateStatus = (typeof ASSESSMENT_TEMPLATE_STATUSES)[number];

export interface AssessmentPassBand {
  label: string;
  minPercent: number;
}
export interface AssessmentTemplateSettings {
  scoringMode?: "points" | "percent";
  passBands?: AssessmentPassBand[];
  shuffleSections?: boolean;
  showResultsToCandidate?: boolean;
  allowBacktrack?: boolean;
}
export interface AssessmentProctoringPolicy {
  enabled?: boolean;
  requireWebcam?: boolean;
  requireScreenShare?: boolean;
  requireIdVerification?: boolean;
  lockdownFullscreen?: boolean;
  blockCopyPaste?: boolean;
  flagTabSwitch?: boolean;
  flagMultiFace?: boolean;
  flagNoFace?: boolean;
  flagSecondVoice?: boolean;
  autoFlagThreshold?: number;
}

export const assessmentTemplates = pgTable(
  "assessment_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    questionBankId: uuid("question_bank_id").references((): typeof questionBanks.id => questionBanks.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    durationMins: integer("duration_mins"),
    passScore: integer("pass_score").notNull().default(60),
    questionIds: uuid("question_ids").array().notNull().default(sql`'{}'::uuid[]`),
    isPublished: boolean("is_published").notNull().default(false),
    // Enterprise rebuild: status supersedes is_published; published_version pins
    // attempts to an immutable snapshot; settings + proctoring_policy authored
    // in the builder.
    status: text("status", { enum: ASSESSMENT_TEMPLATE_STATUSES }).notNull().default("draft"),
    publishedVersion: integer("published_version"),
    settings: jsonb("settings").$type<AssessmentTemplateSettings>().notNull().default(sql`'{}'::jsonb`),
    proctoringPolicy: jsonb("proctoring_policy").$type<AssessmentProctoringPolicy>().notNull().default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("assessment_templates_org_idx").on(t.orgId, t.isPublished, t.createdAt),
    byOrgStatus: index("assessment_templates_org_status_idx").on(t.orgId, t.status, t.createdAt),
    byOrgCursor: index("assessment_templates_org_cursor_idx").on(t.orgId, t.createdAt, t.id),
  }),
);

export const assessmentAttempts = pgTable(
  "assessment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: uuid("template_id")
      .references(() => assessmentTemplates.id, { onDelete: "cascade" })
      .notNull(),
    candidateId: uuid("candidate_id").references(() => candidates.id, {
      onDelete: "set null",
    }),
    inviteToken: text("invite_token").notNull().unique(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ASSESSMENT_ATTEMPT_STATUSES }).notNull().default("invited"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    responses: jsonb("responses")
      .$type<
        Array<{
          questionId: string;
          answer: string;
          scoredAt?: string;
          score?: number;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    totalScore: integer("total_score"),
    pass: boolean("pass"),
    reviewerNotes: text("reviewer_notes"),
    // Enterprise rebuild: pin the immutable version, server-authoritative
    // timing for resume + deadline enforcement, and split machine/manual scores.
    versionId: uuid("version_id").references((): typeof assessmentVersions.id => assessmentVersions.id, {
      onDelete: "set null",
    }),
    serverStartedAt: timestamp("server_started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    autoScore: integer("auto_score"),
    manualScore: integer("manual_score"),
    maxScore: integer("max_score"),
    passBand: text("pass_band"),
    itemResults: jsonb("item_results")
      .$type<
        Array<{
          itemId: string;
          type: string;
          awarded: number;
          max: number;
          correct: boolean | null;
          autoGraded: boolean;
          selectedOptionIds?: string[];
          codeRun?: { passed: number; total: number; stderr?: string };
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTemplate: index("assessment_attempts_template_idx").on(t.templateId, t.status, t.createdAt),
    byCandidate: index("assessment_attempts_candidate_idx").on(t.candidateId, t.createdAt),
    byToken: index("assessment_attempts_token_idx").on(t.inviteToken),
    byOrgCursor: index("assessment_attempts_org_cursor_idx").on(t.orgId, t.createdAt, t.id),
    byOrgStatus: index("assessment_attempts_org_status_idx").on(t.orgId, t.status, t.createdAt),
  }),
);

export const COACHING_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type CoachingDifficulty = (typeof COACHING_DIFFICULTIES)[number];

export const COACHING_RUN_STATUSES = [
  "started",
  "live",
  "completed",
  "abandoned",
] as const;
export type CoachingRunStatus = (typeof COACHING_RUN_STATUSES)[number];

// ---------- PAGE:coaching enums + structured shapes (migration 0036) ----------
// Declared above coachingScenarios / coachingRuns so the additive column enums
// can reference them at module-init time. The NEW tables live in the
// `// >>> PAGE:coaching START … END` block at EOF.
export const COACHING_RUN_MODES = ["ai_roleplay", "self_recorded", "live_call"] as const;
export type CoachingRunMode = (typeof COACHING_RUN_MODES)[number];

export const COACHING_SCORE_SOURCES = ["ai", "manual", "ai_overridden"] as const;
export type CoachingScoreSource = (typeof COACHING_SCORE_SOURCES)[number];

export const COACHING_SCORING_STATUSES = ["pending", "scoring", "scored", "failed", "skipped"] as const;
export type CoachingScoringStatus = (typeof COACHING_SCORING_STATUSES)[number];

export const COACHING_LANGUAGES = ["hinglish", "en-IN", "hi-IN"] as const;
export type CoachingLanguage = (typeof COACHING_LANGUAGES)[number];

export const COACHING_SCORE_BANDS = ["fail", "pass", "excellent"] as const;
export type CoachingScoreBand = (typeof COACHING_SCORE_BANDS)[number];

export const COACHING_ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "completed",
  "overdue",
  "waived",
] as const;
export type CoachingAssignmentStatus = (typeof COACHING_ASSIGNMENT_STATUSES)[number];

export const COACHING_AUDIT_ACTIONS = [
  "scenario.created", "scenario.updated", "scenario.published", "scenario.unpublished",
  "scenario.archived", "scenario.duplicated",
  "run.started", "run.linked_call", "run.completed", "run.abandoned",
  "run.scored", "run.score_overridden",
  "curriculum.created", "curriculum.updated", "curriculum.archived",
  "assignment.created", "assignment.completed", "assignment.waived", "assignment.due_changed",
] as const;
export type CoachingAuditAction = (typeof COACHING_AUDIT_ACTIONS)[number];

// Structured persona shape (was free-form jsonb; keep jsonb but type it).
export interface CoachingPersona {
  candidateName?: string;
  candidateRole?: string;
  yearsExperience?: number;
  currentCompany?: string;
  currentCtcLakhs?: number;
  expectedCtcLakhs?: number;
  noticePeriodDays?: number;
  location?: string;
  speakingStyle?: "concise" | "verbose" | "evasive" | "warm";
  mood?: string;
  resistance?: "low" | "medium" | "high";
  hiddenContext?: string; // not revealed unless probed
  objections?: string[]; // scripted pushbacks the AI raises
  redFlags?: string[];
  openingLine?: string; // AI candidate's firstMessage
  language?: CoachingLanguage;
}

export interface CoachingSuccessCriterion {
  id: string;
  label: string;
  weight: number;
}

export interface CoachingRunFeedback {
  strengths: string[];
  improvements: string[];
  perCriterion?: Array<{
    criterionId: string;
    criterionName: string;
    score: number;
    band?: CoachingScoreBand;
    evidence?: string;
  }>;
  coachNote?: string;
  modelVersion?: string; // e.g. "gpt-4o-mini" or "stub-v1"
  generatedBy?: "ai" | "stub" | "manual";
}

export const coachingScenarios = pgTable(
  "coaching_scenarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    difficulty: text("difficulty", { enum: COACHING_DIFFICULTIES }).notNull().default("medium"),
    candidatePersona: jsonb("candidate_persona").$type<CoachingPersona>().notNull().default(sql`'{}'::jsonb`),
    targetRubricId: uuid("target_rubric_id").references(() => callRubrics.id, { onDelete: "set null" }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    isPublished: boolean("is_published").notNull().default(false),
    // ---- PAGE:coaching additive columns (migration 0036) ----
    language: text("language", { enum: COACHING_LANGUAGES }).notNull().default("hinglish"),
    openingLine: text("opening_line"),
    objections: jsonb("objections").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    successCriteria: jsonb("success_criteria").$type<CoachingSuccessCriterion[]>().notNull().default(sql`'[]'::jsonb`),
    estimatedMinutes: integer("estimated_minutes").notNull().default(8),
    version: integer("version").notNull().default(1),
    publishedVersion: integer("published_version"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgList: index("coaching_scenarios_org_list_idx").on(
      t.orgId,
      t.archivedAt,
      t.isPublished,
      t.difficulty,
      t.createdAt,
    ),
  }),
);

export const coachingRuns = pgTable(
  "coaching_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    scenarioId: uuid("scenario_id")
      .references(() => coachingScenarios.id, { onDelete: "cascade" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    callId: uuid("call_id").references((): typeof callSessions.id => callSessions.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: COACHING_RUN_STATUSES }).notNull().default("started"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cachedOverallScore: numeric("cached_overall_score"),
    feedback: jsonb("feedback").$type<CoachingRunFeedback>(),
    // ---- PAGE:coaching additive columns (migration 0036) ----
    mode: text("mode", { enum: COACHING_RUN_MODES }).notNull().default("ai_roleplay"),
    // FK to coaching_assignments added in SQL migration (table defined at EOF;
    // a Drizzle forward-ref here would create a module-init cycle).
    assignmentId: uuid("assignment_id"),
    scenarioVersion: integer("scenario_version"),
    scoreSource: text("score_source", { enum: COACHING_SCORE_SOURCES }),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    scoringStatus: text("scoring_status", { enum: COACHING_SCORING_STATUSES }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byScenario: index("coaching_runs_scenario_idx").on(t.scenarioId, t.startedAt),
    byRecruiter: index("coaching_runs_recruiter_idx").on(t.recruiterUserId, t.startedAt),
    byCall: index("coaching_runs_call_idx").on(t.callId),
    runIdem: uniqueIndex("coaching_runs_idem_uq").on(t.orgId, t.recruiterUserId, t.idempotencyKey),
  }),
);

export const QUESTION_LEVELS = ["junior", "mid", "senior", "staff"] as const;

// Question-bank enterprise enums (migration 0034). Declared here so the existing
// questionBanks / questionBankQuestions pgTable definitions can adopt the new
// governance/tagging columns; the five NEW tables in the PAGE:question-bank
// block at EOF reuse these same consts.
export const QUESTION_BANK_STATUSES = ["active", "archived"] as const;
export const QUESTION_STATUSES = ["draft", "in_review", "approved", "rejected", "archived"] as const;
export const QUESTION_LANGUAGES = ["en", "hi", "hinglish"] as const;
export const QUESTION_TYPES = ["verbal", "mcq_single", "mcq_multi", "true_false", "short_answer", "coding"] as const;

export type QuestionOption = { id: string; text: string; correct: boolean };

export const questionBanks = pgTable(
  "question_banks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Enterprise rebuild (0034): governance + soft-archive + concurrency token.
    status: text("status", { enum: QUESTION_BANK_STATUSES }).notNull().default("active"),
    defaultLanguage: text("default_language").notNull().default("en"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("question_banks_org_idx").on(t.orgId),
    byOrgStatus: index("question_banks_org_status_idx").on(t.orgId, t.status, t.updatedAt),
  }),
);

export const questionBankQuestions = pgTable(
  "question_bank_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankId: uuid("bank_id")
      .references(() => questionBanks.id, { onDelete: "cascade" })
      .notNull(),
    // Denormalized org_id (0034) for org-scoped list/filter without a join.
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    level: text("level", { enum: QUESTION_LEVELS }),
    difficulty: integer("difficulty"),
    prompt: text("prompt").notNull(),
    expectedAnswerHints: text("expected_answer_hints"),
    evaluationRubric: jsonb("evaluation_rubric").notNull().default(sql`'[]'::jsonb`),
    followUpQuestions: jsonb("follow_up_questions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    commonMistakes: jsonb("common_mistakes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    // Enterprise rebuild (0034): lifecycle + tagging + version + dedup + calibration cache.
    status: text("status", { enum: QUESTION_STATUSES }).notNull().default("draft"),
    language: text("language", { enum: QUESTION_LANGUAGES }).notNull().default("en"),
    questionType: text("question_type", { enum: QUESTION_TYPES }).notNull().default("verbal"),
    roleFamily: text("role_family"),
    options: jsonb("options").$type<QuestionOption[]>().notNull().default(sql`'[]'::jsonb`),
    currentVersion: integer("current_version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    calibratedDifficulty: numeric("calibrated_difficulty", { precision: 4, scale: 3 }),
    exposureCount: integer("exposure_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byBank: index("qbq_bank_idx").on(t.bankId),
    bySkill: index("qbq_skill_idx").on(t.skillId),
    byOrgStatus: index("qbq_org_status_idx").on(t.orgId, t.status, t.createdAt),
    byOrgLang: index("qbq_org_lang_idx").on(t.orgId, t.language),
    byOrgRole: index("qbq_org_role_idx").on(t.orgId, t.roleFamily),
    byOrgHash: index("qbq_org_hash_idx").on(t.orgId, t.contentHash),
    byBankStatus: index("qbq_bank_status_idx").on(t.bankId, t.status),
    byOrgKeyset: index("qbq_org_keyset_idx").on(t.orgId, t.createdAt, t.id),
  }),
);

export const questionBankDemandLinks = pgTable(
  "question_bank_demand_links",
  {
    bankId: uuid("bank_id")
      .references(() => questionBanks.id, { onDelete: "cascade" })
      .notNull(),
    demandId: uuid("demand_id")
      .references(() => demands.id, { onDelete: "cascade" })
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bankId, t.demandId] }),
  }),
);

// ---------- Manual speaker brackets (live-assist) ----------

export const transcriptSpeakerBrackets = pgTable(
  "transcript_speaker_brackets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    speaker: text("speaker", { enum: ["recruiter", "candidate"] }).notNull(),
    tsMs: integer("ts_ms").notNull(),
    source: text("source", { enum: ["manual", "diarize", "vapi"] }).notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("transcript_speaker_brackets_call_idx").on(t.callId, t.tsMs),
  }),
);

// ---------- Offer Letter MySQL sync (heartbeats + outbox) ----------

export const offerLetterSyncHeartbeats = pgTable(
  "offer_letter_sync_heartbeats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    queueName: text("queue_name").notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }).defaultNow().notNull(),
    rowsUpserted: integer("rows_upserted").notNull().default(0),
    durationMs: integer("duration_ms"),
    lastError: text("last_error"),
  },
  (t) => ({
    byOrgQueue: uniqueIndex("offer_letter_sync_heartbeats_org_queue_uniq").on(
      t.orgId,
      t.queueName,
    ),
    byQueue: index("offer_letter_sync_heartbeats_queue_idx").on(t.queueName, t.lastRunAt),
  }),
);

export const OFFER_LETTER_OUTBOX_TARGETS = [
  "applied_jobs",
  "candidate_create",
  "workflow_status",
] as const;
export type OfferLetterOutboxTarget = (typeof OFFER_LETTER_OUTBOX_TARGETS)[number];

export const offerLetterOutbox = pgTable(
  "offer_letter_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    target: text("target", { enum: OFFER_LETTER_OUTBOX_TARGETS }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sourceTable: text("source_table"),
    sourceRowId: uuid("source_row_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pendingIdx: index("offer_letter_outbox_pending_idx").on(t.createdAt),
  }),
);

export const PGVECTOR_INIT_SQL = sql`
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
`;

export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000000";

// Stable id for the JoulesToWatts production tenant. Distinct from the demo
// org so seed scripts can scope their truncates to DEFAULT_ORG_ID without
// touching real data synced from the Offer Letter MySQL. The id matches
// the row inserted by migration 0013_joulestowatts_org.sql.
export const JOULESTOWATTS_ORG_ID = "a6e9e1cc-9e75-4b7e-95b8-7e7eb854fdd3";
export const JOULESTOWATTS_ORG_SLUG = "joulestowatts";
export const JOULESTOWATTS_ADMIN_EMAIL = "cognition.engine@joulestowatts.com";

// Dedicated tenant for the marketing-video walkthrough. Carries rich,
// production-like synthetic data across every page so demos don't have to
// dodge empty states. Created and wiped exclusively by `pnpm db:seed-demo`;
// other seed scripts must not touch it.
export const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_ORG_SLUG = "recruitassist-demo";
export const DEMO_ORG_NAME = "RecruitAssist Demo (Acme GCC)";
export const DEMO_ADMIN_EMAIL = "demo@demo.recruitassist.local";
export const DEMO_USER_EMAIL_DOMAIN = "demo.recruitassist.local";

// >>> PAGE:rubrics START
// Immutable published snapshots. A call_rubric_score / qa-review pins to
// (rubricId, version) so historical scores never drift when the draft head is
// edited. The enums + criterion shapes (RUBRIC_STATUSES, RUBRIC_APPLIES_TO,
// RUBRIC_AUDIT_ACTIONS, RubricCriterionV2, …) are declared above callRubrics.

export const callRubricVersions = pgTable(
  "call_rubric_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    rubricId: uuid("rubric_id")
      .references(() => callRubrics.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    criteria: jsonb("criteria").$type<RubricCriterionV2[]>().notNull().default(sql`'[]'::jsonb`),
    purpose: text("purpose", { enum: RUBRIC_PURPOSES }).notNull(),
    name: text("name").notNull(),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    changeNote: text("change_note"),
  },
  (t) => ({
    byRubricVersion: uniqueIndex("call_rubric_versions_rubric_version_key").on(t.rubricId, t.version),
    byOrg: index("call_rubric_versions_org_idx").on(t.orgId, t.rubricId),
  }),
);

// Append-only audit. Never UPDATEd or DELETEd (a DB trigger enforces this).
// One row per rubric state change. rubric_id is ON DELETE SET NULL (with a
// snapshot rubric_name) so a deletion trace survives the rubric row going away.
export const rubricAuditLog = pgTable(
  "rubric_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    rubricId: uuid("rubric_id").references(() => callRubrics.id, { onDelete: "set null" }),
    rubricName: text("rubric_name"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: RUBRIC_AUDIT_ACTIONS }).notNull(),
    fromVersion: integer("from_version"),
    toVersion: integer("to_version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRubric: index("rubric_audit_log_rubric_idx").on(t.rubricId, t.createdAt),
    byOrg: index("rubric_audit_log_org_idx").on(t.orgId, t.createdAt),
  }),
);

// Page-private idempotency ledger for create/publish/duplicate/import. Keyed by
// (org_id, key); a conflicting key returns the previously-created resource.
export const rubricIdempotencyKeys = pgTable(
  "rubric_idempotency_keys",
  {
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    key: text("key").notNull(),
    createdRubricId: uuid("created_rubric_id").references(() => callRubrics.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.key] }),
  }),
);
// >>> PAGE:rubrics END

// >>> PAGE:assessment START
// Assessment Authoring enterprise rebuild. The question_bank stays the reusable
// item library; an assessment owns an ordered, versioned, typed composition of
// items (assessment_items) grouped into sections (assessment_sections). Publish
// freezes an immutable snapshot (assessment_versions) that attempts pin. Every
// state change writes an append-only assessment_audit_log row.

export const ASSESSMENT_ITEM_TYPES = [
  "mcq_single",
  "mcq_multi",
  "true_false",
  "short_answer",
  "long_answer",
  "coding",
  "file_upload",
  "video_response",
] as const;
export type AssessmentItemType = (typeof ASSESSMENT_ITEM_TYPES)[number];

export const AUTO_GRADABLE_ITEM_TYPES = [
  "mcq_single",
  "mcq_multi",
  "true_false",
  "coding",
] as const;

// Sections group items; section-level timing/shuffle/pool overrides apply.
export const assessmentSections = pgTable(
  "assessment_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: uuid("template_id")
      .references(() => assessmentTemplates.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    // null = inherit template-level limit; >0 = per-section countdown in seconds
    timeLimitSeconds: integer("time_limit_seconds"),
    shuffleItems: boolean("shuffle_items").notNull().default(false),
    // 0/null = use all items; N = randomly draw N items from this section's pool
    poolDrawCount: integer("pool_draw_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTemplate: index("assessment_sections_template_idx").on(t.templateId, t.position),
    byOrg: index("assessment_sections_org_idx").on(t.orgId),
  }),
);

// The builder's source of truth. Items may be authored inline OR sourced from a
// question_bank question (sourceQuestionId), but the assessment ALWAYS owns its
// own typed copy so editing the bank later doesn't mutate a published exam.
export const assessmentItems = pgTable(
  "assessment_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: uuid("template_id")
      .references(() => assessmentTemplates.id, { onDelete: "cascade" })
      .notNull(),
    sectionId: uuid("section_id").references(() => assessmentSections.id, {
      onDelete: "set null",
    }),
    sourceQuestionId: uuid("source_question_id").references(
      (): typeof questionBankQuestions.id => questionBankQuestions.id,
      { onDelete: "set null" },
    ),
    type: text("type", { enum: ASSESSMENT_ITEM_TYPES }).notNull(),
    position: integer("position").notNull().default(0),
    prompt: text("prompt").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    points: integer("points").notNull().default(1),
    negativePoints: integer("negative_points").notNull().default(0),
    partialCredit: boolean("partial_credit").notNull().default(false),
    required: boolean("required").notNull().default(true),
    timeLimitSeconds: integer("time_limit_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTemplate: index("assessment_items_template_idx").on(t.templateId, t.position),
    bySection: index("assessment_items_section_idx").on(t.sectionId, t.position),
    byOrg: index("assessment_items_org_idx").on(t.orgId),
    bySource: index("assessment_items_source_idx").on(t.sourceQuestionId),
  }),
);

// Immutable publish snapshots. Publishing freezes the current items+sections+
// settings into `snapshot`. Attempts pin a versionId so in-flight exams are
// unaffected by later edits. version numbers are monotonic per template.
export const assessmentVersions = pgTable(
  "assessment_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    templateId: uuid("template_id")
      .references(() => assessmentTemplates.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    // Full frozen exam: { settings, sections:[...], items:[...incl answer keys] }
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTemplateVersion: uniqueIndex("assessment_versions_template_version_uq").on(
      t.templateId,
      t.version,
    ),
    byOrg: index("assessment_versions_org_idx").on(t.orgId),
  }),
);

// Append-only audit of every state change on templates/items/attempts/invites.
export const ASSESSMENT_AUDIT_ACTIONS = [
  "template.created",
  "template.updated",
  "template.published",
  "template.unpublished",
  "template.duplicated",
  "template.archived",
  "item.created",
  "item.updated",
  "item.deleted",
  "item.reordered",
  "invite.created",
  "invite.resent",
  "invite.revoked",
  "attempt.started",
  "attempt.submitted",
  "attempt.autograded",
  "attempt.reviewed",
  "attempt.reopened",
] as const;
export type AssessmentAuditAction = (typeof ASSESSMENT_AUDIT_ACTIONS)[number];

export const assessmentAuditLog = pgTable(
  "assessment_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    action: text("action", { enum: ASSESSMENT_AUDIT_ACTIONS }).notNull(),
    // polymorphic target: 'template' | 'item' | 'attempt' | 'version'
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id"),
    templateId: uuid("template_id").references(() => assessmentTemplates.id, {
      onDelete: "cascade",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    // null actor = candidate-side (token) action
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTemplate: index("assessment_audit_template_idx").on(t.templateId, t.createdAt),
    byOrg: index("assessment_audit_org_idx").on(t.orgId, t.createdAt),
    byTarget: index("assessment_audit_target_idx").on(t.targetKind, t.targetId),
  }),
);

// Shared idempotency-key store for create/invite/send. Created IF NOT EXISTS in
// the migration so cross-page co-creation is safe.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.scope, t.key] }),
  }),
);
// >>> PAGE:assessment END

// >>> PAGE:async-video START
// Enterprise rebuild of the Async Video Interview surface. The legacy
// async_video_campaigns / async_video_submissions tables are preserved and
// extended in place (see the additive columns above); these child tables
// normalize ordered questions, per-reviewer scorecards, reviewer comment
// threads, AI artifacts, expiring share links, and an append-only audit log.
// All are org-scoped (org_id NOT NULL), FK-bound, CHECK-constrained, and
// indexed on every filter/sort path.

export const ASYNC_VIDEO_QUESTION_KINDS = ["video", "audio"] as const;
export type AsyncVideoQuestionKind = (typeof ASYNC_VIDEO_QUESTION_KINDS)[number];

export const ASYNC_VIDEO_RECOMMENDATIONS = [
  "strong_yes",
  "yes",
  "maybe",
  "no",
  "strong_no",
] as const;
export type AsyncVideoRecommendation = (typeof ASYNC_VIDEO_RECOMMENDATIONS)[number];

export const ASYNC_VIDEO_AI_KINDS = ["transcript", "summary", "skills"] as const;
export type AsyncVideoAiKind = (typeof ASYNC_VIDEO_AI_KINDS)[number];

export const ASYNC_VIDEO_AI_STATUSES = ["queued", "running", "ready", "failed", "skipped"] as const;
export type AsyncVideoAiStatus = (typeof ASYNC_VIDEO_AI_STATUSES)[number];

export const ASYNC_VIDEO_AUDIT_TARGET_TYPES = [
  "campaign",
  "submission",
  "scorecard",
  "share_link",
  "invite",
] as const;
export type AsyncVideoAuditTargetType = (typeof ASYNC_VIDEO_AUDIT_TARGET_TYPES)[number];

// Ordered question rows (normalizes the legacy prompts jsonb).
export const asyncVideoQuestions = pgTable(
  "async_video_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    campaignId: uuid("campaign_id")
      .references(() => asyncVideoCampaigns.id, { onDelete: "cascade" })
      .notNull(),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ASYNC_VIDEO_QUESTION_KINDS }).notNull().default("video"),
    text: text("text").notNull(),
    stimulusText: text("stimulus_text"),
    stimulusBlobKey: text("stimulus_blob_key"),
    prepSeconds: integer("prep_seconds").notNull().default(30),
    maxSeconds: integer("max_seconds").notNull().default(120),
    maxRetakes: integer("max_retakes").notNull().default(0),
    // The rubrics page stores criteria as JSONB on call_rubrics; there is no
    // standalone rubric_criteria table, so we store a free-text competency key
    // rather than an FK (per the spec's fallback note).
    competencyKey: text("competency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("async_video_questions_campaign_idx").on(t.campaignId, t.position),
    byOrg: index("async_video_questions_org_idx").on(t.orgId),
    uqPos: uniqueIndex("async_video_questions_campaign_pos_uq").on(t.campaignId, t.position),
  }),
);

// Expiring shareable review links (external scoring). Declared before
// scorecards so the share_link_id FK below resolves.
export const asyncVideoShareLinks = pgTable(
  "async_video_share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: uuid("submission_id")
      .references(() => asyncVideoSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    token: text("token").notNull().unique(),
    label: text("label"),
    canScore: boolean("can_score").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("async_video_share_links_submission_idx").on(t.submissionId, t.expiresAt),
    byOrg: index("async_video_share_links_org_idx").on(t.orgId),
  }),
);

// Per-reviewer scorecards (multi-reviewer, blind).
export const asyncVideoScorecards = pgTable(
  "async_video_scorecards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: uuid("submission_id")
      .references(() => asyncVideoSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    externalReviewerLabel: text("external_reviewer_label"),
    shareLinkId: uuid("share_link_id").references(() => asyncVideoShareLinks.id, {
      onDelete: "set null",
    }),
    questionScores: jsonb("question_scores")
      .$type<Array<{ questionId: string; score: number; note?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    overallScore: real("overall_score"),
    recommendation: text("recommendation", { enum: ASYNC_VIDEO_RECOMMENDATIONS }),
    summaryNote: text("summary_note"),
    submitted: boolean("submitted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("async_video_scorecards_submission_idx").on(t.submissionId, t.submitted),
    byReviewer: index("async_video_scorecards_reviewer_idx").on(t.reviewerUserId, t.createdAt),
    byOrg: index("async_video_scorecards_org_idx").on(t.orgId),
    uqReviewer: uniqueIndex("async_video_scorecards_sub_reviewer_uq")
      .on(t.submissionId, t.reviewerUserId)
      .where(sql`reviewer_user_id IS NOT NULL`),
  }),
);

// Threaded comments on a submission (reviewer discussion + jump-to-moment).
export const asyncVideoComments = pgTable(
  "async_video_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: uuid("submission_id")
      .references(() => asyncVideoSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    questionId: uuid("question_id").references(() => asyncVideoQuestions.id, { onDelete: "set null" }),
    timestampSec: integer("timestamp_sec"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("async_video_comments_submission_idx").on(t.submissionId, t.createdAt),
    byOrg: index("async_video_comments_org_idx").on(t.orgId),
  }),
);

// AI artifacts (transcript / summary / skills) — always labeled AI in the UI.
export const asyncVideoAiArtifacts = pgTable(
  "async_video_ai_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    submissionId: uuid("submission_id")
      .references(() => asyncVideoSubmissions.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id").references(() => asyncVideoQuestions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ASYNC_VIDEO_AI_KINDS }).notNull(),
    status: text("status", { enum: ASYNC_VIDEO_AI_STATUSES }).notNull().default("queued"),
    provider: text("provider"),
    model: text("model"),
    content: jsonb("content").$type<unknown>(),
    errorText: text("error_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySubmission: index("async_video_ai_submission_idx").on(t.submissionId, t.kind, t.status),
    byOrg: index("async_video_ai_org_idx").on(t.orgId),
  }),
);

// Append-only audit of every state change.
export const asyncVideoAuditLog = pgTable(
  "async_video_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorLabel: text("actor_label"),
    action: text("action").notNull(),
    targetType: text("target_type", { enum: ASYNC_VIDEO_AUDIT_TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byTarget: index("async_video_audit_target_idx").on(t.targetType, t.targetId, t.createdAt),
    byOrg: index("async_video_audit_org_idx").on(t.orgId, t.createdAt),
  }),
);
// >>> PAGE:async-video END

// >>> PAGE:proctor START
// Proctor cockpit enterprise build: per-assessment proctoring policies,
// identity-verification evidence, live/recorded interventions, and an
// append-only chain-of-custody audit. The legacy proctorSessions/proctorEvents
// tables (above) are extended additively, not replaced. All tables are
// org-scoped (org_id NOT NULL), FK-bound, CHECK-constrained, and indexed on
// every filter/sort/cursor path.

// Instrumentation signal kinds the candidate runtime can report. Each maps to a
// per-policy severity + weight that feeds the cumulative session risk score.
export const PROCTOR_SIGNAL_KINDS = [
  "tab_switch",
  "window_blur",
  "fullscreen_exit",
  "copy",
  "paste",
  "multi_face",
  "no_face",
  "face_mismatch",
  "other_voice",
  "second_device",
  "network_drop",
  "vm_detected",
  "remote_tool",
  "screen_share_lost",
  "id_photo_captured",
  "env_scan_captured",
] as const;
export type ProctorSignalKind = (typeof PROCTOR_SIGNAL_KINDS)[number];

export const PROCTOR_INTERVENTION_KINDS = [
  "chat",
  "broadcast",
  "pause",
  "resume",
  "extend",
  "terminate",
  "warn",
] as const;
export type ProctorInterventionKind = (typeof PROCTOR_INTERVENTION_KINDS)[number];

export const PROCTOR_IDENTITY_STATUSES = ["pending", "verified", "mismatch", "skipped"] as const;
export type ProctorIdentityStatus = (typeof PROCTOR_IDENTITY_STATUSES)[number];

export const PROCTOR_AUDIT_ACTIONS = [
  "session.view",
  "session.review",
  "session.assign",
  "session.terminate",
  "session.pause",
  "session.resume",
  "session.extend",
  "event.ack",
  "evidence.export",
  "evidence.view",
  "identity.verify",
  "policy.update",
  "intervention.send",
] as const;
export type ProctorAuditAction = (typeof PROCTOR_AUDIT_ACTIONS)[number];

export const PROCTOR_SIGNAL_SEVERITIES = ["low", "medium", "high"] as const;
export type ProctorSignalSeverity = (typeof PROCTOR_SIGNAL_SEVERITIES)[number];

export interface ProctorSignalConfigEntry {
  armed: boolean;
  severity: ProctorSignalSeverity;
  weight: number;
}
export type ProctorSignalConfig = Record<string, ProctorSignalConfigEntry>;

// Per-assessment / org-default proctoring policy. A session snapshots the policy
// it was created under (policySnapshot jsonb on the session) so later policy
// edits never rewrite history.
export const proctorPolicies = pgTable(
  "proctor_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    // null assessmentTemplateId => org-default policy. Partial unique index
    // enforces one default per org + one policy per template.
    assessmentTemplateId: uuid("assessment_template_id").references(
      (): typeof assessmentTemplates.id => assessmentTemplates.id,
      { onDelete: "cascade" },
    ),
    isDefault: boolean("is_default").notNull().default(false),
    signalConfig: jsonb("signal_config")
      .$type<ProctorSignalConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    requireIdentity: boolean("require_identity").notNull().default(true),
    requireWebcam: boolean("require_webcam").notNull().default(true),
    requireScreen: boolean("require_screen").notNull().default(false),
    lockdownBrowser: boolean("lockdown_browser").notNull().default(false),
    autoFlagRiskScore: integer("auto_flag_risk_score").notNull().default(40),
    autoTerminateRiskScore: integer("auto_terminate_risk_score"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("proctor_policies_org_idx").on(t.orgId, t.updatedAt),
    byTemplate: index("proctor_policies_template_idx").on(t.assessmentTemplateId),
  }),
);

// Identity-verification evidence captured at session start. One per session.
export const proctorIdentityChecks = pgTable(
  "proctor_identity_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: uuid("session_id")
      .references(() => proctorSessions.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status", { enum: PROCTOR_IDENTITY_STATUSES }).notNull().default("pending"),
    idPhotoBlobKey: text("id_photo_blob_key"),
    selfieBlobKey: text("selfie_blob_key"),
    envScanBlobKey: text("env_scan_blob_key"),
    matchScore: integer("match_score"),
    matchProvider: text("match_provider"),
    notes: text("notes"),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySession: index("proctor_identity_session_idx").on(t.sessionId),
    byOrgStatus: index("proctor_identity_org_status_idx").on(t.orgId, t.status),
  }),
);

// Live + recorded interventions the proctor takes on a session. Append-only.
export const proctorInterventions = pgTable(
  "proctor_interventions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: uuid("session_id")
      .references(() => proctorSessions.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind", { enum: PROCTOR_INTERVENTION_KINDS }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    message: text("message"),
    extendSeconds: integer("extend_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySession: index("proctor_interventions_session_idx").on(t.sessionId, t.createdAt),
  }),
);

// Append-only chain-of-custody / activity audit for EVERY state change & access.
export const proctorAuditEvents = pgTable(
  "proctor_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: uuid("session_id").references(() => proctorSessions.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: PROCTOR_AUDIT_ACTIONS }).notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("proctor_audit_org_idx").on(t.orgId, t.createdAt),
    bySession: index("proctor_audit_session_idx").on(t.sessionId, t.createdAt),
  }),
);
// >>> PAGE:proctor END

// >>> PAGE:triage START

// Immutable, published snapshots of a flow's complete routing rule set.
// Editing produces a new draft; publishing freezes a numbered version that the
// /route engine pins to. Rollback re-publishes an older snapshot's rules.
export const TRIAGE_RULESET_STATUSES = ["draft", "published", "archived"] as const;
export type TriageRulesetStatus = (typeof TRIAGE_RULESET_STATUSES)[number];

export const triageRuleSets = pgTable(
  "triage_rule_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    triageAgentId: uuid("triage_agent_id")
      .references(() => voiceAgents.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(), // monotonic per (orgId, triageAgentId)
    status: text("status", { enum: TRIAGE_RULESET_STATUSES }).notNull().default("draft"),
    // Full frozen rule array at publish time (denormalized for /route + dry-run
    // replay without joining the live mutable rules table).
    rulesSnapshot: jsonb("rules_snapshot").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    note: text("note"), // changelog entry the publisher typed
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byAgentVersion: uniqueIndex("triage_rule_sets_agent_version_uidx").on(
      t.orgId,
      t.triageAgentId,
      t.version,
    ),
    byAgentStatus: index("triage_rule_sets_agent_status_idx").on(
      t.orgId,
      t.triageAgentId,
      t.status,
    ),
  }),
);

// Append-only audit of every configuration state change (rule edit, publish,
// rollback, flow status flip, live-call override/reassign/terminate). NEVER
// updated or deleted. This is the A7 audit requirement + A9 config timeline.
export const TRIAGE_AUDIT_ACTIONS = [
  "ruleset.saved_draft",
  "ruleset.published",
  "ruleset.rolled_back",
  "flow.status_changed",
  "flow.archived",
  "session.reassigned",
  "session.classification_overridden",
  "session.terminated",
  "dryrun.executed",
] as const;
export type TriageAuditAction = (typeof TRIAGE_AUDIT_ACTIONS)[number];

export const triageAuditEvents = pgTable(
  "triage_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    triageAgentId: uuid("triage_agent_id").references(() => voiceAgents.id, {
      onDelete: "set null",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: TRIAGE_AUDIT_ACTIONS }).notNull(),
    targetType: text("target_type"), // 'rule_set' | 'flow' | 'call_session' | 'rule'
    targetId: text("target_id"),
    // Compact before/after diff or operation payload. Never PII beyond callerRef.
    diff: jsonb("diff").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgAt: index("triage_audit_events_org_at_idx").on(t.orgId, t.createdAt),
    byAgentAt: index("triage_audit_events_agent_at_idx").on(t.triageAgentId, t.createdAt),
  }),
);
// >>> PAGE:triage END

// >>> PAGE:recruiters START
// Enterprise recruiter-management surface (/recruiters): quarterly goals/targets,
// per-recruiter capacity caps (over-allocation warnings), configurable+fairness-
// guarded saved leaderboards, manager→recruiter nudges (idempotent), and an
// append-only audit of every management state change. All org-scoped
// (org_id NOT NULL), FK-bound, CHECK-constrained, indexed on every filter/sort
// path. KPI aggregates themselves are computed live off submissions / call_sessions
// / demand_assignments — these tables hold only the manager-authored config + audit.

export const RECRUITER_GOAL_METRICS = [
  "submissions", // count of submissions created in period
  "client_submits", // submissions reaching client_submit+
  "selects", // l*_select / final_select
  "offers", // offer_released+
  "joins", // onboarded
  "calls", // call_sessions
  "conversion_rate", // selects / submissions (target stored as basis points 0..10000)
] as const;
export type RecruiterGoalMetric = (typeof RECRUITER_GOAL_METRICS)[number];

export const RECRUITER_GOAL_PERIODS = ["weekly", "monthly", "quarterly"] as const;
export type RecruiterGoalPeriod = (typeof RECRUITER_GOAL_PERIODS)[number];

export const recruiterGoals = pgTable(
  "recruiter_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    metric: text("metric", { enum: RECRUITER_GOAL_METRICS }).notNull(),
    period: text("period", { enum: RECRUITER_GOAL_PERIODS }).notNull(),
    periodStart: date("period_start").notNull(), // inclusive
    periodEnd: date("period_end").notNull(), // exclusive
    targetValue: integer("target_value").notNull(), // count, or basis-points for rate metrics
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }), // soft-delete
  },
  (t) => ({
    byOrgRecruiter: index("recruiter_goals_org_recruiter_idx").on(t.orgId, t.recruiterUserId),
    byOrgPeriod: index("recruiter_goals_org_period_idx").on(t.orgId, t.periodStart, t.periodEnd),
    // one live goal per (recruiter, metric, period window)
    uniqLive: uniqueIndex("recruiter_goals_uniq_live")
      .on(t.recruiterUserId, t.metric, t.periodStart, t.periodEnd)
      .where(sql`archived_at IS NULL`),
  }),
);

export const recruiterCapacity = pgTable(
  "recruiter_capacity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    maxActiveDemands: integer("max_active_demands").notNull().default(8),
    maxActiveProspects: integer("max_active_prospects").notNull().default(40),
    weeklyCallTarget: integer("weekly_call_target").notNull().default(25),
    notes: text("notes"),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqRecruiter: uniqueIndex("recruiter_capacity_uniq").on(t.orgId, t.recruiterUserId),
  }),
);

export const recruiterLeaderboards = pgTable(
  "recruiter_leaderboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    // ordered metric weights + window + fairness guards; validated app-side by Zod.
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    isShared: boolean("is_shared").notNull().default(false), // org-wide vs owner only
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("recruiter_leaderboards_org_idx").on(t.orgId, t.updatedAt),
  }),
);

export const RECRUITER_NUDGE_KINDS = ["coaching", "sla_breach", "capacity", "goal", "kudos"] as const;
export type RecruiterNudgeKind = (typeof RECRUITER_NUDGE_KINDS)[number];

export const recruiterNudges = pgTable(
  "recruiter_nudges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind", { enum: RECRUITER_NUDGE_KINDS }).notNull(),
    message: text("message").notNull(),
    delivery: text("delivery").notNull().default("in_app_only"), // in_app_only | email
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRecruiter: index("recruiter_nudges_recruiter_idx").on(t.recruiterUserId, t.createdAt),
    uniqIdem: uniqueIndex("recruiter_nudges_idem_uniq")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

// Append-only audit of recruiter-management state changes. Page-local so A7/A9
// are satisfied without coupling to the global audit_log; feeds the detail-page
// activity timeline.
export const RECRUITER_ADMIN_ACTIONS = [
  "goal.set",
  "goal.update",
  "goal.archive",
  "capacity.set",
  "leaderboard.save",
  "leaderboard.update",
  "leaderboard.archive",
  "nudge.send",
  "demand.reassign",
] as const;
export type RecruiterAdminAction = (typeof RECRUITER_ADMIN_ACTIONS)[number];

export const recruiterAdminEvents = pgTable(
  "recruiter_admin_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id").references(() => users.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: RECRUITER_ADMIN_ACTIONS }).notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRecruiter: index("recruiter_admin_events_recruiter_idx").on(
      t.orgId,
      t.recruiterUserId,
      t.createdAt,
    ),
    byActor: index("recruiter_admin_events_actor_idx").on(t.orgId, t.actorUserId, t.createdAt),
  }),
);
// <<< PAGE:recruiters END

// >>> PAGE:team-monitor START
// ---------- Team Monitor: presence, supervision, SLA, alerts, audit ----------

export const PRESENCE_ACTIVITIES = ["on_call", "idle", "in_meeting", "offline"] as const;
export const SUPERVISION_MODES = ["whisper", "barge", "takeover"] as const;
export const SUPERVISION_STATES = ["requested", "active", "ended", "denied", "failed"] as const;
export const SLA_METRICS = [
  "queue_depth",
  "call_duration_ms",
  "recruiter_idle_ms",
  "abandoned_rate",
  "answer_rate",
] as const;
export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const ALERT_STATES = ["open", "acked", "resolved", "expired"] as const;

// Heartbeat-backed presence. One row per (org, user); upserted by the
// live-call hooks (recruiter side) and refreshed by the supervisor poll.
export const recruiterPresence = pgTable(
  "recruiter_presence",
  {
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    currentActivity: text("current_activity", { enum: PRESENCE_ACTIVITIES })
      .notNull()
      .default("offline"),
    activeCallId: uuid("active_call_id").references((): any => callSessions.id, {
      onDelete: "set null",
    }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
    lastActivityChangeAt: timestamp("last_activity_change_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    statusNote: text("status_note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
    byOrgActivity: index("recruiter_presence_org_activity_idx").on(t.orgId, t.currentActivity),
    byHeartbeat: index("recruiter_presence_heartbeat_idx").on(t.orgId, t.lastHeartbeatAt),
  }),
);

// One row per supervisor intervention on a live call. Append-only state
// machine: requested -> active -> ended | denied | failed.
export const callSupervisionSessions = pgTable(
  "call_supervision_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    supervisorUserId: uuid("supervisor_user_id")
      .references(() => users.id, { onDelete: "set null" })
      .notNull(),
    recruiterUserId: uuid("recruiter_user_id").references(() => users.id, { onDelete: "set null" }),
    mode: text("mode", { enum: SUPERVISION_MODES }).notNull(),
    state: text("state", { enum: SUPERVISION_STATES }).notNull().default("requested"),
    idempotencyKey: text("idempotency_key").notNull(),
    providerListenUrl: text("provider_listen_url"),
    providerControlUrl: text("provider_control_url"),
    provider: text("provider"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCall: index("call_supervision_call_idx").on(t.callId, t.startedAt),
    byOrgState: index("call_supervision_org_state_idx").on(t.orgId, t.state),
    bySupervisor: index("call_supervision_supervisor_idx").on(t.supervisorUserId, t.startedAt),
    idemKey: uniqueIndex("call_supervision_idem_key").on(t.orgId, t.idempotencyKey),
  }),
);

// Org-configurable SLA thresholds. One row per (org, metric, scope).
export const teamSlaPolicies = pgTable(
  "team_sla_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    metric: text("metric", { enum: SLA_METRICS }).notNull(),
    warningThreshold: integer("warning_threshold").notNull(),
    criticalThreshold: integer("critical_threshold").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    scopeLeadUserId: uuid("scope_lead_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    notifyUserId: uuid("notify_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("team_sla_policies_org_idx").on(t.orgId, t.enabled),
  }),
);

// Live alerts raised by the engine. Deduped on (org, metric, subjectId) while
// open so the poll doesn't spam duplicates (partial-unique in SQL migration).
export const teamAlerts = pgTable(
  "team_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    policyId: uuid("policy_id").references(() => teamSlaPolicies.id, { onDelete: "set null" }),
    metric: text("metric", { enum: SLA_METRICS }).notNull(),
    severity: text("severity", { enum: ALERT_SEVERITIES }).notNull(),
    state: text("state", { enum: ALERT_STATES }).notNull().default("open"),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    observedValue: integer("observed_value").notNull(),
    thresholdValue: integer("threshold_value").notNull(),
    message: text("message").notNull(),
    ackedByUserId: uuid("acked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgState: index("team_alerts_org_state_idx").on(t.orgId, t.state, t.createdAt),
    bySubject: index("team_alerts_subject_idx").on(t.orgId, t.subjectType, t.subjectId),
  }),
);

// Append-only audit of every supervisor state-changing action on this page.
export const teamMonitorAudit = pgTable(
  "team_monitor_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgAt: index("team_monitor_audit_org_at_idx").on(t.orgId, t.createdAt),
    byTarget: index("team_monitor_audit_target_idx").on(t.orgId, t.targetType, t.targetId),
    byActor: index("team_monitor_audit_actor_idx").on(t.actorUserId, t.createdAt),
  }),
);
// <<< PAGE:team-monitor END

// >>> PAGE:question-bank START
// Enterprise rebuild of the Question Bank page. Promotes a flat CRUD list into
// a governed, calibrated, versioned item library. All tables org-scoped
// (org_id NOT NULL), with CHECK + FK + indexes on every filter/sort path and a
// dedicated append-only domain audit table. The column ADDITIONS to the
// existing question_banks / question_bank_questions tables (status, language,
// versioning, tagging, calibration cache, etc.) live in migration
// 0034_question_bank_enterprise.sql; Drizzle mirrors them on the existing
// pgTable definitions above is intentionally NOT done to avoid churning the
// historical block — the route layer reads the new columns via sql`` / the
// freshly added Drizzle columns below where needed. The five NEW tables follow.

// QUESTION_BANK_STATUSES / QUESTION_STATUSES / QUESTION_LANGUAGES / QUESTION_TYPES
// are declared next to the (now-extended) questionBanks / questionBankQuestions
// tables above and reused here.
export const QUESTION_VERSION_REASONS = ["created", "edited", "approved", "rejected", "reverted"] as const;
export const QUESTION_REVIEW_DECISIONS = ["submitted", "approved", "rejected", "changes_requested"] as const;
export const QUESTION_USAGE_SOURCES = ["assessment_attempt", "live_assist", "manual"] as const;
export const QUESTION_IMPORT_FORMATS = ["csv", "qti"] as const;
export const QUESTION_IMPORT_STATUSES = ["pending", "parsing", "ready", "committed", "failed"] as const;
export const QUESTION_BANK_AUDIT_ACTIONS = [
  "bank.created", "bank.updated", "bank.archived", "bank.restored",
  "question.created", "question.updated", "question.archived",
  "question.submitted_for_review", "question.approved", "question.rejected", "question.reverted",
  "question.imported", "questions.bulk_archived", "questions.bulk_approved",
  "question.linked_demand", "question.unlinked_demand",
] as const;

// Per-item immutable version history (per-item versioning depth bullet).
export const questionVersions = pgTable(
  "question_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id")
      .references(() => questionBankQuestions.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    reason: text("reason", { enum: QUESTION_VERSION_REASONS }).notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byQuestion: index("question_versions_q_idx").on(t.questionId, t.version),
    uniq: uniqueIndex("question_versions_q_version_uniq").on(t.questionId, t.version),
  }),
);

// New-item review/approval workflow — one row per review decision.
export const questionReviews = pgTable(
  "question_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id")
      .references(() => questionBankQuestions.id, { onDelete: "cascade" })
      .notNull(),
    decision: text("decision", { enum: QUESTION_REVIEW_DECISIONS }).notNull(),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byQuestion: index("question_reviews_q_idx").on(t.questionId, t.createdAt),
    byOrgPending: index("question_reviews_org_idx").on(t.orgId, t.createdAt),
  }),
);

// Append-only fact stream that p-value + over-use rollups read.
export const questionUsageEvents = pgTable(
  "question_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    questionId: uuid("question_id")
      .references(() => questionBankQuestions.id, { onDelete: "cascade" })
      .notNull(),
    source: text("source", { enum: QUESTION_USAGE_SOURCES }).notNull(),
    attemptId: uuid("attempt_id").references(() => assessmentAttempts.id, { onDelete: "set null" }),
    callId: uuid("call_id").references(() => callSessions.id, { onDelete: "set null" }),
    scored: boolean("scored").notNull().default(false),
    correct: boolean("correct"),
    scoreFraction: numeric("score_fraction", { precision: 4, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byQuestion: index("question_usage_q_idx").on(t.questionId, t.createdAt),
    byOrg: index("question_usage_org_idx").on(t.orgId, t.createdAt),
  }),
);

// Dedicated append-only audit for every state change on this page.
export const questionBankAudit = pgTable(
  "question_bank_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action", { enum: QUESTION_BANK_AUDIT_ACTIONS }).notNull(),
    bankId: uuid("bank_id").references(() => questionBanks.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").references(() => questionBankQuestions.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("question_bank_audit_org_idx").on(t.orgId, t.createdAt),
    byBank: index("question_bank_audit_bank_idx").on(t.bankId, t.createdAt),
    byQuestion: index("question_bank_audit_q_idx").on(t.questionId, t.createdAt),
  }),
);

// Bulk import (CSV/QTI) tracking + idempotency.
export const questionImportJobs = pgTable(
  "question_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    bankId: uuid("bank_id")
      .references(() => questionBanks.id, { onDelete: "cascade" })
      .notNull(),
    format: text("format", { enum: QUESTION_IMPORT_FORMATS }).notNull(),
    status: text("status", { enum: QUESTION_IMPORT_STATUSES }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key"),
    rowCount: integer("row_count").notNull().default(0),
    validCount: integer("valid_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    preview: jsonb("preview").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    errors: jsonb("errors").$type<Array<{ row: number; message: string }>>().notNull().default(sql`'[]'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("question_import_jobs_org_idx").on(t.orgId, t.createdAt),
    idemUniq: uniqueIndex("question_import_jobs_idem_uniq").on(t.orgId, t.idempotencyKey),
  }),
);
// <<< PAGE:question-bank END

// >>> PAGE:qa-review START
// ───────────────────────────────────────────────────────────────────────────
// QA Review console: sampling policy, gold answers, calibration sessions,
// disputes, reviewer assignment, and an append-only QA audit trail.
// All tables org-scoped (org_id NOT NULL) for hard tenant isolation.
// Migration: 0035_qa_review_enterprise.sql
// ───────────────────────────────────────────────────────────────────────────

export const QA_SAMPLING_STRATEGIES = ["percentage", "every_n", "all", "risk_weighted"] as const;
export type QaSamplingStrategy = (typeof QA_SAMPLING_STRATEGIES)[number];

export const QA_ROUTING_STRATEGIES = ["round_robin", "least_loaded", "manual"] as const;
export type QaRoutingStrategy = (typeof QA_ROUTING_STRATEGIES)[number];

// One active policy per (org, scope). Decides which ended calls become QA
// queue items and (optionally) how they route to reviewers.
export const qaSamplingPolicies = pgTable(
  "qa_sampling_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    strategy: text("strategy", { enum: QA_SAMPLING_STRATEGIES }).notNull().default("percentage"),
    // percentage strategy: 0–100. every_n strategy: sample 1 of every N. Ignored for "all".
    samplePercent: integer("sample_percent"),
    everyN: integer("every_n"),
    // Optional narrowing of which calls are eligible.
    demandId: uuid("demand_id").references(() => demands.id, { onDelete: "set null" }),
    recruiterUserId: uuid("recruiter_user_id").references(() => users.id, { onDelete: "set null" }),
    rubricPurpose: text("rubric_purpose", { enum: RUBRIC_PURPOSES }),
    minAiScore: integer("min_ai_score"), // risk_weighted: only sample below this
    requireDoubleReview: boolean("require_double_review").notNull().default(false),
    blindReview: boolean("blind_review").notNull().default(true),
    // round_robin | least_loaded | manual — how queue items get a reviewer.
    routing: text("routing", { enum: QA_ROUTING_STRATEGIES }).notNull().default("least_loaded"),
    slaHours: integer("sla_hours"), // review-by deadline; null = none
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("qa_sampling_policies_org_idx").on(t.orgId, t.isActive),
  }),
);

// A QA queue item = one call selected for review by a policy (or manually),
// with assignment + SLA + lifecycle. Decouples "what needs reviewing" from the
// review decisions themselves. Up to N items per call when double-review.
export const QA_QUEUE_STATUSES = [
  "pending",
  "in_review",
  "completed",
  "skipped",
  "disputed",
  "resolved",
] as const;
export type QaQueueStatus = (typeof QA_QUEUE_STATUSES)[number];

export const qaQueueItems = pgTable(
  "qa_queue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    policyId: uuid("policy_id").references(() => qaSamplingPolicies.id, { onDelete: "set null" }),
    assignedReviewerId: uuid("assigned_reviewer_id").references(() => users.id, { onDelete: "set null" }),
    // For double-review: 1 = primary, 2 = secondary (blind). One row per slot.
    reviewSlot: integer("review_slot").notNull().default(1),
    status: text("status", { enum: QA_QUEUE_STATUSES }).notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    reviewId: uuid("review_id").references(() => callQaReviews.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgStatus: index("qa_queue_items_org_status_idx").on(t.orgId, t.status, t.dueAt),
    byReviewer: index("qa_queue_items_reviewer_idx").on(t.assignedReviewerId, t.status),
    // Keyset/list path: org + created_at + id.
    byOrgCreated: index("qa_queue_items_org_created_idx").on(t.orgId, t.createdAt, t.id),
    uniqCallSlot: uniqueIndex("qa_queue_items_call_slot_key").on(t.callId, t.reviewSlot),
  }),
);

// Gold-answer calibration target for a call: the QA lead's canonical
// per-criterion scores + rationale. Reviewers' scores (and the AI's) are
// measured against this during calibration sessions.
export const qaGoldAnswers = pgTable(
  "qa_gold_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    rubricId: uuid("rubric_id").references(() => callRubrics.id, { onDelete: "set null" }),
    // criterionId -> { score: 0..100, rationale }
    criterionScores: jsonb("criterion_scores")
      .$type<Record<string, { score: number; rationale?: string }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    goldOverallScore: integer("gold_overall_score"),
    notes: text("notes"),
    authoredByUserId: uuid("authored_by_user_id").references(() => users.id, { onDelete: "set null" }),
    isPublished: boolean("is_published").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("qa_gold_answers_org_idx").on(t.orgId, t.createdAt),
    uniqCall: uniqueIndex("qa_gold_answers_call_key").on(t.callId), // one gold per call
  }),
);

// A calibration session = a set of gold-answer calls a group of reviewers all
// grade blind; the system computes each reviewer's variance from gold + κ.
export const QA_CALIBRATION_STATUSES = ["draft", "open", "closed"] as const;
export type QaCalibrationStatus = (typeof QA_CALIBRATION_STATUSES)[number];

export const qaCalibrationSessions = pgTable(
  "qa_calibration_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    rubricId: uuid("rubric_id").references(() => callRubrics.id, { onDelete: "set null" }),
    callIds: jsonb("call_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    reviewerIds: jsonb("reviewer_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: QA_CALIBRATION_STATUSES }).notNull().default("draft"),
    // Computed at close: { perReviewer: {...}, kappa, meanAbsErrorVsGold }
    results: jsonb("results").$type<Record<string, unknown>>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("qa_calibration_sessions_org_idx").on(t.orgId, t.status, t.createdAt),
  }),
);

// Dispute/appeal raised on a QA review (by recruiter or delivery lead).
export const QA_DISPUTE_STATUSES = ["open", "under_review", "upheld", "overturned", "withdrawn"] as const;
export type QaDisputeStatus = (typeof QA_DISPUTE_STATUSES)[number];

export const qaDisputes = pgTable(
  "qa_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    reviewId: uuid("review_id")
      .references(() => callQaReviews.id, { onDelete: "cascade" })
      .notNull(),
    callId: uuid("call_id")
      .references(() => callSessions.id, { onDelete: "cascade" })
      .notNull(),
    raisedByUserId: uuid("raised_by_user_id")
      .references(() => users.id, { onDelete: "set null" })
      .notNull(),
    reason: text("reason").notNull(),
    // criterionId -> requested score
    requestedScores: jsonb("requested_scores")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status", { enum: QA_DISPUTE_STATUSES }).notNull().default("open"),
    resolverUserId: uuid("resolver_user_id").references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),
    // Thread of comments: [{ userId, name, body, at }]
    thread: jsonb("thread")
      .$type<Array<{ userId: string; name?: string; body: string; at: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    byOrgStatus: index("qa_disputes_org_status_idx").on(t.orgId, t.status, t.createdAt),
    byReview: index("qa_disputes_review_idx").on(t.reviewId),
  }),
);

// Append-only audit of every QA state change. Generic shape so it can record
// review.submit, review.override, dispute.resolve, policy.update, queue.assign,
// gold.publish, calibration.close, resolution.recompute, export.run.
export const qaAuditEvents = pgTable(
  "qa_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(), // e.g. "qa.review.override"
    targetType: text("target_type").notNull(), // "review" | "dispute" | "policy" | "queue_item" | "gold" | "call"
    targetId: text("target_id").notNull(),
    callId: uuid("call_id").references(() => callSessions.id, { onDelete: "set null" }),
    // Before/after snapshot for state changes.
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("qa_audit_events_org_idx").on(t.orgId, t.createdAt),
    byTarget: index("qa_audit_events_target_idx").on(t.targetType, t.targetId),
    byCall: index("qa_audit_events_call_idx").on(t.callId, t.createdAt),
  }),
);
// <<< PAGE:qa-review END

// >>> PAGE:coaching START
// Enterprise coaching rebuild (migration 0036): real per-criterion scoring,
// curricula + assignments, and an append-only audit trail. All org-scoped.
// Additive columns on coaching_scenarios / coaching_runs live inline above
// (next to their original table definitions); these are the NEW tables.

// Per-criterion scores produced by the auto-scoring engine (apps/api/src/
// coaching/score.ts) — real rows, not a cached blob. Upserted on
// (run_id, criterion_id); the run's cached_overall_score is the weighted mean.
export const coachingRunScores = pgTable(
  "coaching_run_scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    runId: uuid("run_id")
      .references(() => coachingRuns.id, { onDelete: "cascade" })
      .notNull(),
    criterionId: text("criterion_id").notNull(),
    criterionName: text("criterion_name").notNull(),
    weight: numeric("weight", { precision: 5, scale: 2 }).notNull().default("1"),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(), // 0..100
    band: text("band", { enum: COACHING_SCORE_BANDS }),
    evidence: text("evidence"),
    source: text("source", { enum: COACHING_SCORE_SOURCES }).notNull().default("ai"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byRun: uniqueIndex("coaching_run_scores_run_crit_uq").on(t.runId, t.criterionId),
    byOrgCrit: index("coaching_run_scores_org_crit_idx").on(t.orgId, t.criterionId, t.createdAt),
  }),
);

// Ordered scenario sets a manager assigns as a unit.
export const coachingCurricula = pgTable(
  "coaching_curricula",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    scenarioIds: jsonb("scenario_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // ordered
    isPublished: boolean("is_published").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("coaching_curricula_org_idx").on(t.orgId, t.archivedAt, t.createdAt),
  }),
);

// Who must do what, by when. Exactly one of scenario_id / curriculum_id set
// (enforced by a SQL CHECK in migration 0036).
export const coachingAssignments = pgTable(
  "coaching_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    scenarioId: uuid("scenario_id").references(() => coachingScenarios.id, { onDelete: "cascade" }),
    curriculumId: uuid("curriculum_id").references(() => coachingCurricula.id, { onDelete: "cascade" }),
    assigneeUserId: uuid("assignee_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status", { enum: COACHING_ASSIGNMENT_STATUSES }).notNull().default("assigned"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedRunId: uuid("completed_run_id").references((): typeof coachingRuns.id => coachingRuns.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    minPassScore: numeric("min_pass_score", { precision: 5, scale: 2 }),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byAssignee: index("coaching_assignments_assignee_idx").on(t.assigneeUserId, t.status, t.dueAt),
    byOrg: index("coaching_assignments_org_idx").on(t.orgId, t.status, t.dueAt),
    idem: uniqueIndex("coaching_assignments_idem_uq").on(t.orgId, t.assignedByUserId, t.idempotencyKey),
  }),
);

// Append-only audit of coaching state changes (REQUIRED for A7 ≥ 3). No
// UPDATE/DELETE routes — append-only by convention (matched to
// submission_stage_transitions).
export const coachingAuditEvents = pgTable(
  "coaching_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    action: text("action", { enum: COACHING_AUDIT_ACTIONS }).notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    scenarioId: uuid("scenario_id").references(() => coachingScenarios.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => coachingRuns.id, { onDelete: "set null" }),
    curriculumId: uuid("curriculum_id").references(() => coachingCurricula.id, { onDelete: "set null" }),
    assignmentId: uuid("assignment_id").references(() => coachingAssignments.id, { onDelete: "set null" }),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byScenario: index("coaching_audit_scenario_idx").on(t.scenarioId, t.createdAt),
    byRun: index("coaching_audit_run_idx").on(t.runId, t.createdAt),
    byOrg: index("coaching_audit_org_idx").on(t.orgId, t.createdAt),
  }),
);
// <<< PAGE:coaching END

// >>> PAGE:analytics START
// Analytics report-engine: persisted dashboard configs (saved views),
// scheduled report deliveries, and materialized export jobs. The report
// aggregates themselves read existing tables (submissions,
// submission_stage_transitions, candidates, call_sessions, call_rubric_scores,
// voice_agents) — see migration 0037 for the covering indexes added for the
// date-range + segment filter paths. All org-scoped, audited via the existing
// audit_log, idempotent on create.
export const ANALYTICS_REPORT_KEYS = [
  "funnel",
  "velocity",
  "source_effectiveness",
  "recruiter_productivity",
  "quality_distribution",
  "voice_screener",
  "call_volume",
  "diversity",
] as const;
export type AnalyticsReportKey = (typeof ANALYTICS_REPORT_KEYS)[number];

export const ANALYTICS_EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export const ANALYTICS_EXPORT_STATUSES = ["queued", "running", "ready", "failed"] as const;
export const ANALYTICS_SCHEDULE_CADENCES = ["daily", "weekly", "monthly"] as const;

export interface AnalyticsViewConfig {
  // relative range token e.g. "last_30d" OR absolute ISO from/to
  range?: { token?: string; from?: string; to?: string };
  compare?: boolean; // period-over-period
  segments?: { recruiterUserId?: string; clientId?: string; demandId?: string; source?: string };
  granularity?: "day" | "week" | "month";
  pinned?: AnalyticsReportKey[];
  [k: string]: unknown;
}

// A persisted dashboard configuration: the filter envelope + which reports are
// pinned + layout. Org-scoped, owned by a user, optionally shared org-wide.
export const analyticsSavedViews = pgTable(
  "analytics_saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    config: jsonb("config").$type<AnalyticsViewConfig>().notNull().default(sql`'{}'::jsonb`),
    isShared: boolean("is_shared").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("analytics_saved_views_org_idx").on(t.orgId, t.updatedAt),
    byOwner: index("analytics_saved_views_owner_idx").on(t.ownerUserId),
    // keyset cursor path: (org_id, updated_at desc, id desc)
    keyset: index("analytics_saved_views_keyset_idx").on(t.orgId, t.updatedAt, t.id),
    uniqName: uniqueIndex("analytics_saved_views_org_name_key").on(t.orgId, t.ownerUserId, t.name),
  }),
);

// A scheduled delivery of a saved view as an export. Idempotent on
// (org_id, saved_view_id, format, cadence). Drain worker is a Phase-2
// follow-up; the row + next_run_at are the contract the UI exercises now.
export const analyticsScheduledReports = pgTable(
  "analytics_scheduled_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    savedViewId: uuid("saved_view_id")
      .references(() => analyticsSavedViews.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    format: text("format", { enum: ANALYTICS_EXPORT_FORMATS }).notNull().default("csv"),
    cadence: text("cadence", { enum: ANALYTICS_SCHEDULE_CADENCES }).notNull().default("weekly"),
    recipients: text("recipients").array().notNull().default(sql`'{}'::text[]`),
    isEnabled: boolean("is_enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("analytics_scheduled_reports_org_idx").on(t.orgId, t.nextRunAt),
    byView: index("analytics_scheduled_reports_view_idx").on(t.savedViewId),
    idemKey: uniqueIndex("analytics_scheduled_reports_idem_key").on(
      t.orgId,
      t.savedViewId,
      t.format,
      t.cadence,
    ),
  }),
);

// Materialized export jobs (CSV/XLSX/PDF of a report's rows). Created
// idempotently from a client-supplied idempotency key.
export const analyticsExportJobs = pgTable(
  "analytics_export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reportKey: text("report_key", { enum: ANALYTICS_REPORT_KEYS }).notNull(),
    format: text("format", { enum: ANALYTICS_EXPORT_FORMATS }).notNull().default("csv"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status", { enum: ANALYTICS_EXPORT_STATUSES }).notNull().default("ready"),
    rowCount: integer("row_count"),
    blobKey: text("blob_key"), // resolved under DUMP_DIR like recordings
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("analytics_export_jobs_org_idx").on(t.orgId, t.createdAt),
    idemKey: uniqueIndex("analytics_export_jobs_idem_key").on(t.orgId, t.idempotencyKey),
  }),
);
// <<< PAGE:analytics END

// >>> PAGE:knowledge-base START
// Enterprise KB rebuild: org-scoped collections (the real corpus grouping unit,
// replacing the fictional name-substring tabs), per-collection grants, retrieval
// telemetry, eval suites/runs, answer feedback, and append-only audit.
export const KB_CORPORA = CHUNK_CORPORA; // ["jd","company","question_bank"]
export const KB_COLLECTION_STATUS = ["active", "deprecated"] as const;
export type KbCollectionStatus = (typeof KB_COLLECTION_STATUS)[number];

export const kbCollections = pgTable(
  "kb_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    corpus: text("corpus", { enum: CHUNK_CORPORA }).notNull().default("company"),
    status: text("status", { enum: KB_COLLECTION_STATUS }).notNull().default("active"),
    // Sources older than this many days since last index are flagged stale. NULL = never stale.
    staleAfterDays: integer("stale_after_days"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrg: index("kb_collections_org_idx").on(t.orgId),
    // keyset/sort path: org + status + updatedAt + id
    byOrgStatusUpdated: index("kb_collections_org_status_updated_idx").on(
      t.orgId,
      t.status,
      t.updatedAt,
      t.id,
    ),
    uniqNamePerOrg: uniqueIndex("kb_collections_org_name_uniq").on(t.orgId, t.name),
  }),
);

// Per-collection access grant. role OR userId set (CHECK enforces exactly one).
export const KB_GRANT_LEVEL = ["read", "manage"] as const;
export const kbCollectionGrants = pgTable(
  "kb_collection_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    collectionId: uuid("collection_id")
      .references(() => kbCollections.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role"), // membership role string OR null
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }), // OR null
    level: text("level", { enum: KB_GRANT_LEVEL }).notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCollection: index("kb_collection_grants_collection_idx").on(t.collectionId),
    uniqRole: uniqueIndex("kb_collection_grants_role_uniq").on(t.collectionId, t.role),
    uniqUser: uniqueIndex("kb_collection_grants_user_uniq").on(t.collectionId, t.userId),
  }),
);

// One row per served chunk on every retrieval (suggest.ts, kb /search, live-rubric).
export const kbRetrievalEvents = pgTable(
  "kb_retrieval_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    collectionId: uuid("collection_id").references(() => kbCollections.id, {
      onDelete: "set null",
    }),
    sourceId: uuid("source_id").references(() => kbSources.id, { onDelete: "set null" }),
    documentId: uuid("document_id"),
    chunkId: bigint("chunk_id", { mode: "number" }),
    corpus: text("corpus", { enum: CHUNK_CORPORA }),
    surface: text("surface", {
      enum: ["suggest", "kb_search", "live_rubric", "eval"],
    }).notNull(),
    queryHash: text("query_hash").notNull(), // sha256(lower(trim(query))) — groups gap analysis
    rank: integer("rank").notNull(),
    score: doublePrecision("score"),
    isTopHit: boolean("is_top_hit").notNull().default(false),
    hadResults: boolean("had_results").notNull().default(true), // false rows = zero-result queries (gaps)
    latencyMs: integer("latency_ms"),
    callId: uuid("call_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgCreated: index("kb_retr_org_created_idx").on(t.orgId, t.createdAt),
    bySource: index("kb_retr_source_idx").on(t.sourceId),
    byCollection: index("kb_retr_collection_idx").on(t.collectionId),
    byQueryHash: index("kb_retr_queryhash_idx").on(t.orgId, t.queryHash),
  }),
);

// Eval suites: golden test queries with expected source/collection.
export const kbEvalSuites = pgTable(
  "kb_eval_suites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    corpus: text("corpus", { enum: CHUNK_CORPORA }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byOrg: index("kb_eval_suites_org_idx").on(t.orgId, t.updatedAt, t.id) }),
);

export const kbEvalCases = pgTable(
  "kb_eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suiteId: uuid("suite_id")
      .references(() => kbEvalSuites.id, { onDelete: "cascade" })
      .notNull(),
    query: text("query").notNull(),
    expectedSourceId: uuid("expected_source_id").references(() => kbSources.id, {
      onDelete: "set null",
    }),
    expectedCollectionId: uuid("expected_collection_id").references(() => kbCollections.id, {
      onDelete: "set null",
    }),
    // free-text substring that the top snippet should contain (citation-accuracy check)
    expectedSnippetContains: text("expected_snippet_contains"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ bySuite: index("kb_eval_cases_suite_idx").on(t.suiteId) }),
);

export const kbEvalRuns = pgTable(
  "kb_eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    suiteId: uuid("suite_id")
      .references(() => kbEvalSuites.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status", { enum: ["running", "completed", "error"] })
      .notNull()
      .default("running"),
    caseCount: integer("case_count").notNull().default(0),
    hitRate: doublePrecision("hit_rate"), // fraction of cases where expected source ∈ top-k
    mrr: doublePrecision("mrr"), // mean reciprocal rank of expected source
    citationAccuracy: doublePrecision("citation_accuracy"), // fraction where snippet matched
    usedRealEmbeddings: boolean("used_real_embeddings").notNull().default(false),
    errorMessage: text("error_message"),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({ bySuite: index("kb_eval_runs_suite_idx").on(t.suiteId, t.createdAt) }),
);

export const kbEvalRunCases = pgTable(
  "kb_eval_run_cases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .references(() => kbEvalRuns.id, { onDelete: "cascade" })
      .notNull(),
    caseId: uuid("case_id").references(() => kbEvalCases.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    hit: boolean("hit").notNull().default(false),
    rankOfExpected: integer("rank_of_expected"), // null if not retrieved
    citationOk: boolean("citation_ok"),
    topSourceId: uuid("top_source_id"),
    topSnippet: text("top_snippet"),
  },
  (t) => ({ byRun: index("kb_eval_run_cases_run_idx").on(t.runId) }),
);

// Answer feedback loop: thumbs on a served retrieval, triaged into a queue.
export const kbAnswerFeedback = pgTable(
  "kb_answer_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    sourceId: uuid("source_id").references(() => kbSources.id, { onDelete: "set null" }),
    collectionId: uuid("collection_id").references(() => kbCollections.id, {
      onDelete: "set null",
    }),
    chunkId: bigint("chunk_id", { mode: "number" }),
    query: text("query"),
    rating: text("rating", { enum: ["up", "down"] }).notNull(),
    reason: text("reason", {
      enum: ["outdated", "wrong", "irrelevant", "incomplete", "helpful", "other"],
    }),
    comment: text("comment"),
    status: text("status", { enum: ["open", "actioned", "dismissed"] })
      .notNull()
      .default("open"),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    byOrgStatus: index("kb_feedback_org_status_idx").on(t.orgId, t.status, t.createdAt),
    bySource: index("kb_feedback_source_idx").on(t.sourceId),
  }),
);

// Append-only audit of every KB state change.
export const kbAudit = pgTable(
  "kb_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    entityType: text("entity_type", {
      enum: [
        "collection",
        "source",
        "document",
        "grant",
        "eval_suite",
        "eval_run",
        "feedback",
      ],
    }).notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byOrgEntity: index("kb_audit_org_entity_idx").on(
      t.orgId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
  }),
);
// <<< PAGE:knowledge-base END
