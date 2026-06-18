// Lazy, idempotent connection pool to the J2W Offer Letter MySQL.
//
// Single shared mysql2/promise pool across api + worker. Reads env vars
// directly so the package stays decoupled from app-specific env.ts files.
// Returns null when not configured — callers must surface a 503-shaped error
// with `error: "offer_letter_not_configured"` in that case.
import mysql, { type Pool } from "mysql2/promise";

let cachedPool: Pool | null = null;
let cachedConfigKey: string | null = null;

export interface OfferLetterConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: boolean;
}

function readConfig(): OfferLetterConfig | null {
  const host = process.env.OFFER_LETTER_MYSQL_HOST;
  const user = process.env.OFFER_LETTER_MYSQL_USER;
  const password = process.env.OFFER_LETTER_MYSQL_PASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    port: Number(process.env.OFFER_LETTER_MYSQL_PORT ?? 3306),
    user,
    password,
    database: process.env.OFFER_LETTER_MYSQL_DATABASE ?? "offerletter",
    tls: (process.env.OFFER_LETTER_MYSQL_TLS ?? "true").toLowerCase() !== "false",
  };
}

export function isOfferLetterConfigured(): boolean {
  return readConfig() !== null;
}

export function getOfferLetterPool(): Pool | null {
  const cfg = readConfig();
  if (!cfg) return null;
  // Recreate pool if config changed (env var hot-reload during tests).
  const key = `${cfg.host}:${cfg.port}/${cfg.database}/${cfg.user}/${cfg.tls}`;
  if (cachedPool && cachedConfigKey === key) return cachedPool;
  if (cachedPool) {
    void cachedPool.end().catch(() => {});
    cachedPool = null;
  }
  cachedPool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    // Doc says keep connectionLimit low (shared production DB).
    connectionLimit: 3,
    // Default queueLimit (10) is too low when the worker fans out a sync
    // batch; the analyst's note says they raised it to 100.
    queueLimit: 100,
    waitForConnections: true,
    // Pool runs in IST so DATETIMEs come back consistent with the rest of
    // RecruitAssist. dateStrings avoids JS Date timezone surprises.
    timezone: "+05:30",
    dateStrings: true,
    // RDS requires TLS. Don't verify the chain — AWS RDS uses certs signed
    // by their own intermediate CAs (Amazon RSA 2048 M0x) which aren't in
    // Node's default trust store. The connection is still encrypted; we
    // skip chain verification rather than bundling RDS's global-bundle.pem.
    // (Same approach the Cognition Engine uses against this host.)
    ssl: cfg.tls ? { rejectUnauthorized: false } : undefined,
  });
  cachedConfigKey = key;
  return cachedPool;
}

export async function closeOfferLetterPool(): Promise<void> {
  if (!cachedPool) return;
  await cachedPool.end();
  cachedPool = null;
  cachedConfigKey = null;
}
