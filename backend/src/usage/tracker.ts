// AI token-usage + cost tracking for the Live Assist co-pilot (MongoDB).
// One document per LLM call (plan/next/verify/final/suggestion/detect) and per
// Deepgram audio session in `ai_usage_events`. The Usage tab aggregates these.
import { randomUUID } from "node:crypto";
import { collections } from "../mongo.js";
import type { FastifyBaseLogger } from "fastify";

export interface ModelPrice { in: number; out: number; }

// USD per 1,000,000 tokens. Keep current with https://openai.com/api/pricing/
export const PRICING: Record<string, ModelPrice> = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "text-embedding-3-small": { in: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0 },
};
const DEFAULT_PRICE: ModelPrice = { in: 0.15, out: 0.6 };

// USD per MINUTE of streamed audio (Deepgram etc.).
export const AUDIO_PRICING: Record<string, number> = {
  "nova-3": 0.0077, "nova-2": 0.0043, nova: 0.0043,
  "saaras:v3": 0.006, "shunya-streaming-v1": 0.005,
};
const DEFAULT_AUDIO_RATE = 0.0077;

export function priceFor(model: string): ModelPrice { return PRICING[model] ?? DEFAULT_PRICE; }
export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}
export function audioRatePerMin(model: string): number { return AUDIO_PRICING[model] ?? DEFAULT_AUDIO_RATE; }
export function audioCostUsd(model: string, seconds: number): number { return (seconds / 60) * audioRatePerMin(model); }

export async function recordAudioUsage(
  input: { orgId: string; callId?: string | null; operation: string; model: string; seconds: number },
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!input.seconds || input.seconds <= 0) return;
  try {
    await collections.aiUsageEvents().insertOne({
      id: randomUUID(), orgId: input.orgId, callId: input.callId ?? null,
      operation: input.operation, model: input.model,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      audioSeconds: Number(input.seconds.toFixed(2)),
      costUsd: audioCostUsd(input.model, input.seconds), createdAt: new Date(),
    });
  } catch (err) {
    log?.warn({ err, operation: input.operation }, "recordAudioUsage failed");
  }
}

export interface UsageInput {
  orgId: string; callId?: string | null; operation: string; model: string;
  promptTokens?: number; completionTokens?: number;
}

export async function recordUsage(input: UsageInput, log?: FastifyBaseLogger): Promise<void> {
  const promptTokens = input.promptTokens ?? 0;
  const completionTokens = input.completionTokens ?? 0;
  const total = promptTokens + completionTokens;
  if (total === 0) return;
  try {
    await collections.aiUsageEvents().insertOne({
      id: randomUUID(), orgId: input.orgId, callId: input.callId ?? null,
      operation: input.operation, model: input.model,
      promptTokens, completionTokens, totalTokens: total, audioSeconds: 0,
      costUsd: costUsd(input.model, promptTokens, completionTokens), createdAt: new Date(),
    });
  } catch (err) {
    log?.warn({ err, operation: input.operation }, "recordUsage failed");
  }
}

const SUM = {
  calls: { $sum: 1 },
  promptTokens: { $sum: "$promptTokens" },
  completionTokens: { $sum: "$completionTokens" },
  totalTokens: { $sum: "$totalTokens" },
  audioSeconds: { $sum: "$audioSeconds" },
  costUsd: { $sum: "$costUsd" },
} as const;

export async function usageSummary(orgId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const match = { orgId, createdAt: { $gte: since } };
  const c = collections.aiUsageEvents();

  const totalsArr = await c.aggregate([{ $match: match }, { $group: { _id: null, ...SUM } }]).toArray();
  const t = totalsArr[0] ?? {};

  const groupBy = async (field: string) =>
    c.aggregate([
      { $match: match },
      { $group: { _id: `$${field}`, ...SUM } },
      { $sort: { costUsd: -1 } },
    ]).toArray();

  const byOperation = (await groupBy("operation")).map((r) => ({
    operation: r._id, calls: r.calls, totalTokens: r.totalTokens, audioSeconds: r.audioSeconds, costUsd: r.costUsd,
  }));
  const byModel = (await groupBy("model")).map((r) => ({
    model: r._id, calls: r.calls, totalTokens: r.totalTokens, audioSeconds: r.audioSeconds, costUsd: r.costUsd,
  }));

  const recentDocs = await c.find(match).sort({ createdAt: -1 }).limit(25).toArray();
  const recent = recentDocs.map((r) => ({
    operation: r.operation, model: r.model, callId: r.callId,
    totalTokens: r.totalTokens, costUsd: r.costUsd,
    createdAt: (r.createdAt as Date).toISOString(),
  }));

  const byCallRaw = await c.aggregate([
    { $match: { ...match, callId: { $ne: null } } },
    { $group: { _id: "$callId", ...SUM, lastAt: { $max: "$createdAt" } } },
    { $sort: { lastAt: -1 } },
    { $limit: 50 },
    { $lookup: { from: "call_sessions", localField: "_id", foreignField: "id", as: "call" } },
    { $unwind: { path: "$call", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "candidates", localField: "call.candidateId", foreignField: "id", as: "cand" } },
    { $lookup: { from: "demands", localField: "call.demandId", foreignField: "id", as: "dem" } },
  ]).toArray();
  const byCall = byCallRaw.map((r) => {
    const candidate = r.cand?.[0]?.displayName ?? null;
    const demand = r.dem?.[0]?.title ?? null;
    return {
      callId: r._id as string,
      label: [candidate, demand].filter(Boolean).join(" · ") || (r._id ? String(r._id).slice(0, 8) : "—"),
      calls: r.calls, totalTokens: r.totalTokens, audioSeconds: r.audioSeconds, costUsd: r.costUsd,
      lastAt: (r.lastAt as Date)?.toISOString?.() ?? null,
    };
  });

  return {
    days,
    totals: {
      calls: t.calls ?? 0, promptTokens: t.promptTokens ?? 0, completionTokens: t.completionTokens ?? 0,
      totalTokens: t.totalTokens ?? 0, audioSeconds: t.audioSeconds ?? 0, costUsd: t.costUsd ?? 0,
    },
    byOperation, byModel, byCall, recent, pricing: PRICING,
  };
}
