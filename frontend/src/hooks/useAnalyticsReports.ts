// Analytics report-engine React Query hooks. One typed hook per server report
// endpoint plus the saved-views / schedules / export mutations. Every report
// accepts the shared filter envelope (range/from/to/compare/granularity +
// segments) and returns rows + an `asOf` server timestamp. Mirrors the
// apiFetch + React Query conventions in hooks/useQuestionBanks.ts.
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

// ---- shared filter envelope ----
export const RANGE_TOKENS = [
  "last_7d",
  "last_14d",
  "last_30d",
  "last_90d",
  "this_quarter",
  "last_quarter",
  "ytd",
  "custom",
] as const;
export type RangeToken = (typeof RANGE_TOKENS)[number];

export const RANGE_LABELS: Record<RangeToken, string> = {
  last_7d: "Last 7 days",
  last_14d: "Last 14 days",
  last_30d: "Last 30 days",
  last_90d: "Last 90 days",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  ytd: "Year to date",
  custom: "Custom range",
};

export const GRANULARITIES = ["day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const REPORT_KEYS = [
  "funnel",
  "velocity",
  "source_effectiveness",
  "recruiter_productivity",
  "quality_distribution",
  "voice_screener",
  "call_volume",
  "diversity",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export interface AnalyticsFilters {
  range: RangeToken;
  from?: string;
  to?: string;
  compare: boolean;
  granularity: Granularity;
  recruiterUserId?: string;
  clientId?: string;
  demandId?: string;
  source?: string;
}

// Build the query string the report endpoints expect from a filter envelope.
export function filtersToQuery(f: AnalyticsFilters): string {
  const p = new URLSearchParams();
  p.set("range", f.range);
  if (f.range === "custom") {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  if (f.compare) p.set("compare", "true");
  p.set("granularity", f.granularity);
  if (f.recruiterUserId) p.set("recruiterUserId", f.recruiterUserId);
  if (f.clientId) p.set("clientId", f.clientId);
  if (f.demandId) p.set("demandId", f.demandId);
  if (f.source) p.set("source", f.source);
  return p.toString();
}

// `custom` range without both bounds is not yet a valid server request — don't
// fire it (the server would 400). The hooks below gate on this.
export function filtersReady(f: AnalyticsFilters): boolean {
  if (f.range === "custom") return !!f.from && !!f.to;
  return true;
}

// ---- response shapes ----
export interface ReportWindow {
  from: string;
  to: string;
}
export interface FunnelRow {
  bucket: string;
  label: string;
  count: number;
  conversionPctFromPrev: number | null;
}
export interface VelocityRow {
  stage: string;
  medianDaysInStage: number | null;
  p90DaysInStage: number | null;
  avgDays: number | null;
  n: number;
}
export interface SourceRow {
  source: string;
  submitted: number;
  onboarded: number;
  conversionPct: number;
}
export interface QualityResponse {
  histogram: Array<{ bucket: string; n: number }>;
  perCriterion: Array<{
    criterionId: string;
    avg: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    n: number;
  }>;
  asOf: string;
  window: ReportWindow;
}
export interface VoiceRow {
  voiceAgentId: string;
  name: string | null;
  kind: string | null;
  calls: number;
  avgDurationSec: number;
}
export interface CallVolumeRow {
  period: string;
  n: number;
}
export interface RecruiterRow {
  recruiterUserId: string;
  name: string | null;
  email: string | null;
  submissions: number;
  onboarded: number;
  conversionPct: number;
}
export interface DiversityResponse {
  rows: Array<{ cohort: string; count: number }>;
  suppressedBuckets: number;
  asOf: string;
  window: ReportWindow;
}
export interface DrillRow {
  submission_id: string;
  candidate_id: string;
  display_name: string | null;
  current_stage: string;
  source: string;
  submitted_at: string;
}

interface RowsResponse<T> {
  rows: T[];
  asOf: string;
  window: ReportWindow;
}
interface PagedRowsResponse<T> extends RowsResponse<T> {
  nextCursor: string | null;
}

// ---- report query hooks ----
function reportKey(path: string, f: AnalyticsFilters): unknown[] {
  return ["analytics", path, filtersToQuery(f)];
}

function useReport<T>(
  path: string,
  f: AnalyticsFilters,
): UseQueryResult<RowsResponse<T>, Error> {
  return useQuery<RowsResponse<T>, Error>({
    queryKey: reportKey(path, f),
    queryFn: () => apiFetch<RowsResponse<T>>(`/api/analytics/${path}?${filtersToQuery(f)}`),
    enabled: filtersReady(f),
  });
}

export function useFunnel(f: AnalyticsFilters) {
  return useReport<FunnelRow>("reports/funnel", f);
}
export function useVelocity(f: AnalyticsFilters) {
  return useReport<VelocityRow>("reports/velocity", f);
}
export function useSourceEffectiveness(f: AnalyticsFilters) {
  return useReport<SourceRow>("reports/source-effectiveness", f);
}
export function useVoiceScreener(f: AnalyticsFilters) {
  return useReport<VoiceRow>("reports/voice-screener", f);
}
export function useCallVolume(f: AnalyticsFilters) {
  return useReport<CallVolumeRow>("reports/call-volume", f);
}

export function useQualityDistribution(f: AnalyticsFilters) {
  return useQuery<QualityResponse, Error>({
    queryKey: reportKey("reports/quality-distribution", f),
    queryFn: () =>
      apiFetch<QualityResponse>(`/api/analytics/reports/quality-distribution?${filtersToQuery(f)}`),
    enabled: filtersReady(f),
  });
}

export function useDiversity(f: AnalyticsFilters, enabled: boolean) {
  return useQuery<DiversityResponse, Error>({
    queryKey: reportKey("reports/diversity", f),
    queryFn: () => apiFetch<DiversityResponse>(`/api/analytics/reports/diversity?${filtersToQuery(f)}`),
    enabled: enabled && filtersReady(f),
  });
}

// Recruiter productivity is keyset-paginated.
export function useRecruiterProductivity(f: AnalyticsFilters, cursor: string | null) {
  return useQuery<PagedRowsResponse<RecruiterRow>, Error>({
    queryKey: ["analytics", "reports/recruiter-productivity", filtersToQuery(f), cursor],
    queryFn: () => {
      const p = new URLSearchParams(filtersToQuery(f));
      p.set("limit", "25");
      if (cursor) p.set("cursor", cursor);
      return apiFetch<PagedRowsResponse<RecruiterRow>>(
        `/api/analytics/reports/recruiter-productivity?${p.toString()}`,
      );
    },
    enabled: filtersReady(f),
  });
}

// Drill-down candidate list underlying a funnel bucket / source / recruiter cell.
export interface DrillParams {
  bucket?: string;
  source?: string;
  recruiterUserId?: string;
}
export function useDrillCandidates(
  f: AnalyticsFilters,
  drill: DrillParams | null,
  cursor: string | null,
) {
  return useQuery<PagedRowsResponse<DrillRow>, Error>({
    queryKey: ["analytics", "drill", filtersToQuery(f), drill, cursor],
    queryFn: () => {
      const p = new URLSearchParams(filtersToQuery(f));
      p.set("limit", "25");
      if (drill?.bucket) p.set("bucket", drill.bucket);
      if (drill?.source) p.set("source", drill.source);
      if (drill?.recruiterUserId) p.set("recruiterUserId", drill.recruiterUserId);
      if (cursor) p.set("cursor", cursor);
      return apiFetch<PagedRowsResponse<DrillRow>>(`/api/analytics/drill/candidates?${p.toString()}`);
    },
    enabled: !!drill && filtersReady(f),
  });
}

// Narrative summary — degrades to heuristic when OPENAI_API_KEY is unset.
export interface SummaryResponse {
  summary: string;
  ai: boolean;
}
export function useReportSummary() {
  return useMutation<SummaryResponse, Error, { reportKey: ReportKey; filters: AnalyticsFilters }>({
    mutationFn: ({ reportKey: key, filters }) =>
      apiFetch<SummaryResponse>(
        `/api/analytics/reports/${key}/summary?${filtersToQuery(filters)}`,
        { method: "POST", json: {} },
      ),
  });
}

// ---- export mutation ----
export interface ExportResult {
  jobId: string;
  status: string;
  rowCount: number | null;
}
function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function useExportReport() {
  return useMutation<
    ExportResult,
    Error,
    { reportKey: ReportKey; filters: AnalyticsFilters }
  >({
    mutationFn: ({ reportKey: key, filters }) =>
      apiFetch<ExportResult>(`/api/analytics/export`, {
        method: "POST",
        json: { reportKey: key, format: "csv", params: filtersToParams(filters) },
        headers: { "Idempotency-Key": idempotencyKey() },
      }),
  });
}

// The export endpoint re-parses `params` with the filter envelope, so send the
// same envelope shape the report GETs receive.
function filtersToParams(f: AnalyticsFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {
    range: f.range,
    compare: f.compare,
    granularity: f.granularity,
  };
  if (f.range === "custom") {
    if (f.from) out.from = f.from;
    if (f.to) out.to = f.to;
  }
  if (f.recruiterUserId) out.recruiterUserId = f.recruiterUserId;
  if (f.clientId) out.clientId = f.clientId;
  if (f.demandId) out.demandId = f.demandId;
  if (f.source) out.source = f.source;
  return out;
}

// ---- saved views ----
export interface SavedView {
  id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  is_shared: boolean;
  owner_user_id: string | null;
  updated_at: string;
}
export function useSavedViews(q?: string) {
  return useQuery<{ rows: SavedView[]; nextCursor: string | null }, Error>({
    queryKey: ["analytics", "views", q ?? ""],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set("limit", "50");
      if (q) p.set("q", q);
      return apiFetch<{ rows: SavedView[]; nextCursor: string | null }>(
        `/api/analytics/views?${p.toString()}`,
      );
    },
  });
}
export function useCreateView() {
  const qc = useQueryClient();
  return useMutation<
    SavedView,
    Error,
    { name: string; description?: string; config: Record<string, unknown>; isShared: boolean }
  >({
    mutationFn: (body) => apiFetch<SavedView>(`/api/analytics/views`, { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics", "views"] }),
  });
}
export function useArchiveView() {
  const qc = useQueryClient();
  return useMutation<SavedView, Error, string>({
    mutationFn: (id) => apiFetch<SavedView>(`/api/analytics/views/${id}/archive`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics", "views"] }),
  });
}

// ---- schedules ----
export const SCHEDULE_CADENCES = ["daily", "weekly", "monthly"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];
export interface ScheduledReport {
  id: string;
  savedViewId: string;
  name: string;
  format: string;
  cadence: string;
  recipients: string[];
  isEnabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}
export function useSchedules() {
  return useQuery<{ rows: ScheduledReport[]; nextCursor: string | null }, Error>({
    queryKey: ["analytics", "schedules"],
    queryFn: () => apiFetch(`/api/analytics/schedules?limit=50`),
  });
}
export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation<
    ScheduledReport,
    Error,
    {
      savedViewId: string;
      name: string;
      format: string;
      cadence: ScheduleCadence;
      recipients: string[];
    }
  >({
    mutationFn: (body) => apiFetch(`/api/analytics/schedules`, { method: "POST", json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics", "schedules"] }),
  });
}
export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/api/analytics/schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics", "schedules"] }),
  });
}
