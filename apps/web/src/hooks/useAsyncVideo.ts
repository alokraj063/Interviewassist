// React Query hooks + shared types for the Async Video Interview page.
//
// Thin wrappers over apiFetch with keepPreviousData for keyset pagination and
// query-key conventions the mutation hooks invalidate. All list hooks are
// keyset-cursor aware; the reviewer cockpit hooks (submission detail, scorecard,
// agreement, comments, share-links, AI artifacts, audit) drive AsyncVideoReview.
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetch, getApiBase, getAccessToken } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignStatus = "draft" | "published" | "archived";
export type SubmissionStatus = "invited" | "started" | "submitted" | "reviewed" | "expired";
export type Recommendation = "strong_yes" | "yes" | "maybe" | "no" | "strong_no";

export const RECOMMENDATIONS: Recommendation[] = ["strong_yes", "yes", "maybe", "no", "strong_no"];
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  maybe: "Maybe",
  no: "No",
  strong_no: "Strong no",
};

export interface CampaignRow {
  id: string;
  title: string;
  introText: string | null;
  demandId: string | null;
  demandTitle: string | null;
  status: CampaignStatus;
  blindReview: boolean;
  requireDeviceCheck: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  questionCount: number;
  submissionCount: number;
  submittedCount: number;
  reviewedCount: number;
}

