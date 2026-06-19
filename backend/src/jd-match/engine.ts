// JD-match engine v1.
//
// Inputs: a candidate row (+ skills) and a demand row (+ required skills,
// salary band, locations, experience band, notice expectation).
// Output: a persisted jd_match_runs row + the structured shape the
// CandidateDetail JD-Match tab and CallDetail JD-Match tab consume.
//
// Strategy: rule-based scoring across six dimensions (must-have skills,
// nice-to-have skills, experience, compensation, location, notice
// period), weighted by configurable weights, bucketed into a verdict.
// No LLM call in v1 — the rules cover the load-bearing 80%. v2 can
// add a semantic similarity dimension (pgvector cosine on candidate
// resume embedding vs demand JD embedding) and an LLM rationale pass.
import { and, eq, inArray } from "drizzle-orm";
import {
  candidates,
  candidateSkills,
  db,
  demands,
  demandLocations,
  demandSkills,
  jdMatchRuns,
  locations as locationsTable,
  skills as skillsTable,
  type JdMatchVerdict,
} from "@j2w/db";

const ENGINE_VERSION = "jd-match-rule-v1";

interface SkillRef {
  id: string;
  name: string;
  isMandatory?: boolean;
  weight?: number;
  yearsOfExperience?: number | null;
  proficiencyLevel?: number | null;
}

interface DimensionScore {
  score: number; // 0..100
  details: Record<string, unknown>;
}

interface MatchRunResult {
  id: string;
  demandId: string;
  candidateId: string;
  overallScore: number;
  verdict: JdMatchVerdict;
  mustHavesScore: number | null;
  niceToHavesScore: number | null;
  experienceFitScore: number | null;
  compensationFitScore: number | null;
  locationFitScore: number | null;
  noticePeriodFitScore: number | null;
  strengths: Array<{ kind: string; label: string; detail?: string }>;
  gaps: Array<{ kind: string; label: string; detail?: string }>;
  explanation: Array<{ dimension: string; score: number; note: string }>;
  modelVersion: string;
}

// --- helpers --------------------------------------------------------------

function asNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

// --- per-dimension scorers ------------------------------------------------

function scoreSkills(
  candidateSkillsList: SkillRef[],
  demandSkillsList: SkillRef[],
): { mustHaves: DimensionScore | null; niceToHaves: DimensionScore | null } {
  const candidateSet = new Map(
    candidateSkillsList.map((s) => [s.name.toLowerCase(), s]),
  );

  const must = demandSkillsList.filter((s) => s.isMandatory);
  const nice = demandSkillsList.filter((s) => !s.isMandatory);

  function scoreList(list: SkillRef[]): DimensionScore | null {
    if (list.length === 0) return null;
    const matched: string[] = [];
    const missing: string[] = [];
    for (const skill of list) {
      const hit = candidateSet.get(skill.name.toLowerCase());
      if (hit) matched.push(skill.name);
      else missing.push(skill.name);
    }
    return {
      score: clamp((matched.length / list.length) * 100),
      details: { matched, missing, total: list.length },
    };
  }

  return {
    mustHaves: scoreList(must),
    niceToHaves: scoreList(nice),
  };
}

function scoreExperience(
  candidateYears: number | null,
  demandMin: number | null,
  demandMax: number | null,
): DimensionScore | null {
  if (candidateYears == null) return null;
  if (demandMin == null && demandMax == null) return null;
  const lo = demandMin ?? 0;
  const hi = demandMax ?? Number.POSITIVE_INFINITY;

  let score = 100;
  let note = "Within range";
  if (candidateYears < lo) {
    const gap = lo - candidateYears;
    score = clamp(100 - gap * 25); // -25 per year short
    note = `${gap.toFixed(1)}y under min (${lo}y)`;
  } else if (Number.isFinite(hi) && candidateYears > hi) {
    const over = candidateYears - hi;
    score = clamp(100 - over * 12); // overqualified, softer penalty
    note = `${over.toFixed(1)}y over max (${hi}y)`;
  }
  return {
    score,
    details: { candidateYears, demandMin: lo, demandMax: Number.isFinite(hi) ? hi : null, note },
  };
}

