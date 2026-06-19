// High-level query helpers built on olQuery. Each applies the standard
// exclusions (clients.id NOT IN (1, 2), users.id <> 887485) where relevant.
// SQL bodies follow docs/offer-letter-db.md sections 4–7 verbatim.
import type { RowDataPacket } from "mysql2";
import { olQuery, olQueryArr } from "./query.js";

export interface OlDemandRow extends RowDataPacket {
  demand_id: number;
  title: string | null;
  designation: string | null;
  description: string | null;
  responsibilities: string | null;
  min_exp: string | null;
  max_exp: string | null;
  salary_from: string | null;
  salary_to: string | null;
  no_of_opening: number | null;
  submission_cap: number | null;
  demand_status: number;
  is_vip: string | null;
  requested_by: string | null;
  requested_date: string | null;
  expected_client_closure: string | null;
  client_internal_ticket: string | null;
  group: string | null;
  sub_group: string | null;
  po_opportunity_mrr: string | null;
  potential_gm: string | null;
  primary_location: string | null;
  created_at: string;
  client_id: number;
  customer: string | null;
  industry: string | null;
  functional_area: string | null;
  role_category: string | null;
  job_role: string | null;
  work_mode: string | null;
  candidate_role: string | null;
  interview_type: string | null;
  notice_period: string | null;
  feedback_eta: string | null;
  urgency_eta: string | null;
  project_size: string | null;
  project_count: string | null;
  reporting_manager_location: string | null;
}

// `job_assignments` is the canonical assignment list — coverage is real
// (~93% on all open demands, ~97% on demands < 30 days old) and senior
// recruiters legitimately carry thousands of rows. We don't cap by recency
// here. Callers (the recruiter home view) sort by demand_assignments
// .active_candidates_count DESC so the recruiter's actual workload
// surfaces first; the long tail of cold assignments stays visible but
// below the fold.
//
// Filters per docs/demand-recruiter-attribution.md §6, with one local
// deviation:
//   * jp.status IN (0, 1)      — include drafts AND active postings.
//                                The reference doc treats `status = 1`
//                                (active) as the only "open" set; in the
//                                J2W workflow recruiters legitimately
//                                source against draft postings before
//                                client activation. The recruiter-home
//                                view needs both. Closed (2) and on-hold
//                                (3) stay excluded.
//   * c.id NOT IN (1, 2)       — exclude internal test clients
//   * u.role_id = 3            — only recruiters (drops ~0.5% noise from
//                                candidate / induction / finance role rows)
//   * u.locked = 0             — exclude locked accounts
// LIMIT 20000 is a safety bound for the largest realistic recruiter
// loads. With status IN (0, 1) Sandipta P returns ~6400 rows; the cap
// gives 3x headroom for the senior end of the recruiter distribution.
export async function getDemandsForRecruiter(recruiterUserId: number): Promise<OlDemandRow[]> {
  return olQuery<OlDemandRow>(
    `SELECT
       jp.id                           AS demand_id,
       jp.title,
       jp.designation,
       jp.description,
       jp.responsibilities,
       jp.experience                   AS min_exp,
       jp.experienceto                 AS max_exp,
       jp.salary_from, jp.salary_to,
       jp.no_of_opening,
       jp.maximum_submission           AS submission_cap,
       jp.status                       AS demand_status,
       jp.is_vip,
       jp.requested_by,
       jp.requested_date,
       jp.expected_client_closure,
       jp.client_job_id                AS client_internal_ticket,
       jp.\`group\`, jp.sub_group,
       jp.po_opportunity_mrr, jp.potential_gm,
       jp.location                     AS primary_location,
       jp.created_at,
       c.id                            AS client_id,
       c.company_name                  AS customer,
       ind.name                        AS industry,
       fa.name                         AS functional_area,
       rc.name                         AS role_category,
       jr.name                         AS job_role,
       pd.work_mode, pd.candidate_role, pd.interview_type, pd.notice_period,
       pd.feedback_eta, pd.urgency_eta, pd.project_size, pd.project_count,
       pd.reporting_manager_location
     FROM job_assignments ja
     JOIN job_postings    jp ON jp.id     = ja.job_posting_id
     JOIN clients         c  ON c.user_id = jp.client_id
     JOIN users           u  ON u.id      = ja.user_id
     LEFT JOIN industries        ind ON ind.id = jp.industry_id
     LEFT JOIN functional_areas  fa  ON fa.id  = jp.functional_area_id
     LEFT JOIN role_categories   rc  ON rc.id  = jp.role_category_id
     LEFT JOIN job_roles         jr  ON jr.id  = jp.job_role_id
     LEFT JOIN probing_details   pd  ON pd.job_id = jp.id
     WHERE ja.user_id = ?
       AND jp.status  IN (0, 1)
       AND c.id NOT IN (1, 2)
       AND u.role_id  = 3
       AND u.locked   = 0
     ORDER BY jp.created_at DESC
     LIMIT 20000`,
    [recruiterUserId],
  );
}

