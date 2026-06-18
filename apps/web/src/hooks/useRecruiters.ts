// React Query hooks + shared types for the Recruiters manager surface.
//
// Thin wrappers over apiFetch. List + trend are keyset/cursor aware with
// keepPreviousData so paging/sorting doesn't flash empty. Mutation hooks
// (goals, capacity, nudge, reassign, leaderboard) invalidate the relevant
// keys so the leaderboard table + detail page re-fetch live KPIs.
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ManagerRole = "recruiter" | "delivery_lead" | "account_manager" | "business_head";
export type MemberStatus = "invited" | "active" | "suspended";
export type Window = "7d" | "30d" | "90d" | "qtd";

export const RECRUITER_GOAL_METRICS = [
  "submissions",
  "client_submits",
  "selects",
  "offers",
  "joins",
  "calls",
  "conversion_rate",
] as const;
export type GoalMetric = (typeof RECRUITER_GOAL_METRICS)[number];

export const RECRUITER_GOAL_PERIODS = ["weekly", "monthly", "quarterly"] as const;
export type GoalPeriod = (typeof RECRUITER_GOAL_PERIODS)[number];

export const RECRUITER_NUDGE_KINDS = ["coaching", "sla_breach", "capacity", "goal", "kudos"] as const;
export type NudgeKind = (typeof RECRUITER_NUDGE_KINDS)[number];

export const LEADERBOARD_METRICS = [
  "submissions",
  "client_submits",
  "selects",
  "offers",
  "joins",
  "conversion",
  "calls",
] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export interface RowKpis {
  submissions: number;
  clientSubmits: number;
  selects: number;
  offers: number;
  joins: number;
  calls: number;
  slaBreaches: number;
  conversion: number; // basis points
  activeDemands: number;
  maxActiveDemands: number;
  loadPct: number;
  overAllocated: boolean;
  goalAttainmentPct: number | null;
  trendSpark: number[];
}

export interface RecruiterRow extends RowKpis {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: ManagerRole;
  status: MemberStatus;
  joinedAt: string | null;
  lastActiveAt: string | null;
  reportingToUserId: string | null;
}

export interface RecruiterListResponse {
  rows: RecruiterRow[];
  nextCursor: string | null;
  total: number;
  window: Window;
  asOf: string;
}

