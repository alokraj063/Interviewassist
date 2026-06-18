// Minimal file-based SQL migration runner.
// Reads every .sql file in ./migrations in lexical order, executes those not
// yet recorded in the `_migrations` table, and records the hash on success.
// Preferred over Drizzle Kit's journal for this project because our initial
// migration needs raw pgvector DDL (CREATE EXTENSION, HNSW index) that
// drizzle-kit doesn't emit cleanly.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../env.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const entries = await readdir(MIGRATIONS_DIR);
    const files = entries.filter((f) => f.endsWith(".sql")).sort();

    const applied = new Map<string, string>();
    const existing = await client.query<{ filename: string; sha256: string }>(
      "SELECT filename, sha256 FROM _migrations",
    );
    for (const row of existing.rows) applied.set(row.filename, row.sha256);

    for (const file of files) {
      const full = path.join(MIGRATIONS_DIR, file);
      const sql = await readFile(full, "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const prev = applied.get(file);
      if (prev === sha) {
        console.log(`[skip] ${file}`);
        continue;
      }
      if (prev && prev !== sha) {
        throw new Error(
          `Migration ${file} already applied with a different hash. ` +
            `Create a new migration instead of editing this one.`,
        );
      }
      console.log(`[apply] ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO _migrations (filename, sha256) VALUES ($1, $2)",
          [file, sha],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("migrations done");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
