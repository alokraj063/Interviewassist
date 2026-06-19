import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// Load .env from the repo root so frontend + backend share one file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname here is backend/src — go up two to reach the repo root.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  API_PUBLIC_URL: z.string().url().default("http://localhost:8787"),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"),
  // Kept only for any legacy code path that still signs an internal token; no
  // longer used to verify incoming requests — those use OL_JWT_KEY below.
  JWT_SECRET: z.string().min(32).default("recruit-assist-internal-token-key-not-used-for-incoming-32+chars"),

  // ─── OfferLetter (OL) auth — single sign-on ────────────────────────────
  // We verify the cookie that the OfferLetter app already sets. Reuse the
  // exact secret that backs OL's `jwt.sign(...)` so we don't run a second
  // login flow. Cookie name + payload shape is documented in
  // /home/developer/J2W/J2W_OfferLetter_2026/INTERVIEW_BACKEND_AUTH.md.
  OL_JWT_KEY: z.string().min(16).default("7ff3629c451a6088086ea601e16cf11bd4e8ec3f-secret-j2w-offerletter-2026-key"),
  OL_AUTH_COOKIE_NAME: z.string().default("authToken"),
  // When true, also check the OL `sessions` collection for jti revocation
  // (matches OL's own middleware). Turn off for local dev where you might
  // be testing tokens minted without a session row.
  OL_VERIFY_SESSION_REVOCATION: z
    .preprocess((v) => (typeof v === "string" ? v.toLowerCase() !== "false" : v ?? true), z.boolean())
    .default(true),

  // ─── MongoDB — SAME cluster + DB as OfferLetter ─────────────────────────
  // Defaults to OL's staging URI so both apps share a single source of truth
  // for users / jobPostings / sessions. Override either var locally if you
  // need to point at a throwaway Mongo for testing.
  MONGO_URL: z.string().default("mongodb+srv://technology_db_user:JH8fA9SqUBf4rCP3@j2wofferletter.acjnjw8.mongodb.net/?retryWrites=true&w=majority"),
  MONGO_DB: z.string().default("j2wOfferletter-staging-2026"),
  // Legacy — no longer used (kept optional so old .env files don't break).
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  // Sarvam AI streaming STT (https://docs.sarvam.ai/api-reference-docs/...).
  // Passed as `api-subscription-key` on the upstream WS connect.
  SARVAM_API_SUBSCRIPTION_KEY: z.string().optional(),
  // Shunya Labs streaming STT (wss://asr.shunyalabs.ai/ws).
  SHUNYA_API_KEY: z.string().optional(),
  // Public base URL that Vapi (or any other SaaS pointer) can reach for the
  // custom-transcriber WebSocket bridge. Must be wss:// in production.
  // Leave unset (or empty) in dev — falls back to API_PUBLIC_URL's host.
  CUSTOM_TRANSCRIBER_PUBLIC_URL: z
    .preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Shared secret Vapi HMACs into its custom-transcriber handshake.
  // Optional locally; required for production.
  CUSTOM_TRANSCRIBER_SECRET: z.string().optional(),
  // Master key-encryption-key for per-tenant integration credentials.
  // 32 raw bytes, base64-encoded (44 chars). Generate with:
  //   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
  // Required when any tenant has stored credentials in tenant_integrations;
  // optional in dev (resolver falls back to provider env vars).
  INTEGRATIONS_KEK: z
    .string()
    .optional()
    .refine(
      (v) => !v || (() => { try { return Buffer.from(v, "base64").length === 32; } catch { return false; } })(),
      { message: "INTEGRATIONS_KEK must be 32 bytes base64-encoded" },
    ),
  OPENAI_API_KEY: z.string().optional(),
  // --- Proctor cockpit: face-match (AWS Rekognition CompareFaces) ---
  // Optional in dev. When unset, POST /api/proctor/sessions/:id/identity/match
  // with ?real=true returns 503 {error:"face_match_provider_missing"} (never
  // 500); the default stub path returns a deterministic score. Per-tenant
  // overrides live in tenant_integrations (provider 'rekognition').
  AWS_REKOGNITION_ACCESS_KEY_ID: z.string().optional(),
  AWS_REKOGNITION_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REKOGNITION_REGION: z.string().default("ap-south-1"),
  // --- Proctor cockpit: live webcam/screen feeds (LiveKit) ---
  // When PROCTOR_STREAM_PROVIDER=none (default) the cockpit runs in snapshot
  // mode (renders evidence_blob_key stills). Set to 'livekit' + keys to mint
  // viewer tokens. GET /api/proctor/sessions/:id/stream-token returns 503
  // {error:"stream_provider_missing"} when 'livekit' is selected but keys are
  // unset (never 500).
  PROCTOR_STREAM_PROVIDER: z.enum(["livekit", "none"]).default("none"),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_URL: z
    .preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Code-execution sandbox (Judge0 — self-host or RapidAPI) for auto-grading
  // `coding` assessment items. When JUDGE0_URL is unset, coding items route to
  // the manual-review queue and POST /attempts/:id/run-code returns 503
  // {error:"code_exec_unavailable"} (never 500). Optional in dev.
  JUDGE0_URL: z
    .preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  JUDGE0_AUTH_TOKEN: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_FALLBACK: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  BLOB_ROOT: z.string().default("./var/blobs"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("RecruitAssist <no-reply@recruitassist.local>"),
  // Vapi. API key is server-only (private). Public key is safe to hand to the
  // browser for in-browser test calls via @vapi-ai/web.
  VAPI_API_KEY: z.string().optional(),
  VAPI_PUBLIC_KEY: z.string().optional(),
  VAPI_API_BASE: z.string().url().default("https://api.vapi.ai"),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  // J2W Offer Letter MySQL (read-only). All values optional in dev — when
  // unset, routes that depend on the integration return 503
  // {error:"offer_letter_not_configured"}. Required in prod.
  OFFER_LETTER_MYSQL_HOST: z.string().optional(),
  OFFER_LETTER_MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  OFFER_LETTER_MYSQL_USER: z.string().optional(),
  OFFER_LETTER_MYSQL_PASSWORD: z.string().optional(),
  OFFER_LETTER_MYSQL_DATABASE: z.string().default("offerletter"),
  OFFER_LETTER_MYSQL_TLS: z
    .preprocess((v) => (typeof v === "string" ? v.toLowerCase() !== "false" : v ?? true), z.boolean())
    .default(true),
  // Recordings on local VM volume (until GCS migration). The container path
  // must match the volume mount in deploy/docker-compose.yml.
  DUMP_DIR: z.string().default("./var/audio-dumps"),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
});

export const env = schema.parse(process.env);
export type Env = typeof env;

/**
 * Chat-completions model with a guaranteed-valid fallback. OPENAI_MODEL can be
 * overridden per deployment, but if it's left empty we fall back to
 * OPENAI_MODEL_FALLBACK so the suggestion + live-rubric engines never call an
 * unset model. Use this everywhere instead of reading env.OPENAI_MODEL directly.
 */
export function chatModel(): string {
  return env.OPENAI_MODEL || env.OPENAI_MODEL_FALLBACK;
}
