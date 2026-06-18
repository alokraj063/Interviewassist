// URL <-> filter mapping for the Knowledge Base Sources tab.
import type { SourcesFilters, SourceSort } from "@/hooks/useKnowledge";

export type KbTab = "sources" | "collections" | "eval" | "feedback" | "analytics";
export const KB_TABS: KbTab[] = ["sources", "collections", "eval", "feedback", "analytics"];

export function tabFromParams(params: URLSearchParams): KbTab {
  const t = params.get("tab");
  return (KB_TABS as string[]).includes(t ?? "") ? (t as KbTab) : "sources";
}

export function sourceFiltersFromParams(params: URLSearchParams): SourcesFilters {
  const sort = params.get("sort");
  const dir = params.get("dir");
  return {
    collectionId: params.get("collectionId") ?? undefined,
    corpus: params.get("corpus") ?? undefined,
    status: params.get("status") ?? undefined,
    staleOnly: params.get("staleOnly") === "true" || undefined,
    q: params.get("q") ?? undefined,
    sort: (["created", "updated", "name", "retrievals"].includes(sort ?? "") ? sort : undefined) as
      | SourceSort
      | undefined,
    dir: (dir === "asc" || dir === "desc" ? dir : undefined) as "asc" | "desc" | undefined,
  };
}

export function activeSourceFilterCount(f: SourcesFilters): number {
  let n = 0;
  if (f.collectionId) n++;
  if (f.corpus) n++;
  if (f.status) n++;
  if (f.staleOnly) n++;
  return n;
}

export function clearSourceFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of ["collectionId", "corpus", "status", "staleOnly", "q", "cursor"]) next.delete(k);
  return next;
}

export const SOURCE_SORT_LABELS: Record<SourceSort, string> = {
  created: "Newest",
  updated: "Recently indexed",
  name: "Name",
  retrievals: "Most retrieved",
};
