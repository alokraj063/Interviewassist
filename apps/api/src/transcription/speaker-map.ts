// Per-call mapping from a Deepgram diarization speaker index to a
// recruiter/candidate role for the mixed-mono browser-mic wedge.
//
// Diarization on a single mixed-mono source (recruiter's phone on speaker +
// laptop mic) is imperfect, so the role this module returns is only a
// PROVISIONAL guess that we show immediately for a responsive UI. The
// suggestion engine's logical LLM pass (rag/suggest.ts) runs on every final
// turn and authoritatively relabels it afterwards via a `transcript.relabel`
// event, so the end state is content-driven, not diarization-driven.
//
// Heuristic seed: on an outbound recruiter call the recruiter speaks first
// (greeting / intro), so the first distinct diarized voice is mapped to
// 'recruiter' and the next distinct voice to 'candidate'. Any third+ speaker
// index falls back to 'candidate'.
import type { Speaker } from "@j2w/shared-types";

const roleByCall = new Map<string, Map<number, Speaker>>();

/** Provisional role for a diarized speaker index on this call. */
export function provisionalRole(callId: string, dgSpeaker: number): Speaker {
  let m = roleByCall.get(callId);
  if (!m) {
    m = new Map();
    roleByCall.set(callId, m);
  }
  const existing = m.get(dgSpeaker);
  if (existing) return existing;
  const role: Speaker = m.size === 0 ? "recruiter" : "candidate";
  m.set(dgSpeaker, role);
  return role;
}

/** Drop a call's speaker map when the call ends. */
export function clearSpeakers(callId: string): void {
  roleByCall.delete(callId);
}
