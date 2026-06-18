// React Query hooks + shared types for the Question Bank page family.
//
// Thin wrappers over apiFetch. List hooks use keepPreviousData for keyset
// pagination. Every mutation invalidates the relevant query keys. The API is
// fully governed (permission-gated, keyset-paginated, audited) — see
// apps/api/src/routes/question-banks.ts. These hooks mirror its shapes.
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

export const QUESTION_LEVELS = ["junior", "mid", "senior", "staff"] as const;
export type QuestionLevel = (typeof QUESTION_LEVELS)[number];

export const QUESTION_LANGUAGES = ["en", "hi", "hinglish"] as const;
export type QuestionLanguage = (typeof QUESTION_LANGUAGES)[number];

export const QUESTION_TYPES = [
  "verbal",
  "mcq_single",
  "mcq_multi",
  "true_false",
  "short_answer",
  "coding",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_STATUSES = ["draft", "in_review", "approved", "rejected", "archived"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  verbal: "Verbal",
  mcq_single: "Single choice",
  mcq_multi: "Multi choice",
  true_false: "True / false",
  short_answer: "Short answer",
  coding: "Coding",
};

export const LANGUAGE_LABELS: Record<QuestionLanguage, string> = {
  en: "English",
  hi: "Hindi",
  hinglish: "Hinglish",
};

export const STATUS_LABELS: Record<QuestionStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
};

export interface BankRow {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  defaultLanguage: QuestionLanguage;
  version: number;
  questionCount: number;
  skillsCovered: number;
  linkedDemandsCount: number;
  updatedAt: string;
}

export interface BanksListResponse {
  banks: BankRow[];
  nextCursor: string | null;
}