function scoreCompensation(
  candidateExpected: number | null,
  demandFrom: number | null,
  demandTo: number | null,
): DimensionScore | null {
  if (candidateExpected == null) return null;
  if (demandFrom == null && demandTo == null) return null;
  const lo = demandFrom ?? 0;
  const hi = demandTo ?? Number.POSITIVE_INFINITY;

  if (candidateExpected <= hi && candidateExpected >= lo) {
    return {
      score: 100,
      details: { candidateExpected, demandFrom: lo, demandTo: Number.isFinite(hi) ? hi : null, note: "in band" },
    };
  }
  // Out-of-band: scale down. Above-band penalises harder than below-band
  // because too-cheap candidates may signal level mismatch but aren't a
  // budget blocker.
  if (Number.isFinite(hi) && candidateExpected > hi) {
    const overPct = (candidateExpected - hi) / Math.max(1, hi);
    return {
      score: clamp(100 - overPct * 100),
      details: {
        candidateExpected,
        demandTo: hi,
        note: `${(overPct * 100).toFixed(0)}% over band`,
      },
    };
  }
  // Below band
  const underPct = (lo - candidateExpected) / Math.max(1, lo);
  return {
    score: clamp(100 - underPct * 50),
    details: {
      candidateExpected,
      demandFrom: lo,
      note: `${(underPct * 100).toFixed(0)}% under band`,
    },
  };
}

function scoreLocation(
  candidateLocation: string | null,
  candidatePreferred: string[],
  candidateWillingToRelocate: boolean | null,
  demandPrimary: string | null,
  demandLocationNames: string[],
): DimensionScore | null {
  const acceptableDemand = new Set(
    [demandPrimary, ...demandLocationNames]
      .filter((s): s is string => !!s)
      .map((s) => s.toLowerCase()),
  );
  if (acceptableDemand.size === 0) return null;

  const candNorm = (candidateLocation ?? "").toLowerCase().trim();
  const candPrefNorm = candidatePreferred
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);

  if (candNorm && acceptableDemand.has(candNorm)) {
    return { score: 100, details: { match: "current_location", value: candidateLocation } };
  }
  for (const p of candPrefNorm) {
    if (acceptableDemand.has(p)) {
      return { score: 90, details: { match: "preferred_location", value: p } };
    }
  }
  if (candidateWillingToRelocate) {
    return { score: 65, details: { match: "willing_to_relocate" } };
  }
  return {
    score: 25,
    details: {
      match: "none",
      candidateLocation,
      acceptable: Array.from(acceptableDemand),
    },
  };
}

function scoreNoticePeriod(
  candidateDays: number | null,
  candidateNegotiable: boolean | null,
): DimensionScore | null {
  if (candidateDays == null) return null;
  if (candidateDays === 0) return { score: 100, details: { note: "immediate" } };
  if (candidateDays <= 30) return { score: 95, details: { note: "≤30d" } };
  if (candidateDays <= 60) return { score: 80, details: { note: "31-60d" } };
  if (candidateDays <= 90) {
    return {
      score: candidateNegotiable ? 70 : 55,
      details: { note: "61-90d", negotiable: !!candidateNegotiable },
    };
  }
  return {
    score: candidateNegotiable ? 50 : 30,
    details: { note: ">90d", negotiable: !!candidateNegotiable },
  };
}

// --- composite scoring + verdict -----------------------------------------

const WEIGHTS = {
  mustHaves: 0.35,
  niceToHaves: 0.1,
  experience: 0.15,
  compensation: 0.15,
  location: 0.15,
  notice: 0.1,
};

function bucketVerdict(overall: number): JdMatchVerdict {
  if (overall >= 80) return "strong_match";
  if (overall >= 60) return "partial_match";
  if (overall >= 40) return "weak_match";
  return "no_match";
}

// --- main engine entrypoint ---------------------------------------------

export interface RunMatchOptions {
  candidateId: string;
  demandId: string;
  triggeredBy?: "manual" | "submission" | "post_call" | "batch";
  triggeredByUserId?: string | null;
}

