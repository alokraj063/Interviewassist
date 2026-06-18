// prospect_outcome_extract worker.
//
// Post-call: read the call_summary that already ran for this call, map its
// discoveredFacts onto the linked prospect row, derive an interestLevel
// from the recruiter's notes + summary signals, and stamp lastContactedAt.
//
// Decoupled from call_summary so a missing summary doesn't crash the
// chain; if the summary isn't there yet, we no-op and rely on a later
// retry. Idempotent — re-running on the same call overwrites.
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { callSessions, db, prospects } from "@j2w/db";
import type { ProspectOutcomeExtractJob } from "@j2w/ingest-shared";

interface ExtractResult {
  skipped: boolean;
  reason?: string;
  prospectId?: string;
  interestLevel?: number;
}

interface DiscoveredFacts {
  currentCompany: string | null;
  currentTitle: string | null;
  totalExperienceYears: number | null;
  currentCtcLakhs: number | null;
  expectedCtcLakhs: number | null;
  noticePeriodDays: number | null;
  noticePeriodNegotiable: boolean | null;
  currentLocation: string | null;
  willingToRelocate: boolean | null;
  reasonForChange: string | null;
}

interface CallSummaryShape {
  overview: string;
  discoveredFacts: DiscoveredFacts;
  unaddressedItems: string[];
  nextStep: string;
  recruiterNotes: string;
}

/**
 * Heuristic interest score from the structured summary signals. Intentionally
 * conservative — recruiter UI will treat the value as a hint, not a verdict.
 *
 *   5 — strong interest: nextStep mentions schedule/L1/round, not a "drop"
 *   4 — moving forward signals: discoveryFacts mostly filled, nextStep ≠ "drop"
 *   3 — neutral / partial discovery
 *   2 — weak signals: nextStep mentions "drop"/"not a fit"/"pass"/"reject"
 *   1 — explicit no-go: drop + low expected CTC delta + reason indicates fit issue
 */
function deriveInterestLevel(summary: CallSummaryShape): number {
  const nextStepLc = (summary.nextStep || "").toLowerCase();
  const notesLc = (summary.recruiterNotes || "").toLowerCase();
  const overviewLc = (summary.overview || "").toLowerCase();
  const corpus = `${nextStepLc} ${notesLc} ${overviewLc}`;

  const dropSignals = [
    "drop",
    "not a fit",
    "not fit",
    "pass on",
    "rejected",
    "reject",
    "decline",
    "withdraw",
  ];
  const advanceSignals = [
    "schedule",
    "l1",
    "round",
    "interview",
    "send to client",
    "submit",
    "shortlist",
    "move forward",
    "next step",
    "follow up",
  ];

  const isDrop = dropSignals.some((kw) => corpus.includes(kw));
  const isAdvance = advanceSignals.some((kw) => corpus.includes(kw));

  const facts = summary.discoveredFacts ?? ({} as DiscoveredFacts);
  const factsFilled = [
    facts.currentCompany,
    facts.currentCtcLakhs,
    facts.expectedCtcLakhs,
    facts.noticePeriodDays,
    facts.totalExperienceYears,
  ].filter((v) => v !== null && v !== undefined).length;

  if (isDrop && !isAdvance) return factsFilled <= 1 ? 1 : 2;
  if (isAdvance && !isDrop) return factsFilled >= 4 ? 5 : 4;
  if (isAdvance && isDrop) return 3;
  if (factsFilled >= 4) return 4;
  if (factsFilled >= 2) return 3;
  return 2;
}

export async function processProspectOutcomeExtract(
  job: ProspectOutcomeExtractJob,
  log: Logger,
): Promise<ExtractResult> {
  const { callId } = job;

  const [call] = await db
    .select({
      id: callSessions.id,
      prospectId: callSessions.prospectId,
      summary: callSessions.summary,
      endedAt: callSessions.endedAt,
    })
    .from(callSessions)
    .where(eq(callSessions.id, callId))
    .limit(1);

  if (!call) {
    return { skipped: true, reason: "call_not_found" };
  }
  if (!call.prospectId) {
    log.info({ callId }, "prospect outcome: no prospect linked to call");
    return { skipped: true, reason: "no_prospect" };
  }
  if (!call.summary) {
    log.info(
      { callId, prospectId: call.prospectId },
      "prospect outcome: no summary yet — will be retried by next enqueue",
    );
    return { skipped: true, reason: "no_summary" };
  }

  const summary = call.summary as CallSummaryShape;
  const interestLevel = deriveInterestLevel(summary);

  const [existing] = await db
    .select({
      metadata: prospects.metadata,
      notes: prospects.notes,
    })
    .from(prospects)
    .where(eq(prospects.id, call.prospectId))
    .limit(1);
  if (!existing) {
    return { skipped: true, reason: "prospect_missing" };
  }

  const facts = summary.discoveredFacts ?? ({} as DiscoveredFacts);
  // Flatten discoveredFacts into prospect.metadata under the "discovery"
  // key so other prospect-aware features (rubrics, JD match, exports) can
  // read it without parsing the call summary directly.
  const nextMetadata: Record<string, unknown> = {
    ...(existing.metadata ?? {}),
    discovery: {
      currentCompany: facts.currentCompany,
      currentTitle: facts.currentTitle,
      totalExperienceYears: facts.totalExperienceYears,
      currentCtcLakhs: facts.currentCtcLakhs,
      expectedCtcLakhs: facts.expectedCtcLakhs,
      noticePeriodDays: facts.noticePeriodDays,
      noticePeriodNegotiable: facts.noticePeriodNegotiable,
      currentLocation: facts.currentLocation,
      willingToRelocate: facts.willingToRelocate,
      reasonForChange: facts.reasonForChange,
      lastUpdatedFromCallId: callId,
      lastUpdatedAt: new Date().toISOString(),
    },
    nextStep: summary.nextStep ?? null,
    unaddressedItems: summary.unaddressedItems ?? [],
  };

  // Notes: append the recruiter's notes from this call to the prospect.
  // Prepend so most recent context is on top; cap to 4 entries to avoid
  // unbounded growth on chatty prospects.
  const stamp = new Date().toISOString().slice(0, 10);
  const newNoteEntry = summary.recruiterNotes
    ? `[${stamp}] ${summary.recruiterNotes.trim()}`
    : null;

  let nextNotes = existing.notes ?? "";
  if (newNoteEntry) {
    const existingEntries = nextNotes
      ? nextNotes.split(/\n\n+/).slice(0, 3)
      : [];
    nextNotes = [newNoteEntry, ...existingEntries].join("\n\n");
  }

  await db
    .update(prospects)
    .set({
      interestLevel,
      notes: nextNotes,
      metadata: nextMetadata,
      lastContactedAt: call.endedAt ?? sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(prospects.id, call.prospectId));

  log.info(
    { callId, prospectId: call.prospectId, interestLevel },
    "prospect outcome applied",
  );
  return { skipped: false, prospectId: call.prospectId, interestLevel };
}
