import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

function connStr(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: connStr(), max: 20, idleTimeoutMillis: 30_000 });
  }
  return _pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

export type DB = NodePgDatabase<typeof schema>;

// For callers who want to use an ambient `db` binding (the vast majority).
// Callers are responsible for ensuring DATABASE_URL is set before use — this
// getter defers the check until first access.
export const db: DB = new Proxy({} as DB, {
  get(_t, prop, recv) {
    const d = getDb() as unknown as Record<string | symbol, unknown>;
    const v = d[prop];
    return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(d) : v;
  },
});

export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_t, prop) {
    const p = getPool() as unknown as Record<string | symbol, unknown>;
    const v = p[prop];
    return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(p) : v;
  },
});
