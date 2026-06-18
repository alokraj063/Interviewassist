> **Read-only reference.** The MySQL DB is shared production. Every query from this app must go through `@j2w/offer-letter-db` (read-only guard + prepared statements + standard exclusion filters). Do not import `mysql2` directly anywhere else in the monorepo.

# Offer Letter MySQL — Reference for the Recruiter Sourcing Companion App

> **Audience:** the engineer building a separate sourcing companion application that plugs into the J2W Offer Letter production MySQL database.
>
> **Purpose:** consolidate every relevant fact we have learned while building the J2W Cognition Engine on top of this same database — schema, role hierarchy, attribution chains, demand-to-recruiter linkage, JD content shape, the submission write path, downstream feedback signals, and operational caveats — into one self-contained reference. The new app should be buildable from this document alone.
>
> **What the new app does:** a recruiter logs in, sees the demands they are sourcing for, reads the JD, sources candidates externally (job boards, LinkedIn, networks), evaluates and screens them, makes calls and tracks conversations. When the recruiter has a viable candidate, the new app pushes a row into Offer Letter (`applied_jobs`) as a submission. From that point on, the Offer Letter system handles the rest of the funnel (client screen → interviews → selection → offer → onboarding). The new app reads back from Offer Letter to show the recruiter what is happening downstream to candidates they submitted.

---

## 1. Connection & access

### Connection parameters

| Parameter | Value |
|---|---|
| Host | `j2wofferletter-prod.ca8kj4bjkq5a.ap-south-1.rds.amazonaws.com` |
| Port | `3306` |
| Engine | MySQL on Amazon RDS |
| Region | `ap-south-1` (Mumbai) |
| Default DB | `offerletter` |
| Read user | `mis_operations` (read-only grants only) |
| TLS | Required (RDS-issued cert) |
| Pool timezone | `+05:30` (IST) |

The `mis_operations` user has read-only grants enforced at the database level. The Cognition Engine adds a second layer in code: every query passes through a regex check that rejects strings matching `INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE`. Calling code never builds raw SQL by string concatenation — all parameters bind through `mysql2` prepared statements. Array-bound `IN (?)` clauses use a special string-substitution helper because mysql2's prepared protocol does not expand array bindings natively.

### Timezone handling

RDS stores `DATETIME` columns in UTC, but the `mysql2` pool is configured with `timezone: '+05:30'`. This means raw `created_at` reads come back as UTC strings; for IST display you wrap with `CONVERT_TZ(col, '+00:00', '+05:30')`. The pool also uses `dateStrings: true` so values come back as ISO date strings rather than Node `Date` objects (which avoids timezone surprises in the application layer). For columns of type `DATE` (e.g. `validation_screens.interview_date`, `offer_letters.client_onboard_date`, `offer_letters.joining_date`), there is no time component, so `BETWEEN start AND end` is safe and the timezone question does not arise.

### Pool sizing

Default `connectionLimit` is 3 — the analyst guidance is to keep concurrent connections low because this is a shared production database. The Cognition Engine raised `queueLimit` from the mysql2 default of 10 to 100 after observing "Queue limit reached" errors during the historical scorecard rollouts (which fan out ~30 parallel queries when computing 6 BHs × 5 metrics). Raising the queue does not raise actual concurrency — it just lets short bursts queue rather than fail. For a recruiter app where each user session triggers a small number of queries, a `connectionLimit` of 2–3 with `queueLimit` of 100 is more than enough.

### Test / internal data filters

These two filters appear in nearly every business query the Cognition Engine runs:

- `clients.id NOT IN (1, 2)` — excludes two test/internal client rows that pre-date production.
- `users.id <> 887485` (or aliased as `recruiter_id <> 887485` in joins) — an internal/system recruiter account that should not be treated as a real recruiter.

Apply these filters whenever you are aggregating real recruitment activity. Skipping them inflates counts.

### Write access (open question)

The Cognition Engine is read-only. The new app needs INSERT/UPDATE access at minimum on `applied_jobs` (to push submissions), and likely also on `users`, `user_details`, `candidate_profiles`, `candidate_skills`, `candidate_qualifications`, `candidate_experiences`, `candidate_work_flow_statuses`, and `reasons` (to register a brand-new candidate before submitting them). This is the single biggest thing to confirm with the J2W database admin before building:

1. Can the new app talk to MySQL directly with INSERT grants on a curated set of tables, or
2. Is there an existing Offer Letter HTTP endpoint that ingests new submissions (which the new app should call instead)?

Direct DB writes are simpler but couple the new app tightly to the schema and bypass any Offer Letter validation/notification logic. An HTTP boundary is safer but does not exist today as far as we know. Assume you will need to confirm and possibly negotiate this with the analyst team.

---

## 2. The 187-table landscape

The full database has 187 tables across 18 functional groups. The new app only needs ~20 of them. The complete table-by-table reference for everything else is in `docs/offer-letter-db-schema.md` in the Cognition Engine repo. Below is a compact map of the groups and a star-flagged shortlist of the tables that matter for sourcing.

| Group | Purpose | Key tables |
|---|---|---|
| Users & Roles | Identity, role hierarchy, RBAC | `users`, `roles`, `user_details`, `role_permissions` |
| Candidate Profiles | Existing-candidate dedup pool | `candidate_profiles`, `api_candidates`, `candidate_skills`, `candidate_qualifications`, `candidate_experiences`, `candidate_documents`, `candidate_additional_details` |
| Clients | Customer records | `clients`, `company_profiles`, `contracts` |
| Job Postings & Requirements | Demands and JDs | ★ `job_postings`, `job_skills`, `job_locations`, `job_assignments`, `probing_details`, `job_mandatory_checks` |
| Recruitment Pipeline | The funnel from submit to onboard | ★ `applied_jobs`, `candidate_work_flows`, `candidate_work_flow_statuses`, `validation_screens`, `selected_candidates`, `reasons` |
| Offer Letters & Salary | Offer + onboarding records | `offer_letters`, `salary_breakups`, `verified_offers`, `po_histories` |
| Onboarding & Induction | Post-offer fulfilment | `inductions`, `induction_statuses`, `employee_details` |
| Employee Lifecycle & Exit | Exit data, retention | `exited_candidates`, `exit_checklist_forms`, `exit_interview_forms` |
| Timesheets & Attendance | Active employee tracking | `timesheets`, `timesheet_docs`, `attendances` (stale, do not use) |
| Skills & Taxonomy | Lookups | `skills`, `skill_groups`, `industries`, `functional_areas`, `job_roles`, `role_categories` |
| Teams & Assignments | Recruiter ↔ client allocation | `teams`, `team_recruiters`, `team_clients`, `client_recruiters`, `recruiter_assignments`, `recruiter_plans` |
| CRM | Internal lightweight sales CRM | `crm_leads`, `crm_contacts`, `crm_meetings`, `crm_stages` |
| Views | Pre-built reporting joins | `Employee`, `Employee_Information`, `OnBoarded_Employee_Information`, `DailySubmissions`, `JobPostings` |
| Reference / Lookup | `locations`, `industries`, `functional_areas`, `job_roles`, etc. | |
| Supporting | History, audit, notifications, helpdesk, KPI | `histories`, `audits` (large, useful for reconstructions), `app_notifications`, `recruiter_notifications` |
| Excluded / Empty | 23+ tables, ignore | |

