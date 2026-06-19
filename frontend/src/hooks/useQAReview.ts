// QA Review console data layer — real apiFetch + React Query, no mock coupling.
// Covers the keyset-paginated queue, sampling policies, gold answers,
// calibration sessions, disputes, agreement/scorecards, and the audit timeline.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ───────────────────────────── shared enums ─────────────────────────────

export const QA_TABS = ["needs", "reviewed", "mine", "disputed", "all"] as const;
export type QaTab = (typeof QA_TABS)[number];

export const QA_SORTS = ["ended_desc", "ended_asc", "ai_desc", "variance_desc", "due_asc"] as const;
export type QaSort = (typeof QA_SORTS)[number];
export const QA_SORT_LABELS: Record<QaSort, string> = {
  ended_desc: "Newest ended",
  ended_asc: "Oldest ended",
  ai_desc: "AI score (high→low)",
  variance_desc: "Gold variance (high→low)",
  due_asc: "Due soonest",
};

export const QA_DECISIONS = ["accept", "override", "escalate"] as const;
export type QaDecision = (typeof QA_DECISIONS)[number];

export const QA_SAMPLING_STRATEGIES = ["percentage", "every_n", "all", "risk_weighted"] as const;
export type QaSamplingStrategy = (typeof QA_SAMPLING_STRATEGIES)[number];
export const QA_STRATEGY_LABELS: Record<QaSamplingStrategy, string> = {
  percentage: "Percentage sample",
  every_n: "Every Nth call",
  all: "All ended calls",
  risk_weighted: "Risk-weighted (low AI scores)",
};

export const QA_ROUTINGS = ["round_robin", "least_loaded", "manual"] as const;
export type QaRouting = (typeof QA_ROUTINGS)[number];

export const QA_DISPUTE_STATUSES = ["open", "under_review", "upheld", "overturned", "withdrawn"] as const;
export type QaDisputeStatus = (typeof QA_DISPUTE_STATUSES)[number];

// ───────────────────────────── types ─────────────────────────────

export interface QueueRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  recruiterUserId: string | null;
  recruiterName: string | null;
  candidateId: string | null;
  candidateName: string | null;
  demandId: string | null;
  demandTitle: string | null;
  reviewCount: number;
  latestDecision: QaDecision | null;
  aiScore: number | null;
  reviewerScore: number | null;
  goldVariance: number | null;
  dueAt: string | null;
  slaBreached: boolean;
  assignedReviewerName: string | null;
  disputeStatus: string | null;
}

export interface QueuePage {
  rows: QueueRow[];
  nextCursor: string | null;
  total: number;
}

export interface QAStats {
  inQueue: number;
  reviewedToday: number;
  avgReviewTimeMs: number;
  reviewerAgreementPct: number | null;
  disputesOpen: number;
  slaBreaches: number;
  medianGoldVariance: number | null;
}

