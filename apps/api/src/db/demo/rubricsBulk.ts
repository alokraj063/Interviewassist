// Guarded 10k-row perf seed for the Rubrics A4 keyset-pagination p95 check.
//
//   pnpm --filter @j2w/api exec tsx src/db/demo/rubricsBulk.ts <orgId> [n]
//
// Generates n published rubrics (default 10,000) with randomized
// purpose/status/name/weights, batched in chunks of 500, each with a v1
// version row. NOT run by the default seed. Refuses to run in production
// unless ALLOW_DEMO_SEED=1.
import "../../env.js";
import { env } from "../../env.js";
import {
  callRubricVersions,
  callRubrics,
  db,
  RUBRIC_PURPOSES,
  type RubricCriterionV2,
} from "@j2w/db";
import { intBetween, rngSeeded, stableUuid, type Rng } from "./rng.js";

const CHUNK = 500;

function bulkCriteria(rng: Rng): RubricCriterionV2[] {
  const kinds = ["script_adherence", "jd_coverage", "salary_handling", "positioning", "candidate_experience"] as const;
  const count = intBetween(3, 5, rng);
  return Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    name: `Criterion ${i + 1}`,
    weight: intBetween(5, 30, rng),
    kind: kinds[i % kinds.length],
    bandThresholds: { fail: 40, pass: 65, excellent: 85 },
    anchors: { fail: "below bar", pass: "meets bar", excellent: "exceeds bar" },
    minEvidenceQuotes: intBetween(0, 2, rng),
    autoScoreEnabled: rng() > 0.3,
  }));
}

export async function seedBulkRubrics(orgId: string, n = 10_000): Promise<number> {
  if (env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "1") {
    throw new Error("Refusing to bulk-seed rubrics in production. Set ALLOW_DEMO_SEED=1 to override.");
  }
  const rng = rngSeeded(0x5eed_b001);
  let inserted = 0;

  for (let start = 0; start < n; start += CHUNK) {
    const size = Math.min(CHUNK, n - start);
    const rubricRows: Array<typeof callRubrics.$inferInsert> = [];
    const versionRows: Array<typeof callRubricVersions.$inferInsert> = [];

    for (let i = 0; i < size; i += 1) {
      const idx = start + i;
      const id = stableUuid(`bulk-rubric-${orgId}-${idx}`);
      const purpose = RUBRIC_PURPOSES[idx % RUBRIC_PURPOSES.length];
      const criteria = bulkCriteria(rng);
      rubricRows.push({
        id,
        orgId,
        name: `Bulk Rubric ${String(idx).padStart(5, "0")}`,
        version: 1,
        purpose,
        appliesTo: ["call"],
        status: "published",
        publishedVersion: 1,
        isDefault: false,
        criteria,
        description: `Synthetic perf rubric #${idx}`,
      });
      versionRows.push({
        orgId,
        rubricId: id,
        version: 1,
        criteria,
        purpose,
        name: `Bulk Rubric ${String(idx).padStart(5, "0")}`,
      });
    }

    await db.insert(callRubrics).values(rubricRows).onConflictDoNothing();
    await db.insert(callRubricVersions).values(versionRows).onConflictDoNothing();
    inserted += size;
    if (inserted % 2000 === 0) console.log(`[bulk-rubrics] inserted ${inserted}/${n}`);
  }
  console.log(`[bulk-rubrics] done — ${inserted} rubrics for org ${orgId}`);
  return inserted;
}

const isDirectExec = import.meta.url === `file://${process.argv[1]}`;
if (isDirectExec) {
  const orgId = process.argv[2];
  const n = process.argv[3] ? parseInt(process.argv[3], 10) : 10_000;
  if (!orgId) {
    console.error("usage: tsx src/db/demo/rubricsBulk.ts <orgId> [n]");
    process.exit(1);
  }
  seedBulkRubrics(orgId, n)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