The recruiter app's working set, in priority order:

1. **Discover demands assigned to the logged-in recruiter** — `job_assignments`, `job_postings`, `clients`
2. **Render the full JD** — `job_postings`, `job_skills` + `skills`, `job_locations`, `probing_details`, `job_mandatory_checks`, `industries`, `functional_areas`, `job_roles`, `role_categories`
3. **Identify whether a candidate already exists** — `users` (where `role_id = 4`), `candidate_profiles`, `api_candidates`, `user_details`
4. **Push a submission** — `applied_jobs`, `candidate_work_flow_statuses`, `users` + `user_details` + `candidate_profiles` (for net-new candidates)
5. **Read downstream status** — `applied_jobs.current_step`, `validation_screens`, `selected_candidates`, `offer_letters`, `reasons`, `candidate_work_flow_statuses`

---

## 3. Role hierarchy, user model, and active filters

The `users` table (~1.3M rows) is shared across every role on the platform — candidates, recruiters, clients, internal staff. It uses Single Table Inheritance via the `type` column (`UserCandidate`, `UserRecruiter`, `UserBusinessHead`, etc.) and a parallel legacy `role_id` column linking to `roles`.

### The recruitment org tree

```
Recruiter         (role_id = 3,  type = "UserRecruiter",       ~2,558 users)
   |  reporting_to
Lead / DL         (role_id = 6,  type = "UserLead",            ~316 users)
   |  reporting_to
Account Manager   (role_id = 5,  type = "UserAccountManager",  ~297 users)
   |  reporting_to
Business Head     (role_id = 23, type = "UserBusinessHead",    ~53 users)
```

All four levels are stored in the same `users` table, distinguished by `role_id`. The hierarchy traverses via the self-referencing `users.reporting_to` column. **Important caveat:** some teams skip the Lead level — a recruiter may report directly to an Account Manager. Always handle both 3-level and 4-level traversals.

### Other relevant `roles` rows

| `role_id` | Name | Notes |
|---|---|---|
| 1 | admin | Platform admin |
| 2 | client | Client-side users |
| **3** | **recruiter** | The user logging in to the new sourcing app |
| **4** | **candidate** | The job seeker — the new app submits one of these |
| **5** | **account_manager** | "Manager" in analyst SQL |
| **6** | **lead** | "Delivery Lead" / "Lead" in email reports |
| **23** | **business_head** | Top of the recruitment chain |

### Active vs locked vs present

Three distinct concepts, easy to confuse:

- **`users.locked = 0`** — account is not locked. Necessary but not sufficient for "active recruiter". A user can be unlocked but no longer at J2W.
- **`user_details.status = 0`** — the authoritative active flag. A recruiter with `users.locked = 0` but `user_details.status != 0` (or no `user_details` row) should NOT be counted as an active recruiter.
- **`users.current_sign_in_at >= CURDATE()`** — the recruiter signed in today. This column is *destructive* — it stores only the most recent login and is overwritten on every sign-in. You cannot use it to look up "who was present yesterday".

For historical "who was present on date X", reconstruct from the `audits` table (a Rails Audited gem log going back to 2015-09-28). Each Devise sign-in writes a row with `auditable_type = 'User'`, `action = 'update'`, and `audited_changes` YAML containing the new `current_sign_in_at` value:

```sql
SELECT DISTINCT a.auditable_id
FROM audits a
INNER JOIN users u ON u.id = a.auditable_id
INNER JOIN user_details ud ON ud.user_id = u.id AND ud.status = 0
WHERE a.auditable_type = 'User'
  AND a.action = 'update'
  AND a.created_at >= ?  -- start of date in IST
  AND a.created_at <  DATE_ADD(?, INTERVAL 1 DAY)
  AND a.audited_changes LIKE '%current_sign_in_at%'
  AND u.role_id = 3
  AND u.locked = 0;
```

Validation against `current_sign_in_at` for today matches within ±1 user. 30-day aggregations benchmark at ~170ms.

The `attendances` table looks tempting and is not the answer — its last data is from 2022, and it uses `emp_id varchar` (employee codes) rather than `users.id`. The `sessions` table only retains ~10 days. The `versions` table is PaperTrail audit, scoped to `JobPosting` only, no use here.

### BH/customer ownership vs reporting chain

A subtlety from the email-report side of the world: the BH that "owns" a customer (in our static `BH_CUSTOMER_MAP`) is not necessarily the BH at the top of the reporting chain for the recruiter who submits to that customer. A recruiter physically reporting up through Deepak Desai may submit only for Sadhna Shukla's customers; the email reports filter by *customer ownership*, not by reporting chain. For an internal recruiter dashboard like the new app, the reporting-chain attribution is fine and probably preferred.

The current BH roster is: **Tarun Sareen, Anuradha Murthy, Sadhna Shukla, Mehr Hashim, Deepak Desai**. (Nirmit Desai is no longer at J2W as of early 2026; his team has been absorbed under Deepak as the "Nirmit POD".)

Strategic / Growth / New (SGN) tagging on customers is a J2W internal concept that lives in the Cognition Engine repo (`server/src/lib/operations/bh-customer-map.ts`), not in the MySQL DB. The new app does not need it unless it reproduces BH-level dashboards.

### Things that don't work (lessons learned, do not retry)