export interface SamplingPolicy {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  strategy: QaSamplingStrategy;
  samplePercent: number | null;
  everyN: number | null;
  demandId: string | null;
  recruiterUserId: string | null;
  rubricPurpose: string | null;
  minAiScore: number | null;
  requireDoubleReview: boolean;
  blindReview: boolean;
  routing: QaRouting;
  slaHours: number | null;
  isActive: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyInput {
  name: string;
  description?: string | null;
  strategy: QaSamplingStrategy;
  samplePercent?: number | null;
  everyN?: number | null;
  demandId?: string | null;
  recruiterUserId?: string | null;
  rubricPurpose?: string | null;
  minAiScore?: number | null;
  requireDoubleReview?: boolean;
  blindReview?: boolean;
  routing?: QaRouting;
  slaHours?: number | null;
}

export interface Dispute {
  id: string;
  orgId: string;
  reviewId: string;
  callId: string;
  raisedByUserId: string;
  reason: string;
  requestedScores: Record<string, number>;
  status: QaDisputeStatus;
  resolverUserId: string | null;
  resolutionNote: string | null;
  thread: Array<{ userId: string; name?: string; body: string; at: string }>;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CalibrationSession {
  id: string;
  orgId: string;
  name: string;
  rubricId: string | null;
  callIds: string[];
  reviewerIds: string[];
  status: "draft" | "open" | "closed";
  results: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface Agreement {
  kappa: number | null;
  pairwise: Array<{ a: string; b: string; kappa: number | null; n: number }>;
  driftAlerts: Array<{ reviewerUserId: string; meanGoldVariance: number; n: number }>;
  asOf: string;
}

export interface Scorecard {
  reviewerUserId: string;
  reviews: number;
  overrideRate: number;
  meanGoldVariance: number | null;
  trend: Array<{ week: string; reviews: number }>;
}

export interface AuditEvent {
  id: number;
  action: string;
  targetType: string;
  targetId: string;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

// ───────────────────────────── query helpers ─────────────────────────────

export interface QueueFilters {
  tab: QaTab;
  q?: string;
  recruiterId?: string;
  demandId?: string;
  decision?: QaDecision;
  policyId?: string;
  endedFrom?: string;
  endedTo?: string;
  sort: QaSort;
}

export function queueQueryString(f: QueueFilters, opts: { cursor?: string; limit: number }): string {
  const sp = new URLSearchParams();
  sp.set("tab", f.tab);
  sp.set("sort", f.sort);
  sp.set("limit", String(opts.limit));
  if (f.q) sp.set("q", f.q);
  if (f.recruiterId) sp.set("recruiterId", f.recruiterId);
  if (f.demandId) sp.set("demandId", f.demandId);
  if (f.decision) sp.set("decision", f.decision);
  if (f.policyId) sp.set("policyId", f.policyId);
  if (f.endedFrom) sp.set("endedFrom", f.endedFrom);
  if (f.endedTo) sp.set("endedTo", f.endedTo);
  if (opts.cursor) sp.set("cursor", opts.cursor);
  return sp.toString();
}

// ───────────────────────────── queries ─────────────────────────────

export function useQAStats() {
  return useQuery({
    queryKey: ["qa-stats"],
    queryFn: () => apiFetch<QAStats>("/api/qa/stats"),
    refetchInterval: 30_000,
    retry: 1,
    staleTime: 15_000,
  });
}

export function useQAQueue(filters: QueueFilters, opts: { cursor?: string; limit: number }) {
  const qs = queueQueryString(filters, opts);
  return useQuery({
    queryKey: ["qa-queue", qs],
    queryFn: () => apiFetch<QueuePage>(`/api/qa/queue?${qs}`),
    placeholderData: (prev) => prev,
    retry: 1,
  });
}

export function useQAPolicies() {
  return useQuery({
    queryKey: ["qa-policies"],
    queryFn: () => apiFetch<{ policies: SamplingPolicy[]; nextCursor: string | null }>("/api/qa/policies?limit=100"),
    retry: 1,
  });
}

export function useQADisputes(status?: string) {
  const qs = status ? `?status=${status}&limit=100` : "?limit=100";
  return useQuery({
    queryKey: ["qa-disputes", status ?? "all"],
    queryFn: () => apiFetch<{ disputes: Dispute[]; nextCursor: string | null }>(`/api/qa/disputes${qs}`),
    retry: 1,
  });
}

export function useQACalibration() {
  return useQuery({
    queryKey: ["qa-calibration"],
    queryFn: () =>
      apiFetch<{ sessions: CalibrationSession[]; nextCursor: string | null }>("/api/qa/calibration?limit=100"),
    retry: 1,
  });
}

export function useQAAgreement(enabled = true) {
  return useQuery({
    queryKey: ["qa-agreement"],
    queryFn: () => apiFetch<Agreement>("/api/qa/agreement"),
    enabled,
    retry: 1,
    staleTime: 30_000,
  });
}

export function useQAScorecard(userId: string | undefined) {
  return useQuery({
    queryKey: ["qa-scorecard", userId],
    queryFn: () => apiFetch<Scorecard>(`/api/qa/reviewers/${userId}/scorecard`),
    enabled: !!userId,
    retry: 1,
  });
}

export function useQAAudit(
  target: { targetType?: string; targetId?: string; callId?: string } | undefined,
) {
  const sp = new URLSearchParams();
  if (target?.targetType) sp.set("targetType", target.targetType);
  if (target?.targetId) sp.set("targetId", target.targetId);
  if (target?.callId) sp.set("callId", target.callId);
  const qs = sp.toString();
  return useQuery({
    queryKey: ["qa-audit", qs],
    queryFn: () => apiFetch<{ events: AuditEvent[] }>(`/api/qa/audit?${qs}`),
    enabled: !!target && (!!target.targetId || !!target.callId),
    retry: 1,
  });
}

// ───────────────────────────── mutations ─────────────────────────────

function useInvalidateQa() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["qa-stats"] });
    qc.invalidateQueries({ queryKey: ["qa-queue"] });
    qc.invalidateQueries({ queryKey: ["qa-policies"] });
    qc.invalidateQueries({ queryKey: ["qa-disputes"] });
    qc.invalidateQueries({ queryKey: ["qa-agreement"] });
  };
}

