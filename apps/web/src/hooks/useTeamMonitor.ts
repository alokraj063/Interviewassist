// React Query hooks + shared types for the Team Monitor supervisor surface.
//
// Thin wrappers over apiFetch. List hooks (roster / live-calls / alerts /
// replay) are keyset/cursor aware with keepPreviousData so paging doesn't
// flash empty. Mutation hooks (supervise / endSupervision / reassign /
// ack / resolve / bulk / upsertSla / heartbeat) invalidate the relevant keys
// so the floor view re-fetches live state without a full reload.
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Enums (mirror packages/db/src/schema.ts page block)
// ---------------------------------------------------------------------------

export const PRESENCE_ACTIVITIES = ["on_call", "idle", "in_meeting", "offline"] as const;
export type PresenceActivity = (typeof PRESENCE_ACTIVITIES)[number];

export const SUPERVISION_MODES = ["whisper", "barge", "takeover"] as const;
export type SupervisionMode = (typeof SUPERVISION_MODES)[number];

export const SLA_METRICS = [
  "queue_depth",
  "call_duration_ms",
  "recruiter_idle_ms",
  "abandoned_rate",
  "answer_rate",
] as const;
export type SlaMetric = (typeof SLA_METRICS)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATES = ["open", "acked", "resolved", "expired"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const ROSTER_SORTS = ["name", "idleTime", "activity", "lastHeartbeat"] as const;
export type RosterSort = (typeof ROSTER_SORTS)[number];

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface OverviewResp {
  kpis: {
    recruitersOnline: number;
    onCall: number;
    idle: number;
    queueDepth: number;
    activeCalls: number;
    openAlerts: number;
    criticalAlerts: number;
  };
  presenceByActivity: Record<PresenceActivity, number>;
  openAlerts: Record<AlertSeverity, number>;
}

export interface RosterRow {
  userId: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  role: string | null;
  activity: PresenceActivity;
  activeCallId: string | null;
  statusNote: string | null;
  lastHeartbeatAt: string;
  lastActivityChangeAt: string | null;
  idleMs: number | null;
}

export interface LiveCallRow {
  id: string;
  status: string;
  startedAt: string;
  recruiterUserId: string | null;
  recruiterName: string | null;
  recruiterEmail: string | null;
  candidateId: string | null;
  candidateName: string | null;
  demandId: string | null;
  demandTitle: string | null;
  durationMs: number | null;
  supervisionMode: SupervisionMode | null;
}

export interface AlertRow {
  id: string;
  policyId: string | null;
  metric: SlaMetric;
  severity: AlertSeverity;
  state: AlertState;
  subjectType: string | null;
  subjectId: string | null;
  observedValue: number;
  thresholdValue: number;
  message: string;
  ackedByUserId: string | null;
  ackedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SlaPolicy {
  id: string;
  metric: SlaMetric;
  warningThreshold: number;
  criticalThreshold: number;
  enabled: boolean;
  scopeLeadUserId: string | null;
  notifyUserId: string | null;
  updatedByUserId: string | null;
  updatedAt: string;
}

export interface SupervisionAudio {
  provider: "vapi" | "stub";
  listenUrl: string | null;
  controlUrl: string | null;
}

export interface FeedResp {
  callId: string;
  transcript: Array<{
    id: string;
    speaker: string | null;
    text: string;
    tsStartMs: number | null;
    isFinal: boolean;
  }>;
  audio: SupervisionAudio;
}

export interface ReplayEvent {
  id: number;
  orgId: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Query-string helper
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | number | undefined | null | string[]>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useOverview(): UseQueryResult<OverviewResp> {
  return useQuery<OverviewResp>({
    queryKey: ["tm", "overview"],
    queryFn: () => apiFetch<OverviewResp>("/api/team-monitor/overview"),
    refetchInterval: 15_000,
  });
}

export interface RosterParams {
  cursor?: string;
  limit?: number;
  activity?: PresenceActivity[];
  podLeadId?: string;
  q?: string;
  sort?: RosterSort;
  segment?: string;
}

export function useRoster(p: RosterParams): UseQueryResult<Page<RosterRow>> {
  return useQuery<Page<RosterRow>>({
    queryKey: ["tm", "roster", p],
    queryFn: () =>
      apiFetch<Page<RosterRow>>(
        `/api/team-monitor/roster${qs({
          cursor: p.cursor,
          limit: p.limit,
          activity: p.activity,
          podLeadId: p.podLeadId,
          q: p.q,
          sort: p.sort,
          segment: p.segment,
        })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export interface LiveCallsParams {
  cursor?: string;
  limit?: number;
  recruiterId?: string;
  demandId?: string;
  minDurationMs?: number;
  q?: string;
}

export function useLiveCalls(p: LiveCallsParams): UseQueryResult<Page<LiveCallRow>> {
  return useQuery<Page<LiveCallRow>>({
    queryKey: ["tm", "live-calls", p],
    queryFn: () =>
      apiFetch<Page<LiveCallRow>>(
        `/api/team-monitor/live-calls${qs({
          cursor: p.cursor,
          limit: p.limit,
          recruiterId: p.recruiterId,
          demandId: p.demandId,
          minDurationMs: p.minDurationMs,
          q: p.q,
        })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
  });
}

export interface AlertsParams {
  cursor?: string;
  limit?: number;
  state?: AlertState[];
  severity?: AlertSeverity[];
  metric?: SlaMetric[];
  subjectType?: string;
}

export function useAlerts(p: AlertsParams): UseQueryResult<Page<AlertRow>> {
  return useQuery<Page<AlertRow>>({
    queryKey: ["tm", "alerts", p],
    queryFn: () =>
      apiFetch<Page<AlertRow>>(
        `/api/team-monitor/alerts${qs({
          cursor: p.cursor,
          limit: p.limit,
          state: p.state,
          severity: p.severity,
          metric: p.metric,
          subjectType: p.subjectType,
        })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useSlaPolicies(): UseQueryResult<{ policies: SlaPolicy[] }> {
  return useQuery<{ policies: SlaPolicy[] }>({
    queryKey: ["tm", "sla"],
    queryFn: () => apiFetch<{ policies: SlaPolicy[] }>("/api/team-monitor/sla-policies"),
  });
}

export function useSuperviseFeed(callId: string | null): UseQueryResult<FeedResp> {
  return useQuery<FeedResp>({
    queryKey: ["tm", "feed", callId],
    queryFn: () => apiFetch<FeedResp>(`/api/team-monitor/calls/${callId}/supervise/feed`),
    enabled: !!callId,
    refetchInterval: callId ? 4_000 : false,
  });
}

export interface ReplayParams {
  from: string;
  to: string;
  cursor?: string;
  limit?: number;
}

export function useReplay(p: ReplayParams, enabled: boolean): UseQueryResult<{
  events: ReplayEvent[];
  nextCursor: string | null;
}> {
  return useQuery<{ events: ReplayEvent[]; nextCursor: string | null }>({
    queryKey: ["tm", "replay", p],
    queryFn: () =>
      apiFetch(`/api/team-monitor/replay${qs({ from: p.from, to: p.to, cursor: p.cursor, limit: p.limit })}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function rnd(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8)
  );
}

export function useSupervise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { callId: string; mode: SupervisionMode }) =>
      apiFetch<{ session: { id: string }; audio: SupervisionAudio }>(
        `/api/team-monitor/calls/${v.callId}/supervise`,
        { method: "POST", json: { mode: v.mode, idempotencyKey: rnd() } },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "live-calls"] });
    },
  });
}

