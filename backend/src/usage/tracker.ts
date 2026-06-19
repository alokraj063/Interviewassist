// AI usage tracking has been removed alongside the rest of the side tables.
// We keep this module so existing call sites compile, but every function is
// a no-op. If/when usage tracking is needed again, decide whether to log to
// stdout or fold per-call totals into the interview document directly.
//
// All exports retain their original signatures so importers don't need to
// change.

import type { FastifyBaseLogger } from "fastify";

export interface ModelPrice { in: number; out: number }
export const PRICING: Record<string, ModelPrice> = {};
export const AUDIO_PRICING: Record<string, number> = {};

export function priceFor(_model: string): ModelPrice { return { in: 0, out: 0 }; }
export function costUsd(_model: string, _promptTokens: number, _completionTokens: number): number { return 0; }
export function audioRatePerMin(_model: string): number { return 0; }
export function audioCostUsd(_model: string, _seconds: number): number { return 0; }

export interface UsageInput {
  orgId: string;
  callId?: string | null;
  operation: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export async function recordAudioUsage(
  _input: { orgId: string; callId?: string | null; operation: string; model: string; seconds: number },
  _log?: FastifyBaseLogger,
): Promise<void> {
  // no-op
}

export async function recordUsage(_input: UsageInput, _log?: FastifyBaseLogger): Promise<void> {
  // no-op
}

export async function usageSummary(_orgId: string, _days = 30) {
  return {
    days: _days,
    totals: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, audioSeconds: 0, costUsd: 0 },
    byOperation: [],
    byModel: [],
    byCall: [],
    recent: [],
    pricing: PRICING,
  };
}
