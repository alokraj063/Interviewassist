// Shared types for the AI triage feature. Imported by apps/api, apps/web, and
// apps/worker. Keep dependency-free.

import type { TranscriptTurn } from "./index.js";

export type TriageDestinationType =
  | "human_team"
  | "voice_agent"
  | "external_pstn"
  | "voicemail";

export type TriageHandoffMode = "warm" | "cold" | "voicemail";

export type CallRoutingEventKind =
  | "triage_started"
  | "classified"
  | "route_decision"
  | "handoff_initiated"
  | "handoff_accepted"
  | "handoff_failed"
  | "handoff_completed";

export type TriageStatus = "active" | "paused" | "draft";

// What the triage assistant tells us about a call when it invokes routeCall.
// `urgency` is derived server-side from sentiment + caller phrasing; the LLM
// doesn't have to fill it in.
export interface Classification {
  intent: string;
  confidence: number;
  sentiment?: number;
  language?: string;
  urgency?: "low" | "normal" | "high";
  entities?: Record<string, string>;
  reason?: string;
  updatedAt?: string;
}

export interface TriageFlow {
  id: string;
  name: string;
  purpose: string;
  status: TriageStatus;
  phoneNumber: string | null;
  language: string;
  intentVocabulary: string[];
  ruleCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  voiceAgentId: string;
  routing?: {
    intentVocabulary?: string[];
    defaultDestinationRef?: string;
    confidenceThreshold?: number;
  } | null;
}

export interface TriageRoutingRuleConditions {
  minConfidence?: number;
  sentimentLt?: number;
  language?: string;
}

export type TriageRoutingStrategy =
  | "first_idle"
  | "round_robin"
  | "weighted"
  | "least_loaded";

export interface TriageRoutingRule {
  id: string;
  flowId: string;
  priority: number;
  intent: string;
  conditions?: TriageRoutingRuleConditions;
  destinationType: TriageDestinationType;
  destinationRef: string;
  destinationLabel: string;
  handoffMode: TriageHandoffMode;
  enabled: boolean;
  uiPosition: { x: number; y: number };
  // Enterprise SLA / capacity / load-balancing knobs (additive; default-filled
  // server-side so older callers omitting them still validate).
  slaTargetSec?: number | null;
  routingStrategy?: TriageRoutingStrategy;
  weight?: number;
  maxConcurrent?: number | null;
  requiredSkill?: string | null;
}

export type TriageRulesetStatus = "draft" | "published" | "archived";

export interface TriageRuleSetSummary {
  id: string;
  flowId: string;
  version: number;
  status: TriageRulesetStatus;
  note: string | null;
  ruleCount: number;
  publishedAt: string | null;
  publishedByUserId: string | null;
  publishedByName: string | null;
  createdAt: string;
}

export interface TriageDryRunResult {
  windowDays: number;
  sampleLimit: number;
  evaluated: number;
  matched: number;
  noMatch: number;
  fallback: number;
  // Calls whose destination would change vs the currently-published set.
  wouldRouteDifferently: number;
  byDestination: Array<{ destination: string; count: number }>;
  projectedSlaBreaches: number;
  asOf: string;
}

export type TriageAuditAction =
  | "ruleset.saved_draft"
  | "ruleset.published"
  | "ruleset.rolled_back"
  | "flow.status_changed"
  | "flow.archived"
  | "session.reassigned"
  | "session.classification_overridden"
  | "session.terminated"
  | "dryrun.executed";

export interface TriageAuditRow {
  id: number;
  flowId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  action: TriageAuditAction;
  targetType: string | null;
  targetId: string | null;
  diff: Record<string, unknown> | null;
  createdAt: string;
}

export type LiveTriageSessionStatus =
  | "classifying"
  | "decided"
  | "handing_off"
  | "completed"
  | "failed";

export interface LiveTriageSession {
  callId: string;
  flowId: string;
  flowName: string;
  callerRef: string;
  startedAt: string;
  elapsedSec: number;
  status: LiveTriageSessionStatus;
  classification: Classification;
  destinationLabel: string | null;
  destinationType: TriageDestinationType | null;
  // SLA target inherited from the matched rule (seconds), remaining countdown,
  // and breach flag. Null target = the matched rule set no SLA.
  slaTargetSec: number | null;
  slaRemainingSec: number | null;
  slaBreached: boolean;
}

export interface LiveTriageSessionPage {
  sessions: LiveTriageSession[];
  nextCursor: string | null;
  total: number;
}

export interface CallRoutingEvent {
  id: number;
  callId: string;
  seq: number;
  kind: CallRoutingEventKind;
  fromRef?: { type: string; id: string; label?: string };
  toRef?: { type: string; id: string; label?: string };
  classification?: Classification;
  ruleId?: string | null;
  createdAt: string;
}

export interface TriageSessionDetail extends LiveTriageSession {
  turns: TranscriptTurn[];
  timeline: Array<{ t: string; kind: CallRoutingEventKind; label: string }>;
}

export interface TriageRuleHitRate {
  ruleId: string;
  intent: string;
  destinationLabel: string;
  decisions: number;
  hitRatePct: number; // decisions / total route_decisions in window
  slaAttainmentPct: number | null; // % of this rule's handoffs within SLA
}

export interface TriageAnalytics {
  triagedToday: number;
  avgTimeToRouteSec: number;
  autoResolvedPct: number;
  toHumanPct: number;
  // Real handoff-success over the trailing 24h: completed / (completed+failed).
  handoffSuccess24hPct: number;
  noMatchRate: number; // % of triaged calls that hit no rule (fallback excluded)
  fallbackRate: number; // % routed via the '*' fallback rule
  slaAttainmentPct: number; // % of handoffs completed within the matched rule SLA
  byIntent: Array<{ intent: string; count: number }>;
  byDestination: Array<{ destination: string; human: number; voiceAgent: number }>;
  byRule: TriageRuleHitRate[];
  dailyVolume: Array<{ day: string; triaged: number; handoffs: number }>;
  asOf: string;
}

export interface HandoffContext {
  callId: string;
  fromFlowId: string;
  fromFlowName: string;
  classification: Classification;
  triageTurns: TranscriptTurn[];
  summary: string;
  arrivedAt: string;
}

// Body the routeCall fulfillment endpoint accepts, sent by the triage
// assistant via Vapi function-call webhook.
export interface RouteCallRequest {
  callId: string;
  intent: string;
  confidence: number;
  sentiment?: number;
  language?: string;
  entities?: Record<string, string>;
  reason?: string;
}

export interface RouteCallResponse {
  destinationType: TriageDestinationType;
  destinationRef: string;
  destinationLabel: string;
  handoffMode: TriageHandoffMode;
  // Spoken acknowledgement Vapi should say before transferring.
  instructions: string;
  ruleId: string | null;
}

// Lightweight option lists for the routing-rule editor's destination pickers.
// Returned by GET /api/triage/destinations so the web doesn't hard-code teams.
export interface TriageDestinationOption {
  id: string;
  name: string;
}
export interface TriageDestinationCatalog {
  humanTeams: TriageDestinationOption[];
  voiceAgents: TriageDestinationOption[];
}
