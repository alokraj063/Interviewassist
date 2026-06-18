// Candidate source enum mirrored for the SPA (matches CANDIDATE_SOURCES in
// packages/db/src/schema.ts). Kept here so the web bundle doesn't import the
// server schema module.
export const CANDIDATE_SOURCES = [
  "naukri",
  "linkedin",
  "referral",
  "direct",
  "internal_db",
  "imported",
  "other",
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