export interface OlDemandSkillRow extends RowDataPacket {
  job_posting_id: number;
  skill_id: number;
  skill_name: string;
}

// Batched skill lookup. mysql2's prepared protocol can't expand IN (?), so
// olQueryArr substitutes ?, ?, ? for the array. Caller provides up to ~6400
// demand IDs per recruiter (Sandipta's worst case); each posting averages
// ~1.8 skills, so worst-case ~12K rows per call. Single round-trip beats
// fan-out.
export async function getSkillsForDemands(
  jobPostingIds: ReadonlyArray<number>,
): Promise<OlDemandSkillRow[]> {
  return olQueryArr<OlDemandSkillRow>(
    `SELECT js.job_posting_id, s.id AS skill_id, s.name AS skill_name
     FROM job_skills js
     JOIN skills s ON s.id = js.skill_id
     WHERE js.job_posting_id IN (?)`,
    jobPostingIds,
  );
}

export interface OlDemandLocationRow extends RowDataPacket {
  job_posting_id: number;
  location_id: number;
  city: string | null;
  state: string | null;
}

export async function getLocationsForDemands(
  jobPostingIds: ReadonlyArray<number>,
): Promise<OlDemandLocationRow[]> {
  // OL `locations` table column for the city is `name`, not `city`. Aliased
  // for the consumer.
  return olQueryArr<OlDemandLocationRow>(
    `SELECT jl.job_posting_id, l.id AS location_id, l.name AS city, l.state
     FROM job_locations jl
     JOIN locations l ON l.id = jl.location_id
     WHERE jl.job_posting_id IN (?)`,
    jobPostingIds,
  );
}

export interface OlRecruiterDemandActivityRow extends RowDataPacket {
  job_posting_id: number;
  active_candidates: number;
  last_activity_at: string | null;
}

// Per-(recruiter, demand) pipeline activity for the last 365 days, drawn
// from applied_jobs. Returned rows feed the local
// demand_assignments.active_candidates_count + last_recruiter_activity_at
// columns. The terminal step IDs come from
// docs/demand-recruiter-attribution.md §8 caveat #11:
//   3   Validation Reject
//   6   Internal Reject
//   8   Client Screen Reject
//   12  L1 Reject
//   17  L2 Reject
//   22  L3 Reject
//   49  Duplicate Profile
//   76  Position On Hold
//   83  No Feedback
//   84  Position Closed
//   85  Closed by Client
// applied_jobs.current_step is varchar(255) so values are quoted.
export async function getRecruiterActivityByDemand(
  recruiterUserId: number,
): Promise<OlRecruiterDemandActivityRow[]> {
  return olQuery<OlRecruiterDemandActivityRow>(
    `SELECT
       aj.job_posting_id,
       COUNT(*)               AS active_candidates,
       MAX(aj.updated_at)     AS last_activity_at
     FROM applied_jobs aj
     WHERE aj.applied_by_id = ?
       AND aj.current_step NOT IN ('3','6','8','12','17','22','49','76','83','84','85')
       AND aj.created_at >= DATE_SUB(NOW(), INTERVAL 365 DAY)
     GROUP BY aj.job_posting_id`,
    [recruiterUserId],
  );
}

