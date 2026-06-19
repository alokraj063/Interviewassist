// Thin client for /api/triage/*. Mirrors the server response shapes from
// apps/api/src/routes/triage.ts. All values trace to live apiFetch calls — no
// mock data lives here.

import { apiFetch } from "@/lib/api";
import type {
  HandoffContext,
  LiveTriageSession,
  LiveTriageSessionPage,
  TriageAnalytics,
  TriageAuditAction,
  TriageAuditRow,
  TriageDestinationCatalog,
  TriageDestinationType,
  TriageDryRunResult,
  TriageFlow,
  TriageRoutingRule,
  TriageRuleSetSummary,
  TriageSessionDetail,
} from "@j2w/shared-types";

export async function fetchTriageFlows(): Promise<TriageFlow[]> {
  const res = await apiFetch<{ flows: TriageFlow[] }>("/api/triage/flows");
  return res.flows;
}

export async function fetchTriageFlow(id: string): Promise<{
  flow: TriageFlow;
  publishedVersion: number | null;
} | null> {
  try {
    return await apiFetch<{ flow: TriageFlow; publishedVersion: number | null }>(
      `/api/triage/flows/${id}`,
    );
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function fetchRoutingRules(
  flowId: string,
  ruleSetId?: string,
): Promise<TriageRoutingRule[]> {
  const qs = ruleSetId ? `?ruleSetId=${encodeURIComponent(ruleSetId)}` : "";
  const res = await apiFetch<{ rules: TriageRoutingRule[] }>(
    `/api/triage/flows/${flowId}/routing-rules${qs}`,
  );
  return res.rules;
}

// Saves a DRAFT — server validates priorities/fallback/destinations and 400s
// with `issues` on failure (surfaced inline by the builder).
export async function saveRoutingRules(
  flowId: string,
  rules: TriageRoutingRule[],
): Promise<TriageRoutingRule[]> {
  const payload = {
    rules: rules.map(({ flowId: _flowId, ...r }) => r),
  };
  const res = await apiFetch<{ rules: TriageRoutingRule[] }>(
    `/api/triage/flows/${flowId}/routing-rules`,
    { method: "PUT", json: payload },
  );
  return res.rules;
}

// ---- versioned rule sets ----

export interface RuleSetsPage {
  ruleSets: TriageRuleSetSummary[];
  nextCursor: number | null;
}

export async function fetchRuleSets(
  flowId: string,
  cursor?: number | null,
): Promise<RuleSetsPage> {
  const params = new URLSearchParams();
  if (cursor != null) params.set("cursor", String(cursor));
  const qs = params.toString();
  return apiFetch<RuleSetsPage>(
    `/api/triage/flows/${flowId}/rule-sets${qs ? `?${qs}` : ""}`,
  );
}

export async function publishRuleSet(
  flowId: string,
  note: string | undefined,
): Promise<TriageRuleSetSummary> {
  const res = await apiFetch<{ ruleSet: TriageRuleSetSummary }>(
    `/api/triage/flows/${flowId}/rule-sets/publish`,
    { method: "POST", json: { note } },
  );
  return res.ruleSet;
}

export async function rollbackRuleSet(
  flowId: string,
  versionId: string,
): Promise<TriageRuleSetSummary> {
  const res = await apiFetch<{ ruleSet: TriageRuleSetSummary }>(
    `/api/triage/flows/${flowId}/rule-sets/${versionId}/rollback`,
    { method: "POST", json: {} },
  );
  return res.ruleSet;
}

// ---- dry-run against history ----

export interface DryRunInput {
  rules?: TriageRoutingRule[];
  ruleSetId?: string;
  windowDays: number;
  sampleLimit: number;
}

export async function dryRunRules(
  flowId: string,
  input: DryRunInput,
): Promise<TriageDryRunResult> {
  const body: Record<string, unknown> = {
    windowDays: input.windowDays,
    sampleLimit: input.sampleLimit,
  };
  if (input.rules) {
    body.rules = input.rules.map(({ flowId: _flowId, ...r }) => r);
  }
  if (input.ruleSetId) body.ruleSetId = input.ruleSetId;
  return apiFetch<TriageDryRunResult>(`/api/triage/flows/${flowId}/dry-run`, {
    method: "POST",
    json: body,
  });
}

// ---- live ops board ----

export interface LiveSessionFilters {
  status?: string;
  flowId?: string;
  slaBreached?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

export async function fetchLiveTriageSessions(
  filters: LiveSessionFilters = {},
): Promise<LiveTriageSessionPage> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.flowId) params.set("flowId", filters.flowId);
  if (filters.slaBreached) params.set("slaBreached", "true");
  if (filters.q) params.set("q", filters.q);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return apiFetch<LiveTriageSessionPage>(
    `/api/triage/sessions/active${qs ? `?${qs}` : ""}`,
  );
}

export async function fetchTriageSession(callId: string): Promise<TriageSessionDetail | null> {
  try {
    const res = await apiFetch<{ session: TriageSessionDetail }>(
      `/api/triage/sessions/${encodeURIComponent(callId)}`,
    );
    return res.session;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

// ---- live-call operate verbs ----

export interface ReassignInput {
  destinationType: TriageDestinationType;
  destinationRef: string;
  destinationLabel?: string;
  reason?: string;
}

export async function reassignSession(
  callId: string,
  input: ReassignInput,
): Promise<{ ok: boolean; destinationLabel: string }> {
  return apiFetch(`/api/triage/sessions/${encodeURIComponent(callId)}/reassign`, {
    method: "POST",
    json: input,
  });
}

export interface OverrideInput {
  intent: string;
  urgency?: "low" | "normal" | "high";
  reason?: string;
}

export async function overrideClassification(
  callId: string,
  input: OverrideInput,
): Promise<{
  ok: boolean;
  destinationLabel: string | null;
  destinationType: TriageDestinationType | null;
}> {
  return apiFetch(
    `/api/triage/sessions/${encodeURIComponent(callId)}/override-classification`,
    { method: "POST", json: input },
  );
}

export async function terminateSession(
  callId: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/triage/sessions/${encodeURIComponent(callId)}/terminate`, {
    method: "POST",
    json: { reason },
  });
}

// ---- analytics ----

export interface AnalyticsFilters {
  from?: string;
  to?: string;
  flowId?: string;
}

export async function fetchTriageAnalytics(
  filters: AnalyticsFilters = {},
): Promise<TriageAnalytics> {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.flowId) params.set("flowId", filters.flowId);
  const qs = params.toString();
  return apiFetch<TriageAnalytics>(`/api/triage/analytics${qs ? `?${qs}` : ""}`);
}

// ---- config audit ----

export interface AuditPage {
  events: TriageAuditRow[];
  nextCursor: number | null;
}

export async function fetchTriageAudit(params: {
  flowId?: string;
  action?: TriageAuditAction;
  cursor?: number | null;
}): Promise<AuditPage> {
  const qs = new URLSearchParams();
  if (params.flowId) qs.set("flowId", params.flowId);
  if (params.action) qs.set("action", params.action);
  if (params.cursor != null) qs.set("cursor", String(params.cursor));
  const q = qs.toString();
  return apiFetch<AuditPage>(`/api/triage/audit${q ? `?${q}` : ""}`);
}

// ---- handoff (unchanged) ----

export async function fetchHandoffContext(callId: string): Promise<HandoffContext | null> {
  try {
    return await apiFetch<HandoffContext>(
      `/api/triage/handoff/${encodeURIComponent(callId)}/context`,
    );
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function acceptTriageHandoff(callId: string): Promise<void> {
  await apiFetch(`/api/triage/handoff/${encodeURIComponent(callId)}/accept`, {
    method: "POST",
    json: {},
  });
}

export async function fetchTriageDestinations(): Promise<TriageDestinationCatalog> {
  return apiFetch<TriageDestinationCatalog>("/api/triage/destinations");
}

export type { LiveTriageSession };