export function useCreatePolicy() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (input: PolicyInput) =>
      apiFetch<SamplingPolicy>("/api/qa/policies", { method: "POST", json: input }),
    onSuccess: invalidate,
  });
}

export function useUpdatePolicy() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (args: { id: string; input: Partial<PolicyInput> & { isActive?: boolean } }) =>
      apiFetch<SamplingPolicy>(`/api/qa/policies/${args.id}`, { method: "PATCH", json: args.input }),
    onSuccess: invalidate,
  });
}

export function useArchivePolicy() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ archived: boolean }>(`/api/qa/policies/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useRunPolicy() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ inserted: number; skipped: number }>(`/api/qa/policies/${id}/run`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useBulkAssign() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (args: { itemIds: string[]; reviewerId: string }) =>
      apiFetch<unknown>("/api/qa/queue/bulk-assign", { method: "POST", json: args }),
    onSuccess: invalidate,
  });
}

export function useBulkEscalate() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (args: { itemIds: string[]; note: string }) =>
      apiFetch<unknown>("/api/qa/queue/bulk-escalate", { method: "POST", json: args }),
    onSuccess: invalidate,
  });
}

export function useRaiseDispute() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (args: { reviewId: string; reason: string; requestedScores?: Record<string, number> }) =>
      apiFetch<Dispute>(`/api/qa/reviews/${args.reviewId}/dispute`, {
        method: "POST",
        json: { reason: args.reason, requestedScores: args.requestedScores ?? {} },
      }),
    onSuccess: invalidate,
  });
}

export function useCommentDispute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: string }) =>
      apiFetch<Dispute>(`/api/qa/disputes/${args.id}/comment`, { method: "POST", json: { body: args.body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["qa-disputes"] }),
  });
}

export function useResolveDispute() {
  const invalidate = useInvalidateQa();
  return useMutation({
    mutationFn: (args: { id: string; status: "upheld" | "overturned"; resolutionNote: string }) =>
      apiFetch<Dispute>(`/api/qa/disputes/${args.id}/resolve`, {
        method: "POST",
        json: { status: args.status, resolutionNote: args.resolutionNote },
      }),
    onSuccess: invalidate,
  });
}

export function useCreateCalibration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; rubricId?: string | null; callIds?: string[]; reviewerIds?: string[] }) =>
      apiFetch<CalibrationSession>("/api/qa/calibration", { method: "POST", json: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["qa-calibration"] }),
  });
}

export function useCloseCalibration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<CalibrationSession>(`/api/qa/calibration/${id}/close`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["qa-calibration"] }),
  });
}

// ───────────────────────────── small utils ─────────────────────────────

/** Pull a human-readable error string off an ApiError thrown by apiFetch. */
export function apiErrorMessage(err: unknown): string {
  const e = err as { body?: { error?: string; message?: string }; message?: string };
  return e?.body?.error ?? e?.body?.message ?? e?.message ?? "Something went wrong";
}
