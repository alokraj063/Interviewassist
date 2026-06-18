// React Query data layer for the Coaching L&D surface.
// All reads/writes go through apiFetch against /api/coaching/* (real, org-scoped,
// keyset-paginated, audited). Mutations stamp an Idempotency-Key and invalidate
// the right query keys. No mock data, no fabricated figures.
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shared enums / labels
// ---------------------------------------------------------------------------

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const LANGUAGES = ["hinglish", "en-IN", "hi-IN"] as const;
export type CoachingLanguage = (typeof LANGUAGES)[number];
export const LANGUAGE_LABELS: Record<CoachingLanguage, string> = {
  hinglish: "Hinglish",
  "en-IN": "English (IN)",
  "hi-IN": "Hindi (IN)",
};

export const RUN_STATUSES = ["started", "live", "completed", "abandoned"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "completed",
  "overdue",
  "waived",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const SCENARIO_SORTS = ["created_at", "updated_at", "title"] as const;
export type ScenarioSort = (typeof SCENARIO_SORTS)[number];
export const SORT_LABELS: Record<ScenarioSort, string> = {
  created_at: "Newest",
  updated_at: "Recently updated",
  title: "Title (A–Z)",
};

// ---------------------------------------------------------------------------
// Types (mirror the route response shapes)
// ---------------------------------------------------------------------------

export interface Persona {
  candidateName?: string;
  candidateRole?: string;
  yearsExperience?: number;
  currentCompany?: string;
  currentCtcLakhs?: number;
  expectedCtcLakhs?: number;
  noticePeriodDays?: number;
  location?: string;
  speakingStyle?: "concise" | "verbose" | "evasive" | "warm";
  mood?: string;
  resistance?: "low" | "medium" | "high";
  hiddenContext?: string;
  redFlags?: string[];
}

export interface SuccessCriterion {
  id: string;
  label: string;
  weight: number;
}

export interface ScenarioRow {
  id: string;
  title: string;
  description: string | null;
  difficulty: Difficulty;
  targetRubricId: string | null;
  targetRubricName: string | null;
  tags: string[];
  language: CoachingLanguage;
  estimatedMinutes: number;
  isPublished: boolean;
  version: number;
  publishedVersion: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  avgScore: number | null;
}

export interface ScenarioFull extends Omit<ScenarioRow, "runCount" | "avgScore" | "targetRubricName"> {
  openingLine: string | null;
  candidatePersona: Persona;
  objections: string[];
  successCriteria: SuccessCriterion[];
  publishedAt: string | null;
  createdByUserId: string | null;
}

export interface RecentRun {
  id: string;
  recruiterUserId: string;
  recruiterEmail: string | null;
  recruiterName: string | null;
  callId: string | null;
  status: RunStatus;
  scoringStatus: string;
  startedAt: string;
  completedAt: string | null;
  cachedOverallScore: string | null;
}

export interface AuditEvent {
  id: number;
  action: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface RunRow {
  id: string;
  scenarioId: string;
  scenarioTitle: string | null;
  recruiterUserId: string;
  recruiterEmail: string | null;
  recruiterName: string | null;
  callId: string | null;
  status: RunStatus;
  mode: string;
  scoringStatus: string;
  startedAt: string;
  completedAt: string | null;
  cachedOverallScore: string | null;
}

export interface RunScore {
  id: number;
  runId: string;
  criterionId: string;
  criterionName: string;
  weight: string;
  score: string;
  band: "fail" | "pass" | "excellent" | null;
  evidence: string | null;
  source: string;
  createdAt: string;
}

export interface RunDetail {
  run: {
    id: string;
    scenarioId: string;
    recruiterUserId: string;
    callId: string | null;
    status: RunStatus;
    mode: string;
    scoringStatus: string;
    scoreSource: string | null;
    cachedOverallScore: string | null;
    feedback: {
      strengths?: string[];
      improvements?: string[];
      coachNote?: string;
      generatedBy?: string;
      modelVersion?: string;
    } | null;
    startedAt: string;
    completedAt: string | null;
  };
  scenario: ScenarioFull | null;
  scores: RunScore[];
  call: { id: string } | null;
  auditEvents: AuditEvent[];
}

export interface AssignmentRow {
  id: string;
  scenarioId: string | null;
  scenarioTitle: string | null;
  curriculumId: string | null;
  assigneeUserId: string;
  assigneeEmail: string | null;
  assigneeName: string | null;
  status: AssignmentStatus;
  dueAt: string | null;
  completedAt: string | null;
  minPassScore: string | null;
  createdAt: string;
}

export interface CurriculumRow {
  id: string;
  name: string;
  description: string | null;
  scenarioIds: string[];
  isPublished: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressResponse {
  userId: string;
  points: Array<{ period: string; avgScore: number | null; runCount: number }>;
  bySkill: Array<{ criterion: string; avgScore: number | null; runCount: number }>;
}

export interface TeamSummaryRow {
  userId: string;
  email: string | null;
  name: string | null;
  avgScore: number | null;
  runCount: number;
  lastActivity: string | null;
  assigned: number;
  completed: number;
  overdue: number;
}

// ---------------------------------------------------------------------------
// Query params + URL helpers
// ---------------------------------------------------------------------------

export interface ScenarioFilters {
  q?: string;
  difficulty?: Difficulty;
  published?: boolean;
  tag?: string[];
  archived?: boolean;
  sort?: ScenarioSort;
  dir?: "asc" | "desc";
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Scenario queries
// ---------------------------------------------------------------------------

interface ScenarioListResp {
  scenarios: ScenarioRow[];
  nextCursor: string | null;
  total?: number;
}

export function useScenarios(
  filters: ScenarioFilters,
  page: { cursor?: string; limit?: number },
) {
  const params = { ...filters, ...page };
  return useQuery({
    queryKey: ["coaching", "scenarios", params],
    queryFn: () =>
      apiFetch<ScenarioListResp>(`/api/coaching/scenarios${qs(params)}`),
    placeholderData: keepPreviousData,
  });
}

export function useScenario(id?: string) {
  return useQuery({
    enabled: !!id,
    queryKey: ["coaching", "scenario", id],
    queryFn: () =>
      apiFetch<{ scenario: ScenarioFull; recentRuns: RecentRun[]; auditEvents: AuditEvent[] }>(
        `/api/coaching/scenarios/${id}`,
      ),
  });
}

export interface ScenarioInput {
  title: string;
  description?: string;
  difficulty: Difficulty;
  language: CoachingLanguage;
  openingLine?: string;
  candidatePersona: Persona;
  objections: string[];
  successCriteria: SuccessCriterion[];
  targetRubricId?: string | null;
  estimatedMinutes: number;
  tags: string[];
  isPublished: boolean;
}

function idemHeaders(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

export function useCreateScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScenarioInput) =>
      apiFetch<{ scenario: ScenarioRow }>(`/api/coaching/scenarios`, {
        method: "POST",
        json: input,
        headers: idemHeaders(),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "scenarios"] }),
  });
}

