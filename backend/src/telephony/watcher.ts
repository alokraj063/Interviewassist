// Server-side call watcher.
//
// Why this exists: the browser cannot reliably tell when the CANDIDATE picked
// up. FreJun's softphone reports "Established" as soon as our leg joins its
// bridge — while the candidate's phone is still ringing — so the SDK is not an
// answer signal. Only FreJun's own call record is.
//
// Polling that record from the browser was tried first and proved fragile: it
// depended on React state (is this a telephony call? is the softphone busy?)
// surviving remounts, and it silently stopped for exactly the calls that
// mattered. Observed: a not-answered call reconciled fine while two answered
// ones stayed stuck at "created".
//
// So the server polls instead and broadcasts over /ws/session. That is
// independent of anything the UI does, survives a page refresh, and is the
// same path the `call.status` webhook will use once a public URL exists —
// at which point this becomes a fallback rather than the primary signal.
import type { FastifyBaseLogger } from "fastify";
import { findCallByTransactionId } from "./frejun.js";
import { applyStatus, isTerminal, mapFrejunStatus } from "./callState.js";

const POLL_MS = 2500;
/** Give up well after any realistic ring-out, so a stuck call can't poll forever. */
const MAX_MS = 10 * 60_000;

const active = new Map<string, NodeJS.Timeout>();
/** Last status we actually wrote, so an unchanged poll is a no-op. */
const lastApplied = new Map<string, string>();

export function isWatching(callId: string): boolean {
  return active.has(callId);
}

export function stopWatching(callId: string): void {
  const t = active.get(callId);
  if (t) clearInterval(t);
  active.delete(callId);
  lastApplied.delete(callId);
}

/**
 * Follow a call until it reaches a terminal state, applying each change (which
 * broadcasts `call.status` / `call.answered` / `call.ended` to the browser).
 *
 * Safe to call twice for the same call — the second is a no-op.
 */
export function watchCall(callId: string, log: FastifyBaseLogger): void {
  if (active.has(callId)) return;
  const startedAt = Date.now();

  const tick = async () => {
    if (Date.now() - startedAt > MAX_MS) {
      log.warn({ callId }, "telephony watcher timed out");
      stopWatching(callId);
      return;
    }
    try {
      const remote = await findCallByTransactionId(callId);

      // Loud on purpose. FreJun's call log has proven only *eventually*
      // consistent: one call exposed "ongoing.." live, the next never appeared
      // until it was already over (so the watcher jumped created -> completed
      // and the answer was never seen). Without a per-tick trace there is no
      // way to tell "no record yet" apart from "record says nothing useful".
      log.info(
        {
          callId,
          tick: Math.round((Date.now() - startedAt) / 1000),
          found: Boolean(remote),
          raw: remote?.status ?? null,
          endTime: remote?.call_end_time ?? null,
        },
        "frejun watcher tick",
      );

      // Not in FreJun's log yet.
      if (!remote) return;

      // Call-log semantics, learned from live traces (docs describe none of it):
      //   "ongoing.."  → the call is happening right now (candidate on the line)
      //   "answered"   → the call was answered AND has since ENDED
      //   "not-answered"/"user-not-answered" → ended, never picked up
      //
      // NOTE: `call_end_time` is NOT an end signal — FreJun populates it even
      // while status is still "ongoing..", so trusting it made the watcher jump
      // straight to "completed" and skip "answered" entirely.
      const rawSlug = (remote.status ?? "").trim().toLowerCase().replace(/\.+$/, "");
      let mapped = mapFrejunStatus(remote.status); // "ongoing" → answered
      // The bare slug "answered" (not the webhook's prose "Call answered")
      // means answered-and-over.
      if (rawSlug === "answered") mapped = "completed";
      if (!mapped) {
        // Log once per call, not on every 2.5s tick — an unknown status used
        // to bury the log in identical warnings.
        if (lastApplied.get(callId) !== `unmapped:${remote.status}`) {
          lastApplied.set(callId, `unmapped:${remote.status}`);
          log.warn({ callId, raw: remote.status }, "unmapped frejun status in watcher");
        }
        return;
      }

      // "answered" is NOT terminal, so the watcher must keep polling to catch
      // the hangup — but it must not rewrite the same status on every tick.
      // Without this guard a 3-minute call accumulated 30 identical
      // `answered(reconcile)` history rows and kept re-stamping answerTime,
      // which corrupted the on-call timer.
      if (lastApplied.get(callId) === mapped) return;
      lastApplied.set(callId, mapped);

      await applyStatus({
        callId,
        status: mapped,
        source: "reconcile",
        patch: {
          frejunCallId: remote.call_id,
          startTime: remote.call_start_time ? new Date(remote.call_start_time) : null,
          endTime: remote.call_end_time ? new Date(remote.call_end_time) : null,
          // FreJun reports MINUTES; we store milliseconds everywhere.
          durationMs: remote.call_duration != null ? Math.round(remote.call_duration * 60_000) : null,
          frejunRecordingUrl: remote.recording_url ?? null,
          candidateNumber: remote.candidate_number ?? null,
          // The call-log endpoint has no explicit answer_time (only the webhook
          // payload carries one), so stamp it ourselves. Guarded by the
          // lastApplied check above, this runs exactly once per call.
          ...(mapped === "answered" ? { answerTime: new Date() } : {}),
        },
        log,
      });

      log.info({ callId, status: mapped, raw: remote.status }, "frejun watcher applied status");

      if (isTerminal(mapped)) stopWatching(callId);
    } catch (err) {
      // Transient network/API trouble: keep polling, the next tick retries.
      log.debug({ err, callId }, "telephony watcher tick failed");
    }
  };

  active.set(callId, setInterval(() => void tick(), POLL_MS));
  void tick();
}
