// Funnel-poll worker. For every active local submission with an
// external_offer_letter_applied_jobs_id set, fetch the latest state from
// MySQL and reflect step transitions back into our submissions table +
// audit trail. Read-only against MySQL.
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  db,
  STAGE_METADATA,
  submissionStageTransitions,
  submissions,
  type SubmissionStage,
} from "@j2w/db";
import {
  getActiveSubmissionStatuses,
  isOfferLetterConfigured,
} from "@j2w/offer-letter-db";
import {
  OFFER_LETTER_FUNNEL_POLL_QUEUE,
  type OfferLetterFunnelPollJob,
} from "@j2w/ingest-shared";
import { writeHeartbeat } from "./offerLetterDemandSync.js";

interface PollResult {
  submissionsScanned: number;
  transitionsRecorded: number;
  durationMs: number;
}

// Map an OL `current_step` (varchar; the doc says always quote) into one of
// our SUBMISSION_STAGES. Best-effort; OL has 100+ workflow steps and not
// all map cleanly. Unmapped values keep the local stage unchanged.
function olStepToStage(olStep: string | null): SubmissionStage | null {
  if (olStep === null || olStep === undefined) return null;
  const n = Number(olStep);
  switch (n) {
    case 4:
      return "internal_review";
    case 5:
      return "internal_review";
    case 6:
      return "internal_reject";
    case 7:
      return "client_submit";
    case 8:
      return "client_screen_reject";
    case 9:
    case 10:
      return "l1_scheduled";
    case 12:
      return "l1_reject";
    case 13:
      return "l1_select";
    case 14:
    case 15:
      return "l2_scheduled";
    case 17:
      return "l2_reject";
    case 18:
      return "l2_select";
    case 19:
    case 20:
      return "l3_scheduled";
    case 22:
      return "l3_reject";
    case 23:
      return "l3_select";
    case 38:
      return "offer_released";
    case 39:
      return "offer_accepted";
    case 44:
      return "onboarded";
    case 45:
    case 46:
      return "exited";
    case 49:
      return "duplicate_profile";
    case 75:
    case 77:
      return "on_hold";
    case 86:
    case 87:
    case 88:
    case 89:
      return "position_closed";
    case 109:
    case 110:
      return "panel_unavailable";
    default:
      return null;
  }
}

export async function processFunnelPoll(
  data: OfferLetterFunnelPollJob,
  log: Logger,
): Promise<PollResult> {
  if (!isOfferLetterConfigured()) {
    throw new Error("offer_letter_not_configured");
  }
  const t0 = Date.now();
  const { orgId } = data;

  // Active submissions that have a known OL link. Skip terminals — once a
  // submission is in a terminal local stage we trust our state and stop
  // polling. (If the user re-opens a terminal, that's a manual action; the
  // poller doesn't need to chase it.)
  const terminals = (Object.entries(STAGE_METADATA) as [SubmissionStage, { isTerminal: boolean }][])
    .filter(([, m]) => m.isTerminal)
    .map(([k]) => k);

  const localSubs = await db
    .select({
      id: submissions.id,
      currentStage: submissions.currentStage,
      externalId: submissions.externalOfferLetterAppliedJobsId,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        eq(submissions.status, "active"),
        isNotNull(submissions.externalOfferLetterAppliedJobsId),
      ),
    )
    .limit(500);

  const eligible = localSubs.filter((s) => !terminals.includes(s.currentStage));
  if (eligible.length === 0) {
    const durationMs = Date.now() - t0;
    await writeHeartbeat(orgId, OFFER_LETTER_FUNNEL_POLL_QUEUE, 0, durationMs, null);
    return { submissionsScanned: 0, transitionsRecorded: 0, durationMs };
  }

  const externalIds = eligible.map((s) => s.externalId!).filter((n): n is number => n !== null);
  let olRows;
  try {
    olRows = await getActiveSubmissionStatuses(externalIds);
  } catch (err) {
    const durationMs = Date.now() - t0;
    log.error({ err }, "funnel poll fetch failed");
    await writeHeartbeat(orgId, OFFER_LETTER_FUNNEL_POLL_QUEUE, 0, durationMs, String(err));
    throw err;
  }

  const byExternal = new Map<number, { current_step: string; updated_at: string }>();
  for (const r of olRows) {
    byExternal.set(r.application_id, { current_step: r.current_step, updated_at: r.updated_at });
  }

  let transitions = 0;
  for (const sub of eligible) {
    const ol = byExternal.get(sub.externalId!);
    if (!ol) continue;
    const newStage = olStepToStage(ol.current_step);
    if (!newStage || newStage === sub.currentStage) continue;

    await db.transaction(async (tx) => {
      await tx
        .update(submissions)
        .set({
          previousStage: sub.currentStage,
          currentStage: newStage,
          updatedAt: sql`now()`,
          metadata: sql`jsonb_set(coalesce(metadata,'{}'::jsonb), '{ol_last_step}', to_jsonb(${ol.current_step}::text))`,
        })
        .where(eq(submissions.id, sub.id));
      await tx.insert(submissionStageTransitions).values({
        submissionId: sub.id,
        fromStage: sub.currentStage,
        toStage: newStage,
        reasonText: `synced_from_offer_letter:step=${ol.current_step}`,
      });
    });
    transitions += 1;
  }

  const durationMs = Date.now() - t0;
  await writeHeartbeat(orgId, OFFER_LETTER_FUNNEL_POLL_QUEUE, transitions, durationMs, null);
  return { submissionsScanned: eligible.length, transitionsRecorded: transitions, durationMs };
}

// Small helper used during integration tests. Not exported through the
// queue path.
export async function findOpenSubmissionExternalIds(orgId: string): Promise<number[]> {
  const rows = await db
    .select({ extId: submissions.externalOfferLetterAppliedJobsId })
    .from(submissions)
    .where(
      and(
        eq(submissions.orgId, orgId),
        eq(submissions.status, "active"),
        isNotNull(submissions.externalOfferLetterAppliedJobsId),
      ),
    );
  return rows.map((r) => r.extId!).filter((n): n is number => n !== null);
}
