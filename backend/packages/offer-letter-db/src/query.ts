// Read-only prepared-statement helpers. Every public query in this package
// goes through olQuery / olQueryArr — never raw pool.query.
import type { RowDataPacket } from "mysql2";
import { getOfferLetterPool } from "./pool.js";

const MUTATING = /\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE)\b/i;

export class OfferLetterNotConfiguredError extends Error {
  readonly code = "offer_letter_not_configured";
  constructor() {
    super("Offer Letter MySQL is not configured (OFFER_LETTER_MYSQL_* env vars missing)");
  }
}

function assertReadOnly(sql: string): void {
  if (MUTATING.test(sql)) {
    throw new Error(
      `@j2w/offer-letter-db rejected a mutating statement: ${sql.slice(0, 80)}…`,
    );
  }
}

export async function olQuery<T extends RowDataPacket>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  assertReadOnly(sql);
  const pool = getOfferLetterPool();
  if (!pool) throw new OfferLetterNotConfiguredError();
  // mysql2's typed execute() narrows values to a structural type that
  // doesn't accept `unknown[]`. Bind callers stay typed; the runtime
  // protocol handles primitive coercion.
  const [rows] = await pool.execute<T[]>(sql, params as never);
  return rows;
}

// mysql2's prepared protocol does not expand `IN (?)` array bindings.
// Substitute the array as `?, ?, ?` placeholders and flatten params.
export async function olQueryArr<T extends RowDataPacket>(
  sql: string,
  arrayParam: ReadonlyArray<unknown>,
  extraParams: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  assertReadOnly(sql);
  if (arrayParam.length === 0) return [];
  const placeholders = arrayParam.map(() => "?").join(", ");
  const expanded = sql.replace("IN (?)", `IN (${placeholders})`);
  if (expanded === sql) {
    throw new Error(
      "olQueryArr expects exactly one `IN (?)` placeholder to expand",
    );
  }
  return olQuery<T>(expanded, [...arrayParam, ...extraParams]);
}

export async function olHealthCheck(): Promise<number | null> {
  const pool = getOfferLetterPool();
  if (!pool) return null;
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT 1 AS ok", [] as never);
  return (rows[0]?.ok as number | undefined) ?? null;
}
