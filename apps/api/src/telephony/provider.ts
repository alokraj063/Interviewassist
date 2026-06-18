// Provider-agnostic surface for warm-handing a triaged call to its
// destination. Triage routing in apps/api/src/routes/triage.ts dispatches
// against this interface based on the call's `origin` so adding a new
// provider (Twilio, Exotel, etc.) is a one-file change.

import type { Classification, TriageHandoffMode } from "@j2w/shared-types";

export type TelephonyProviderId = "vapi";

export interface WarmTransferToHumanOpts {
  // E.164 PSTN extension for the picked human agent.
  extension?: string;
  // Spoken summary the AI will say on the bridged call before stepping off.
  summary: string;
  // Free-form classification snapshot, useful for IVR-side debugging.
  classification: Classification;
  // Mode requested by the rule. Cold = blind transfer, no summary spoken.
  mode: TriageHandoffMode;
}

export interface WarmTransferToAssistantOpts {
  targetVapiAssistantId: string;
  // Triage flow's vapi squad id when routing within a squad. Optional: when
  // absent the provider falls back to a fresh squad for this call.
  squadId?: string | null;
  classification: Classification;
}

export interface TelephonyProvider {
  id: TelephonyProviderId;

  // Hands the active call off to a human extension. For Vapi we use the
  // built-in transferCall tool with `transferPlan.mode='warm-transfer-say-summary'`.
  warmTransferToHuman(callId: string, opts: WarmTransferToHumanOpts): Promise<void>;

  // Hands the active call off to a different autonomous voice agent.
  // Vapi: switch the active member of the call's squad.
  warmTransferToAssistant(callId: string, opts: WarmTransferToAssistantOpts): Promise<void>;

  // Gracefully end the call (no transfer) — used for the voicemail
  // destination after the recording is captured.
  endCall(callId: string): Promise<void>;
}

export class NotImplementedError extends Error {
  constructor(public readonly provider: TelephonyProviderId, public readonly method: string) {
    super(`Telephony provider '${provider}' does not implement '${method}' yet`);
    this.name = "NotImplementedError";
  }
}
