// Scoped wipe of the demo tenant. Every DELETE filters by org_id (or joins
// through a parent that does) so other tenants — DEFAULT_ORG_ID,
// JOULESTOWATTS_ORG_ID, anything created via /api/platform/orgs — are never
// touched. Order is FK-safe; children with no org_id ride out via cascade
// from their org-scoped parent.
import { db } from "@j2w/db";
import { sql } from "drizzle-orm";
import { DEMO_ORG_ID, DEMO_USER_EMAIL_DOMAIN } from "./constants.js";

export async function wipeDemoOrg(): Promise<void> {
  const orgId = sql`${DEMO_ORG_ID}::uuid`;
  const inDemoCalls = sql`(SELECT id FROM call_sessions WHERE org_id = ${orgId})`;
  const inDemoCampaigns = sql`(SELECT id FROM voice_agent_campaigns WHERE org_id = ${orgId})`;
  const inDemoSessions = sql`(SELECT id FROM proctor_sessions WHERE org_id = ${orgId})`;
  const inDemoAttempts = sql`(SELECT id FROM assessment_attempts WHERE org_id = ${orgId})`;
  const inDemoSubmissions = sql`(SELECT id FROM submissions WHERE org_id = ${orgId})`;
  const inDemoSelections = sql`(SELECT s.id FROM selections s JOIN submissions su ON su.id = s.submission_id WHERE su.org_id = ${orgId})`;
  const inDemoSources = sql`(SELECT id FROM kb_sources WHERE org_id = ${orgId})`;
  const inDemoDocs = sql`(SELECT d.id FROM documents d JOIN kb_sources s ON s.id = d.source_id WHERE s.org_id = ${orgId})`;
  const inDemoBanks = sql`(SELECT id FROM question_banks WHERE org_id = ${orgId})`;

  // Coaching
  await db.execute(sql`DELETE FROM coaching_runs        WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM coaching_scenarios   WHERE org_id = ${orgId}`);

  // Proctor (events cascade from sessions, but we delete explicitly to keep
  // the wipe idempotent if a session row was orphaned by hand).
  // PAGE:proctor child tables (FK-cascade off sessions/org, but explicit for a
  // clean, order-independent re-seed). Audit + interventions + identity hang
  // off sessions; policies hang off org + assessment_templates.
  await db.execute(sql`DELETE FROM proctor_audit_events    WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM proctor_interventions   WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM proctor_identity_checks WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM proctor_events       WHERE session_id IN ${inDemoSessions}`);
  await db.execute(sql`DELETE FROM proctor_sessions     WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM proctor_policies     WHERE org_id = ${orgId}`);

  // Async video + assessments (attempts cascade from templates). Both carry
  // an append-only audit log whose immutability trigger blocks the ON DELETE
  // CASCADE that fires when a template/campaign is removed. Disable the trigger
  // for the duration of the maintenance delete, inside one transaction each.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE async_video_audit_log DISABLE TRIGGER async_video_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM async_video_audit_log WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM async_video_submissions WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM async_video_campaigns   WHERE org_id = ${orgId}`);
    await tx.execute(sql`ALTER TABLE async_video_audit_log ENABLE TRIGGER async_video_audit_log_no_mutate`);
  });
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE assessment_audit_log DISABLE TRIGGER assessment_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM assessment_audit_log WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM assessment_attempts     WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM assessment_templates    WHERE org_id = ${orgId}`);
    await tx.execute(sql`ALTER TABLE assessment_audit_log ENABLE TRIGGER assessment_audit_log_no_mutate`);
  });

  // Voice campaigns (call_targets cascade from campaign).
  await db.execute(sql`DELETE FROM voice_agent_call_targets WHERE campaign_id IN ${inDemoCampaigns}`);
  await db.execute(sql`DELETE FROM voice_agent_campaigns    WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM voice_agent_deployments  WHERE agent_id IN (SELECT id FROM voice_agents WHERE org_id = ${orgId})`);
  await db.execute(sql`DELETE FROM voice_agents             WHERE org_id = ${orgId}`);

  // Calls + everything hung off them.
  await db.execute(sql`DELETE FROM call_routing_events     WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM transcript_acoustic_windows WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM transcript_speaker_brackets WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM transcript_turns        WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM call_rubric_scores      WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM call_technical_qa       WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM prospect_calls          WHERE call_session_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM call_qa_reviews         WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM suggestions             WHERE call_id IN ${inDemoCalls}`);
  await db.execute(sql`DELETE FROM call_sessions           WHERE org_id = ${orgId}`);

  // Rubrics — audit log first (rubric_id is ON DELETE SET NULL, so orphan
  // trace rows would otherwise accumulate across re-seeds); versions cascade
  // off call_rubrics; idempotency keys cascade off call_rubrics. The audit
  // table is append-only (a row trigger blocks DELETE), so disable the trigger
  // for the duration of this maintenance delete inside one transaction (the
  // demo seed owner can DISABLE/ENABLE its own trigger), then re-enable. Scoped
  // to the demo org only.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE rubric_audit_log DISABLE TRIGGER rubric_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM rubric_audit_log WHERE org_id = ${orgId}`);
    await tx.execute(sql`DELETE FROM rubric_idempotency_keys WHERE org_id = ${orgId}`);
    // call_rubrics delete cascades ON DELETE SET NULL onto rubric_audit_log.
    // rubric_id (an UPDATE the immutability trigger would block), so it must run
    // while the trigger is disabled, inside this same transaction.
    await tx.execute(sql`DELETE FROM call_rubrics WHERE org_id = ${orgId}`);
    await tx.execute(sql`ALTER TABLE rubric_audit_log ENABLE TRIGGER rubric_audit_log_no_mutate`);
  });

  // jd_match_runs (no org_id; reach via demand or candidate join — both
  // share org_id semantics).
  await db.execute(sql`DELETE FROM jd_match_runs           WHERE demand_id IN (SELECT id FROM demands WHERE org_id = ${orgId})`);

  // Submissions chain (offers via selections via submissions; transitions
  // cascade; client_feedback via submissions).
  await db.execute(sql`DELETE FROM submission_client_feedback WHERE submission_id IN ${inDemoSubmissions}`);
  await db.execute(sql`DELETE FROM offers                  WHERE selection_id IN ${inDemoSelections}`);
  await db.execute(sql`DELETE FROM selections              WHERE submission_id IN ${inDemoSubmissions}`);
  await db.execute(sql`DELETE FROM interviews              WHERE submission_id IN ${inDemoSubmissions}`);
  await db.execute(sql`DELETE FROM submission_stage_transitions WHERE submission_id IN ${inDemoSubmissions}`);
  await db.execute(sql`DELETE FROM submissions             WHERE org_id = ${orgId}`);

  // Prospects
  await db.execute(sql`DELETE FROM prospects               WHERE org_id = ${orgId}`);

  // Question banks (questions + demand_links cascade from bank).
  await db.execute(sql`DELETE FROM question_bank_demand_links WHERE bank_id IN ${inDemoBanks}`);
  await db.execute(sql`DELETE FROM question_bank_questions    WHERE bank_id IN ${inDemoBanks}`);
  await db.execute(sql`DELETE FROM question_banks             WHERE org_id = ${orgId}`);

  // KB
  await db.execute(sql`DELETE FROM chunks                  WHERE document_id IN ${inDemoDocs}`);
  await db.execute(sql`DELETE FROM documents               WHERE source_id IN ${inDemoSources}`);
  await db.execute(sql`DELETE FROM kb_sources              WHERE org_id = ${orgId}`);

  // Tenant integrations
  await db.execute(sql`DELETE FROM tenant_integrations     WHERE org_id = ${orgId}`);

  // Messaging events
  await db.execute(sql`DELETE FROM messaging_events        WHERE org_id = ${orgId}`);

  // Demands (skills/locations/assignments cascade)
  await db.execute(sql`DELETE FROM demand_assignments      WHERE demand_id IN (SELECT id FROM demands WHERE org_id = ${orgId})`);
  await db.execute(sql`DELETE FROM demand_locations        WHERE demand_id IN (SELECT id FROM demands WHERE org_id = ${orgId})`);
  await db.execute(sql`DELETE FROM demand_skills           WHERE demand_id IN (SELECT id FROM demands WHERE org_id = ${orgId})`);
  await db.execute(sql`DELETE FROM demands                 WHERE org_id = ${orgId}`);

  // Candidates (skills/experiences/qualifications/resumes cascade)
  await db.execute(sql`DELETE FROM candidates              WHERE org_id = ${orgId}`);

  // Clients (recruiter eligibility cascades)
  await db.execute(sql`DELETE FROM clients                 WHERE org_id = ${orgId}`);

  // Memberships + demo users (and their auth side-tables).
  // Match by email domain so ad-hoc demo users created via /api/platform/orgs
  // are not deleted by accident.
  const emailLike = `%@${DEMO_USER_EMAIL_DOMAIN}`;
  await db.execute(sql`DELETE FROM memberships
    WHERE org_id = ${orgId}
       OR user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`);
  await db.execute(sql`DELETE FROM email_verification_tokens
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`);
  await db.execute(sql`DELETE FROM password_reset_tokens
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`);
  await db.execute(sql`DELETE FROM refresh_tokens
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${emailLike})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);

  // organizations row stays — re-runnable seeding hangs everything off the
  // same DEMO_ORG_ID, so recreating it would require cascading deletes we'd
  // rather avoid.
}