export interface OlDemandFullRow extends RowDataPacket {
  id: number;
  title: string | null;
  designation: string | null;
  experience: string | null;
  experienceto: string | null;
  salary_from: string | null;
  salary_to: string | null;
  description: string | null;
  responsibilities: string | null;
  no_of_opening: number | null;
  maximum_submission: number | null;
  is_vip: string | null;
  requested_by: string | null;
  requested_date: string | null;
  expected_client_closure: string | null;
  client_job_id: string | null;
  group: string | null;
  sub_group: string | null;
  po_opportunity_mrr: string | null;
  potential_gm: string | null;
  primary_location: string | null;
  created_at: string;
  client_id: number;
  customer: string | null;
  industry: string | null;
  functional_area: string | null;
  role_category: string | null;
  job_role: string | null;
  work_mode: string | null;
  candidate_role: string | null;
  interview_type: string | null;
  notice_period: string | null;
  feedback_eta: string | null;
  urgency_eta: string | null;
  project_size: string | null;
  project_count: string | null;
  reporting_manager_location: string | null;
}

export interface OlSkillRow extends RowDataPacket {
  id: number;
  name: string;
}

export interface OlLocationRow extends RowDataPacket {
  id: number;
  city: string | null;
  state: string | null;
}

export interface OlDemandFull {
  demand: OlDemandFullRow | null;
  skills: OlSkillRow[];
  locations: OlLocationRow[];
}

export async function getDemandFull(jobPostingId: number): Promise<OlDemandFull> {
  const [demands, skills, locations] = await Promise.all([
    olQuery<OlDemandFullRow>(
      `SELECT
         jp.id, jp.title, jp.designation,
         jp.experience, jp.experienceto, jp.salary_from, jp.salary_to,
         jp.description, jp.responsibilities, jp.no_of_opening,
         jp.maximum_submission, jp.is_vip, jp.requested_by, jp.requested_date,
         jp.expected_client_closure, jp.client_job_id, jp.\`group\`, jp.sub_group,
         jp.po_opportunity_mrr, jp.potential_gm, jp.location AS primary_location,
         jp.created_at,
         c.id AS client_id, c.company_name AS customer,
         ind.name          AS industry,
         fa.name           AS functional_area,
         rc.name           AS role_category,
         jr.name           AS job_role,
         pd.work_mode, pd.candidate_role, pd.interview_type, pd.notice_period,
         pd.feedback_eta, pd.urgency_eta, pd.project_size, pd.project_count,
         pd.reporting_manager_location
       FROM job_postings    jp
       JOIN clients         c   ON c.user_id  = jp.client_id
       LEFT JOIN industries        ind ON ind.id = jp.industry_id
       LEFT JOIN functional_areas  fa  ON fa.id  = jp.functional_area_id
       LEFT JOIN role_categories   rc  ON rc.id  = jp.role_category_id
       LEFT JOIN job_roles         jr  ON jr.id  = jp.job_role_id
       LEFT JOIN probing_details   pd  ON pd.job_id = jp.id
       WHERE jp.id = ?
         AND c.id NOT IN (1, 2)`,
      [jobPostingId],
    ),
    olQuery<OlSkillRow>(
      `SELECT s.id, s.name
       FROM job_skills js
       JOIN skills s ON s.id = js.skill_id
       WHERE js.job_posting_id = ?`,
      [jobPostingId],
    ),
    olQuery<OlLocationRow>(
      `SELECT l.id, l.name AS city, l.state
       FROM job_locations jl
       JOIN locations l ON l.id = jl.location_id
       WHERE jl.job_posting_id = ?`,
      [jobPostingId],
    ),
  ]);
  return { demand: demands[0] ?? null, skills, locations };
}

export interface OlCandidateRow extends RowDataPacket {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  total_experience: string | null;
  current_ctc: string | null;
  expected_ctc: string | null;
  notice_period: string | null;
  contact_phone: string | null;
}

