// URL <-> filter-envelope serialization for the Analytics dashboard. The URL is
// the single source of truth (shareable/bookmarkable); this module is the only
// place that maps between `useSearchParams` and the typed AnalyticsFilters.
import {
  RANGE_TOKENS,
  GRANULARITIES,
  type AnalyticsFilters,
  type RangeToken,
  type Granularity,
} from "@/hooks/useAnalyticsReports";

export const ANALYTICS_TABS = [
  "funnel",
  "velocity",
  "sources",
  "quality",
  "voice",
  "recruiters",
  "trends",
  "diversity",
] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export const TAB_LABELS: Record<AnalyticsTab, string> = {
  funnel: "Funnel",
  velocity: "Velocity",
  sources: "Sources",
  quality: "Quality",
  voice: "Voice",
  recruiters: "Recruiters",
  trends: "Trends",
  diversity: "Diversity",
};

export function filtersFromParams(params: URLSearchParams): AnalyticsFilters {
  const rawRange = params.get("range");
  const range: RangeToken = (RANGE_TOKENS as readonly string[]).includes(rawRange ?? "")
    ? (rawRange as RangeToken)
    : "last_30d";
  const rawGran = params.get("granularity");
  const granularity: Granularity = (GRANULARITIES as readonly string[]).includes(rawGran ?? "")
    ? (rawGran as Granularity)
    : "day";
  return {
    range,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    compare: params.get("compare") === "1" || params.get("compare") === "true",
    granularity,
    recruiterUserId: params.get("recruiterUserId") ?? undefined,
    clientId: params.get("clientId") ?? undefined,
    demandId: params.get("demandId") ?? undefined,
    source: params.get("source") ?? undefined,
  };
}

export function tabFromParams(params: URLSearchParams): AnalyticsTab {
  const t = params.get("tab");
  return (ANALYTICS_TABS as readonly string[]).includes(t ?? "") ? (t as AnalyticsTab) : "funnel";
}

// True when any segment filter is set (used to distinguish first-run-empty from
// filtered-to-zero).
export function hasActiveSegments(f: AnalyticsFilters): boolean {
  return Boolean(f.recruiterUserId || f.clientId || f.demandId || f.source);
}

export function activeSegmentCount(f: AnalyticsFilters): number {
  return [f.recruiterUserId, f.clientId, f.demandId, f.source].filter(Boolean).length;
}
