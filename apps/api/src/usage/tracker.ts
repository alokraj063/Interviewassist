// AI token-usage + cost tracking for the Live Assist co-pilot.
//
// Every LLM call in the interview flow (plan / next / verify / final) and the
// per-turn suggestion engine records one row in ai_usage_events with token
// counts and a computed USD cost. The Usage tab aggregates these.
//
// Pricing is USD per 1,000,000 tokens (input / output). Update PRICING when
// you change models or the provider changes prices. Embeddings are output-free.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { aiUsageEvents, callSessions, candidates, db, demands } from "@j2w/db";
import type { FastifyBaseLogger } from "fastify";

export interface ModelPrice {
  in: number; // USD per 1M input (prompt) tokens
  out: number; // USD per 1M output (completion) tokens
}

// Keep these current with https://openai.com/api/pricing/
export const PRICING: Record<string, ModelPrice> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
};

const DEFAULT_PRICE: ModelPrice = { in: 0.15, out: 0.6 }; // fall back to gpt-4o-mini

export function priceFor(model: string): ModelPrice {
  return PRICING[model] ?? DEFAULT_PRICE;
}

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

export interface UsageInput {
  orgId: string;
  callId?: string | null;
  operation: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

/** Record one LLM call's usage. Best-effort — never throws into the caller. */
export async function recordUsage(input: UsageInput, log?: FastifyBaseLogger): Promise<void> {
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;
  const total = promptTokens + completionTokens;
  if (total === 0) return;
  const cost = costUsd(input.model, promptTokens, completionTokens);
  try {
    await db.insert(aiUsageEvents).values({
      orgId: input.orgId,
      callId: input.callId ?? null,
      operation: input.operation,
      model: input.model,
      promptTokens,
      completionTokens,
      totalTokens: total,
      costUsd: cost.toFixed(8),
    });
  } catch (err) {
    log?.warn({ err, operation: input.operation }, "recordUsage failed");
  }
}

/** Aggregated usage for an org over the last `days` days. */
export async function usageSummary(orgId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = and(eq(aiUsageEvents.orgId, orgId), gte(aiUsageEvents.createdAt, since));

  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}),0)::bigint`,
      completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}),0)::bigint`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::bigint`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}),0)::float8`,
    })
    .from(aiUsageEvents)
    .where(where);

  const byOperation = await db
    .select({
      operation: aiUsageEvents.operation,
      calls: sql<number>`count(*)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::bigint`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}),0)::float8`,
    })
    .from(aiUsageEvents)
    .where(where)
    .groupBy(aiUsageEvents.operation)
    .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`));

  const byModel = await db
    .select({
      model: aiUsageEvents.model,
      calls: sql<number>`count(*)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::bigint`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}),0)::float8`,
    })
    .from(aiUsageEvents)
    .where(where)
    .groupBy(aiUsageEvents.model)
    .orderBy(desc(sql`sum(${aiUsageEvents.costUsd})`));

  const recent = await db
    .select({
      operation: aiUsageEvents.operation,
      model: aiUsageEvents.model,
      callId: aiUsageEvents.callId,
      totalTokens: aiUsageEvents.totalTokens,
      costUsd: sql<number>`${aiUsageEvents.costUsd}::float8`,
      createdAt: aiUsageEvents.createdAt,
    })
    .from(aiUsageEvents)
    .where(where)
    .orderBy(desc(aiUsageEvents.createdAt))
    .limit(25);

  // Per-call cost breakdown — one row per interview call, labelled with the
  // candidate + demand, with token + cost totals and last activity time.
  const byCall = await db
    .select({
      callId: aiUsageEvents.callId,
      candidate: candidates.displayName,
      demand: demands.title,
      calls: sql<number>`count(*)::int`,
      totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}),0)::bigint`,
      costUsd: sql<number>`coalesce(sum(${aiUsageEvents.costUsd}),0)::float8`,
      lastAt: sql<string>`max(${aiUsageEvents.createdAt})`,
    })
    .from(aiUsageEvents)
    .leftJoin(callSessions, eq(callSessions.id, aiUsageEvents.callId))
    .leftJoin(candidates, eq(candidates.id, callSessions.candidateId))
    .leftJoin(demands, eq(demands.id, callSessions.demandId))
    .where(and(where, sql`${aiUsageEvents.callId} is not null`))
    .groupBy(aiUsageEvents.callId, candidates.displayName, demands.title)
    .orderBy(desc(sql`max(${aiUsageEvents.createdAt})`))
    .limit(50);

  return {
    days,
    totals: {
      calls: Number(totals?.calls ?? 0),
      promptTokens: Number(totals?.promptTokens ?? 0),
      completionTokens: Number(totals?.completionTokens ?? 0),
      totalTokens: Number(totals?.totalTokens ?? 0),
      costUsd: Number(totals?.costUsd ?? 0),
    },
    byOperation: byOperation.map((r) => ({ ...r, totalTokens: Number(r.totalTokens), costUsd: Number(r.costUsd) })),
    byModel: byModel.map((r) => ({ ...r, totalTokens: Number(r.totalTokens), costUsd: Number(r.costUsd) })),
    byCall: byCall.map((r) => ({
      callId: r.callId,
      label: [r.candidate, r.demand].filter(Boolean).join(" · ") || (r.callId ? r.callId.slice(0, 8) : "—"),
      calls: Number(r.calls),
      totalTokens: Number(r.totalTokens),
      costUsd: Number(r.costUsd),
      lastAt: r.lastAt,
    })),
    recent: recent.map((r) => ({ ...r, costUsd: Number(r.costUsd), createdAt: r.createdAt.toISOString() })),
    pricing: PRICING,
  };
}