export async function runJdMatch(
  opts: RunMatchOptions,
): Promise<MatchRunResult> {
  // 1) Gather inputs.
  const [cand] = await db
    .select()
    .from(candidates)
    .where(eq(candidates.id, opts.candidateId))
    .limit(1);
  if (!cand) throw new Error(`candidate ${opts.candidateId} not found`);

  const [demand] = await db
    .select()
    .from(demands)
    .where(eq(demands.id, opts.demandId))
    .limit(1);
  if (!demand) throw new Error(`demand ${opts.demandId} not found`);

  const candSkillRows = await db
    .select({
      skillId: candidateSkills.skillId,
      yearsOfExperience: candidateSkills.yearsOfExperience,
      proficiencyLevel: candidateSkills.proficiencyLevel,
      name: skillsTable.name,
    })
    .from(candidateSkills)
    .leftJoin(skillsTable, eq(skillsTable.id, candidateSkills.skillId))
    .where(eq(candidateSkills.candidateId, opts.candidateId));

  const demandSkillRows = await db
    .select({
      skillId: demandSkills.skillId,
      isMandatory: demandSkills.isMandatory,
      weight: demandSkills.weight,
      name: skillsTable.name,
    })
    .from(demandSkills)
    .leftJoin(skillsTable, eq(skillsTable.id, demandSkills.skillId))
    .where(eq(demandSkills.demandId, opts.demandId));

  const demandLocationRows = await db
    .select({ city: locationsTable.city, state: locationsTable.state })
    .from(demandLocations)
    .leftJoin(locationsTable, eq(locationsTable.id, demandLocations.locationId))
    .where(eq(demandLocations.demandId, opts.demandId));
  void inArray; // silence unused-import if the inArray helper isn't needed below

  const candSkillsList: SkillRef[] = candSkillRows
    .filter((r) => r.name)
    .map((r) => ({
      id: r.skillId,
      name: r.name as string,
      yearsOfExperience: asNumber(r.yearsOfExperience as unknown as string | number | null),
      proficiencyLevel: r.proficiencyLevel,
    }));

  const demandSkillsList: SkillRef[] = demandSkillRows
    .filter((r) => r.name)
    .map((r) => ({
      id: r.skillId,
      name: r.name as string,
      isMandatory: r.isMandatory,
      weight: asNumber(r.weight as unknown as string | number) ?? 1,
    }));

  // 2) Score each dimension.
  const skillsScored = scoreSkills(candSkillsList, demandSkillsList);
  const experience = scoreExperience(
    asNumber(cand.totalExperienceYears as unknown as string | number | null),
    asNumber(demand.experienceMinYears as unknown as string | number | null),
    asNumber(demand.experienceMaxYears as unknown as string | number | null),
  );
  const compensation = scoreCompensation(
    asNumber(cand.expectedCtcLakhs as unknown as string | number | null),
    asNumber(demand.salaryFrom as unknown as string | number | null),
    asNumber(demand.salaryTo as unknown as string | number | null),
  );
  const location = scoreLocation(
    cand.currentLocation,
    cand.preferredLocations ?? [],
    null, // candidates table has no willingToRelocate column today
    demand.primaryLocation,
    demandLocationRows
      .map((r) => (r.city ? (r.state ? `${r.city}, ${r.state}` : r.city) : null))
      .filter((n): n is string => !!n),
  );
  const notice = scoreNoticePeriod(cand.noticePeriodDays, cand.noticePeriodNegotiable);

  // 3) Composite weighted score.
  type DimEntry = {
    key: keyof typeof WEIGHTS;
    score: DimensionScore | null;
    label: string;
  };
  const dims: DimEntry[] = [
    { key: "mustHaves", score: skillsScored.mustHaves, label: "Must-have skills" },
    { key: "niceToHaves", score: skillsScored.niceToHaves, label: "Nice-to-have skills" },
    { key: "experience", score: experience, label: "Experience" },
    { key: "compensation", score: compensation, label: "Compensation" },
    { key: "location", score: location, label: "Location" },
    { key: "notice", score: notice, label: "Notice period" },
  ];

  let totalWeight = 0;
  let weighted = 0;
  for (const d of dims) {
    if (d.score == null) continue;
    const w = WEIGHTS[d.key];
    totalWeight += w;
    weighted += d.score.score * w;
  }
  const overall = totalWeight > 0 ? weighted / totalWeight : 0;
  const verdict = bucketVerdict(overall);

  // 4) Build strengths / gaps / explanation.
  const strengths: Array<{ kind: string; label: string; detail?: string }> = [];
  const gaps: Array<{ kind: string; label: string; detail?: string }> = [];
  const explanation: Array<{ dimension: string; score: number; note: string }> = [];
  for (const d of dims) {
    if (d.score == null) continue;
    explanation.push({
      dimension: d.label,
      score: Math.round(d.score.score),
      note: typeof d.score.details.note === "string" ? d.score.details.note : "",
    });
    if (d.score.score >= 80) {
      strengths.push({ kind: d.key, label: d.label, detail: JSON.stringify(d.score.details) });
    } else if (d.score.score < 50) {
      gaps.push({ kind: d.key, label: d.label, detail: JSON.stringify(d.score.details) });
    }
  }

  // 5) Persist.
  const [row] = await db
    .insert(jdMatchRuns)
    .values({
      demandId: opts.demandId,
      candidateId: opts.candidateId,
      triggeredBy: opts.triggeredBy ?? "manual",
      triggeredByUserId: opts.triggeredByUserId ?? null,
      modelVersion: ENGINE_VERSION,
      overallScore: String(Math.round(overall * 100) / 100),
      mustHavesScore: skillsScored.mustHaves
        ? String(Math.round(skillsScored.mustHaves.score))
        : null,
      niceToHavesScore: skillsScored.niceToHaves
        ? String(Math.round(skillsScored.niceToHaves.score))
        : null,
      experienceFitScore: experience ? String(Math.round(experience.score)) : null,
      compensationFitScore: compensation ? String(Math.round(compensation.score)) : null,
      locationFitScore: location ? String(Math.round(location.score)) : null,
      noticePeriodFitScore: notice ? String(Math.round(notice.score)) : null,
      semanticScore: null,
      explanation,
      gaps,
      strengths,
      verdict,
    })
    .returning();

  return {
    id: row.id,
    demandId: row.demandId,
    candidateId: row.candidateId,
    overallScore: Math.round(overall * 100) / 100,
    verdict,
    mustHavesScore: skillsScored.mustHaves ? Math.round(skillsScored.mustHaves.score) : null,
    niceToHavesScore: skillsScored.niceToHaves ? Math.round(skillsScored.niceToHaves.score) : null,
    experienceFitScore: experience ? Math.round(experience.score) : null,
    compensationFitScore: compensation ? Math.round(compensation.score) : null,
    locationFitScore: location ? Math.round(location.score) : null,
    noticePeriodFitScore: notice ? Math.round(notice.score) : null,
    strengths,
    gaps,
    explanation,
    modelVersion: ENGINE_VERSION,
  };
}

// Convenience: run for a candidate against every open demand in the org.
export async function runJdMatchAgainstOpenDemands(opts: {
  candidateId: string;
  orgId: string;
  triggeredBy?: "manual" | "submission" | "post_call" | "batch";
  triggeredByUserId?: string | null;
  limit?: number;
}): Promise<MatchRunResult[]> {
  const openDemands = await db
    .select({ id: demands.id })
    .from(demands)
    .where(and(eq(demands.orgId, opts.orgId), eq(demands.status, "active")))
    .limit(opts.limit ?? 25);
  const results: MatchRunResult[] = [];
  for (const d of openDemands) {
    const r = await runJdMatch({
      candidateId: opts.candidateId,
      demandId: d.id,
      triggeredBy: opts.triggeredBy ?? "batch",
      triggeredByUserId: opts.triggeredByUserId,
    });
    results.push(r);
  }
  return results;
}