- `attendances` for present-recruiter — stale.
- `validation_screens.user_id` — column does not exist. Use `applied_candidate_id` for the candidate FK.
- Joining `validation_screens → applied_jobs` on `job_posting_id` alone — multi-attributes. Always include `AND aj.user_id = vs.applied_candidate_id` so the join is 1:1 on candidate AND job.
- Numeric step ranges (9-13 for L1, 14-18 for L2) — miss the on-hold / position-closed / panel-unavailable variants at steps 75, 77, 86-89, 109, 110. Use regex on `candidate_work_flows.workflow_step` text instead.

---

## 4. How the new app knows what to work on (demand → recruiter bridge)

This is the section the new app's recruiter login screen depends on.

### The four candidate tables for "what is this recruiter assigned to"

| Table | Rows | Grain | What it tells you |
|---|---|---|---|
| **`job_assignments`** | ~433K | (job_posting_id, user_id) | **Per-demand** recruiter assignment. ~4.5 recruiters per active demand on average. Strongest candidate for "demands this recruiter is working on right now." |
| `client_recruiters` | ~20.4K | (client_id, recruiter_id, status) | **Per-customer** recruiter eligibility. Broader than per-demand. Useful as a fallback ("all customers this recruiter is allowed to source for") and is heavily used by the Cognition Engine's BH/customer mapping. |
| `team_recruiters` + `team_clients` + `teams` | ~235 + ~215 + a few | (team_id, recruiter_id) and (team_id, client_id) | Team-level layer. Each recruiter belongs to one team (Falcons, Challengers, Voyagers, Perm, International_clients) and each team owns a set of clients. |
| `recruiter_assignments` | ~23 rows only | (recruiter_id, count, max_count) | Workload cap helper, not the assignment list. Only ~23 rows exist — almost certainly not the primary mechanism. |

### Canonical query: "demands assigned to recruiter X right now"

```sql
SELECT
  jp.id                           AS demand_id,
  jp.title,
  jp.designation,
  jp.experience                   AS min_exp,
  jp.experienceto                 AS max_exp,
  jp.salary_from, jp.salary_to,
  jp.no_of_opening,
  jp.maximum_submission           AS submission_cap,
  jp.status                       AS demand_status,  -- 1 = active
  jp.is_vip,
  jp.requested_by,
  jp.requested_date,
  jp.expected_client_closure,
  jp.client_job_id                AS client_internal_ticket,
  jp.`group`, jp.sub_group,
  jp.po_opportunity_mrr, jp.potential_gm,
  jp.location                     AS primary_location,
  jp.created_at,
  c.id                            AS client_id,
  c.company_name                  AS customer
FROM job_assignments ja
JOIN job_postings    jp ON jp.id        = ja.job_posting_id
JOIN clients         c  ON c.user_id    = jp.client_id
WHERE ja.user_id = ?            -- the logged-in recruiter
  AND jp.status = 1             -- active demands only
  AND c.id NOT IN (1, 2)
ORDER BY jp.created_at DESC;
```

Note the slightly unusual join: `clients.user_id = job_postings.client_id`. The `job_postings.client_id` column actually holds the client *user id* (i.e. the FK to `users.id` for the client admin), not the `clients.id` PK. This is consistent throughout the schema — the analyst's reference SQL all use `LEFT JOIN clients c ON c.user_id = jp.client_id`.

### Open questions worth confirming with the analyst before building on `job_assignments`

We have not yet confirmed exactly when rows appear in `job_assignments`. Two plausible models:

1. **Allocation model.** The AM/Lead explicitly assigns one or more recruiters to a demand at the moment they create the requirement. `job_assignments` is the assignment list and is set up front.
2. **Activity model.** The row is created lazily the first time a recruiter takes any action on a posting (views it, submits a candidate). In this model, the table grows over the demand's life and reflects "people who touched this", not "people who own it".

The 4.5-recruiters-per-demand average is consistent with either model, so the row count alone doesn't decide it. Confirm with the analyst before using this as the authoritative assignment list. If model 2 turns out to be the case, an alternative source of truth is `applied_jobs` rows where `applied_by_id = recruiter` AND `current_step ≤ 6` — i.e. the recruiter has started sourcing and has at least one in-flight candidate but hasn't submitted yet.

### Other useful "what's this recruiter touching" projections

- **Recruiter's eligible customers (broader, less specific):**
  ```sql
  SELECT DISTINCT c.id, c.company_name
  FROM client_recruiters cr
  JOIN clients c ON c.id = cr.client_id
  WHERE cr.recruiter_id = ?
    AND cr.status = 1
    AND c.id NOT IN (1, 2);
  ```
- **Recruiter's team and team's customers:**
  ```sql
  SELECT t.id, t.team_name, c.id AS client_id, c.company_name
  FROM team_recruiters tr
  JOIN teams t  ON t.id = tr.team_id
  JOIN team_clients tc ON tc.team_id = t.id
  JOIN clients c  ON c.id = tc.client_id
  WHERE tr.recruiter_id = ?
    AND c.id NOT IN (1, 2);
  ```
- **Recruiter's reporting chain (DL → AM → BH):**
  ```sql
  SELECT
    r.id   AS recruiter_id,  CONCAT(r.first_name,' ',r.last_name) AS recruiter,
    dl.id  AS dl_id,         CONCAT(dl.first_name,' ',dl.last_name) AS dl,
    am.id  AS am_id,         CONCAT(am.first_name,' ',am.last_name) AS am,
    bh.id  AS bh_id,         CONCAT(bh.first_name,' ',bh.last_name) AS bh
  FROM users r
  LEFT JOIN users dl ON r.reporting_to  = dl.id
  LEFT JOIN users am ON dl.reporting_to = am.id
  LEFT JOIN users bh ON am.reporting_to = bh.id
  WHERE r.id = ?
    AND r.role_id = 3;
  ```
  Some teams skip DL — handle the case where `dl.role_id = 5` (i.e. recruiter reports straight to AM).

### Demand workload cap (`maximum_submission`)

`job_postings.maximum_submission` is the cap on how many candidates can be submitted to a posting before submissions stop being accepted. When deciding whether to surface a JD as "open for sourcing" in the new app, you may want to count current submissions and compare against this cap:

```sql
SELECT
  jp.id,
  jp.maximum_submission,
  COUNT(aj.id) AS submissions_so_far
FROM job_postings jp
LEFT JOIN applied_jobs aj
       ON aj.job_posting_id = jp.id AND aj.current_step > 6
WHERE jp.id IN (?)
GROUP BY jp.id;
```

---

## 5. JD content shape (what to render to the recruiter)

All JD-related tables key off `job_posting_id`. Most of the rich qualitative content lives in `probing_details`, but it is only filled in for ~24% of postings (~23K rows out of ~95K). The new app should render gracefully when probing data is absent.