export function useUpdateScenario(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<ScenarioInput> & { expectedUpdatedAt?: string }) =>
      apiFetch<{ scenario: ScenarioFull }>(`/api/coaching/scenarios/${id}`, {
        method: "PATCH",
        json: input,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["coaching", "scenario", id] });
      qc.invalidateQueries({ queryKey: ["coaching", "scenarios"] });
    },
  });
}

export function useScenarioVerb(verb: "duplicate" | "archive" | "unarchive") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ scenario: ScenarioRow }>(`/api/coaching/scenarios/${id}/${verb}`, {
        method: "POST",
        headers: verb === "duplicate" ? idemHeaders() : undefined,
      }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["coaching", "scenarios"] });
      qc.invalidateQueries({ queryKey: ["coaching", "scenario", id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Run queries
// ---------------------------------------------------------------------------

export interface RunFilters {
  scope?: "mine" | "team" | "all";
  scenarioId?: string;
  status?: RunStatus;
  recruiterUserId?: string;
}

interface RunListResp {
  runs: RunRow[];
  nextCursor: string | null;
  total?: number;
}

export function useRuns(filters: RunFilters, page: { cursor?: string; limit?: number }) {
  const params = { ...filters, ...page };
  return useQuery({
    queryKey: ["coaching", "runs", params],
    queryFn: () => apiFetch<RunListResp>(`/api/coaching/runs${qs(params)}`),
    placeholderData: keepPreviousData,
  });
}

export function useRun(id?: string, opts?: { poll?: boolean }) {
  return useQuery({
    enabled: !!id,
    queryKey: ["coaching", "run", id],
    queryFn: () => apiFetch<RunDetail>(`/api/coaching/runs/${id}`),
    // Poll only while scoring is in flight; stop once scored/failed/skipped.
    refetchInterval: (query) => {
      if (!opts?.poll) return false;
      const st = query.state.data?.run.scoringStatus;
      return st === "pending" || st === "scoring" ? 2500 : false;
    },
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { scenarioId: string; mode?: string; assignmentId?: string }) =>
      apiFetch<{ run: RunRow }>(`/api/coaching/runs`, {
        method: "POST",
        json: input,
        headers: idemHeaders(),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "runs"] }),
  });
}

export function usePatchRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status?: RunStatus; callId?: string }) =>
      apiFetch<{ run: RunRow }>(`/api/coaching/runs/${input.id}`, {
        method: "PATCH",
        json: { status: input.status, callId: input.callId },
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["coaching", "run", v.id] });
      qc.invalidateQueries({ queryKey: ["coaching", "runs"] });
    },
  });
}

