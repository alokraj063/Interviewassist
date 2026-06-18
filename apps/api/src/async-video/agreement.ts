// Inter-rater agreement for Async Video submissions.
//
// Given the submitted scorecards for one submission, compute:
//  - per-question score spread (min/max/mean across reviewers)
//  - the overall-score delta between the highest and lowest reviewer
//  - a normalized agreement metric in [0,1] derived from mean pairwise absolute
//    difference of per-question scores (1 = perfect agreement, 0 = max spread).
//
// This drives the "agreement / delta" panel the B2 PASS gate requires. It is a
// pure function over already-fetched rows (no DB access), so it's trivially
// unit-testable and used by both the queue (counts) and the review cockpit.

export interface ScorecardForAgreement {
  reviewerLabel: string;
  overallScore: number | null;
  questionScores: Array<{ questionId: string; score: number }>;
}

export interface PerQuestionAgreement {
  questionId: string;
  min: number;
  max: number;
  mean: number;
  spread: number; // max - min
  count: number;
}

export interface AgreementResult {
  reviewerCount: number;
  overallDelta: number | null; // max overall - min overall across reviewers
  overallMean: number | null;
  agreement: number | null; // [0,1]; null when <2 reviewers
  perQuestion: PerQuestionAgreement[];
}

const MAX_PER_Q = 5; // per-question scores are 0..5

export function computeAgreement(cards: ScorecardForAgreement[]): AgreementResult {
  const reviewerCount = cards.length;

  // Overall delta + mean.
  const overalls = cards
    .map((c) => c.overallScore)
    .filter((v): v is number => typeof v === "number");
  const overallDelta =
    overalls.length >= 2 ? Math.max(...overalls) - Math.min(...overalls) : null;
  const overallMean =
    overalls.length > 0 ? overalls.reduce((a, b) => a + b, 0) / overalls.length : null;

  // Group scores by question.
  const byQuestion = new Map<string, number[]>();
  for (const card of cards) {
    for (const qs of card.questionScores) {
      const arr = byQuestion.get(qs.questionId) ?? [];
      arr.push(qs.score);
      byQuestion.set(qs.questionId, arr);
    }
  }

  const perQuestion: PerQuestionAgreement[] = [];
  const normalizedDiffs: number[] = [];
  for (const [questionId, scores] of byQuestion) {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    perQuestion.push({ questionId, min, max, mean, spread: max - min, count: scores.length });

    // Mean pairwise absolute difference, normalized by the max possible (MAX_PER_Q).
    if (scores.length >= 2) {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < scores.length; i++) {
        for (let j = i + 1; j < scores.length; j++) {
          sum += Math.abs(scores[i] - scores[j]);
          pairs += 1;
        }
      }
      if (pairs > 0) normalizedDiffs.push(sum / pairs / MAX_PER_Q);
    }
  }

  // agreement = 1 - mean(normalized pairwise diff). Null when <2 reviewers
  // contributed comparable per-question scores.
  const agreement =
    reviewerCount >= 2 && normalizedDiffs.length > 0
      ? Math.max(0, Math.min(1, 1 - normalizedDiffs.reduce((a, b) => a + b, 0) / normalizedDiffs.length))
      : null;

  perQuestion.sort((a, b) => a.questionId.localeCompare(b.questionId));

  return { reviewerCount, overallDelta, overallMean, agreement, perQuestion };
}

/**
 * Normalize a set of per-question 0..5 scores into an overall 0..100, given the
 * questions in the campaign (uniform weighting). Returns null when there are no
 * scored questions.
 */
export function computeOverallScore(
  questionScores: Array<{ score: number }>,
): number | null {
  if (questionScores.length === 0) return null;
  const mean =
    questionScores.reduce((a, b) => a + b.score, 0) / questionScores.length;
  return Math.round((mean / MAX_PER_Q) * 100 * 10) / 10;
}
