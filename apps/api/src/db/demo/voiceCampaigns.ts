// Voice agents are seeded by seedAgents.ts globally for every org. We just
// pick up the IDs, then build campaigns + per-target call records.
import {
  db,
  voiceAgentCampaigns,
  voiceAgentCallTargets,
  voiceAgents,
} from "@j2w/db";
import { and, eq } from "drizzle-orm";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import { daysAgo, daysFromNow, intBetween, pick, type Rng } from "./rng.js";

const CAMPAIGN_SPECS: Array<{
  name: string;
  agentName: string;
  status: "draft" | "scheduled" | "running" | "completed";
  scheduledOffsetDays?: number;
  notes?: string;
}> = [
  { name: "Q2 Senior Java — Outbound Screen", agentName: "General Screen — Hinglish", status: "running", notes: "Targeting senior Java backend candidates from Naukri pull." },
  { name: "Senior Backend Re-engagement", agentName: "Interest Gauge — Re-engagement", status: "running", notes: "Re-engaging parked senior backend pool." },
  { name: "Java Technical Pre-screen", agentName: "Technical Screen — Java", status: "completed", notes: "Pre-screened 40 candidates ahead of L1 batch." },
  { name: "Acme Comp Alignment", agentName: "Notice Period & Comp Check", status: "completed" },
  { name: "Frontend Hiring Wave — May", agentName: "General Screen — Hinglish", status: "scheduled", scheduledOffsetDays: 5 },
  { name: "DevOps Reactivation", agentName: "Interest Gauge — Re-engagement", status: "draft" },
];

export async function seedDemoVoiceCampaigns(ctx: DemoContext, rng: Rng): Promise<void> {
  // Look up the seeded voice agents for this org. Fall back to inserting a
  // minimal copy if seedDefaultVoiceAgents hasn't been called for the demo
  // org yet (it runs in the orchestrator before this phase, but we keep the
  // safety so this module is robust).
  const agentRows = await db
    .select({ id: voiceAgents.id, name: voiceAgents.name })
    .from(voiceAgents)
    .where(eq(voiceAgents.orgId, DEMO_ORG_ID));
  for (const r of agentRows) ctx.voiceAgentIdByName.set(r.name, r.id);

  if (ctx.voiceAgentIdByName.size === 0) {
    console.warn("[demo-seed] WARN: no voice agents in demo org — campaigns will skip.");
    return;
  }

  const campaignRows = await db
    .insert(voiceAgentCampaigns)
    .values(
      CAMPAIGN_SPECS.filter((s) => ctx.voiceAgentIdByName.has(s.agentName)).map((spec) => ({
        orgId: DEMO_ORG_ID,
        voiceAgentId: ctx.voiceAgentIdByName.get(spec.agentName)!,
        demandId: pick(ctx.demandIds, rng) ?? null,
        name: spec.name,
        notes: spec.notes ?? null,
        status: spec.status,
        scheduledFor: spec.scheduledOffsetDays != null ? daysFromNow(spec.scheduledOffsetDays) : null,
        ratePerMinute: 12,
        createdByUserId: ctx.adminUserId,
        createdAt: daysAgo(intBetween(2, 25, rng)),
      })),
    )
    .returning({ id: voiceAgentCampaigns.id, name: voiceAgentCampaigns.name, status: voiceAgentCampaigns.status });

  // Targets: distribute the budget across campaigns. Running/completed get
  // the bulk; draft/scheduled get a few queued targets.
  const targetRows = [] as Array<typeof voiceAgentCallTargets.$inferInsert>;
  let budget = VOLUMES.voiceCallTargets;
  for (const c of campaignRows) {
    const slice = c.status === "running" || c.status === "completed"
      ? Math.min(budget, intBetween(15, 25, rng))
      : Math.min(budget, intBetween(4, 8, rng));
    budget -= slice;
    for (let i = 0; i < slice; i += 1) {
      const candidateId = ctx.candidateIds[(i * 13) % ctx.candidateIds.length];
      const baseStatus =
        c.status === "completed"
          ? pick(["completed", "no_answer", "failed", "completed", "completed"], rng)
          : c.status === "running"
            ? pick(["queued", "dialing", "connected", "completed", "no_answer", "queued"], rng)
            : c.status === "scheduled"
              ? "queued"
              : "queued";
      targetRows.push({
        campaignId: c.id,
        candidateId,
        phone: `+91${9000000000 + intBetween(0, 99999999, rng)}`,
        status: baseStatus as "queued" | "dialing" | "connected" | "completed" | "failed" | "no_answer" | "cancelled",
        attemptCount: baseStatus === "queued" ? 0 : intBetween(1, 3, rng),
        lastAttemptAt: baseStatus === "queued" ? null : daysAgo(intBetween(0, 18, rng)),
        callId: baseStatus === "completed" || baseStatus === "connected"
          ? ctx.callIds[(i * 7) % Math.max(1, ctx.callIds.length)] ?? null
          : null,
        outcome: baseStatus === "completed" ? "screened" : null,
      });
    }
    if (budget <= 0) break;
  }
  if (targetRows.length) await db.insert(voiceAgentCallTargets).values(targetRows);
}