export interface Question {
  id: string;
  campaignId: string;
  position: number;
  kind: "video" | "audio";
  text: string;
  stimulusText: string | null;
  stimulusBlobKey: string | null;
  prepSeconds: number;
  maxSeconds: number;
  maxRetakes: number;
  competencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignDetail {
  campaign: CampaignRow & {
    outroText: string | null;
    isPublished: boolean;
    archivedAt: string | null;
  };
  questions: Question[];
  submissions: Array<{
    id: string;
    candidateId: string | null;
    candidateName: string | null;
    status: SubmissionStatus;
    shortlisted: boolean;
    reviewerDecision: "forward" | "hold" | "reject" | null;
    reviewerScore: number | null;
    inviteToken: string;
    expiresAt: string | null;
    reminderCount: number;
    startedAt: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    createdAt: string;
  }>;
  counts: { total: number; submitted: number; reviewed: number; shortlisted: number };
}

export interface QueueRow {
  id: string;
  campaignId: string;
  campaignTitle: string | null;
  candidateId: string | null;
  candidateName: string | null;
  status: SubmissionStatus;
  shortlisted: boolean;
  reviewerDecision: "forward" | "hold" | "reject" | null;
  reviewerScore: number | null;
  dropOffPromptIndex: number | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  scorecardCount: number;
  aiSummaryStatus: string | null;
}

export interface QuestionScore {
  questionId: string;
  score: number;
  note?: string;
}

export interface Scorecard {
  id: string;
  reviewerUserId: string | null;
  reviewerName: string | null;
  externalReviewerLabel: string | null;
  questionScores: QuestionScore[];
  overallScore: number | null;
  recommendation: Recommendation | null;
  summaryNote: string | null;
  submitted: boolean;
  updatedAt: string;
}

export interface AiArtifact {
  id: string;
  submissionId: string;
  questionId: string | null;
  kind: "transcript" | "summary" | "skills";
  status: "queued" | "running" | "ready" | "failed" | "skipped";
  provider: string | null;
  model: string | null;
  content: unknown;
  errorText: string | null;
  updatedAt: string;
}

export interface SubmissionDetail {
  submission: {
    id: string;
    campaignId: string;
    status: SubmissionStatus;
    shortlisted: boolean;
    reviewerDecision: "forward" | "hold" | "reject" | null;
    reviewerScore: number | null;
    dropOffPromptIndex: number | null;
    deviceCheck: { camera: boolean; mic: boolean; bandwidthKbps: number | null; checkedAt: string } | null;
    reminderCount: number;
    startedAt: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    createdAt: string;
  };
  campaign: { id: string; title: string; blindReview: boolean; requireDeviceCheck: boolean } | null;
  candidate: { id: string; displayName: string | null } | null;
  questions: Question[];
  videos: Array<{ promptIndex: number; durationSec: number; recordedAt: string }>;
  scorecards: Scorecard[];
  ai: AiArtifact[];
}

export interface Agreement {
  reviewerCount: number;
  overallDelta: number | null;
  overallMean: number | null;
  agreement: number | null; // [0,1]
  perQuestion: Array<{ questionId: string; min: number; max: number; mean: number; spread: number; count: number }>;
}

export interface ShareLink {
  id: string;
  submissionId: string;
  token: string;
  label: string | null;
  canScore: boolean;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  createdAt: string;
  url: string;
  active: boolean;
}

export interface Comment {
  id: string;
  body: string;
  questionId: string | null;
  timestampSec: number | null;
  authorUserId: string | null;
  authorName: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  actorLabel: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface CampaignsListResponse {
  campaigns: CampaignRow[];
  nextCursor: string | null;
  total: number;
}
export interface QueueListResponse {
  submissions: QueueRow[];
  nextCursor: string | null;
  total: number;
}

export interface QuestionDraft {
  kind?: "video" | "audio";
  text: string;
  stimulusText?: string | null;
  prepSeconds?: number;
  maxSeconds?: number;
  maxRetakes?: number;
  competencyKey?: string | null;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// List + detail queries
// ---------------------------------------------------------------------------

export function useCampaigns(params: {
  status?: string;
  q?: string;
  demandId?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}): UseQueryResult<CampaignsListResponse> {
  return useQuery({
    queryKey: ["av-campaigns", params],
    queryFn: () =>
      apiFetch<CampaignsListResponse>(
        `/api/async-video/campaigns${qs({
          status: params.status,
          q: params.q,
          demandId: params.demandId,
          sort: params.sort,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useQueue(params: {
  status?: string;
  campaignId?: string;
  shortlisted?: string;
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
}): UseQueryResult<QueueListResponse> {
  return useQuery({
    queryKey: ["av-queue", params],
    queryFn: () =>
      apiFetch<QueueListResponse>(
        `/api/async-video/queue${qs({
          status: params.status,
          campaignId: params.campaignId,
          shortlisted: params.shortlisted,
          q: params.q,
          sort: params.sort,
          cursor: params.cursor,
          limit: params.limit ? String(params.limit) : undefined,
        })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ["av-campaign", id],
    queryFn: () => apiFetch<CampaignDetail>(`/api/async-video/campaigns/${id}`),
    enabled: !!id,
  });
}

export function useSubmission(id: string | undefined) {
  return useQuery({
    queryKey: ["av-submission", id],
    queryFn: () => apiFetch<SubmissionDetail>(`/api/async-video/submissions/${id}`),
    enabled: !!id,
  });
}

export function useAgreement(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["av-agreement", id],
    queryFn: () => apiFetch<Agreement>(`/api/async-video/submissions/${id}/agreement`),
    enabled: !!id && enabled,
  });
}

export function useComments(id: string | undefined) {
  return useQuery({
    queryKey: ["av-comments", id],
    queryFn: () => apiFetch<{ comments: Comment[] }>(`/api/async-video/submissions/${id}/comments`),
    enabled: !!id,
  });
}

export function useShareLinks(id: string | undefined) {
  return useQuery({
    queryKey: ["av-share-links", id],
    queryFn: () => apiFetch<{ shareLinks: ShareLink[] }>(`/api/async-video/submissions/${id}/share-links`),
    enabled: !!id,
  });
}

export function useAiArtifacts(id: string | undefined) {
  return useQuery({
    queryKey: ["av-ai", id],
    queryFn: () => apiFetch<{ artifacts: AiArtifact[]; configured: boolean }>(`/api/async-video/submissions/${id}/ai`),
    enabled: !!id,
  });
}

export function useSubmissionAudit(id: string | undefined) {
  return useQuery({
    queryKey: ["av-audit", id],
    queryFn: () => apiFetch<{ entries: AuditEntry[] }>(`/api/async-video/submissions/${id}/audit`),
    enabled: !!id,
  });
}

export function useCandidateSearch(q: string) {
  return useQuery({
    queryKey: ["av-candidate-search", q],
    queryFn: () =>
      apiFetch<{ candidates: Array<{ id: string; displayName: string | null; currentTitle: string | null }> }>(
        `/api/candidates${qs({ q: q || undefined, limit: "20" })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export function useInvalidateAsyncVideo() {
  const qc = useQueryClient();
  return (opts?: { campaignId?: string; submissionId?: string }) => {
    qc.invalidateQueries({ queryKey: ["av-campaigns"] });
    qc.invalidateQueries({ queryKey: ["av-queue"] });
    if (opts?.campaignId) qc.invalidateQueries({ queryKey: ["av-campaign", opts.campaignId] });
    if (opts?.submissionId) {
      qc.invalidateQueries({ queryKey: ["av-submission", opts.submissionId] });
      qc.invalidateQueries({ queryKey: ["av-agreement", opts.submissionId] });
      qc.invalidateQueries({ queryKey: ["av-comments", opts.submissionId] });
      qc.invalidateQueries({ queryKey: ["av-share-links", opts.submissionId] });
      qc.invalidateQueries({ queryKey: ["av-ai", opts.submissionId] });
      qc.invalidateQueries({ queryKey: ["av-audit", opts.submissionId] });
    }
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateCampaign() {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: {
      title: string;
      introText?: string | null;
      outroText?: string | null;
      demandId?: string | null;
      blindReview?: boolean;
      requireDeviceCheck?: boolean;
      questions: QuestionDraft[];
    }) =>
      apiFetch<{ campaign: CampaignRow }>("/api/async-video/campaigns", {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateCampaign(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: {
      title?: string;
      introText?: string | null;
      outroText?: string | null;
      demandId?: string | null;
      blindReview?: boolean;
      requireDeviceCheck?: boolean;
      expectedVersion?: number;
    }) =>
      apiFetch<{ campaign: CampaignRow }>(`/api/async-video/campaigns/${campaignId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useAddQuestion(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: QuestionDraft) =>
      apiFetch<{ question: Question }>(`/api/async-video/campaigns/${campaignId}/questions`, {
        method: "POST",
        json: body,
      }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useUpdateQuestion(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: ({ questionId, body }: { questionId: string; body: Partial<QuestionDraft> }) =>
      apiFetch<{ question: Question }>(`/api/async-video/questions/${questionId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useDeleteQuestion(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (questionId: string) =>
      apiFetch(`/api/async-video/questions/${questionId}`, { method: "DELETE" }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useReorderQuestions(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      apiFetch(`/api/async-video/campaigns/${campaignId}/questions/reorder`, {
        method: "POST",
        json: { orderedIds },
      }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function usePublishCampaign(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: () => apiFetch(`/api/async-video/campaigns/${campaignId}/publish`, { method: "POST" }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useUnpublishCampaign(campaignId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: () => apiFetch(`/api/async-video/campaigns/${campaignId}/unpublish`, { method: "POST" }),
    onSuccess: () => invalidate({ campaignId }),
  });
}

export function useArchiveCampaign() {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (campaignId: string) =>
      apiFetch(`/api/async-video/campaigns/${campaignId}/archive`, { method: "POST" }),
    onSuccess: () => invalidate(),
  });
}

export function useDuplicateCampaign() {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (campaignId: string) =>
      apiFetch<{ campaign: CampaignRow }>(`/api/async-video/campaigns/${campaignId}/duplicate`, { method: "POST" }),
    onSuccess: () => invalidate(),
  });
}

export function useInvite() {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: { campaignId: string; candidateId?: string | null; expiresInHours?: number }) =>
      apiFetch<{ submission: { id: string }; inviteToken: string; inviteLink: string }>(
        "/api/async-video/invites",
        { method: "POST", json: body, headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    onSuccess: (_d, vars) => invalidate({ campaignId: vars.campaignId }),
  });
}

export function useBulkInvite() {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: { campaignId: string; candidateIds: string[]; expiresInHours?: number }) =>
      apiFetch<{ created: number; skipped: number }>("/api/async-video/invites/bulk", {
        method: "POST",
        json: body,
      }),
    onSuccess: (_d, vars) => invalidate({ campaignId: vars.campaignId }),
  });
}

export function useRemindSubmission(campaignId?: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (submissionId: string) =>
      apiFetch(`/api/async-video/submissions/${submissionId}/remind`, { method: "POST" }),
    onSuccess: (_d, submissionId) => invalidate({ campaignId, submissionId }),
  });
}

export function useRevokeSubmission(campaignId?: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (submissionId: string) =>
      apiFetch(`/api/async-video/submissions/${submissionId}/revoke`, { method: "POST" }),
    onSuccess: (_d, submissionId) => invalidate({ campaignId, submissionId }),
  });
}

export function useSaveScorecard(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: {
      questionScores: QuestionScore[];
      recommendation?: Recommendation | null;
      summaryNote?: string | null;
      submitted: boolean;
    }) =>
      apiFetch<{ scorecard: Scorecard }>(`/api/async-video/submissions/${submissionId}/scorecard`, {
        method: "PUT",
        json: body,
      }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

export function useShortlist(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (shortlisted: boolean) =>
      apiFetch(`/api/async-video/submissions/${submissionId}/shortlist`, {
        method: "POST",
        json: { shortlisted },
      }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

export function useAddComment(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: { body: string; questionId?: string | null; timestampSec?: number | null }) =>
      apiFetch(`/api/async-video/submissions/${submissionId}/comments`, { method: "POST", json: body }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

export function useCreateShareLink(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (body: { label?: string | null; expiresInHours?: number; canScore?: boolean }) =>
      apiFetch<{ shareLink: ShareLink; url: string }>(`/api/async-video/submissions/${submissionId}/share-links`, {
        method: "POST",
        json: body,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

export function useRevokeShareLink(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: (shareLinkId: string) =>
      apiFetch(`/api/async-video/share-links/${shareLinkId}`, { method: "DELETE" }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

export function useTranscribe(submissionId: string) {
  const invalidate = useInvalidateAsyncVideo();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/async-video/submissions/${submissionId}/ai/transcribe`, { method: "POST" }),
    onSuccess: () => invalidate({ submissionId }),
  });
}

// Authenticated video stream URL — <video> can't set headers, so the access
// token rides in the query string (the API's app.authenticate honors ?token=).
export function videoUrl(submissionId: string, promptIndex: number): string {
  const token = getAccessToken();
  return `${getApiBase()}/api/async-video/submissions/${submissionId}/video/${promptIndex}${
    token ? `?token=${encodeURIComponent(token)}` : ""
  }`;
}
