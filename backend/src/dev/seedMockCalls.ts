// Dev-only seeder: materialize the frontend's 260 mock conversations as
// call_sessions rows so real qa_reviews FKs resolve. No-op in prod.
//
// Called from server boot under `env.NODE_ENV === "development"`.

import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { db, callSessions, DEFAULT_ORG_ID } from "@j2w/db";
import { env } from "../env.js";
import { mockIdToUuid } from "./mockCallIds.js";

const MOCK_COUNT = 260;
const MOCK_PREFIX = "CV-";
const MOCK_START = 10_000;

export async function seedMockCalls(log: FastifyBaseLogger): Promise<void> {
  if (env.NODE_ENV !== "development") return;

  // Cheap guard: if any of our mock UUIDs already exist, assume seeded.
  const sampleId = mockIdToUuid(`${MOCK_PREFIX}${MOCK_START}`);
  const res = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS(SELECT 1 FROM call_sessions WHERE id = ${sampleId}::uuid) AS exists
  `);
  if (res.rows?.[0]?.exists) {
    log.info("mock call_sessions already seeded — skipping");
    return;
  }

  const now = new Date();
  const rows = Array.from({ length: MOCK_COUNT }, (_, i) => {
    const mockId = `${MOCK_PREFIX}${MOCK_START + i}`;
    const uuid = mockIdToUuid(mockId);
    // Randomize start/end across the last ~30 days so the stats queries
    // have a realistic distribution.
    const start = new Date(now.getTime() - (i % 30) * 86_400_000 - ((i * 131) % 3600) * 1000);
    return {
      id: uuid,
      orgId: DEFAULT_ORG_ID,
      status: "ended" as const,
      origin: "web" as const,
      customerRef: `MOCK-${MOCK_START + i}`,
      startedAt: start,
      endedAt: new Date(start.getTime() + 5 * 60 * 1000),
    };
  });

  // Batch insert — onConflictDoNothing so reruns are safe.
  await db.insert(callSessions).values(rows).onConflictDoNothing({ target: callSessions.id });

  log.info({ count: rows.length }, "seeded mock call_sessions for dev");
}
