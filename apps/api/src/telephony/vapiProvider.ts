// Vapi implementation of TelephonyProvider. Used by the triage routing
// engine to actually move a Vapi-hosted call from the triage assistant
// to its destination (human PSTN extension or another voice agent).
//
// Vapi mid-call control happens via PATCH /call/:id with a `transfer` or
// `control` directive. The exact field shape is loosely typed in the SDK
// docs; we keep our payload minimal so behavior changes without code edits.

import {
  NotImplementedError,
  type TelephonyProvider,
  type WarmTransferToAssistantOpts,
  type WarmTransferToHumanOpts,
} from "./provider.js";
import { patchCall } from "../vapi/client.js";

export const vapiProvider: TelephonyProvider = {
  id: "vapi",

  async warmTransferToHuman(callId, opts) {
    if (!opts.extension) {
      // No PSTN extension — surface a typed error so the caller can either
      // fall back to a queue or fail the routing decision.
      throw new NotImplementedError("vapi", "warmTransferToHuman_without_extension");
    }
    await patchCall(callId, {
      transfer: {
        destination: {
          type: "number",
          number: opts.extension,
        },
        transferPlan: {
          mode:
            opts.mode === "warm"
              ? "warm-transfer-say-summary"
              : "blind-transfer",
          ...(opts.mode === "warm" ? { summaryPlan: { summary: opts.summary } } : {}),
        },
      },
    });
  },

  async warmTransferToAssistant(callId, opts) {
    // For a squad-backed call: switch the active member to the target
    // assistant. For a non-squad call: kick off an assistant transfer with a
    // freshly-resolved destination.
    if (opts.squadId) {
      await patchCall(callId, {
        squad: {
          activeMemberAssistantId: opts.targetVapiAssistantId,
        },
      });
      return;
    }
    await patchCall(callId, {
      transfer: {
        destination: {
          type: "assistant",
          assistantId: opts.targetVapiAssistantId,
        },
        transferPlan: {
          mode: "warm-transfer-say-summary",
          summaryPlan: {
            summary: `Routing to specialist agent. Caller intent: ${opts.classification.intent}.`,
          },
        },
      },
    });
  },

  async endCall(callId) {
    await patchCall(callId, { control: { type: "end-call" } });
  },
};