export async function findCandidateByEmail(email: string): Promise<OlCandidateRow[]> {
  // Normalize the same way our Postgres dedup-check does (lowercased + trimmed).
  const normalized = email.trim().toLowerCase();
  return olQuery<OlCandidateRow>(
    `SELECT u.id, u.first_name, u.last_name, u.email,
            cp.total_experience, cp.current_ctc, cp.expected_ctc, cp.notice_period,
            ud.contact_phone
     FROM users u
     LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
     LEFT JOIN user_details       ud ON ud.user_id = u.id
     WHERE u.role_id = 4
       AND LOWER(u.email) = ?
     LIMIT 5`,
    [normalized],
  );
}

export async function findCandidateByPhone(phone: string): Promise<OlCandidateRow[]> {
  // The MySQL phone column may contain country-code variations; match on
  // the trailing digits (last 10) since Indian numbers dominate.
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return [];
  const tail = digits.slice(-10);
  return olQuery<OlCandidateRow>(
    `SELECT u.id, u.first_name, u.last_name, u.email,
            cp.total_experience, cp.current_ctc, cp.expected_ctc, cp.notice_period,
            ud.contact_phone
     FROM users u
     LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
     LEFT JOIN user_details       ud ON ud.user_id = u.id
     WHERE u.role_id = 4
       AND ud.contact_phone LIKE ?
     LIMIT 5`,
    [`%${tail}`],
  );
}

export interface OlReportingChainRow extends RowDataPacket {
  recruiter_id: number;
  recruiter: string | null;
  dl_id: number | null;
  dl: string | null;
  am_id: number | null;
  am: string | null;
  bh_id: number | null;
  bh: string | null;
}

export async function getRecruiterReportingChain(
  recruiterUserId: number,
): Promise<OlReportingChainRow | null> {
  // 4-level chain: recruiter → DL (role 6) → AM (role 5) → BH (role 23).
  // Some teams skip DL — recruiter reports straight to AM. Caller should
  // detect this by checking dl_id's role and shifting columns if needed.
  const rows = await olQuery<OlReportingChainRow>(
    `SELECT
       r.id   AS recruiter_id,  CONCAT(r.first_name,' ',r.last_name) AS recruiter,
       dl.id  AS dl_id,         CONCAT(dl.first_name,' ',dl.last_name) AS dl,
       am.id  AS am_id,         CONCAT(am.first_name,' ',am.last_name) AS am,
       bh.id  AS bh_id,         CONCAT(bh.first_name,' ',bh.last_name) AS bh
     FROM users r
     LEFT JOIN users dl ON r.reporting_to  = dl.id
     LEFT JOIN users am ON dl.reporting_to = am.id
     LEFT JOIN users bh ON am.reporting_to = bh.id
     WHERE r.id = ?
       AND r.role_id = 3`,
    [recruiterUserId],
  );
  return rows[0] ?? null;
}

export interface OlSubmissionStatusRow extends RowDataPacket {
  application_id: number;
  candidate_id: number;
  candidate: string | null;
  email: string | null;
  job_posting_id: number;
  title: string | null;
  company_name: string | null;
  current_step: string;
  step_name: string | null;
  stage_group: string | null;
  created_at: string;
  updated_at: string;
  latest_reason: string | null;
}

export async function getActiveSubmissionStatuses(
  appliedJobIds: ReadonlyArray<number>,
): Promise<OlSubmissionStatusRow[]> {
  return olQueryArr<OlSubmissionStatusRow>(
    `SELECT
       aj.id            AS application_id,
       aj.user_id       AS candidate_id,
       CONCAT(u.first_name,' ',u.last_name) AS candidate,
       u.email,
       aj.job_posting_id,
       jp.title,
       c.company_name,
       aj.current_step,
       cwf.workflow_step AS step_name,
       cwf.stage         AS stage_group,
       aj.created_at, aj.updated_at,
       r.reason          AS latest_reason
     FROM applied_jobs aj
     JOIN users        u   ON u.id   = aj.user_id
     JOIN job_postings jp  ON jp.id  = aj.job_posting_id
     JOIN clients      c   ON c.user_id = jp.client_id
     LEFT JOIN candidate_work_flows cwf ON cwf.step_id = aj.current_step
     LEFT JOIN reasons r ON r.applied_job_id = aj.id AND r.step_id = aj.current_step
     WHERE aj.id IN (?)
       AND c.id NOT IN (1, 2)
     ORDER BY aj.updated_at DESC`,
    appliedJobIds,
  );
}

