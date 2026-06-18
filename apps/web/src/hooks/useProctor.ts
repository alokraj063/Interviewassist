// React Query hooks + shared types for the Proctor Cockpit (roster, session
// detail / live console, review queue, and proctoring policies).
//
// Thin wrappers over apiFetch following the QuestionBankDetail / useAssessments
// conventions: useQuery / useInfiniteQuery (keyset cursor) for reads,
// useMutation for writes, query-key constants the mutation hooks invalidate.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { apiFetch, type ApiError } from "@/lib/api";

// ---------- shared enums (mirror packages/db/src/schema.ts) ----------

export const SIGNAL_KINDS = [
  "tab_switch",
  "window_blur",
  "fullscreen_exit",
  "copy",
  "paste",
  "multi_face",
  "no_face",
  "face_mismatch",
  "other_voice",
  "second_device",
  "network_drop",
  "vm_detected",
  "remote_tool",
  "screen_share_lost",
  "id_photo_captured",
  "env_scan_captured",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  tab_switch: "Tab switch",
  window_blur: "Window blur",
  fullscreen_exit: "Fullscreen exit",
  copy: "Copy",
  paste: "Paste",
  multi_face: "Multiple faces",
  no_face: "No face",
  face_mismatch: "Face mismatch",
  other_voice: "Other voice",
  second_device: "Second device",
  network_drop: "Network drop",
  vm_detected: "VM detected",
  remote_tool: "Remote tool",
  screen_share_lost: "Screen share lost",
  id_photo_captured: "ID photo captured",
  env_scan_captured: "Environment scan",
};

export type SignalSeverity = "low" | "medium" | "high";
export type LiveState = "active" | "paused" | "ended";
export type SessionStatus = "live" | "completed" | "abandoned";
export type ReviewerDecision = "clean" | "flagged" | "invalidated";
export type IdentityStatus = "pending" | "verified" | "mismatch" | "skipped";
export type InterventionKind =
  | "chat"
  | "broadcast"
  | "pause"
  | "resume"
  | "extend"
  | "terminate"
  | "warn";
export type RiskLabel = "low" | "elevated" | "high";

export interface SignalConfigEntry {
  armed: boolean;
  severity: SignalSeverity;
  weight: number;
}
export type SignalConfig = Record<string, SignalConfigEntry>;

// ---------- response shapes ----------

export interface ProctorSummary {
  live: number;
  paused: number;
  pendingReview: number;
  slaBreached: number;
  flaggedToday: number;
  invalidated: number;
  avgRisk: number;
  total: number;
}

export interface SessionRow {
  id: string;
  candidateId: string | null;
  candidateName: string | null;
  status: SessionStatus;
  liveState: LiveState;
  riskScore: number;
  riskLabel: RiskLabel;
  flagCount: number;
  startedAt: string;
  endedAt: string | null;
  reviewerDecision: ReviewerDecision | null;
  assignedReviewerUserId: string | null;
  assignedReviewerName: string | null;
  reviewSlaDueAt: string | null;
  assessmentAttemptId: string | null;
  asyncVideoSubmissionId: string | null;
}

export interface SessionsPage {
  sessions: SessionRow[];
  nextCursor: string | null;
  total: number;
}

