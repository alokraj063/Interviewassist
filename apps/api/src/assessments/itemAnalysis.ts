// Item analysis — the B1 differentiator. Computes psychometric stats over a
// cohort of graded attempts for an assessment template:
//   - p-value (difficulty): mean(awarded/max) per item across attempts.
//   - discrimination (point-biserial): correlation between per-item correctness
//     and the attempt total; items < 0.1 are flagged "review" (poor signal).
//   - distractor analysis (MCQ): selection counts per option id, so a mis-keyed
//     option chosen by high scorers is visible.
//   - cohort distribution: 10-bucket histogram of total percent + pass-rate +
//     pass-band breakdown.
// Pure functions over the persisted itemResults — no external dependency.

export interface AttemptForAnalysis {
  id: string;
  totalPercent: number; // 0..100
  pass: boolean | null;
  passBand: string | null;
  itemResults: Array<{
    itemId: string;
    type: string;
    awarded: number;
    max: number;
    correct: boolean | null;
    selectedOptionIds?: string[];
  }>;
}

export interface ItemStat {
  itemId: string;
  type: string;
  prompt: string;
  n: number; // attempts that included this item
  pValue: number | null; // mean awarded/max, 0..1 (difficulty; higher = easier)
  discrimination: number | null; // point-biserial, -1..1
  flagged: boolean; // discrimination < 0.1 → review
  distractors: Array<{ optionId: string; label: string; correct: boolean; count: number }>;
}

export interface CohortDistribution {
  buckets: Array<{ from: number; to: number; count: number }>;
  passRate: number | null; // fraction 0..1, null if no pass info
  passBandBreakdown: Array<{ band: string; count: number }>;
  meanPercent: number | null;
  attemptCount: number;
}

export interface ItemAnalysisResult {
  asOf: string;
  attemptCount: number;
  distribution: CohortDistribution;
  items: ItemStat[];
}

interface SnapshotItemLite {
  id: string;
  type: string;
  prompt: string;
  config?: { options?: Array<{ id: string; label: string; correct: boolean }> };
}

/** Pearson correlation between two equal-length numeric arrays. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const denom = Math.sqrt(dx * dy);
  if (denom === 0) return null;
  return num / denom;
}

export function computeCohortDistribution(attempts: AttemptForAnalysis[]): CohortDistribution {
  const buckets = Array.from({ length: 10 }, (_, i) => ({
    from: i * 10,
    to: i * 10 + 10,
    count: 0,
  }));
  let passYes = 0;
  let passKnown = 0;
  let sum = 0;
  const bandCounts = new Map<string, number>();
  for (const a of attempts) {
    const pct = Math.max(0, Math.min(100, a.totalPercent));
    const idx = Math.min(9, Math.floor(pct / 10));
    buckets[idx].count += 1;
    sum += pct;
    if (a.pass !== null) {
      passKnown += 1;
      if (a.pass) passYes += 1;
    }
    if (a.passBand) bandCounts.set(a.passBand, (bandCounts.get(a.passBand) ?? 0) + 1);
  }
  return {
    buckets,
    passRate: passKnown > 0 ? passYes / passKnown : null,
    passBandBreakdown: [...bandCounts.entries()].map(([band, count]) => ({ band, count })),
    meanPercent: attempts.length > 0 ? Math.round((sum / attempts.length) * 10) / 10 : null,
    attemptCount: attempts.length,
  };
}

export function computeItemAnalysis(
  attempts: AttemptForAnalysis[],
  snapshotItems: SnapshotItemLite[],
): ItemAnalysisResult {
  const itemMap = new Map(snapshotItems.map((it) => [it.id, it]));
  const distribution = computeCohortDistribution(attempts);

  // Per-item collectors.
  const collectors = new Map<
    string,
    {
      fractions: number[]; // awarded/max per attempt
      attemptTotals: number[]; // attempt total percent aligned with fractions
      correctFlags: number[]; // 1 if correct (or awarded==max), 0 else
      distractorCounts: Map<string, number>;
    }
  >();

  for (const att of attempts) {
    for (const r of att.itemResults) {
      if (!itemMap.has(r.itemId)) continue;
      let c = collectors.get(r.itemId);
      if (!c) {
        c = { fractions: [], attemptTotals: [], correctFlags: [], distractorCounts: new Map() };
        collectors.set(r.itemId, c);
      }
      const frac = r.max > 0 ? Math.max(0, Math.min(1, r.awarded / r.max)) : 0;
      c.fractions.push(frac);
      c.attemptTotals.push(att.totalPercent);
      const isCorrect = r.correct === true || (r.correct === null && r.max > 0 && r.awarded >= r.max);
      c.correctFlags.push(isCorrect ? 1 : 0);
      for (const oid of r.selectedOptionIds ?? []) {
        c.distractorCounts.set(oid, (c.distractorCounts.get(oid) ?? 0) + 1);
      }
    }
  }

  const items: ItemStat[] = [];
  for (const snap of snapshotItems) {
    const c = collectors.get(snap.id);
    const n = c?.fractions.length ?? 0;
    const pValue = n > 0 ? Math.round((c!.fractions.reduce((a, b) => a + b, 0) / n) * 1000) / 1000 : null;
    const discrimination = c ? round3(pearson(c.correctFlags, c.attemptTotals)) : null;
    const options = snap.config?.options ?? [];
    const distractors = options.map((o) => ({
      optionId: o.id,
      label: o.label,
      correct: o.correct,
      count: c?.distractorCounts.get(o.id) ?? 0,
    }));
    items.push({
      itemId: snap.id,
      type: snap.type,
      prompt: snap.prompt,
      n,
      pValue,
      discrimination,
      flagged: discrimination !== null && discrimination < 0.1,
      distractors,
    });
  }

  return {
    asOf: new Date().toISOString(),
    attemptCount: attempts.length,
    distribution,
    items,
  };
}

function round3(v: number | null): number | null {
  return v === null ? null : Math.round(v * 1000) / 1000;
}