export function useEndSupervision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sessionId: string }) =>
      apiFetch(`/api/team-monitor/supervise/${v.sessionId}/end`, {
        method: "POST",
        json: { reason: "supervisor_ended" },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "live-calls"] });
    },
  });
}

export function useReassign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { callId: string; toUserId: string; reason: string }) =>
      apiFetch(`/api/team-monitor/calls/${v.callId}/reassign`, {
        method: "POST",
        json: { toUserId: v.toUserId, reason: v.reason, idempotencyKey: rnd() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "live-calls"] });
      qc.invalidateQueries({ queryKey: ["tm", "roster"] });
    },
  });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/team-monitor/alerts/${id}/ack`, { method: "POST", json: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "alerts"] });
      qc.invalidateQueries({ queryKey: ["tm", "overview"] });
    },
  });
}

export function useResolveAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/team-monitor/alerts/${id}/resolve`, { method: "POST", json: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "alerts"] });
      qc.invalidateQueries({ queryKey: ["tm", "overview"] });
    },
  });
}

export function useBulkAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids: string[]; action: "ack" | "resolve" }) =>
      apiFetch<{ affected: string[]; skipped: string[] }>("/api/team-monitor/alerts/bulk", {
        method: "POST",
        json: v,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "alerts"] });
      qc.invalidateQueries({ queryKey: ["tm", "overview"] });
    },
  });
}

export function useUpsertSla() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      metric: SlaMetric;
      warningThreshold: number;
      criticalThreshold: number;
      enabled: boolean;
    }) =>
      apiFetch<{ policy: SlaPolicy }>(`/api/team-monitor/sla-policies/${v.metric}`, {
        method: "PUT",
        json: {
          warningThreshold: v.warningThreshold,
          criticalThreshold: v.criticalThreshold,
          enabled: v.enabled,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tm", "sla"] });
    },
  });
}

export function useHeartbeat() {
  return useMutation({
    mutationFn: (v: { statusNote?: string | null; activity?: PresenceActivity } = {}) =>
      apiFetch("/api/team-monitor/presence/heartbeat", { method: "POST", json: v }),
  });
}