export interface ReviewQueueRow {
  id: string;
  candidateId: string | null;
  candidateName: string | null;
  riskScore: number;
  riskLabel: RiskLabel;
  flagCount: number;
  reviewSlaDueAt: string | null;
  assignedReviewerUserId: string | null;
  assignedReviewerName: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ReviewQueuePage {
  queue: ReviewQueueRow[];
  nextCursor: string | null;
  total: number;
}

export interface ProctorEventRow {
  id: number;
  sessionId: string;
  kind: string;
  severity: SignalSeverity;
  payload: Record<string, unknown> | null;
  flagged: boolean;
  reviewerAcked: boolean;
  offsetMs: number | null;
  evidenceBlobKey: string | null;
  createdAt: string;
}

export interface IdentityCheck {
  id: string;
  sessionId: string;
  status: IdentityStatus;
  idPhotoBlobKey: string | null;
  selfieBlobKey: string | null;
  envScanBlobKey: string | null;
  matchScore: number | null;
  matchProvider: string | null;
  notes: string | null;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
}

export interface InterventionRow {
  id: string;
  kind: InterventionKind;
  message: string | null;
  extendSeconds: number | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface SessionDetail {
  session: SessionRow & {
    policyId: string | null;
    policySnapshot: Record<string, unknown> | null;
    reviewerNotes: string | null;
    reviewedAt: string | null;
  };
  candidate: { id: string; displayName: string | null } | null;
  identity: IdentityCheck | null;
  interventions: InterventionRow[];
  events: ProctorEventRow[];
  assignedReviewer: { id: string; name: string | null } | null;
  streamMode: "live" | "snapshot";
}

export interface AuditEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  fromValue: string | null;
  toValue: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface Policy {
  id: string;
  name: string;
  assessmentTemplateId: string | null;
  assessmentTemplateTitle: string | null;
  isDefault: boolean;
  signalConfig: SignalConfig;
  requireIdentity: boolean;
  requireWebcam: boolean;
  requireScreen: boolean;
  lockdownBrowser: boolean;
  autoFlagRiskScore: number;
  autoTerminateRiskScore: number | null;
  updatedAt: string;
}

// ---------- filter shape (URL-synced from the page) ----------

export interface SessionFilters {
  status?: SessionStatus;
  liveState?: LiveState;
  decision?: ReviewerDecision;
  minRisk?: number;
  assignedToMe?: boolean;
  q?: string;
  sort?: "risk" | "recent" | "sla";
}

function buildQuery(filters: SessionFilters, extra: Record<string, string | number | undefined> = {}): string {
  const sp = new URLSearchParams();
  if (filters.status) sp.set("status", filters.status);
  if (filters.liveState) sp.set("liveState", filters.liveState);
  if (filters.decision) sp.set("decision", filters.decision);
  if (typeof filters.minRisk === "number" && filters.minRisk > 0) sp.set("minRisk", String(filters.minRisk));
  if (filters.assignedToMe) sp.set("assignedToMe", "true");
  if (filters.q && filters.q.trim()) sp.set("q", filters.q.trim());
  if (filters.sort) sp.set("sort", filters.sort);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Pull the precise server error code (e.g. "face_match_provider_missing") out of an ApiError body. */
export function serverErrorCode(err: unknown): string | null {
  const body = (err as ApiError | undefined)?.body;
  if (body && typeof body === "object" && "error" in body) {
    const v = (body as { error?: unknown }).error;
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** A user-facing message preferring the server error code, then the generic message. */
export function errMessage(err: unknown): string {
  return serverErrorCode(err) ?? (err instanceof Error ? err.message : String(err));
}

// ---------- query keys ----------

export const proctorKeys = {
  summary: ["proctor", "summary"] as const,
  sessions: (f: SessionFilters) => ["proctor", "sessions", f] as const,
  session: (id: string) => ["proctor", "session", id] as const,
  audit: (id: string) => ["proctor", "audit", id] as const,
  reviewQueue: (assignedToMe: boolean) => ["proctor", "review-queue", assignedToMe] as const,
  policies: ["proctor", "policies"] as const,
};

// ---------- read hooks ----------

export function useProctorSummary(refetchMs?: number) {
  return useQuery<ProctorSummary>({
    queryKey: proctorKeys.summary,
    queryFn: () => apiFetch<ProctorSummary>("/api/proctor/summary"),
    refetchInterval: refetchMs,
  });
}

export function useProctorSessions(filters: SessionFilters, limit = 25) {
  return useInfiniteQuery<SessionsPage>({
    queryKey: proctorKeys.sessions(filters),
    queryFn: ({ pageParam }) =>
      apiFetch<SessionsPage>(
        `/api/proctor/sessions${buildQuery(filters, { limit, cursor: pageParam as string | undefined })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useProctorSession(id: string | undefined, refetchMs?: number) {
  return useQuery<SessionDetail>({
    queryKey: proctorKeys.session(id ?? ""),
    queryFn: () => apiFetch<SessionDetail>(`/api/proctor/sessions/${id}`),
    enabled: !!id,
    refetchInterval: refetchMs,
  });
}

export function useSessionAudit(id: string | undefined) {
  return useQuery<{ entries: AuditEntry[] }>({
    queryKey: proctorKeys.audit(id ?? ""),
    queryFn: () => apiFetch<{ entries: AuditEntry[] }>(`/api/proctor/sessions/${id}/audit`),
    enabled: !!id,
  });
}

export function useReviewQueue(assignedToMe: boolean, limit = 25) {
  return useInfiniteQuery<ReviewQueuePage>({
    queryKey: proctorKeys.reviewQueue(assignedToMe),
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams();
      if (assignedToMe) sp.set("assignedToMe", "true");
      sp.set("limit", String(limit));
      if (pageParam) sp.set("cursor", pageParam as string);
      return apiFetch<ReviewQueuePage>(`/api/proctor/review-queue?${sp.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useProctorPolicies() {
  return useQuery<{ policies: Policy[] }>({
    queryKey: proctorKeys.policies,
    queryFn: () => apiFetch<{ policies: Policy[] }>("/api/proctor/policies"),
  });
}

export interface Reviewer {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

export function useReviewers(enabled = true) {
  return useQuery<{ reviewers: Reviewer[] }>({
    queryKey: ["proctor", "reviewers"],
    queryFn: () => apiFetch<{ reviewers: Reviewer[] }>("/api/proctor/reviewers"),
    enabled,
    staleTime: 60_000,
  });
}

// ---------- mutation hooks ----------

function useInvalidate() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["proctor", "sessions"] });
    qc.invalidateQueries({ queryKey: proctorKeys.summary });
    qc.invalidateQueries({ queryKey: ["proctor", "review-queue"] });
    if (id) {
      qc.invalidateQueries({ queryKey: proctorKeys.session(id) });
      qc.invalidateQueries({ queryKey: proctorKeys.audit(id) });
    }
  };
}

export interface InterveneInput {
  sessionId: string;
  kind: InterventionKind;
  message?: string;
  extendSeconds?: number;
}

export function useIntervene() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, ...body }: InterveneInput) =>
      apiFetch<{ intervention: InterventionRow; liveState: LiveState }>(
        `/api/proctor/sessions/${sessionId}/intervene`,
        { method: "POST", json: body },
      ),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export interface ReviewInput {
  sessionId: string;
  decision: ReviewerDecision;
  justification?: string;
  force?: boolean;
}

export function useReviewSession() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, ...body }: ReviewInput) =>
      apiFetch<{ session: SessionRow }>(`/api/proctor/sessions/${sessionId}/review`, {
        method: "POST",
        json: body,
      }),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export function useAssignReviewer() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, reviewerUserId }: { sessionId: string; reviewerUserId: string | null }) =>
      apiFetch<{ session: SessionRow }>(`/api/proctor/sessions/${sessionId}/assign`, {
        method: "POST",
        json: { reviewerUserId },
      }),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export function useAckEvent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ eventId }: { eventId: number; sessionId: string }) =>
      apiFetch(`/api/proctor/events/${eventId}/ack`, { method: "POST" }),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export function useVerifyIdentity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      sessionId,
      status,
      notes,
    }: {
      sessionId: string;
      status: "verified" | "mismatch" | "skipped";
      notes?: string;
    }) =>
      apiFetch<{ identity: IdentityCheck }>(`/api/proctor/sessions/${sessionId}/identity/verify`, {
        method: "POST",
        json: { status, notes },
      }),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export function useRunFaceMatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ sessionId, real }: { sessionId: string; real?: boolean }) =>
      apiFetch<{ matchScore: number; provider: string }>(
        `/api/proctor/sessions/${sessionId}/identity/match${real ? "?real=true" : ""}`,
        { method: "POST" },
      ),
    onSuccess: (_d, v) => invalidate(v.sessionId),
  });
}

