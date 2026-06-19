import { EventEmitter } from "node:events";
import type { Classification, TriageHandoffMode } from "@j2w/shared-types";

export interface CallAssignedEvent {
  type: "call_assigned";
  callId: string;
  recruiterUserId: string;
  orgId: string;
  candidateRefOrPhone: string | null;
  origin: "web" | "telephony" | "desktop" | "vapi" | "bridge";
  assignedAt: string;
}

export interface CallEndedEvent {
  type: "call_ended";
  callId: string;
  recruiterUserId: string | null;
}

// Triage warm-handoff: server picked an idle user in the destination team
// and is asking them to accept the handed-off call. Includes the prebuilt
// classification + summary so the desktop/web can render the Accept toast
// without an extra fetch.
export interface TriageHandoffOfferedEvent {
  type: "triage_handoff_offered";
  callId: string;
  recruiterUserId: string;
  orgId: string;
  triageAgentId: string;
  triageFlowName: string;
  classification: Classification;
  summary: string;
  handoffMode: TriageHandoffMode;
  expiresAt: string;
}

export interface TriageHandoffAcceptedEvent {
  type: "triage_handoff_accepted";
  callId: string;
  recruiterUserId: string;
  ts: number;
}

export interface TriageHandoffFailedEvent {
  type: "triage_handoff_failed";
  callId: string;
  recruiterUserId: string | null;
  reason: string;
  ts: number;
}

// Team Monitor supervisor intervention state change (whisper/barge/takeover
// requested|active|ended|denied|failed). Published when a supervisor opens or
// ends a supervision session so the recruiter's live-call WS can render a
// "supervisor present" banner. Additive — no new WS endpoint, reuses /ws/session.
export interface SupervisionChangedEvent {
  type: "supervision_changed";
  callId: string;
  orgId: string;
  sessionId: string;
  mode: "whisper" | "barge" | "takeover";
  state: "requested" | "active" | "ended" | "denied" | "failed";
  supervisorUserId: string;
  supervisorName: string | null;
  ts: number;
}

export type AgentEvent =
  | CallAssignedEvent
  | CallEndedEvent
  | TriageHandoffOfferedEvent
  | TriageHandoffAcceptedEvent
  | TriageHandoffFailedEvent
  | SupervisionChangedEvent;

// In-process pub/sub for agent-facing events. Swap for Redis pub/sub when we
// need to run multiple API instances; for now a single-node EventEmitter is
// enough and keeps latency near-zero.
class Bus extends EventEmitter {
  publish(ev: AgentEvent): void {
    this.emit("agent-event", ev);
  }
  subscribe(fn: (ev: AgentEvent) => void): () => void {
    this.on("agent-event", fn);
    return () => this.off("agent-event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);
