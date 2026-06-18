// React Query hooks for the Rubrics surface. Every call goes through apiFetch
// against the real /api/rubrics endpoints; mutations invalidate the relevant
// query keys so the UI updates without a full reload.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---------- types ----------

export type RubricStatus = "draft" | "published" | "archived";
export type RubricPurpose =
  | "general_screen"
  | "technical_screen"
  | "senior_technical"
  | "hr_screen"
  | "outbound_pitch";
export type RubricAppliesTo = "call" | "coaching" | "async_video" | "assessment";
export type RubricCriterionKind =
  | "script_adherence"
  | "jd_coverage"
  | "technical_depth"
  | "salary_handling"
  | "positioning"
  | "candidate_experience"
  | "compliance_disclosure"
  | "custom";

export interface RubricBandAnchor {
  fail?: string;
  pass?: string;
  excellent?: string;
}
export interface RubricCriterionV2 {
  id: string;
  name: string;
  description?: string;
  weight: number;
  kind: RubricCriterionKind;
  bandThresholds: { fail: number; pass: number; excellent: number };
  anchors?: RubricBandAnchor;
  minEvidenceQuotes?: number;
  autoScoreEnabled: boolean;
}

export interface RubricListRow {
  id: string;
  name: string;
  version: number;
  publishedVersion: number | null;
  purpose: RubricPurpose;
  status: RubricStatus;
  appliesTo: RubricAppliesTo[];
  clientId: string | null;
  description: string | null;
  criteria: RubricCriterionV2[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  timesUsed: number;
}

export interface RubricListResponse {
  rubrics: RubricListRow[];
  nextCursor: string | null;
  total: number;
  metrics: { published: number; defaults: number; timesScored: number };
}

export interface RubricUsage {
  timesScored: number;
  scoredCalls: number;
  voiceAgents: number;
  coachingScenarios: number;
  defaultForPurpose: boolean;
}

export interface RubricDetail {
  rubric: RubricListRow;
  usage: RubricUsage;
  recentAudit: AuditEntry[];
}

export interface RubricVersion {
  id: string;
  version: number;
  name: string;
  purpose: RubricPurpose;
  criteria: RubricCriterionV2[];
  changeNote: string | null;
  publishedAt: string;
  publishedByName: string | null;
}

export interface AuditEntry {
  id: number;
  action: string;
  fromVersion: number | null;
  toVersion: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
}

export interface CalibrationRow {
  id: string;
  name: string;
  aiAvg: number | null;
  reviewerAvg: number | null;
  overrideRate: number;
  agreementPct: number | null;
  n: number;
}

export interface RubricListParams {
  q?: string;
  status?: RubricStatus;
  purpose?: RubricPurpose;
  appliesTo?: RubricAppliesTo;
  isDefault?: boolean;
  sort?: "updatedAt" | "name" | "timesUsed";
  dir?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

function toQuery(params: RubricListParams): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------- queries ----------

export function useRubricList(params: RubricListParams) {
  return useQuery<RubricListResponse>({
    queryKey: ["rubrics", "list", params],
    queryFn: () => apiFetch<RubricListResponse>(`/api/rubrics${toQuery(params)}`),
    placeholderData: (prev) => prev,
  });
}

export function useRubric(id: string | undefined) {
  return useQuery<RubricDetail>({
    queryKey: ["rubric", id],
    queryFn: () => apiFetch<RubricDetail>(`/api/rubrics/${id}`),
    enabled: !!id,
  });
}

export function useRubricVersions(id: string | undefined) {
  return useQuery<{ versions: RubricVersion[] }>({
    queryKey: ["rubric", id, "versions"],
    queryFn: () => apiFetch<{ versions: RubricVersion[] }>(`/api/rubrics/${id}/versions`),
    enabled: !!id,
  });
}

export function useRubricVersion(id: string | undefined, version: string | undefined) {
  return useQuery<{ version: RubricVersion }>({
    queryKey: ["rubric", id, "version", version],
    queryFn: () => apiFetch<{ version: RubricVersion }>(`/api/rubrics/${id}/versions/${version}`),
    enabled: !!id && !!version,
  });
}

export function useRubricAudit(id: string | undefined) {
  return useQuery<{ entries: AuditEntry[]; nextCursor: string | null }>({
    queryKey: ["rubric", id, "audit"],
    queryFn: () => apiFetch<{ entries: AuditEntry[]; nextCursor: string | null }>(`/api/rubrics/${id}/audit`),
    enabled: !!id,
  });
}

export function useRubricCalibration(id: string | undefined) {
  return useQuery<{ criteria: CalibrationRow[]; reviewCount: number }>({
    queryKey: ["rubric", id, "calibration"],
    queryFn: () => apiFetch<{ criteria: CalibrationRow[]; reviewCount: number }>(`/api/rubrics/${id}/calibration`),
    enabled: !!id,
  });
}

// ---------- mutations ----------

export interface CreateRubricInput {
  name: string;
  purpose: RubricPurpose;
  description?: string;
  appliesTo: RubricAppliesTo[];
  criteria?: RubricCriterionV2[];
  idempotencyKey?: string;
}

export function useCreateRubric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRubricInput) =>
      apiFetch<{ rubric: RubricListRow }>("/api/rubrics", {
        method: "POST",
        json: { ...input, idempotencyKey: undefined },
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rubrics"] }),
  });
}

