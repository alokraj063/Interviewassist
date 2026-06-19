// URL <-> question-filter state (de)serialization for the bank-detail table.
// Keeps the question list shareable/bookmarkable. The cursor is NOT stored in
// the URL (it is ephemeral keyset state owned by the infinite query).

import type { QuestionFilters } from "@/hooks/useQuestionBanks";

export const QUESTION_SORTS = [
  "created_desc",
  "created_asc",
  "difficulty_desc",
  "exposure_desc",
  "calibrated_desc",
  "last_used_desc",
] as const;
export type QuestionSort = (typeof QUESTION_SORTS)[number];

export const SORT_LABELS: Record<QuestionSort, string> = {
  created_desc: "Newest first",
  created_asc: "Oldest first",
  difficulty_desc: "Hardest first",
  exposure_desc: "Most used first",
  calibrated_desc: "Highest p-value first",
  last_used_desc: "Recently used first",
};

// Keys that live in the URL. `cursor`/`limit` are intentionally excluded.
const FILTER_KEYS = [
  "status",
  "skillId",
  "level",
  "difficultyMin",
  "difficultyMax",
  "language",
  "roleFamily",
  "questionType",
  "q",
  "sort",
] as const;

export type UrlFilterKey = (typeof FILTER_KEYS)[number];

export function filtersFromParams(sp: URLSearchParams): QuestionFilters {
  const out: QuestionFilters = {};
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v !== null && v !== "") (out as Record<string, string>)[k] = v;
  }
  return out;
}

// Count of *active* filters (excludes the always-present sort).
export function activeFilterCount(f: QuestionFilters): number {
  return FILTER_KEYS.filter(
    (k) => k !== "sort" && (f as Record<string, string | undefined>)[k],
  ).length;
}

export function setParam(
  sp: URLSearchParams,
  key: UrlFilterKey,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (value === undefined || value === "") next.delete(key);
  else next.set(key, value);
  return next;
}

export function clearFilters(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const k of FILTER_KEYS) if (k !== "sort") next.delete(k);
  next.delete("q");
  return next;
}
