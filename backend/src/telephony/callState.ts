// Shared telephony state for an interview document.
//
// Both the outbound route (routes/telephony.ts) and the webhook receiver
// (routes/frejunWebhook.ts) mutate the same `telephony` sub-document, so the
// transition rules live here rather than being written twice.
//
// Everything is ADDITIVE to `ia_interviews`. The existing transcript pipeline
// reads none of these fields, so calls created the old way keep working
// untouched.
import type { FastifyBaseLogger } from "fastify";
import { collections } from "../mongo.js";
import { broadcastToCall } from "../ws/session.js";

export type TelephonyStatus =
  | "created"
  | "dialing"
  | "ringing"
  | "answered"
  | "completed"
  /** Actively refused — the recruiter pressed Decline, or the candidate rejected the call. */
  | "declined"
  | "busy"
  | "not-answered"
  | "failed";

export type CallDirection = "outbound" | "inbound";

/**
 * Rank used to reject out-of-order webhooks. Telephony providers retry and
 * re-order freely, so a late "ringing" must never clobber "completed".
 * Terminal states share the top rank — whichever lands first wins.
 */
const RANK: Record<TelephonyStatus, number> = {
  created: 0,
  dialing: 1,
  ringing: 2,
  answered: 3,
  completed: 4,
  declined: 4,
  busy: 4,
  "not-answered": 4,
  failed: 4,
};

export function isTerminal(status: TelephonyStatus): boolean {
  return RANK[status] === 4;
}

/**
 * Map FreJun's status vocabulary onto ours.
 *
 * Two vocabularies exist and they differ — the webhook `call.status` event
 * sends prose ("Call answered"), while GET /integrations/calls/ returns slugs
 * ("answered", "not-answered", "user-not-answered"). Both are handled.
 * Unknown values map to null so the caller can log and ignore rather than
 * corrupt state.
 */
export function mapFrejunStatus(
  raw: string | null | undefined,
  hasAnswerTime?: boolean,
): TelephonyStatus | null {
  // FreJun pads some live values with trailing dots ("ongoing..") — observed in
  // the wild, not documented. Strip them before matching.
  const s = (raw ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!s) return null;
  // A real pickup ALWAYS carries an answer timestamp (webhook `answer_time`,
  // call-log `call_start_time`). FreJun reports "ongoing"/"in progress" (and the
  // webhook an "answered" event) WHILE THE PHONE IS STILL RINGING, with no
  // answer time yet — mapping that to "answered" lit up "On call" + the timer +
  // the live transcript before anyone picked up. When the caller passes
  // hasAnswerTime === false we hold at "ringing" until the answer time arrives.
  const answeredGate = (mapped: TelephonyStatus): TelephonyStatus =>
    hasAnswerTime === false ? "ringing" : mapped;
  // While a call is UP, the call-log status is "ongoing" — a value that appears
  // nowhere in the docs and that only shows during the call. Once the call
  // ends the same record flips to "answered". So "ongoing" is the real
  // candidate-picked-up signal; "answered" alone arrives too late to start
  // transcribing. (End-of-call is detected from call_end_time, not from the
  // status string — see telephony/watcher.ts.)
  if (s === "ongoing" || s.includes("in progress") || s.includes("in-progress")) return answeredGate("answered");
  if (s.includes("outbound") && s.includes("initiated")) return "dialing";
  if (s.includes("inbound") && s.includes("initiated")) return "ringing";
  if (s === "answered" || s.includes("call answered")) return answeredGate("answered");
  if (s === "completed" || s.includes("call completed")) return "completed";
  // An active refusal, by either side. Kept distinct from "not-answered"
  // because the call log has to tell "they said no" apart from "nobody picked
  // up" — the recruiter acts differently on each.
  if (s === "declined" || s === "rejected" || s.includes("declin") || s.includes("reject")) {
    return "declined";
  }
  if (s === "busy" || s.includes("call busy")) return "busy";
  if (s === "not-answered" || s === "user-not-answered" || s.includes("not answered")) {
    return "not-answered";
  }
  if (s === "call-initiating" || s === "initiating") return "dialing";
  if (s === "ringing") return "ringing";
  if (s === "failed") return "failed";
  return null;
}

export interface ApplyStatusInput {
  callId: string;
  status: TelephonyStatus;
  source: "webhook" | "sdk" | "api" | "reconcile";
  /** Extra `telephony.*` fields to set alongside the status. */
  patch?: Record<string, unknown>;
  log: FastifyBaseLogger;
}

/**
 * Move an interview's telephony status forward and tell the browser.
 *
 * Returns false when the transition was rejected as stale (out-of-order
 * delivery) or the interview is missing — callers should treat that as a
 * successful no-op, not an error.
 */
export async function applyStatus(input: ApplyStatusInput): Promise<boolean> {
  const { callId, status, source, patch = {}, log } = input;

  const current = await collections.interviews().findOne<{
    telephony?: { status?: TelephonyStatus; direction?: CallDirection };
  }>({ id: callId }, { projection: { _id: 0, telephony: 1 } });

  if (!current) {
    log.warn({ callId, status, source }, "telephony status for unknown interview");
    return false;
  }

  const prev = current.telephony?.status;
  if (prev && RANK[status] < RANK[prev]) {
    log.info({ callId, prev, status, source }, "ignoring stale telephony status");
    return false;
  }
  // Terminal statuses all share the TOP rank, so the guard above — which only
  // rejects a lower rank — happily let a later terminal status overwrite an
  // earlier one. That is exactly how a missed inbound call ended up labelled
  // "completed" (QA TC053): the browser correctly reported "not-answered" the
  // instant the ring stopped, then FreJun's webhook landed a second later
  // calling the same call "completed", because that is what FreJun calls every
  // finished call regardless of whether anyone picked up.
  //
  // First terminal wins. The browser is the only witness to whether the
  // recruiter actually answered, and it always reports first.
  if (prev && status !== prev && isTerminal(prev)) {
    log.info({ callId, prev, status, source }, "keeping first terminal telephony status");
    return false;
  }
  // Same-rank repeats (duplicate deliveries) still refresh `patch` but must not
  // re-broadcast, or the UI flickers and retry counters double-fire.
  const isRepeat = prev === status;

  const now = new Date();
  const set: Record<string, unknown> = { "telephony.status": status };
  for (const [k, v] of Object.entries(patch)) set[`telephony.${k}`] = v;

  await collections.interviews().updateOne(
    { id: callId },
    // Repeats (e.g. the frontend's mid-ring reconcile poll firing "ringing"
    // every couple of seconds) refresh `patch` but must NOT push a duplicate
    // history entry — the status history IS the call log the UI renders.
    isRepeat
      ? ({ $set: set } as never)
      : ({
          $set: set,
          $push: { "telephony.statusHistory": { status, at: now, source } },
        } as never),
  );

  if (isRepeat) return true;

  const direction = (current.telephony?.direction ?? "outbound") as CallDirection;
  const ts = now.getTime();
  broadcastToCall(callId, { type: "call.status", callId, status, direction, ts });
  if (status === "answered") broadcastToCall(callId, { type: "call.answered", callId, ts });
  if (isTerminal(status)) broadcastToCall(callId, { type: "call.ended", callId, ts });

  return true;
}