export function useUpdateRubric(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CreateRubricInput> & { expectedUpdatedAt?: string }) =>
      apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}`, { method: "PATCH", json: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubric", id] });
      qc.invalidateQueries({ queryKey: ["rubrics"] });
    },
  });
}

export function usePublishRubric(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changeNote?: string) =>
      apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}/publish`, { method: "POST", json: { changeNote } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubric", id] });
      qc.invalidateQueries({ queryKey: ["rubrics"] });
    },
  });
}

export function useArchiveRubric(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (force?: boolean) =>
      apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}/archive${force ? "?force=true" : ""}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubric", id] });
      qc.invalidateQueries({ queryKey: ["rubrics"] });
    },
  });
}

export function useRestoreRubric(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubric", id] });
      qc.invalidateQueries({ queryKey: ["rubrics"] });
    },
  });
}

export function useSetDefaultRubric(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}/set-default`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rubric", id] });
      qc.invalidateQueries({ queryKey: ["rubrics"] });
    },
  });
}

export function useDuplicateRubric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ rubric: RubricListRow }>(`/api/rubrics/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rubrics"] }),
  });
}

export interface BulkInput {
  ids: string[];
  action: "archive" | "set_default" | "export" | "set_applies_to";
  payload?: { appliesTo?: RubricAppliesTo[] };
}
export interface BulkResult {
  ok: string[];
  failed: Array<{ id: string; reason: string }>;
  exported?: unknown[];
}

export function useBulkRubrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkInput) => apiFetch<BulkResult>("/api/rubrics/bulk", { method: "POST", json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rubrics"] }),
  });
}

export function useImportRubric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (doc: { name: string; purpose: RubricPurpose; appliesTo: RubricAppliesTo[]; description?: string; criteria: RubricCriterionV2[] }) =>
      apiFetch<{ rubric: RubricListRow }>("/api/rubrics/import", { method: "POST", json: doc }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rubrics"] }),
  });
}

export function useAiSuggest(id: string) {
  return useMutation({
    mutationFn: (input: { purpose?: RubricPurpose; context?: string }) =>
      apiFetch<{ suggestions: RubricCriterionV2[] }>(`/api/rubrics/${id}/ai-suggest`, { method: "POST", json: input }),
  });
}

// ---------- pure helpers shared by editor components ----------

export const PURPOSE_LABELS: Record<RubricPurpose, string> = {
  general_screen: "General screen",
  technical_screen: "Technical screen",
  senior_technical: "Senior technical",
  hr_screen: "HR screen",
  outbound_pitch: "Outbound pitch",
};

export const CRITERION_KINDS: RubricCriterionKind[] = [
  "script_adherence",
  "jd_coverage",
  "technical_depth",
  "salary_handling",
  "positioning",
  "candidate_experience",
  "compliance_disclosure",
  "custom",
];

export const APPLIES_TO_OPTIONS: RubricAppliesTo[] = ["call", "coaching", "async_video", "assessment"];

export function normalizedWeights(criteria: RubricCriterionV2[]): Map<string, number> {
  const total = criteria.reduce((s, c) => s + (c.weight || 0), 0);
  const out = new Map<string, number>();
  for (const c of criteria) out.set(c.id, total > 0 ? (c.weight / total) * 100 : 0);
  return out;
}

export function criteriaValid(criteria: RubricCriterionV2[]): boolean {
  if (criteria.length === 0) return false;
  for (const c of criteria) {
    if (!c.name.trim()) return false;
    const b = c.bandThresholds;
    if (!(b.fail <= b.pass && b.pass <= b.excellent)) return false;
  }
  return true;
}

export function publishable(criteria: RubricCriterionV2[]): boolean {
  return criteriaValid(criteria) && criteria.reduce((s, c) => s + (c.weight || 0), 0) > 0;
}