### `job_postings` — the spine of every JD (~95K rows)

| Column | Type | Purpose |
|---|---|---|
| `id` | int PK | Demand ID |
| `client_id` | int FK → `users.id` (client admin) | Customer; join `clients ON clients.user_id = job_postings.client_id` |
| `user_id` | int FK → `users.id` | **Creator** (usually AM or DL) — NOT the assigned recruiter |
| `title` | varchar(255) | Job title (display) |
| `designation` | varchar(255) | Role designation |
| `experience` / `experienceto` | varchar(255) | Min / max experience (in years, stored as strings — be defensive) |
| `salary_from` / `salary_to` | decimal(10,2) | Salary range, INR |
| `description` | text | Long-form JD body |
| `responsibilities` | text | Role responsibilities, free text |
| `status` | int | 0 = draft, 1 = active, 2 = closed, 3 = on hold |
| `no_of_opening` | int | Number of seats to fill |
| `maximum_submission` | int | Cap on candidate submissions per recruiter/per demand |
| `location` | varchar(100) | Single primary location string |
| `industry_id`, `functional_area_id`, `role_category_id`, `job_role_id` | int FKs | Taxonomy hooks |
| `job_types`, `job_requirement_type` | int / varchar | Categorisation |
| `client_job_id` | varchar(255) | Client's own internal ticket ID (helpful when the client refers to "ticket #BB-12345") |
| `requested_by`, `requested_date` | varchar / date | Who at the client asked, when |
| `expected_client_closure` | date | Client's deadline for the role |
| `group` / `sub_group` | varchar(255) | Internal client department / sub-department |
| `po_opportunity_mrr` | varchar(255) | Estimated PO opportunity |
| `potential_gm` | varchar(255) | Potential gross margin |
| `is_vip` | varchar(255) | "VIP" / urgency / strategic flag |
| `created_at` | datetime | Demand creation |

`status` distribution roughly: ~60K active, ~45K draft, ~3K closed, plus a small on-hold pool. Filter on `status = 1` for the recruiter's active workload.

### `job_skills` (~170K rows) — required skill list

```sql
SELECT s.id, s.name
FROM job_skills js
JOIN skills s ON s.id = js.skill_id
WHERE js.job_posting_id = ?;
```

`skills` (~30K rows) is the master list. Multiple skills per posting; ~1.8 skills/posting on average.

### `job_locations` (~78K rows) — multi-location postings

The `job_postings.location` column holds a single primary, but real openings are often multi-city. `job_locations` is the per-posting location list. Schema is straightforward: `(job_posting_id, location_id)` joining `locations` (~3.2K rows for cities/states).

### `job_mandatory_checks` (~60K rows) — compliance requirements

Mandatory pre-employment checks per posting (BGV, drug test, etc.). The recruiter app may want to display these so the recruiter can pre-screen for them.

### `probing_details` (~23K rows) — the rich qualitative JD

When the AM has done the probing call with the client SPOC, the answers land here. One row per `job_id` (= `job_posting_id`):

| Column | Type | Content |
|---|---|---|
| `reporting_manager_location` | text | Where the hiring manager sits |
| `project_size` / `project_count` | text | Team/project scale at the client |
| `work_mode` | text | Remote / hybrid / onsite |
| `candidate_role` | text | Detailed role clarity, free-form |
| `feedback_eta` | text | How fast the client gives interview feedback |
| `interview_type` | text | Interview format the client uses |
| `notice_period` | text | What notice period the client will accept |
| `urgency_eta` | text | Urgency level |

Only ~24% of postings have probing data — coverage is partial and skewed toward Strategic accounts. The new app should treat this as supplementary, not required.

### One-shot "fetch full JD" query

```sql
SELECT
  jp.id, jp.title, jp.designation,
  jp.experience, jp.experienceto, jp.salary_from, jp.salary_to,
  jp.description, jp.responsibilities, jp.no_of_opening,
  jp.maximum_submission, jp.is_vip, jp.requested_by, jp.requested_date,
  jp.expected_client_closure, jp.client_job_id, jp.`group`, jp.sub_group,
  jp.po_opportunity_mrr, jp.potential_gm, jp.location AS primary_location,
  jp.created_at,
  c.id AS client_id, c.company_name AS customer,
  ind.industry      AS industry,
  fa.functional_area AS functional_area,
  rc.name           AS role_category,
  jr.role_name      AS job_role,
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
WHERE jp.id = ?;
```

Then issue two follow-up queries for the multi-row pieces (`job_skills` joined to `skills`, and `job_locations` joined to `locations`).

---

## 6. The submission write path (recruiter → Offer Letter)

When the recruiter finishes triaging a candidate in the new app and decides to push them as a submission, the new app inserts into `applied_jobs`. After that insert, the candidate is "in" Offer Letter and the rest of the funnel is driven by Offer Letter UI.

### `applied_jobs` (~1.4M rows) — the central pipeline table

| Column | Type | What to populate |
|---|---|---|
| `id` | int PK | auto-increment |
| `user_id` | int FK → `users.id` | The candidate (must exist in `users` with `role_id = 4`) |
| `job_posting_id` | int FK → `job_postings.id` | The demand |
| `applied_by_id` | int FK → `users.id` | The recruiter (must be `role_id = 3`) |
| `current_step` | varchar(255) | Workflow step ID — see below. **Always quote** (column is `varchar`, not int.) |
| `prev_step` | varchar(255) | Previous step (for the audit trail) |
| `self_applied` | tinyint(1) | `0` for recruiter-pushed, `1` for self-applied |
| `note` | text | Recruiter's submission note (visible to AM/Lead) |
| `status` | int | `0` for active. Different from `current_step` |
| `created_at` / `updated_at` | datetime | UTC |

### Where to set `current_step`

The submission lands somewhere on the early end of the workflow:

- **Step 4 (Internal Submit):** the standard recruiter handoff. The candidate goes to the J2W AM/Lead first for internal validation. Lead/AM moves it to step 5 (Lead/Manager Validation) → 7 (Client Submit) or 6 (Internal Reject). This is the safe default.
- **Step 7 (Client Submit):** skips the internal validation gate. Some teams allow this for trusted recruiters or specific clients. Use only if the analyst confirms it's appropriate.
- **Step 1 (Applied):** the candidate-self-applied case. Almost certainly not what the new app should write.