export interface BankDetail {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  defaultLanguage: QuestionLanguage;
  version: number;
  archivedAt: string | null;
  counts: { total: number; approved: number; inReview: number; draft: number };
  linkedDemandIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface QuestionOption {
  id: string;
  text: string;
  correct: boolean;
}

export interface QuestionRow {
  id: string;
  bankId: string;
  skillId: string | null;
  level: QuestionLevel;
  difficulty: number;
  language: QuestionLanguage;
  questionType: QuestionType;
  roleFamily: string | null;
  prompt: string;
  expectedAnswerHints: string | null;
  evaluationRubric: string[];
  followUpQuestions: string[];
  commonMistakes: string[];
  options: QuestionOption[];
  status: QuestionStatus;
  currentVersion: number;
  contentHash: string;
  calibratedDifficulty: string | null;
  exposureCount: number;
  lastUsedAt: string | null;
  overUsed: boolean;
  createdByUserId: string | null;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionListResponse {
  questions: QuestionRow[];
  nextCursor: string | null;
  totalApprox: number;
}

export interface ReviewQueueResponse {
  questions: QuestionRow[];
  nextCursor: string | null;
}

export interface QuestionVersionEntry {
  version: number;
  reason: "created" | "edited" | "approved" | "rejected" | "reverted";
  authorUserId: string | null;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

export interface QuestionReviewEntry {
  id: string;
  decision: "submitted" | "approved" | "rejected" | "changes_requested";
  reviewerUserId: string | null;
  note: string | null;
  createdAt: string;
}

export interface QuestionUsage {
  events: number;
  scored: number;
  liveExposureCount: number;
  calibratedDifficulty: string | null;
  observedPValue: number | null;
  lastUsedAt: string | null;
  overUsed: boolean;
}

export interface QuestionDetailResponse {
  question: QuestionRow;
  versions: QuestionVersionEntry[];
  reviews: QuestionReviewEntry[];
  usage: QuestionUsage;
}

export interface ActivityEvent {
  id: string;
  action: string;
  actorUserId: string | null;
  questionId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export interface ImportPreviewRow {
  row: number;
  prompt: string;
  level: string;
  difficulty: number;
  language: string;
  questionType: string;
  roleFamily: string | null;
  duplicate: boolean;
}

export interface ImportJobResult {
  jobId: string;
  status: "pending" | "parsing" | "ready" | "committed" | "failed";
  rowCount: number;
  validCount: number;
  duplicateCount: number;
  errorCount: number;
  preview: ImportPreviewRow[];
  errors: Array<{ row: number; message: string }>;
  idempotent?: boolean;
}

export interface QuestionDraft {
  skillId?: string | null;
  skillName?: string;
  level: QuestionLevel;
  difficulty: number;
  language: QuestionLanguage;
  questionType: QuestionType;
  roleFamily?: string | null;
  prompt: string;
  expectedAnswerHints?: string | null;
  evaluationRubric: string[];
  followUpQuestions: string[];
  commonMistakes: string[];
  options: QuestionOption[];
}

// ---------------------------------------------------------------------------
// Query-string helper
// ---------------------------------------------------------------------------

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useBanks(params: {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}): UseQueryResult<BanksListResponse> {
  return useQuery({
    queryKey: ["qbanks", params],
    queryFn: () =>
      apiFetch<BanksListResponse>(
        `/api/question-banks${qs({
          status: params.status,
          q: params.q,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useBank(id: string | undefined) {
  return useQuery({
    queryKey: ["qbank", id],
    queryFn: () => apiFetch<BankDetail>(`/api/question-banks/${id}`),
    enabled: !!id,
  });
}

export interface QuestionFilters {
  status?: string;
  skillId?: string;
  level?: string;
  difficultyMin?: string;
  difficultyMax?: string;
  language?: string;
  roleFamily?: string;
  questionType?: string;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}

export function useBankQuestions(
  bankId: string | undefined,
  filters: QuestionFilters,
): UseQueryResult<QuestionListResponse> {
  return useQuery({
    queryKey: ["qbank-questions", bankId, filters],
    queryFn: () =>
      apiFetch<QuestionListResponse>(
        `/api/question-banks/${bankId}/questions${qs({
          status: filters.status,
          skillId: filters.skillId,
          level: filters.level,
          difficultyMin: filters.difficultyMin,
          difficultyMax: filters.difficultyMax,
          language: filters.language,
          roleFamily: filters.roleFamily,
          questionType: filters.questionType,
          q: filters.q,
          sort: filters.sort,
          cursor: filters.cursor,
          limit: filters.limit ? String(filters.limit) : undefined,
        })}`,
      ),
    enabled: !!bankId,
    placeholderData: keepPreviousData,
  });
}

export function useQuestion(qid: string | undefined) {
  return useQuery({
    queryKey: ["qbank-question", qid],
    queryFn: () => apiFetch<QuestionDetailResponse>(`/api/question-banks/questions/${qid}`),
    enabled: !!qid,
  });
}

export function useReviewQueue(params: { cursor?: string; limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ["qbank-review-queue", params],
    queryFn: () =>
      apiFetch<ReviewQueueResponse>(
        `/api/question-banks/review-queue${qs({
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useBankActivity(bankId: string | undefined) {
  return useQuery({
    queryKey: ["qbank-activity", bankId],
    queryFn: () => apiFetch<ActivityResponse>(`/api/question-banks/${bankId}/activity`),
    enabled: !!bankId,
  });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export function useInvalidateQuestionBanks() {
  const qc = useQueryClient();
  return (opts?: { bankId?: string; questionId?: string }) => {
    qc.invalidateQueries({ queryKey: ["qbanks"] });
    qc.invalidateQueries({ queryKey: ["qbank-review-queue"] });
    if (opts?.bankId) {
      qc.invalidateQueries({ queryKey: ["qbank", opts.bankId] });
      qc.invalidateQueries({ queryKey: ["qbank-questions", opts.bankId] });
      qc.invalidateQueries({ queryKey: ["qbank-activity", opts.bankId] });
    } else {
      qc.invalidateQueries({ queryKey: ["qbank-questions"] });
    }
    if (opts?.questionId) qc.invalidateQueries({ queryKey: ["qbank-question", opts.questionId] });
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateBank() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (body: { name: string; description?: string | null; defaultLanguage: QuestionLanguage }) =>
      apiFetch<{ id: string }>("/api/question-banks", {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => invalidate(),
  });
}

export function usePatchBank(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (body: {
      name?: string;
      description?: string | null;
      defaultLanguage?: QuestionLanguage;
      expectedVersion: number;
    }) => apiFetch<{ id: string; version: number }>(`/api/question-banks/${bankId}`, { method: "PATCH", json: body }),
    onSuccess: () => invalidate({ bankId }),
  });
}

export function useArchiveBank() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (bankId: string) => apiFetch(`/api/question-banks/${bankId}/archive`, { method: "POST" }),
    onSuccess: (_d, bankId) => invalidate({ bankId }),
  });
}

export function useRestoreBank() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (bankId: string) => apiFetch(`/api/question-banks/${bankId}/restore`, { method: "POST" }),
    onSuccess: (_d, bankId) => invalidate({ bankId }),
  });
}

export function useCreateQuestion(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ body, allowDuplicate }: { body: QuestionDraft; allowDuplicate?: boolean }) =>
      apiFetch<{ id: string; currentVersion: number }>(
        `/api/question-banks/${bankId}/questions${allowDuplicate ? "?allowDuplicate=true" : ""}`,
        { method: "POST", json: body, headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: () => invalidate({ bankId }),
  });
}

export function usePatchQuestion(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ questionId, body }: { questionId: string; body: Partial<QuestionDraft> & { expectedVersion: number } }) =>
      apiFetch<{ id: string; currentVersion: number }>(`/api/question-banks/questions/${questionId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: (_d, { questionId }) => invalidate({ bankId, questionId }),
  });
}

export function useArchiveQuestion(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (questionId: string) =>
      apiFetch(`/api/question-banks/questions/${questionId}/archive`, { method: "POST" }),
    onSuccess: (_d, questionId) => invalidate({ bankId, questionId }),
  });
}

export function useSubmitReview(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ questionId, note }: { questionId: string; note?: string }) =>
      apiFetch(`/api/question-banks/questions/${questionId}/submit-review`, { method: "POST", json: { note } }),
    onSuccess: (_d, { questionId }) => invalidate({ bankId, questionId }),
  });
}

export function useApproveQuestion() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ questionId, note }: { questionId: string; note?: string }) =>
      apiFetch(`/api/question-banks/questions/${questionId}/approve`, { method: "POST", json: { note } }),
    onSuccess: (_d, { questionId }) => invalidate({ questionId }),
  });
}

export function useRejectQuestion() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ questionId, note }: { questionId: string; note: string }) =>
      apiFetch(`/api/question-banks/questions/${questionId}/reject`, { method: "POST", json: { note } }),
    onSuccess: (_d, { questionId }) => invalidate({ questionId }),
  });
}

export function useRevertQuestion() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ questionId, version }: { questionId: string; version: number }) =>
      apiFetch(`/api/question-banks/questions/${questionId}/revert/${version}`, { method: "POST" }),
    onSuccess: (_d, { questionId }) => invalidate({ questionId }),
  });
}

export function useBulkQuestions(bankId?: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: (body: {
      questionIds: string[];
      action: "archive" | "approve" | "submit_review" | "set_role_family" | "set_language";
      roleFamily?: string;
      language?: QuestionLanguage;
    }) =>
      apiFetch<{ updated: number; skipped: Array<{ id: string; reason: string }> }>("/api/question-banks/questions/bulk", {
        method: "POST",
        json: body,
      }),
    onSuccess: () => invalidate({ bankId }),
  });
}

export function useImportPreview(bankId: string) {
  return useMutation({
    mutationFn: (body: { format: "csv" | "qti"; content: string }) =>
      apiFetch<ImportJobResult>(`/api/question-banks/${bankId}/import`, {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
  });
}

export function useCommitImport(bankId: string) {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: ({ jobId, allowDuplicates }: { jobId: string; allowDuplicates?: boolean }) =>
      apiFetch<{ jobId: string; status: string; inserted: number }>(
        `/api/question-banks/import-jobs/${jobId}/commit${allowDuplicates ? "?allowDuplicates=true" : ""}`,
        { method: "POST" },
      ),
    onSuccess: () => invalidate({ bankId }),
  });
}

export function useRecalibrate() {
  const invalidate = useInvalidateQuestionBanks();
  return useMutation({
    mutationFn: () => apiFetch<{ recalibrated: number }>("/api/question-banks/recalibrate", { method: "POST" }),
    onSuccess: () => invalidate(),
  });
}

export function useGenerateAi(bankId: string) {
  return useMutation({
    mutationFn: () => apiFetch(`/api/question-banks/${bankId}/generate`, { method: "POST" }),
  });
}

// CSV export uses a direct authenticated fetch (download), not a query.
export function bankExportPath(bankId: string): string {
  return `/api/question-banks/${bankId}/export?format=csv`;
}
