// Real API queries + mutations for the triage feature. Every hook resolves to
// a live /api/triage/* call (no mock layer).

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  acceptTriageHandoff,
  dryRunRules,
  fetchHandoffContext,
  fetchLiveTriageSessions,
  fetchRoutingRules,
  fetchRuleSets,
  fetchTriageAnalytics,
  fetchTriageAudit,
  fetchTriageDestinations,
  fetchTriageFlow,
  fetchTriageFlows,
  fetchTriageSession,
  overrideClassification,
  publishRuleSet,
  reassignSession,
  rollbackRuleSet,
  saveRoutingRules,
  terminateSession,
  type AnalyticsFilters,
  type AuditPage,
  type DryRunInput,
  type LiveSessionFilters,
  type OverrideInput,
  type ReassignInput,
  type RuleSetsPage,
} from "@/lib/triageApi";
import type {
  HandoffContext,
  LiveTriageSessionPage,
  TriageAnalytics,
  TriageAuditAction,
  TriageDestinationCatalog,
  TriageDryRunResult,
  TriageFlow,
  TriageRoutingRule,
  TriageRuleSetSummary,
  TriageSessionDetail,
} from "@j2w/shared-types";

export function useTriageFlows() {
  return useQuery<TriageFlow[]>({
    queryKey: ["triage", "flows"],
    queryFn: fetchTriageFlows,
  });
}

export function useTriageFlow(id: string | undefined) {
  return useQuery({
    queryKey: ["triage", "flow", id],
    queryFn: () => fetchTriageFlow(id!),
    enabled: !!id,
  });
}

export function useRoutingRules(flowId: string | undefined, ruleSetId?: string) {
  return useQuery<TriageRoutingRule[]>({
    queryKey: ["triage", "rules", flowId, ruleSetId ?? null],
    queryFn: () => fetchRoutingRules(flowId!, ruleSetId),
    enabled: !!flowId,
  });
}

export function useSaveRoutingRules(flowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: TriageRoutingRule[]) => {
      if (!flowId) throw new Error("missing flowId");
      return saveRoutingRules(flowId, rules);
    },
    onSuccess: (rules) => {
      if (flowId) qc.setQueryData(["triage", "rules", flowId, null], rules);
    },
  });
}

// ---- versioned rule sets ----

export function useRuleSets(flowId: string | undefined) {
  return useQuery<RuleSetsPage>({
    queryKey: ["triage", "rule-sets", flowId],
    queryFn: () => fetchRuleSets(flowId!),
    enabled: !!flowId,
  });
}

export function usePublishRuleSet(flowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<TriageRuleSetSummary, Error, string | undefined>({
    mutationFn: (note) => {
      if (!flowId) throw new Error("missing flowId");
      return publishRuleSet(flowId, note);
    },
    onSuccess: () => {
      if (!flowId) return;
      qc.invalidateQueries({ queryKey: ["triage", "rule-sets", flowId] });
      qc.invalidateQueries({ queryKey: ["triage", "flow", flowId] });
      qc.invalidateQueries({ queryKey: ["triage", "audit"] });
    },
  });
}

export function useRollbackRuleSet(flowId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<TriageRuleSetSummary, Error, string>({
    mutationFn: (versionId) => {
      if (!flowId) throw new Error("missing flowId");
      return rollbackRuleSet(flowId, versionId);
    },
    onSuccess: () => {
      if (!flowId) return;
      qc.invalidateQueries({ queryKey: ["triage", "rule-sets", flowId] });
      qc.invalidateQueries({ queryKey: ["triage", "rules", flowId] });
      qc.invalidateQueries({ queryKey: ["triage", "flow", flowId] });
      qc.invalidateQueries({ queryKey: ["triage", "audit"] });
    },
  });
}

export function useDryRunRules(flowId: string | undefined) {
  return useMutation<TriageDryRunResult, Error, DryRunInput>({
    mutationFn: (input) => {
      if (!flowId) throw new Error("missing flowId");
      return dryRunRules(flowId, input);
    },
  });
}

// ---- live ops board ----

export function useLiveTriageSessions(filters: LiveSessionFilters = {}) {
  return useQuery<LiveTriageSessionPage>({
    queryKey: ["triage", "live", filters],
    queryFn: () => fetchLiveTriageSessions(filters),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useTriageSession(callId: string | undefined) {
  return useQuery<TriageSessionDetail | null>({
    queryKey: ["triage", "session", callId],
    queryFn: () => fetchTriageSession(callId!),
    enabled: !!callId,
    refetchInterval: 5000,
  });
}

export function useReassignSession() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; destinationLabel: string },
    Error,
    { callId: string; input: ReassignInput }
  >({
    mutationFn: ({ callId, input }) => reassignSession(callId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["triage", "live"] });
      qc.invalidateQueries({ queryKey: ["triage", "session"] });
    },
  });
}

export function useOverrideClassification() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; destinationLabel: string | null; destinationType: string | null },
    Error,
    { callId: string; input: OverrideInput }
  >({
    mutationFn: ({ callId, input }) => overrideClassification(callId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["triage", "live"] });
      qc.invalidateQueries({ queryKey: ["triage", "session"] });
    },
  });
}

export function useTerminateSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { callId: string; reason?: string }>({
    mutationFn: ({ callId, reason }) => terminateSession(callId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["triage", "live"] });
      qc.invalidateQueries({ queryKey: ["triage", "session"] });
    },
  });
}

// ---- analytics + audit ----

export function useTriageAnalytics(filters: AnalyticsFilters = {}) {
  return useQuery<TriageAnalytics>({
    queryKey: ["triage", "analytics", filters],
    queryFn: () => fetchTriageAnalytics(filters),
    placeholderData: keepPreviousData,
  });
}

export function useTriageAudit(flowId: string | undefined, action?: TriageAuditAction) {
  return useQuery<AuditPage>({
    queryKey: ["triage", "audit", flowId ?? null, action ?? null],
    queryFn: () => fetchTriageAudit({ flowId, action }),
  });
}

export function useHandoffContext(callId: string | null | undefined) {
  return useQuery<HandoffContext | null>({
    queryKey: ["triage", "handoff", callId],
    queryFn: () => fetchHandoffContext(callId!),
    enabled: !!callId,
  });
}

export function useTriageDestinations() {
  return useQuery<TriageDestinationCatalog>({
    queryKey: ["triage", "destinations"],
    queryFn: fetchTriageDestinations,
  });
}

export function useAcceptTriageHandoff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) => acceptTriageHandoff(callId),
    onSuccess: (_data, callId) => {
      qc.invalidateQueries({ queryKey: ["triage", "handoff", callId] });
      qc.invalidateQueries({ queryKey: ["triage", "live"] });
    },
  });
}