If unsure, default to `current_step = '4'`. The metric definition for "submission" is `current_step > 6` — so a step-4 row will not yet count as a submission until the AM/Lead promotes it.

Set `prev_step = NULL` on the initial insert (it's the first hop in the workflow for this candidate-job pair).

### Pre-existing candidate vs net-new candidate

The Offer Letter DB already has ~1.39M `UserCandidate` rows. Many of them are real, dedupable candidates with full profiles. The new app's first job before submitting is to determine whether this candidate already exists.

The standard dedup key is **email**. The path:

```sql
SELECT u.id, u.first_name, u.last_name, u.email,
       cp.total_experience, cp.current_ctc, cp.expected_ctc, cp.notice_period,
       ud.contact_phone
FROM users u
LEFT JOIN candidate_profiles cp ON cp.user_id = u.id
LEFT JOIN user_details       ud ON ud.user_id = u.id
WHERE u.role_id = 4
  AND u.email   = ?;
```

If a row exists, reuse `u.id` for the `applied_jobs.user_id` — no new candidate insert needed. (You may still want to update the candidate's profile if your app has fresher data, but that's a write-policy decision.)

If no row exists, the new app must register the candidate before submitting. Minimum required inserts (with sensible defaults):

1. `users` — `role_id = 4`, `type = 'UserCandidate'`, `email`, `first_name`, `last_name`, `encrypted_password` (a placeholder bcrypt hash works), `locked = 0`, `confirmed_at = NOW()`, `created_at`, `updated_at`.
2. `user_details` — `user_id = <new>`, `status = 0`, `contact_phone`, `gender = 0` if unknown.
3. `candidate_profiles` — `user_id = <new>`, `total_experience`, `current_ctc`, `expected_ctc`, `notice_period`, `summary`, `resume` path.
4. Optionally: `candidate_skills` (per-skill rows), `candidate_qualifications`, `candidate_experiences`, `candidate_documents`, `candidate_additional_details` (notice-period negotiability, ready-to-join, etc.), `candidate_prefered_locations`, `candidate_social_media`.

Mirror Offer Letter's own validation rules where possible — email format, phone format, required fields — to avoid creating rows that downstream Offer Letter UI rejects when the AM tries to act on them.

### Workflow step reference (the lifecycle the new app inserts into)

The full state machine has 102 rows in `candidate_work_flows`. The early portion the new app interacts with:

| Step | Name | Notes |
|---|---|---|
| 1 | Applied | Candidate self-applied (rare; usually skipped) |
| 2 | Validate | Auto-validation |
| 3 | Validation Reject | Terminal (rejected at validate) |
| **4** | **Internal Submit** | The safe default for the new app |
| 5 | Lead / Manager Validation | Lead has reviewed |
| 6 | Internal Reject | Terminal (Lead rejected) |
| **7** | **Client Submit** | Officially counted as a submission. Past this point the workflow is owned by Offer Letter + the client. |
| 49 | Duplicate Profile | Terminal (dedup caught it) |

After step 7, the next stages are owned by the client and J2W ops via Offer Letter UI:

- 8: Client Screen Reject (terminal)
- 9–13: L1 Schedule / Reschedule / No Show / Reject / Select
- 14–18: L2 cycle
- 19–23: L3 cycle, then 58–67 for L4–L6 (yes, six interview rounds are supported)
- 26–39: Offer letter creation, manager approval, BGV, offer accepted/rejected
- 41: Confirm Onboarding, 43: Set Contract End Date, **44: Onboarded**
- 45: Initiate Exit Formalities, 46: Exit Formalities Complete

The new app should **not** drive transitions past step 7. Reading them is fine and important (Section 7).

### `candidate_work_flow_statuses` — the audit trail

If your write strategy goes through an Offer Letter API, this table is updated for you. If you write directly to `applied_jobs`, you should also insert a row here for the audit trail:

```sql
INSERT INTO candidate_work_flow_statuses
  (user_id, status, current_step, status_change_by, created_at, updated_at)
VALUES
  (?, ?, ?, ?, NOW(), NOW());
-- user_id           = candidate user id
-- status            = text description ("Internal Submit")
-- current_step      = step id ("4")
-- status_change_by  = recruiter user id
```

### `reasons` — rejection / hold reasons

When a step transition includes a reason (rejection, on-hold, position-closed), Offer Letter writes a row here:

```
reasons:  step_id (int), reason (text), candidate_id (int), applied_job_id FK
```

The new app's submission insert does not need this — there's no reason text on a fresh submission. But when reading downstream feedback (Section 7) the rejection text comes from this table.

---

## 7. Reading downstream feedback (Offer Letter → new app)

Once a submission is in `applied_jobs`, the rest of the funnel is driven outside the new app. The new app polls or subscribes to changes so it can show the recruiter what is happening to their candidates.

### Polling strategy

There is no built-in change-feed; the recommended approach is timestamp-based polling per recruiter:

```sql
-- The recruiter's active submissions and their current state
SELECT
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
WHERE aj.applied_by_id = ?
  AND aj.updated_at > ?     -- last poll cursor
ORDER BY aj.updated_at DESC;
```

For richer transition history, query `candidate_work_flow_statuses` (~222K rows). It records every step change, so you can detect "submitted yesterday at step 4, promoted to step 7 today":

```sql
SELECT
  cwfs.user_id, cwfs.current_step, cwfs.status,
  cwfs.status_change_by, cwfs.created_at,
  cwf.workflow_step
FROM candidate_work_flow_statuses cwfs
LEFT JOIN candidate_work_flows cwf ON cwf.step_id = cwfs.current_step
WHERE cwfs.user_id IN (?)         -- candidate user ids the recruiter submitted
  AND cwfs.created_at > ?         -- last poll cursor
ORDER BY cwfs.created_at DESC;
```

### `validation_screens` (~226K rows) — interview scheduling

A row appears here whenever an interview is scheduled (any round, L1–L6).

| Column | Meaning |
|---|---|
| `applied_candidate_id` | candidate user id |
| `applied_candidate_for_job_id` | job posting id |
| `candidate_work_flow_step` | the step_id at the time of the interview (used to detect L1 vs L2 etc.) |
| `interview_date` | DATE — `BETWEEN` is safe |
| `interview_time` | varchar |
| `interview_mode` | int — in-person / video / phone |
| `venue` | text |
| `contact_person` | varchar — interviewer or client SPOC |

**Critical join rule.** `validation_screens` does NOT have a `user_id` (recruiter) column. To get the recruiter for an interview, join `applied_jobs` on **both** `job_posting_id` AND `user_id = applied_candidate_id`:

```sql
SELECT vs.*, aj.applied_by_id AS recruiter_id, cwf.workflow_step
FROM validation_screens vs
JOIN applied_jobs aj
  ON aj.job_posting_id = vs.applied_candidate_for_job_id
 AND aj.user_id        = vs.applied_candidate_id      -- 1:1 candidate-job match
JOIN candidate_work_flows cwf ON cwf.step_id = vs.candidate_work_flow_step
WHERE vs.interview_date BETWEEN ? AND ?;
```

Joining only on `job_posting_id` causes multi-attribution when several recruiters submit different candidates to the same posting.

### Detecting L1 vs L2 vs L3+

Use regex on `candidate_work_flows.workflow_step` text — do **not** use numeric ranges. The numeric ranges 9–13 / 14–18 / 19–23 cover the main flow but miss the on-hold (75, 77), position-closed (86–89), and panel-unavailable (109, 110) variants:

```sql
-- L1 step ids
SELECT step_id FROM candidate_work_flows
WHERE workflow_step REGEXP 'L1[[:space:]]|L1$|L1 ';
-- L2: same pattern with L2
```

### `selected_candidates` (~28.5K rows)

Inserted when the candidate is selected by the client. Carries the offer-relevant fields — `po`, `margin`, `tentative_doj`, `current_ctc`, `offered_ctc`. FK back to `applied_jobs.id` via `applied_jobs_id`. To match the analyst's "Selections" metric, dedupe by candidate email — sometimes a candidate gets selected for multiple postings within a window.

### `offer_letters` (~34.5K rows) — onboarding outcome

| `status` | Meaning |
|---|---|
| 0 | Draft / Pending |
| 1 | Created / Pending Approval |
| 2 | Approved |
| 3 | Offer Released |
| 4 | Offer Accepted |
| **5** | **Onboarding Complete** |
| **6** | **Active Employee** |
| 7 | Exited |
| 8 | Terminated |

| `employee_type` | Meaning |
|---|---|
| 0 | Standard Contract — **excluded from "real onboardings"** |
| 1 | Fixed Term |
| 2 | Third-party Payroll |
| 3 | Permanent |
| 4 | Consultant |
| 5 | Intern |
| 6 | On-Demand |
| 7 | Other |

Two date fields on `offer_letters` that are easy to confuse:

- `joining_date` — the candidate's date of joining as recorded on the offer letter.
- `client_onboard_date` — when the candidate was officially onboarded with the client. This is the date the analyst's "today's onboarding" metric uses.

These usually agree but can diverge by a few days. Use `client_onboard_date` for "Onboarded" reporting; use `joining_date` for HC planning cascades or for showing the recruiter "your candidate joins on date X". Don't conflate them.

`created_by_id` on `offer_letters` is the recruiter who drafted the offer — for attribution it usually equals the `applied_jobs.applied_by_id` of the parent submission, but not always. Trust `created_by_id` when filtering offers per recruiter.

### Pulling the full lifecycle for one of your submissions

```sql
SELECT
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
WHERE aj.id = ?;
```

---

## 8. Pipeline metrics (the canonical formulas)

The new app does not need to reproduce these for the Operations dashboard, but the recruiter-facing UI may want to show "your week so far: X submissions, Y interviews, Z selections, W onboardings." These formulas come from the analyst-validated reference SQL. Match them exactly so any number you display reconciles to the email reports.

### Demand

```sql
SELECT COUNT(DISTINCT jp.id) AS demand_count,
       SUM(jp.no_of_opening) AS opening_count
FROM job_postings jp
JOIN clients c ON c.user_id = jp.client_id
WHERE jp.created_at BETWEEN ? AND ?
  AND c.id NOT IN (1, 2);
```

### Submission

```sql
SELECT COUNT(DISTINCT aj.id) AS submissions
FROM applied_jobs aj
JOIN job_postings jp ON jp.id = aj.job_posting_id
JOIN clients c       ON c.user_id = jp.client_id
WHERE aj.created_at BETWEEN ? AND ?
  AND aj.current_step > 6
  AND c.id NOT IN (1, 2);
```

Per-recruiter heuristic for daily target: `present_recruiters * 6` (an analyst-hardcoded rule of thumb verified against email reports).

### Interview

```sql
SELECT COUNT(DISTINCT vs.id) AS interviews
FROM validation_screens vs
JOIN job_postings jp ON jp.id = vs.applied_candidate_for_job_id
JOIN applied_jobs aj
  ON aj.job_posting_id = jp.id
 AND aj.user_id        = vs.applied_candidate_id   -- 1:1 candidate-job
JOIN clients c ON c.user_id = jp.client_id
WHERE vs.interview_date BETWEEN ? AND ?
  AND c.id NOT IN (1, 2);
```

L1/L2 split by joining `candidate_work_flows` on `vs.candidate_work_flow_step` and regex'ing the text.

### Selection

```sql
SELECT COUNT(DISTINCT u.email) AS selections
FROM selected_candidates sc
JOIN applied_jobs aj ON aj.id = sc.applied_jobs_id
JOIN users        u  ON u.id = aj.user_id           -- candidate
JOIN job_postings jp ON jp.id = aj.job_posting_id
JOIN clients      c  ON c.user_id = jp.client_id
WHERE sc.created_at BETWEEN ? AND ?
  AND c.id NOT IN (1, 2);
```

Dedup by candidate email.

### Onboarding (count + PO)

```sql
SELECT
  COUNT(DISTINCT ol.id)                  AS onboarding_count,
  SUM(ol.p_o_value)  / 100000            AS po_lakhs,
  SUM(ol.margin)     / 100000            AS margin_lakhs
FROM offer_letters ol
JOIN clients c ON c.user_id = ol.client_id
WHERE ol.status IN (5, 6)
  AND ol.employee_type   <> 0
  AND ol.job_posting_id IS NOT NULL
  AND ol.client_onboard_date BETWEEN ? AND ?
  AND c.id NOT IN (1, 2);
```

### Exit (count)

```sql
SELECT COUNT(DISTINCT ol.id) AS exits
FROM exited_candidates ec
JOIN offer_letters ol ON ol.id = ec.offer_letter_id
JOIN clients c ON c.user_id = ol.client_id
WHERE ec.last_work_day BETWEEN ? AND ?
  AND c.id NOT IN (1, 2);
```

### Active headcount as of date X

```sql
SELECT COUNT(DISTINCT ol.id) AS active_hc
FROM offer_letters ol
LEFT JOIN exited_candidates ec ON ec.offer_letter_id = ol.id
JOIN clients c ON c.user_id = ol.client_id
WHERE ol.status = 5
  AND ol.joining_date <= ?
  AND (ec.last_work_day IS NULL OR ec.last_work_day > ?)
  AND c.id NOT IN (1, 2);
```

(Uses `status = 5` for "Onboarding Complete"; the simpler "active employees" query uses `status = 6` "Active Employee" but the joined exit-check version above is what the planning code uses for trajectory cascades.)

---

## 9. Operational caveats

A consolidated list of the things that have bitten us and that you should design around from day one.

1. **Email reports are noon snapshots.** The Daily DL Performance email is generated around 12:00 IST and shows cumulative counts up to that moment. A live dashboard query for the same day will return *higher* numbers as the afternoon proceeds — this is correct, not a bug.

2. **Email reports exclude ITES.** "Excluding ITES" is in the email header. To match the email exactly, filter to non-ITES customers. The new app probably doesn't need this filter unless it specifically reproduces a daily report.

3. **Email reports filter by BH-customer ownership, not the reporting chain.** A recruiter physically reporting up through one BH may submit only for another BH's customers; the email shows their numbers under the customer-owning BH, not the reporting-chain BH. For internal recruiter dashboards the reporting-chain attribution is fine and arguably more useful.

4. **`Total Recruiter Count` requires `user_details.status = 0`.** Filtering only on `users.locked = 0` is too permissive — it includes archived/terminated recruiters whose accounts were never locked.

5. **Timezone — pool is IST, raw `created_at` is UTC.** Use `CONVERT_TZ(col, '+00:00', '+05:30')` for IST display of `DATETIME` columns. `DATE` columns (interview_date, joining_date, client_onboard_date, last_work_day) have no time component and `BETWEEN` is safe.

6. **Pool burst protection.** Default `queueLimit` of 10 is too low for any dashboard that fans out parallel queries. We bumped it to 100. Concurrency is still gated by `connectionLimit` — the queue just absorbs short bursts.

7. **Analyst metrics ≠ raw MySQL counts.** Don't replace existing API or analyst-published metrics with raw MySQL rewrites without checking. Counting logic differs in subtle ways (e.g. dedup by email vs by application id; exclusions; date column choice). Treat MySQL as the source of truth for *exploration* and as a source of *enrichment fields* layered on top of the official metric, not as a free-form replacement.

8. **Test/internal exclusions.** `clients.id NOT IN (1, 2)` and (where joining recruiters) `users.id <> 887485` should appear in every business query.

9. **BH roster.** Tarun Sareen, Anuradha Murthy, Sadhna Shukla, Mehr Hashim, Deepak Desai (active as of April 2026). Nirmit Desai is no longer at J2W; his team has been absorbed under Deepak as the "Nirmit POD". Don't hardcode Nirmit as an active BH.

10. **`joining_date` vs `client_onboard_date`.** `joining_date` is what's on the offer letter; `client_onboard_date` is when the client confirmed onboarding. Use `client_onboard_date` for the "Onboarded" metric. Use `joining_date` when telling the recruiter "your candidate joins on date X."

11. **`validation_screens.user_id` does not exist.** Use `applied_candidate_id` for the candidate FK, and join `applied_jobs` on both `job_posting_id` and `user_id = applied_candidate_id` to recover the recruiter.

12. **`applied_jobs.current_step` is `varchar(255)`, not int.** Always quote in SQL literals. `WHERE current_step = '4'` not `= 4`.

13. **`clients.user_id` is the FK to the client admin user**, not a backwards reference. The right join is `clients.user_id = job_postings.client_id` and `clients.user_id = offer_letters.client_id`.

14. **Skills tables are huge.** `api_candidates_skills` is ~30M rows, `candidate_skills` is ~13M rows. Always use `LIMIT` on exploration queries against these. The query helper used in the Cognition Engine adds a default LIMIT of 1000 if missing.

15. **`attendances`, `versions`, `sessions` are NOT useful** for the things you might be tempted to use them for. See Section 3.

---

## 10. Existing helpers in the Cognition Engine repo (cross-reference)

If you have access to the Cognition Engine source, every function below in `server/src/db/offer-letter-db.ts` is something you can read or port directly. They all run as parameterized read-only queries and apply the standard exclusions.

| Helper | What it returns | Tables touched |
|---|---|---|
| `olQuery<T>(sql, params)` | Generic prepared-statement read | any |
| `olQueryArr<T>(sql, params)` | Read with `IN (?)` array expansion | any |
| `olQueryLimited<T>(sql, params, limit=1000)` | Same as `olQuery` but auto-appends LIMIT if missing | any |
| `olHealthCheck` | Connectivity check (`SELECT 1`) | — |
| `olShowDatabases` / `olShowTables` / `olDescribeTable` / `olSampleRows` | Schema introspection (dev-only in production) | INFORMATION_SCHEMA |
| `getTeamMemberIds(bhUserId)` | Self + 1st-level + 2nd-level reports for a BH | `users` |
| `getClientsForTeam(teamIds)` | Distinct clients tied to a recruiter team via `client_recruiters` | `client_recruiters`, `clients` |
| `olGetBhCustomerMapping(bhUserIds)` | Full BH → customers mapping, deduped by company name | `users`, `client_recruiters`, `clients` |
| `resolveClientUserIds(teamIds)` | Cached recruiter→client_user_id map (1h TTL) | `client_recruiters`, `clients` |
| `olGetOpeningBalance(monthStart, monthEnd, teamIds)` | HC at month start for the team | `offer_letters`, `exited_candidates` |
| `olGetMonthOnboardings(monthStart, monthEnd, teamIds)` | Joinings during the month (uses `joining_date`) | `offer_letters` |
| `olGetMonthExits(monthStart, monthEnd, teamIds)` | Exits during the month | `exited_candidates`, `offer_letters` |
| `olGetActiveDemands(monthStart, monthEnd, teamIds)` | Demand count + opening count for the month | `job_postings` |
| `olGetMonthSubmissions(month, teamIds)` | `current_step > 6` submissions in the month | `applied_jobs`, `job_postings`, `clients` |
| `olGetMonthInterviews(month, teamIds)` | Interviews via `validation_screens.interview_date` | `validation_screens`, `applied_jobs` |
| `olGetMonthSelections(month, teamIds)` | Selections deduped by candidate email | `selected_candidates`, `applied_jobs`, `users` |
| `olGetMonthOnboardedByClientDate(month, teamIds)` | Onboardings using `client_onboard_date`, status (5,6,7), `employee_type <> 0` | `offer_letters`, `clients` |
| `olGetPlanningActualsBatch(teamIds, months[])` | All planning actuals (HC, OB, exits, sub, int, sel, demand) in 2 parallel queries instead of 4×N serial | several |
| `olGetAvgPoMargin(teamIds)` | Per-customer avg PO and margin for onboardings | `offer_letters` |
| `olGetBhUniqueAssignment(bhUserIds)` | Unique customer→BH assignment (resolves shared customers) | `client_recruiters`, `users`, `offer_letters`, `clients` |
| `olGetExitInProgress(teamIds)` | Offers in pipeline (`status IN (1,3)`) with future `client_onboard_date` | `offer_letters` |
| `olGetObPipeline(teamIds)` | Onboarding pipeline (`status IN (5,6)`) for current month | `offer_letters` |
| `olGetActiveHcAsOf(customers, date)` | HC count at a point in time | `offer_letters`, `clients` |
| `olGetMonthlyRevenueAllClients(monthsBack=12)` | Org-wide PO/margin/HC by customer × month | `offer_letters`, `clients` |
| `olGetFirstJoiningByClient` / `olGetLastExitByClient` | Customer lifecycle bookends | `offer_letters` / `exited_candidates` |
| `olGetDeliveryLeads(bhUserId, forDate?)` | DLs under a BH with recruiter-count + present-count | `users`, `audits`, `user_details` |
| `olGetRecruiterPresenceHistory(start, end)` | Daily org-wide present counts via `audits` | `audits`, `users`, `user_details` |
| `olGetDlDailyPerformance(...)` | The 14-column daily DL performance table | several |
| `olApiBhDailyBasis` / `olApiBhDailyBasisIntraday` / `olApiBhMonthlyBasis` / `olApiBhMtdBasis` / `olApiBhDemands` | BH dashboard rollups (single-day, intraday checkpoints, monthly, MTD, demand detail) | several |
| `olGetExitAnalysis` / `olGetMarginSnapshot` / `olGetHikeAnalysis` | CEO dashboard analytics | `offer_letters`, `exited_candidates` |
| `olGetMonthInterviewsByLevel` / `olGetFunnelMonth` / `olGetDailyMetrics` / `olGetDemandAging` / `olGetSkillsDistribution` / `olGetCustomerStageDetail` / `olGetSubmitTiming` | CEO/Operations analytics | several |
| `olGetRecruiterCounts(BH_USER_IDS)` | Per-BH active recruiter count | `users`, `user_details` |

For the new app's recruiter-facing screens, the foundation helpers (`olQuery`, `olQueryArr`, `olQueryLimited`) plus a handful of new queries built on top (Section 4's "demands assigned to recruiter X", Section 5's full-JD fetch, Section 7's lifecycle-for-one-submission) is most of what you need. The dashboarding helpers are interesting if you want to surface team-level views to a Lead/AM logging into the same app.

