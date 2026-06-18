// Auto-grading engine for objective assessment items. Pure functions over a
// pinned version snapshot's items + the candidate's responses. No external
// dependency — always real, never fabricated. Subjective items (short/long/
// file/video) are routed to the manual review queue (correct:null, autoGraded:
// false). Coding items grade via the code-exec sandbox when configured, else
// fall through to manual review.
//
// The version snapshot carries the answer keys (options[].correct, true_false
// correct, coding test cases). Candidate responses are keyed by itemId.

export interface SnapshotOption {
  id: string;
  label: string;
  correct: boolean;
}

export interface SnapshotTestCase {
  id: string;
  stdin?: string;
  expected: string;
  hidden?: boolean;
  weight?: number;
}

export interface SnapshotItem {
  id: string;
  type: string;
  prompt: string;
  points: number;
  negativePoints: number;
  partialCredit: boolean;
  required: boolean;
  config: {
    options?: SnapshotOption[];
    correct?: boolean; // true_false
    language?: string;
    testCases?: SnapshotTestCase[];
    timeoutMs?: number;
    [k: string]: unknown;
  };
}

export interface CandidateResponse {
  itemId: string;
  // unified shape: objective items use selectedOptionIds / boolValue; subjective
  // use textValue; coding uses codeValue.
  selectedOptionIds?: string[];
  boolValue?: boolean;
  textValue?: string;
  codeValue?: string;
}

export interface ItemResult {
  itemId: string;
  type: string;
  awarded: number;
  max: number;
  correct: boolean | null;
  autoGraded: boolean;
  selectedOptionIds?: string[];
  codeRun?: { passed: number; total: number; stderr?: string };
}

export interface GradeOutcome {
  itemResults: ItemResult[];
  autoScore: number; // sum of machine-graded awarded points
  manualPending: number; // count of items awaiting human review
  maxScore: number; // sum of all item.points
}

const AUTO_GRADABLE = new Set(["mcq_single", "mcq_multi", "true_false"]);

/** Clamp a number into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Grade objective items synchronously. Coding items get a placeholder result
 * (correct:null, autoGraded:false) here; the caller may run codeExec.ts and
 * patch the codeRun + awarded afterwards, or leave them for manual review when
 * the sandbox is unconfigured.
 */
export function gradeObjective(
  items: SnapshotItem[],
  responses: CandidateResponse[],
): GradeOutcome {
  const byItem = new Map(responses.map((r) => [r.itemId, r]));
  const itemResults: ItemResult[] = [];
  let autoScore = 0;
  let manualPending = 0;
  let maxScore = 0;

  for (const item of items) {
    const max = item.points ?? 0;
    maxScore += max;
    const resp = byItem.get(item.id);

    if (AUTO_GRADABLE.has(item.type)) {
      const r = gradeAutoItem(item, resp);
      autoScore += r.awarded;
      itemResults.push(r);
    } else if (item.type === "coding") {
      // Coding is auto-gradable but needs the sandbox; defer to codeExec.
      // Placeholder until the sandbox runs (or stays manual if unconfigured).
      itemResults.push({
        itemId: item.id,
        type: item.type,
        awarded: 0,
        max,
        correct: null,
        autoGraded: false,
        codeRun: undefined,
      });
      manualPending += 1;
    } else {
      // Subjective: short_answer / long_answer / file_upload / video_response.
      itemResults.push({
        itemId: item.id,
        type: item.type,
        awarded: 0,
        max,
        correct: null,
        autoGraded: false,
      });
      manualPending += 1;
    }
  }

  return { itemResults, autoScore, manualPending, maxScore };
}

function gradeAutoItem(item: SnapshotItem, resp: CandidateResponse | undefined): ItemResult {
  const max = item.points ?? 0;
  const neg = item.negativePoints ?? 0;

  if (item.type === "true_false") {
    const correctVal = item.config.correct === true;
    const given = resp?.boolValue;
    const answered = given !== undefined;
    const isCorrect = answered && given === correctVal;
    // correct → full points; wrong explicit answer → -neg; unanswered → 0.
    const awarded = isCorrect ? max : answered ? -Math.min(neg, max) : 0;
    return {
      itemId: item.id,
      type: item.type,
      awarded: Math.max(awarded, -neg),
      max,
      correct: answered ? isCorrect : false,
      autoGraded: true,
      selectedOptionIds: [],
    };
  }

  // mcq_single / mcq_multi
  const options = item.config.options ?? [];
  const correctIds = new Set(options.filter((o) => o.correct).map((o) => o.id));
  const selected = new Set(resp?.selectedOptionIds ?? []);
  const selectedArr = [...selected];

  if (item.type === "mcq_single") {
    // exactly one selection; correct iff it equals the single correct option.
    const isCorrect =
      selected.size === 1 && [...selected].every((id) => correctIds.has(id));
    let awarded = isCorrect ? max : 0;
    if (!isCorrect && selected.size > 0) awarded = -Math.min(neg, max); // negative marking on wrong pick
    awarded = Math.max(awarded, -neg);
    return {
      itemId: item.id,
      type: item.type,
      awarded,
      max,
      correct: isCorrect,
      autoGraded: true,
      selectedOptionIds: selectedArr,
    };
  }

  // mcq_multi
  const correctSelected = selectedArr.filter((id) => correctIds.has(id)).length;
  const wrongSelected = selectedArr.filter((id) => !correctIds.has(id)).length;
  const totalCorrect = correctIds.size || 1;
  const exact =
    correctSelected === correctIds.size && wrongSelected === 0;

  let awarded: number;
  if (item.partialCredit) {
    // Jaccard-style partial: fraction of correct picked minus penalty for wrong.
    const frac = correctSelected / totalCorrect;
    awarded = frac * max - wrongSelected * neg;
    awarded = clamp(awarded, -neg, max);
  } else {
    awarded = exact ? max : selectedArr.length > 0 ? -Math.min(neg, max) : 0;
    awarded = Math.max(awarded, -neg);
  }
  return {
    itemId: item.id,
    type: item.type,
    awarded: Math.round(awarded * 100) / 100,
    max,
    correct: exact,
    autoGraded: true,
    selectedOptionIds: selectedArr,
  };
}

/**
 * Compute total + pass given the item results, the template settings, and the
 * pass threshold. Returns score percent (0-100), pass boolean, and the matched
 * pass band label (if bands configured).
 */
export function computeTotals(
  itemResults: ItemResult[],
  passScore: number,
  passBands: Array<{ label: string; minPercent: number }> = [],
): { autoScore: number; maxScore: number; percent: number; pass: boolean; passBand: string | null } {
  const autoScore = itemResults.reduce((s, r) => s + r.awarded, 0);
  const maxScore = itemResults.reduce((s, r) => s + r.max, 0);
  const percent = maxScore > 0 ? Math.round(clamp((autoScore / maxScore) * 100, 0, 100)) : 0;
  const pass = percent >= passScore;
  // Pass band = highest band whose minPercent <= percent.
  let passBand: string | null = null;
  const sorted = [...passBands].sort((a, b) => b.minPercent - a.minPercent);
  for (const b of sorted) {
    if (percent >= b.minPercent) {
      passBand = b.label;
      break;
    }
  }
  return { autoScore: Math.round(autoScore * 100) / 100, maxScore, percent, pass, passBand };
}