export function useScoreRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; force?: boolean }) =>
      apiFetch<{ scoringStatus: string; overall: number | null; generatedBy: string }>(
        `/api/coaching/runs/${input.id}/score${input.force ? "?force=true" : ""}`,
        { method: "POST" },
      ),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ["coaching", "run", v.id] }),
  });
}

export function useOverrideScore(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      criterionId: string;
      score: number;
      band?: "fail" | "pass" | "excellent";
      evidence?: string;
      justification: string;
    }) =>
      apiFetch<{ score: RunScore; overall: number }>(
        `/api/coaching/runs/${runId}/scores/${input.criterionId}`,
        { method: "PATCH", json: input },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "run", runId] }),
  });
}

// Returns { mode, publicKey, assistant } or throws 503 vapi_public_key_missing.
export function useAiCall() {
  return useMutation({
    mutationFn: (runId: string) =>
      apiFetch<{ mode: string; publicKey: string; assistant: Record<string, unknown> }>(
        `/api/coaching/runs/${runId}/ai-call`,
        { method: "POST" },
      ),
  });
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function useAssignments(
  filters: { scope?: "mine" | "team" | "all"; status?: AssignmentStatus },
  page?: { cursor?: string; limit?: number },
) {
  const params = { ...filters, ...page };
  return useQuery({
    queryKey: ["coaching", "assignments", params],
    queryFn: () =>
      apiFetch<{ assignments: AssignmentRow[]; nextCursor: string | null }>(
        `/api/coaching/assignments${qs(params)}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useAssign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      scenarioId?: string;
      curriculumId?: string;
      assigneeUserIds: string[];
      dueAt?: string;
      minPassScore?: number;
    }) =>
      apiFetch<{ assignments: AssignmentRow[] }>(`/api/coaching/assignments`, {
        method: "POST",
        json: input,
        headers: idemHeaders(),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "assignments"] }),
  });
}

export function usePatchAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status?: AssignmentStatus; dueAt?: string }) =>
      apiFetch<{ assignment: AssignmentRow }>(`/api/coaching/assignments/${input.id}`, {
        method: "PATCH",
        json: { status: input.status, dueAt: input.dueAt },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "assignments"] }),
  });
}

// ---------------------------------------------------------------------------
// Curricula
// ---------------------------------------------------------------------------

export function useCurricula() {
  return useQuery({
    queryKey: ["coaching", "curricula"],
    queryFn: () =>
      apiFetch<{ curricula: CurriculumRow[]; nextCursor: string | null }>(
        `/api/coaching/curricula`,
      ),
  });
}

export function useCreateCurriculum() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description?: string;
      scenarioIds: string[];
      isPublished: boolean;
    }) =>
      apiFetch<{ curriculum: CurriculumRow }>(`/api/coaching/curricula`, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching", "curricula"] }),
  });
}

// ---------------------------------------------------------------------------
// Progress / team
// ---------------------------------------------------------------------------

export function useProgress(userId?: string, groupBy: "week" | "month" = "week") {
  return useQuery({
    queryKey: ["coaching", "progress", userId ?? "self", groupBy],
    queryFn: () =>
      apiFetch<ProgressResponse>(`/api/coaching/progress${qs({ userId, groupBy })}`),
  });
}

export function useTeamSummary(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["coaching", "team-summary"],
    queryFn: () => apiFetch<{ team: TeamSummaryRow[] }>(`/api/coaching/team-summary`),
  });
}

// ---------------------------------------------------------------------------
// Helper lookups (rubrics + recruiters) for the authoring/assign dialogs
// ---------------------------------------------------------------------------

export function useRubricOptions(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["coaching", "rubric-options"],
    queryFn: () =>
      apiFetch<{ rubrics: Array<{ id: string; name: string }> }>(`/api/rubrics?limit=100`),
  });
}

export function useRecruiterOptions(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["coaching", "recruiter-options"],
    queryFn: () =>
      apiFetch<{ rows: Array<{ id: string; name: string | null; email: string }> }>(
        `/api/recruiters?limit=100`,
      ),
  });
}