---

## 11. Open questions to confirm before building

Honest list of things we have not nailed down. Get answers from the analyst team before shipping.

1. **`job_assignments` semantics.** Is a row created at the moment of demand allocation by the AM, or lazily when a recruiter first touches the posting? This determines whether the table is "what you should be working on" or "what you have already touched". If it's lazy, an alternative source of truth is `applied_jobs` rows where `applied_by_id = recruiter` AND `current_step ≤ 6`.

2. **Write access path.** Does the new app talk to MySQL with INSERT grants on a specific allow-list (`applied_jobs`, `users`, `user_details`, `candidate_profiles`, etc.), or does it call an existing Offer Letter HTTP endpoint that ingests submissions? If the former, what's the dedicated DB user? If the latter, what's the API contract?

3. **Candidate dedup strategy.** Email is the obvious key, but Offer Letter probably also has phone-, PAN-, and Aadhar-based dedup logic. Mirror whatever the existing UI does so you don't create duplicates. The `temporary_pans` table is a hint that PAN dedup is handled with a "set later" workflow.

4. **`current_step` choice on insert.** Confirm whether new submissions should land at step 4 (Internal Submit, the safe default) or step 7 (Client Submit, skipping internal validation). Likely client- or team-specific.

5. **`candidate_work_flow_statuses` write responsibility.** If you're writing directly to `applied_jobs`, do you also need to insert a `candidate_work_flow_statuses` row to keep the audit trail honest? The existing Offer Letter UI almost certainly does this on every step transition; check whether it's enforced or expected.

