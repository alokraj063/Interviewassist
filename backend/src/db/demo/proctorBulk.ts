// Guarded 10k-row perf seed for the Proctor Cockpit A4 keyset-pagination p95
// check. Batch-inserts ~10k sessions + ~30k events with randomized risk /
// status / live-state / SLA across the demo org so the roster + review queue
// list routes can be measured against a large table.
//
// Invoked from seedDemoProctor when PROCTOR_BULK is set (e.g. PROCTOR_BULK=10000
// pnpm db:seed). Gated so the normal demo seed stays fast.
import { randomUUID } from "node:crypto";
import {
  db,
  proctorEvents,
  proctorSessions,
} from "@j2w/db";
import { DEMO_ORG_ID } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo, daysFromNow, intBetween, pick, type Rng } from "./rng.js";

const SESSION_CHUNK = 1000;
const EVENT_CHUNK = 2000;
const KINDS = ["tab_switch", "multi_face", "no_face", "paste", "second_device", "window_blur"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;

export async function seedProctorBulk(
  ctx: DemoContext,
  rng: Rng,
  policyId: string | null,
  policySnapshot: Record<string, unknown>,
  count = 10000,
): Promise<void> {
  const candidateIds = ctx.candidateIds.length ? ctx.candidateIds : [null];
  const reviewers = [...ctx.qaUserIds, ...ctx.proctorUserIds];
  let sessionBuffer: Array<typeof proctorSessions.$inferInsert> = [];
  let eventBuffer: Array<typeof proctorEvents.$inferInsert> = [];
  let totalEvents = 0;

  const flushSessions = async () => {
    if (sessionBuffer.length) {
      await db.insert(proctorSessions).values(sessionBuffer);
      sessionBuffer = [];
    }
  };
  const flushEvents = async () => {
    if (eventBuffer.length) {
      await db.insert(proctorEvents).values(eventBuffer);
      eventBuffer = [];
    }
  };

  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    const status = pick(["live", "completed", "completed", "completed", "abandoned"], rng) as
      | "live"
      | "completed"
      | "abandoned";
    const riskScore = intBetween(0, 100, rng);
    const startedAt = daysAgo(intBetween(0, 120, rng));
    sessionBuffer.push({
      id,
      orgId: DEMO_ORG_ID,
      candidateId: candidateIds[i % candidateIds.length],
      status,
      liveState: status === "live" ? "active" : "ended",
      riskScore,
      policyId,
      policySnapshot,
      startedAt,
      endedAt: status === "live" ? null : daysAgo(intBetween(0, 110, rng)),
      flagCount: intBetween(0, 8, rng),
      assignedReviewerUserId: reviewers.length && rng() > 0.5 ? pick(reviewers, rng) : null,
      reviewSlaDueAt: rng() > 0.5 ? daysAgo(intBetween(0, 3, rng)) : daysFromNow(intBetween(0, 3, rng)),
      reviewerDecision: status === "completed" && rng() > 0.5 ? (pick(["clean", "flagged", "invalidated"], rng) as "clean" | "flagged" | "invalidated") : null,
    });

    const nEvents = intBetween(0, 5, rng);
    for (let e = 0; e < nEvents; e += 1) {
      eventBuffer.push({
        sessionId: id,
        kind: pick(KINDS, rng),
        severity: pick(SEVERITIES, rng),
        flagged: rng() > 0.4,
        offsetMs: intBetween(0, 25 * 60_000, rng),
        createdAt: new Date(startedAt.getTime() + intBetween(0, 25 * 60_000, rng)),
      });
      totalEvents += 1;
    }

    if (sessionBuffer.length >= SESSION_CHUNK) await flushSessions();
    if (eventBuffer.length >= EVENT_CHUNK) {
      // Sessions referenced by these events must already be inserted.
      await flushSessions();
      await flushEvents();
    }
  }
  await flushSessions();
  await flushEvents();
  console.log(`[demo-seed] PROCTOR_BULK inserted ${count} proctor sessions + ${totalEvents} events`);
}
