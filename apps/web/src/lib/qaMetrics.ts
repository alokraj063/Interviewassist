import type { TranscriptTurn, Sentiment } from "@/data/types";

function tsToSeconds(ts: string): number {
  const [m, s] = ts.split(":").map(Number);
  return (m || 0) * 60 + (s || 0);
}

/**
 * Infer each turn's duration from the gap to the next turn.
 * Last turn defaults to 8s since we have no end marker in the mock.
 */
function turnDurations(turns: TranscriptTurn[]): number[] {
  const secs = turns.map((t) => tsToSeconds(t.ts));
  return secs.map((s, i) => {
    if (i === secs.length - 1) return 8;
    return Math.max(1, secs[i + 1] - s);
  });
}

/** Sum of gaps over 3 seconds between consecutive speaker turns. */
export function deadAirSeconds(turns: TranscriptTurn[]): number {
  if (turns.length < 2) return 0;
  const durations = turnDurations(turns);
  let dead = 0;
  for (let i = 0; i < turns.length - 1; i++) {
    const gap = tsToSeconds(turns[i + 1].ts) - (tsToSeconds(turns[i].ts) + durations[i]);
    if (gap > 3) dead += gap;
  }
  return Math.round(dead);
}

/** Ratio of agent speaking seconds to customer speaking seconds. 0-100. */
export function talkListenRatio(turns: TranscriptTurn[]): { agentPct: number; customerPct: number } {
  const durations = turnDurations(turns);
  let agent = 0;
  let customer = 0;
  turns.forEach((t, i) => {
    if (t.speaker === "agent") agent += durations[i];
    else customer += durations[i];
  });
  const total = agent + customer;
  if (total === 0) return { agentPct: 0, customerPct: 0 };
  return {
    agentPct: Math.round((agent / total) * 100),
    customerPct: Math.round((customer / total) * 100),
  };
}

/** Average words-per-minute for agent turns. */
export function agentWpm(turns: TranscriptTurn[]): number {
  const durations = turnDurations(turns);
  let words = 0;
  let seconds = 0;
  turns.forEach((t, i) => {
    if (t.speaker !== "agent") return;
    words += t.text.split(/\s+/).filter(Boolean).length;
    seconds += durations[i];
  });
  if (seconds === 0) return 0;
  return Math.round((words / seconds) * 60);
}

const SENTIMENT_SCORES: Record<Sentiment, number> = {
  positive: 0.5,
  neutral: 0,
  negative: -0.4,
  escalated: -0.8,
};

/**
 * Average customer sentiment in the first third vs last third of the call.
 * Returns values in [-1, 1] plus a trend.
 */
export function sentimentArc(turns: TranscriptTurn[]): {
  start: number;
  end: number;
  trend: "recovery" | "decline" | "stable";
} {
  const customerTurns = turns.filter((t) => t.speaker === "customer");
  if (customerTurns.length < 2) return { start: 0, end: 0, trend: "stable" };
  const third = Math.max(1, Math.floor(customerTurns.length / 3));
  const first = customerTurns.slice(0, third);
  const last = customerTurns.slice(-third);
  const avg = (arr: TranscriptTurn[]) =>
    arr.reduce((s, t) => s + (t.sentiment ? SENTIMENT_SCORES[t.sentiment] : 0), 0) / arr.length;
  const start = Number(avg(first).toFixed(2));
  const end = Number(avg(last).toFixed(2));
  const delta = end - start;
  const trend: "recovery" | "decline" | "stable" =
    delta > 0.15 ? "recovery" : delta < -0.15 ? "decline" : "stable";
  return { start, end, trend };
}

/**
 * Number of discovery questions asked by the agent (turns ending in `?`).
 * A crude but useful signal for diagnosis quality.
 */
export function discoveryQuestions(turns: TranscriptTurn[]): number {
  return turns.filter((t) => t.speaker === "agent" && t.text.includes("?")).length;
}

/**
 * Interruption count — only meaningful with ms-level tsStart/tsEnd.
 * Mock data lacks end timestamps, so returns null; real data path can compute.
 */
export function interruptionCount(_turns: TranscriptTurn[]): number | null {
  return null;
}

export function formatSentimentArc(a: ReturnType<typeof sentimentArc>): string {
  const arrow = a.trend === "recovery" ? "▲" : a.trend === "decline" ? "▼" : "■";
  const fmt = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));
  return `${fmt(a.start)} → ${fmt(a.end)} ${arrow} ${a.trend}`;
}