export interface Goal {
  id: string;
  recruiterUserId: string;
  metric: GoalMetric;
  period: GoalPeriod;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
  note: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Capacity {
  id: string;
  recruiterUserId: string;
  maxActiveDemands: number;
  maxActiveProspects: number;
  weeklyCallTarget: number;
  notes: string | null;
  updatedAt: string;
}

export interface TimelineEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecruiterDetailResponse {
  recruiter: {
    userId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    role: ManagerRole;
    status: MemberStatus;
    joinedAt: string | null;
    lastActiveAt: string | null;
    reportingToUserId: string | null;
  };
  kpis: RowKpis;
  stageBreakdown: Array<{ stage: string; n: number }>;
  goals: Goal[];
  capacity: Capacity | null;
  recentCalls: Array<{
    id: string;
    startedAt: string;
    endedAt: string | null;
    candidateId: string | null;
    candidateName: string | null;
    demandId: string | null;
    demandTitle: string | null;
  }>;
  activeProspects: Array<{
    id: string;
    candidateId: string;
    candidateName: string | null;
    demandId: string;
    demandTitle: string | null;
    status: string;
    interestLevel: number | null;
    lastContactedAt: string | null;
  }>;
  recentNudges: Array<{
    id: string;
    kind: NudgeKind;
    message: string;
    delivery: string | null;
    createdAt: string;
  }>;
  timeline: TimelineEntry[];
}

export interface TrendResponse {
  metric: string;
  granularity: string;
  series: Array<{ bucket: string; value: number }>;
  asOf: string;
}

export interface LeaderboardWeight {
  metric: LeaderboardMetric;
  weight: number;
}
export interface LeaderboardConfig {
  window: Window;
  weights: LeaderboardWeight[];
  minTenureDays: number;
  normalizeByCapacity: boolean;
  excludeOnLeave: boolean;
}
export interface Leaderboard {
  id: string;
  name: string;
  config: LeaderboardConfig;
  isShared: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListParams {
  q?: string;
  role?: string;
  status?: string;
  window?: string;
  sort?: string;
  dir?: string;
  cursor?: string;
  limit?: number;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useRecruiterList(params: ListParams): UseQueryResult<RecruiterListResponse> {
  return useQuery({
    queryKey: ["recruiters", params],
    queryFn: () =>
      apiFetch<RecruiterListResponse>(
        `/api/recruiters${qs({
          q: params.q,
          role: params.role,
          status: params.status,
          window: params.window,
          sort: params.sort,
          dir: params.dir,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useRecruiterDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["recruiter", id],
    queryFn: () => apiFetch<RecruiterDetailResponse>(`/api/recruiters/${id}`),
    enabled: !!id,
  });
}

export function useRecruiterTrend(id: string | undefined, metric: string, granularity = "week") {
  return useQuery({
    queryKey: ["recruiter-trend", id, metric, granularity],
    queryFn: () =>
      apiFetch<TrendResponse>(
        `/api/recruiters/${id}/trend${qs({ metric, granularity, weeks: "12" })}`,
      ),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });
}

export function useLeaderboards() {
  return useQuery({
    queryKey: ["recruiter-leaderboards"],
    queryFn: () => apiFetch<{ leaderboards: Leaderboard[] }>("/api/recruiters/leaderboards"),
  });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export function useInvalidateRecruiters() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["recruiters"] });
    if (id) {
      qc.invalidateQueries({ queryKey: ["recruiter", id] });
      qc.invalidateQueries({ queryKey: ["recruiter-trend", id] });
    }
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface GoalInput {
  metric: GoalMetric;
  period: GoalPeriod;
  periodStart: string;
  periodEnd: string;
  targetValue: number;
  note?: string | null;
}

export function useSetGoal(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: (body: GoalInput) =>
      apiFetch<{ goal: Goal }>(`/api/recruiters/${id}/goals`, { method: "POST", json: body }),
    onSuccess: () => invalidate(id),
  });
}

export function usePatchGoal(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: ({ goalId, body }: { goalId: string; body: { targetValue?: number; note?: string | null } }) =>
      apiFetch<{ goal: Goal }>(`/api/recruiters/goals/${goalId}`, { method: "PATCH", json: body }),
    onSuccess: () => invalidate(id),
  });
}

export function useArchiveGoal(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: (goalId: string) =>
      apiFetch(`/api/recruiters/goals/${goalId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(id),
  });
}

export interface CapacityInput {
  maxActiveDemands: number;
  maxActiveProspects: number;
  weeklyCallTarget: number;
  notes?: string | null;
}

export function useSetCapacity(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: (body: CapacityInput) =>
      apiFetch<{ capacity: Capacity }>(`/api/recruiters/${id}/capacity`, { method: "PUT", json: body }),
    onSuccess: () => invalidate(id),
  });
}

export function useSendNudge(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: (body: { kind: NudgeKind; message?: string; draftWithAI?: boolean; context?: string }) =>
      apiFetch<{ nudge: { id: string }; delivery: string }>(`/api/recruiters/${id}/nudge`, {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => invalidate(id),
  });
}

// Server-side AI draft for a nudge. 503 → openai_key_missing surfaced to the caller.
export function useDraftNudge(id: string) {
  return useMutation({
    mutationFn: (body: { kind: NudgeKind; context?: string }) =>
      apiFetch<{ message: string }>(`/api/recruiters/${id}/nudge/draft`, { method: "POST", json: body }),
  });
}

export function useReassignDemand(id: string) {
  const invalidate = useInvalidateRecruiters();
  return useMutation({
    mutationFn: (body: { demandId: string; toRecruiterId: string }) =>
      apiFetch(`/api/recruiters/${id}/reassign-demand`, { method: "POST", json: body }),
    onSuccess: (_d, vars) => {
      invalidate(id);
      invalidate(vars.toRecruiterId);
    },
  });
}

export function useSaveLeaderboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; config: LeaderboardConfig; isShared: boolean }) =>
      apiFetch<{ leaderboard: Leaderboard }>("/api/recruiters/leaderboards", {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recruiter-leaderboards"] }),
  });
}

export function useDeleteLeaderboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lbId: string) => apiFetch(`/api/recruiters/leaderboards/${lbId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recruiter-leaderboards"] }),
  });
}

// Candidates list for the reassign target picker (active demands of a recruiter
// come from the detail response).
export function exportUrl(params: ListParams): string {
  return `/api/recruiters/export${qs({
    q: params.q,
    role: params.role,
    status: params.status,
    window: params.window,
    sort: params.sort,
    dir: params.dir,
  })}`;
}