6. **Demand-closed signal.** When the client closes a position, `job_postings.status` flips to 2 (Closed) or 3 (On Hold). The new app should hide such postings from the recruiter's working list and stop the recruiter from sourcing further candidates for them. Confirm whether there are any other signals (e.g. `job_postings.expected_client_closure` past, `applied_jobs.current_step` for all candidates is 84/85/76 = "Position Closed/Closed by Client/On Hold") that should also count as "demand effectively dead".

7. **Resume storage.** Offer Letter stores resumes as a path string in `candidate_profiles.resume` (and `candidate_documents` rows for other documents). Where do those files actually live (S3? local disk on the Offer Letter VM?), and can the new app upload to the same store, or does it need its own?

8. **`maximum_submission` enforcement.** Does Offer Letter actually block inserts when `applied_jobs` count for a posting hits `job_postings.maximum_submission`, or is this just an advisory display field? The new app should probably treat it as a soft guideline (warn the recruiter) unless the analyst confirms it's enforced.

9. **`is_vip`, `urgency_eta`, `expected_client_closure`.** These are useful sorting / surfacing signals for the recruiter's dashboard. Confirm the conventions: what values does `is_vip` take? Is it a boolean string ("yes"/"no") or a tag set? Is `urgency_eta` free text or one of a few enum-like values?

10. **Conversation/call logging.** This is entirely the new app's domain (Offer Letter doesn't track candidate calls), but you may want to plan around eventual reverse integration: e.g. surfacing call counts per posting back to Offer Letter, or letting AM/Lead users see the new app's call notes when reviewing a submission. None of this touches the MySQL DB directly, but the data model should keep `users.id` (recruiter), `job_postings.id` (demand), and `applied_jobs.id` (eventual submission) as keys so cross-app linkage is straightforward.
