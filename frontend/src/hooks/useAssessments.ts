// React Query hooks + shared types for the Assessment Authoring page.
// Thin wrappers over apiFetch with keepPreviousData for keyset pagination and
// query-key conventions that the mutation hooks invalidate.
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export type ItemType =
  | "mcq_single"
  | "mcq_multi"
  | "true_false"
  | "short_answer"
  | "long_answer"
  | "coding"
  | "file_upload"
  | "video_response";

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  mcq_single: "Multiple choice (single)",
  mcq_multi: "Multiple choice (multi)",
  true_false: "True / false",
  short_answer: "Short answer",
  long_answer: "Long answer",
  coding: "Coding",
  file_upload: "File upload",
  video_response: "Video response",
};

export const AUTO_GRADABLE: ItemType[] = ["mcq_single", "mcq_multi", "true_false", "coding"];

export type TemplateStatus = "draft" | "published" | "archived";
export type AttemptStatus = "invited" | "started" | "submitted" | "reviewed" | "expired" | "revoked";

export interface TemplateRow {
  id: string;
  title: string;
  description: string | null;
  durationMins: number | null;
  passScore: number;
  status: TemplateStatus;
  publishedVersion: number | null;
  proctoringEnabled: boolean;
  itemCount: number;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRow {
  id: string;
  templateId: string;
  templateTitle: string | null;
  candidateId: string | null;
  candidateName: string | null;
  status: AttemptStatus;
  totalScore: number | null;
  autoScore: number | null;
  manualScore: number | null;
  maxScore: number | null;
  pass: boolean | null;
  passBand: string | null;
  remindersSent: number;
  inviteToken: string;
  proctorFlags: number;
  startedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface PassBand {
  label: string;
  minPercent: number;
}
export interface TemplateSettings {
  scoringMode?: "points" | "percent";
  passBands?: PassBand[];
  shuffleSections?: boolean;
  showResultsToCandidate?: boolean;
  allowBacktrack?: boolean;
}
export interface ProctoringPolicy {
  enabled?: boolean;
  requireWebcam?: boolean;
  requireScreenShare?: boolean;
  requireIdVerification?: boolean;
  lockdownFullscreen?: boolean;
  blockCopyPaste?: boolean;
  flagTabSwitch?: boolean;
  flagMultiFace?: boolean;
  flagNoFace?: boolean;
  flagSecondVoice?: boolean;
  autoFlagThreshold?: number;
}

export interface Section {
  id: string;
  templateId: string;
  title: string;
  description: string | null;
  position: number;
  timeLimitSeconds: number | null;
  shuffleItems: boolean;
  poolDrawCount: number | null;
}

export interface Item {
  id: string;
  templateId: string;
  sectionId: string | null;
  sourceQuestionId: string | null;
  type: ItemType;
  position: number;
  prompt: string;
  config: Record<string, unknown>;
  points: number;
  negativePoints: number;
  partialCredit: boolean;
  required: boolean;
  timeLimitSeconds: number | null;
}

export interface TemplateDetail {
  template: TemplateRow & {
    settings: TemplateSettings;
    proctoringPolicy: ProctoringPolicy;
    questionIds: string[];
  };
  sections: Section[];
  items: Item[];
  versions: Array<{ id: string; version: number; publishedAt: string; publishedByUserId: string | null }>;
  recentAttempts: Array<Pick<AttemptRow, "id" | "status" | "candidateId" | "candidateName" | "totalScore" | "autoScore" | "manualScore" | "maxScore" | "pass" | "passBand" | "inviteToken" | "startedAt" | "submittedAt" | "createdAt">>;
}

export interface TemplatesListResponse {
  templates: TemplateRow[];
  nextCursor: string | null;
  total: number;
}
export interface AttemptsListResponse {
  attempts: AttemptRow[];
  nextCursor: string | null;
  total: number;
}

export interface ResultsResponse {
  asOf: string;
  attemptCount: number;
  distribution: {
    buckets: Array<{ from: number; to: number; count: number }>;
    passRate: number | null;
    passBandBreakdown: Array<{ band: string; count: number }>;
    meanPercent: number | null;
    attemptCount: number;
  };
  items: Array<{
    itemId: string;
    type: string;
    prompt: string;
    n: number;
    pValue: number | null;
    discrimination: number | null;
    flagged: boolean;
    distractors: Array<{ optionId: string; label: string; correct: boolean; count: number }>;
  }>;
}

export interface AuditEntry {
  id: number;
  action: string;
  targetKind: string;
  targetId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function useTemplatesList(params: {
  status?: string;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}): UseQueryResult<TemplatesListResponse> {
  return useQuery({
    queryKey: ["assessment-templates", params],
    queryFn: () =>
      apiFetch<TemplatesListResponse>(
        `/api/assessments/templates${qs({
          status: params.status,
          q: params.q,
          sort: params.sort,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useAttemptsList(params: {
  status?: string;
  templateId?: string;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}): UseQueryResult<AttemptsListResponse> {
  return useQuery({
    queryKey: ["assessment-attempts", params],
    queryFn: () =>
      apiFetch<AttemptsListResponse>(
        `/api/assessments/attempts${qs({
          status: params.status,
          templateId: params.templateId,
          q: params.q,
          sort: params.sort,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useTemplateDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["assessment-template", id],
    queryFn: () => apiFetch<TemplateDetail>(`/api/assessments/templates/${id}`),
    enabled: !!id,
  });
}

export function useAttemptDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["assessment-attempt", id],
    queryFn: () =>
      apiFetch<{
        attempt: AttemptRow & {
          responses: unknown[];
          itemResults: Array<{
            itemId: string;
            type: string;
            awarded: number;
            max: number;
            correct: boolean | null;
            autoGraded: boolean;
            selectedOptionIds?: string[];
            codeRun?: { passed: number; total: number; stderr?: string };
          }>;
          reviewerNotes: string | null;
          versionId: string | null;
          deadlineAt: string | null;
        };
        template: { title: string; passScore: number } | null;
        version: { snapshot: { items?: Item[] } } | null;
        candidate: { id: string; displayName: string | null } | null;
      }>(`/api/assessments/attempts/${id}`),
    enabled: !!id,
  });
}

export function useResults(id: string | undefined) {
  return useQuery({
    queryKey: ["assessment-results", id],
    queryFn: () => apiFetch<ResultsResponse>(`/api/assessments/templates/${id}/results`),
    enabled: !!id,
  });
}

export function useAudit(id: string | undefined) {
  return useQuery({
    queryKey: ["assessment-audit", id],
    queryFn: () => apiFetch<{ entries: AuditEntry[] }>(`/api/assessments/templates/${id}/audit`),
    enabled: !!id,
  });
}

export function useInvalidateAssessments() {
  const qc = useQueryClient();
  return (id?: string) => {
    qc.invalidateQueries({ queryKey: ["assessment-templates"] });
    qc.invalidateQueries({ queryKey: ["assessment-attempts"] });
    if (id) {
      qc.invalidateQueries({ queryKey: ["assessment-template", id] });
      qc.invalidateQueries({ queryKey: ["assessment-results", id] });
      qc.invalidateQueries({ queryKey: ["assessment-audit", id] });
    }
  };
}

// ---- mutation helpers (return useMutation results) ----

export function useCreateTemplate() {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (body: { title: string; description?: string | null; durationMins?: number | null; passScore?: number }) =>
      apiFetch<{ template: TemplateRow }>("/api/assessments/templates", {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => invalidate(),
  });
}

export interface ItemDraft {
  type: ItemType;
  prompt: string;
  points: number;
  negativePoints: number;
  partialCredit: boolean;
  required: boolean;
  timeLimitSeconds: number | null;
  config: Record<string, unknown>;
  sectionId?: string | null;
}

export function useCreateItem(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (body: ItemDraft) =>
      apiFetch<{ item: Item }>(`/api/assessments/templates/${templateId}/items`, {
        method: "POST",
        json: body,
      }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useUpdateItem(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: Partial<ItemDraft> }) =>
      apiFetch<{ item: Item }>(`/api/assessments/items/${itemId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useDeleteItem(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (itemId: string) =>
      apiFetch(`/api/assessments/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useReorderItems(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (ordered: Array<{ itemId: string; sectionId?: string | null; position: number }>) =>
      apiFetch(`/api/assessments/templates/${templateId}/items/reorder`, {
        method: "POST",
        json: { ordered },
      }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useCreateSection(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (body: { title: string; description?: string | null; timeLimitSeconds?: number | null; shuffleItems?: boolean; poolDrawCount?: number | null }) =>
      apiFetch<{ section: Section }>(`/api/assessments/templates/${templateId}/sections`, {
        method: "POST",
        json: body,
      }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useDeleteSection(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (sectionId: string) =>
      apiFetch(`/api/assessments/sections/${sectionId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useUpdateTemplate(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (body: {
      title?: string;
      description?: string | null;
      durationMins?: number | null;
      passScore?: number;
      settings?: TemplateSettings;
      proctoringPolicy?: ProctoringPolicy;
    }) =>
      apiFetch<{ template: TemplateRow }>(`/api/assessments/templates/${templateId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => invalidate(templateId),
  });
}

export function usePublishTemplate(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string; version: number; versionId: string }>(
        `/api/assessments/templates/${templateId}/publish`,
        { method: "POST" },
      ),
    onSuccess: () => invalidate(templateId),
  });
}

export function useUnpublishTemplate(templateId: string) {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/assessments/templates/${templateId}/unpublish`, { method: "POST" }),
    onSuccess: () => invalidate(templateId),
  });
}

export function useDuplicateTemplate() {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (templateId: string) =>
      apiFetch<{ template: TemplateRow }>(`/api/assessments/templates/${templateId}/duplicate`, {
        method: "POST",
      }),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveTemplate() {
  const invalidate = useInvalidateAssessments();
  return useMutation({
    mutationFn: (templateId: string) =>
      apiFetch(`/api/assessments/templates/${templateId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(),
  });
}

export function useReviewAttempt(attemptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { itemScores?: Array<{ itemId: string; awarded: number }>; reviewerNotes?: string; pass?: boolean }) =>
      apiFetch<{ attempt: AttemptRow }>(`/api/assessments/attempts/${attemptId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assessment-attempt", attemptId] });
      qc.invalidateQueries({ queryKey: ["assessment-attempts"] });
    },
  });
}

export interface PreviewResponse {
  template: { id: string; title: string; description: string | null; durationMins: number | null; passScore: number };
  sections: Array<{ id: string; title: string; description: string | null; position: number }>;
  items: Array<{
    id: string;
    sectionId: string | null;
    type: ItemType;
    position: number;
    prompt: string;
    points: number;
    required: boolean;
    config: Record<string, unknown>;
  }>;
  proctoringPolicy: ProctoringPolicy;
}

export function usePreview(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["assessment-preview", id],
    queryFn: () => apiFetch<PreviewResponse>(`/api/assessments/templates/${id}/preview`),
    enabled: !!id && enabled,
  });
}
