// Vitest globalSetup for the API integration-test harness.
//
// Stands up a DISPOSABLE Postgres database (`recruitassist_itest`) once per
// `vitest run`, migrates + seeds it, and tears it down on exit. It NEVER
// touches the dev database — it derives the base connection from the dev
// DATABASE_URL but swaps the database name to the throwaway one, and connects
// to the `postgres` maintenance DB to issue CREATE/DROP DATABASE.
//
// Order of operations matters:
//   1. Resolve the base connection from .env / process.env.
//   2. Point process.env.DATABASE_URL at the itest DB BEFORE anything imports
//      @j2w/db (its client reads process.env.DATABASE_URL lazily via a Proxy,
//      so this redirects every query). The test worker forks spawned after
//      this hook returns inherit this env, so the harness + specs all talk to
//      the disposable DB.
//   3. Drop-if-exists + CREATE the itest DB (from the maintenance connection).
//   4. Run the SQL migrations as a subprocess with DATABASE_URL overridden
//      (migrate.ts is a standalone runner; extensions vector/pgcrypto come
//      from 0000, citext from 0001 — all applied on the fresh DB).
//   5. runSeed() in-process (now that DATABASE_URL points at the itest DB).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/test → up two to apps/api, up three more to the repo root.
const API_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_DIR, "..", "..");

const ITEST_DB_NAME = "recruitassist_itest";

/** Resolve the dev DATABASE_URL from process.env or the repo-root .env. */
function resolveBaseDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const parsed = dotenv.config({ path: path.join(REPO_ROOT, ".env") });
  const url = parsed.parsed?.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Cannot resolve DATABASE_URL for integration tests (not in env or repo-root .env).",
    );
  }
  return url;
}

/** Swap the pathname (database name) on a Postgres URL, preserving creds/host. */
function withDatabaseName(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function setup() {
  const baseUrl = resolveBaseDatabaseUrl();
  const itestUrl = withDatabaseName(baseUrl, ITEST_DB_NAME);
  // The maintenance connection must target a database OTHER than the one we
  // drop/create — use the conventional `postgres` admin DB.
  const adminUrl = withDatabaseName(baseUrl, "postgres");

  // Redirect every subsequent DB access (this process AND the forks spawned
  // after this hook returns) at the disposable DB.
  process.env.DATABASE_URL = itestUrl;
  process.env.NODE_ENV = "test";

  // --- 1. (Re)create the disposable database from the admin connection. ---
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Terminate any stragglers, then drop + recreate for a pristine schema.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [ITEST_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${ITEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ITEST_DB_NAME}`);
  } finally {
    await admin.end();
  }

  // --- 2. Run migrations as a subprocess against the disposable DB. ---
  // migrate.ts reads env.DATABASE_URL; override it for the child only.
  const migrate = spawnSync(
    "pnpm",
    ["--filter", "@j2w/api", "exec", "tsx", "src/db/migrate.ts"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: itestUrl, NODE_ENV: "test" },
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  if (migrate.status !== 0) {
    throw new Error(`Migration subprocess failed (exit ${migrate.status}).`);
  }

  // --- 3. Seed in-process (DATABASE_URL already points at the itest DB). ---
  // runSeed() lazily opens the shared @j2w/db pool against the itest DB; we
  // close that pool in teardown so the setup process can exit cleanly (open
  // sockets otherwise keep the event loop alive and make vitest force-exit).
  const { runSeed } = await import("../db/seed.js");
  await runSeed();

  return async function teardown() {
    // Close the shared @j2w/db pool opened by runSeed() so no lingering
    // sessions hold the itest DB (and so the process can exit cleanly). The
    // exported `pool` is a Proxy that forwards `.end()` to the live pg.Pool.
    try {
      const { pool } = await import("@j2w/db");
      await pool.end();
    } catch {
      // Pool may already be closed or never opened — ignore.
    }

    // Drop the disposable DB from the admin connection. WITH (FORCE)
    // disconnects any lingering sessions (e.g. an unclosed app pool).
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [ITEST_DB_NAME],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${ITEST_DB_NAME} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