export interface PolicyInput {
  name: string;
  assessmentTemplateId?: string | null;
  isDefault: boolean;
  signalConfig: SignalConfig;
  requireIdentity: boolean;
  requireWebcam: boolean;
  requireScreen: boolean;
  lockdownBrowser: boolean;
  autoFlagRiskScore: number;
  autoTerminateRiskScore: number | null;
}

export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: PolicyInput & { id?: string }) =>
      id
        ? apiFetch<{ policy: Policy }>(`/api/proctor/policies/${id}`, { method: "PATCH", json: body })
        : apiFetch<{ policy: Policy }>("/api/proctor/policies", { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: proctorKeys.policies }),
  });
}

// Default per-kind weight/severity used to pre-fill a brand-new policy form so
// the authoring grid starts from sane values (mirrors the server-side
// DEFAULT_SIGNAL_WEIGHTS in apps/api/src/proctor/risk.ts).
export const DEFAULT_SIGNAL_PRESET: Record<SignalKind, SignalConfigEntry> = {
  tab_switch: { armed: true, severity: "low", weight: 6 },
  window_blur: { armed: true, severity: "low", weight: 5 },
  fullscreen_exit: { armed: true, severity: "medium", weight: 8 },
  copy: { armed: true, severity: "medium", weight: 7 },
  paste: { armed: true, severity: "high", weight: 9 },
  multi_face: { armed: true, severity: "high", weight: 20 },
  no_face: { armed: true, severity: "medium", weight: 10 },
  face_mismatch: { armed: true, severity: "high", weight: 25 },
  other_voice: { armed: true, severity: "medium", weight: 12 },
  second_device: { armed: true, severity: "high", weight: 18 },
  network_drop: { armed: true, severity: "low", weight: 3 },
  vm_detected: { armed: true, severity: "high", weight: 22 },
  remote_tool: { armed: true, severity: "high", weight: 24 },
  screen_share_lost: { armed: true, severity: "medium", weight: 8 },
  id_photo_captured: { armed: false, severity: "low", weight: 0 },
  env_scan_captured: { armed: false, severity: "low", weight: 0 },
};

export function riskLabelFor(score: number): RiskLabel {
  if (score >= 70) return "high";
  if (score >= 35) return "elevated";
  return "low";
}