export interface OlSubmissionLifecycleRow extends RowDataPacket {
  application_id: number;
  submitted_at: string;
  current_state: string | null;
  l1_date: string | null;
  l2_date: string | null;
  selected_at: string | null;
  po: string | null;
  margin: string | null;
  offered_ctc: string | null;
  offer_status: number | null;
  joining_date: string | null;
  client_onboard_date: string | null;
  p_o_value: string | null;
  ol_margin: string | null;
  exit_date: string | null;
  exit_type: string | null;
}

export async function getSubmissionLifecycle(
  appliedJobId: number,
): Promise<OlSubmissionLifecycleRow | null> {
  const rows = await olQuery<OlSubmissionLifecycleRow>(
    `SELECT
       aj.id            AS application_id,
       aj.created_at    AS submitted_at,
       cwf.workflow_step AS current_state,
       vs_l1.interview_date AS l1_date,
       vs_l2.interview_date AS l2_date,
       sc.created_at        AS selected_at,
       sc.po, sc.margin, sc.offered_ctc,
       ol.status            AS offer_status,
       ol.joining_date, ol.client_onboard_date,
       ol.p_o_value, ol.margin AS ol_margin,
       ec.last_work_day     AS exit_date,
       ec.exit_type
     FROM applied_jobs aj
     LEFT JOIN candidate_work_flows cwf ON cwf.step_id = aj.current_step
     LEFT JOIN validation_screens   vs_l1 ON vs_l1.applied_candidate_id = aj.user_id
             AND vs_l1.applied_candidate_for_job_id = aj.job_posting_id
             AND vs_l1.candidate_work_flow_step IN (
                   SELECT step_id FROM candidate_work_flows
                   WHERE workflow_step LIKE 'Schedule L1%'
                 )
     LEFT JOIN validation_screens   vs_l2 ON vs_l2.applied_candidate_id = aj.user_id
             AND vs_l2.applied_candidate_for_job_id = aj.job_posting_id
             AND vs_l2.candidate_work_flow_step IN (
                   SELECT step_id FROM candidate_work_flows
                   WHERE workflow_step LIKE 'Schedule L2%'
                 )
     LEFT JOIN selected_candidates sc ON sc.applied_jobs_id = aj.id
     LEFT JOIN offer_letters       ol ON ol.candidate_id = aj.user_id
             AND ol.job_posting_id = aj.job_posting_id
     LEFT JOIN exited_candidates   ec ON ec.offer_letter_id = ol.id
     WHERE aj.id = ?`,
    [appliedJobId],
  );
  return rows[0] ?? null;
}

export interface OlUserByEmailRow extends RowDataPacket {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  role_id: number;
  reporting_to: number | null;
  locked: number;
}

// Used by the demand-sync worker to map a recruiter's RecruitAssist email to
// their MySQL user_id, which is the join key for getDemandsForRecruiter.
export async function findRecruiterUserByEmail(email: string): Promise<OlUserByEmailRow | null> {
  const normalized = email.trim().toLowerCase();
  const rows = await olQuery<OlUserByEmailRow>(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role_id, u.reporting_to, u.locked
     FROM users u
     INNER JOIN user_details ud ON ud.user_id = u.id AND ud.status = 0
     WHERE u.role_id = 3
       AND u.locked = 0
       AND u.id <> 887485
       AND LOWER(u.email) = ?`,
    [normalized],
  );
  return rows[0] ?? null;
}
