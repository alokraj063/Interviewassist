# Demand → Recruiter Attribution in the J2W Offer Letter Database

**A reference report on how to map a specific recruiter to the specific demands (job postings) they are working on, derived from direct investigation of the production MySQL database.**

---

## 1. The question

> "If a recruiter comes in to work today, what demands are they working on?"

There is no single column on `job_postings` that names the recruiter. The link must be reconstructed via a junction table. This report identifies that table, validates its quality, and gives you the canonical query.

---

## 2. The answer in one line

The link is **`job_assignments`** — a junction table holding one row per `(job_posting × user)` assignment. It is alive, maintained, and covers **97% of demands created in the last 30 days**. Use it.

---

## 3. Background — the org-chart and existing attribution chains

The Offer Letter database (`offerletter` schema, MySQL on Amazon RDS) models the recruitment org as a 4-level reporting tree, walked via `users.reporting_to`:

```
Recruiter (role_id = 3)
  ↓ reporting_to
Lead / Delivery Lead (role_id = 6)
  ↓ reporting_to
Account Manager (role_id = 5)
  ↓ reporting_to
Business Head (role_id = 23)
```

**Important caveat:** in some teams the recruiter's `reporting_to` skips the DL layer and points straight to the AM. Any traversal must handle both 3-level and 4-level chains.

For every recruitment metric **except demands**, attribution to a recruiter exists naturally because there is an "action" field on the row:

| Metric | Action field on row → recruiter | Then walk |
|---|---|---|
| Submissions | `applied_jobs.applied_by_id` | `→ reporting_to` chain to BH |
| Interviews (L1/L2) | derived via `applied_jobs.applied_by_id`, joined to `validation_screens` on **both** `job_posting_id` and `aj.user_id = vs.applied_candidate_id` (1:1 candidate-job match) | same |
| Selections | `selected_candidates → applied_jobs.applied_by_id` | same |
| Onboarding | `offer_letters.created_by_id` | same |

Demands have no such action field. `job_postings.user_id` is the **creator** (often a DL or AM), not the working recruiter. This is the gap `job_assignments` fills.

---

## 4. Candidates evaluated for the missing link

| Table | Rows | What it links | Verdict |
|---|---|---|---|
| **`job_assignments`** | **631,302** | (job_posting_id × user_id × created_at × updated_at × id) | ✅ **The answer.** Per-demand granularity, actively maintained. |
| `client_recruiters` | ~20,400 | (client_id × recruiter_id × status) | Per-**client** only — one level too coarse. Used heavily in current code. |
| `team_recruiters` + `team_clients` | ~235 + ~215 | recruiter→team→clients (transitive) | Sparsely populated; only ~5 active teams. Not granular enough on its own. |
| `recruiter_assignments` | 23 | (recruiter_id, count, max_count) | **Misnomer** — this is workload caps, not assignments. |
| `applied_jobs.applied_by_id` (filtered to recent dates) | — | (recruiter × job_posting via candidate touch) | Behavioral, not assignment. Useful as a fallback signal. |
| `job_postings.user_id` | — | demand creator | Not the working recruiter. |

---

## 5. Detail on `job_assignments`

### 5.1 Schema (verified directly against the live DB)

```sql
DESCRIBE job_assignments;
```

| Field | Type | Null | Key | Extra |
|---|---|---|---|---|
| id | int | NO | PRI | auto_increment |
| job_posting_id | int | YES | MUL | |
| user_id | int | YES | MUL | |
| created_at | datetime | NO | | |
| updated_at | datetime | NO | | |

**Note:** Some internal documentation lists this table as having ~433K rows and only 2 columns. Both are stale — actual row count is 631,302 and there are 5 columns. The presence of `created_at` and `updated_at` is significant: they let you reason about freshness and recency of an assignment.

### 5.2 Data quality — coverage of currently-open demands

Filtering `job_postings.status = 1` (active) and excluding internal test clients (`clients.id NOT IN (1, 2)`):

| Metric | Value |
|---|---|
| Total open demands | 60,477 |
| Open demands with ≥1 assignment | 56,382 |
| **Coverage** | **93.2%** |

Coverage by demand age (how long the posting has been open):

| Demand age | Open demands | With assignment | Coverage |
|---|---|---|---|
| 0–7 days | 8 | 8 | **100.0%** |
| 8–30 days | 287 | 282 | **98.3%** |
| 31–90 days | 96 | 92 | 95.8% |
| 90+ days | 60,086 | 56,000 | 93.2% |

**Interpretation:** the 7% uncovered population is concentrated in old (>90-day) postings — almost certainly stale reqs nobody bothered to update. For any practical "what is this recruiter working on today" use case, coverage is effectively complete.

### 5.3 Recently-created demands

Demands created in the last 30 days (a more meaningful "current work" denominator):

| Recent demands | With assignment | Coverage |
|---|---|---|
| 2,159 | 2,098 | **97.2%** |

### 5.4 Liveness — is the table actively maintained?

Assignment rows by year of the parent `job_posting.created_at`:

| Year | Assignment rows | (open demands only — distinct) |
|---|---|---|
| 2026 | 40,157 | 444 |
| 2025 | 93,734 | 1,035 |
| 2024 | 72,681 | 1,244 |
| 2023 | 65,826 | 1,711 |
| 2022 | 55,332 | 478 |
| 2021 | 43,782 | 1,249 |
| 2020 | 40,104 | 4,276 |
| 2019 | 78,252 | 16,557 |
| 2018 | 74,303 | 16,106 |
| 2017 | 62,214 | 12,474 |

40K assignments already in 2026 — the table is being actively written to.

### 5.5 Role distribution of assigned users (current open demands)

| role_id | role_name | Assignment rows | Distinct users |
|---|---|---|---|
| 3 | recruiter | 237,869 | 1,897 |
| 6 | lead | 36,869 | 225 |
| 5 | account_manager | 7,332 | 51 |
| 19 | you_matter | 963 | 10 |
| 4 | candidate | 190 | 1 |
| 23 | business_head | 122 | 1 |
| 16 | induction | 20 | 1 |
| 18 | finance | 12 | 1 |

Recruiters (role_id=3) dominate — exactly what you'd want. The DL/AM rows are also legitimate (DLs sometimes work demands directly). The handful of `candidate`, `induction`, `finance`, `business_head` rows are noise (~1,300 of 283,000 = 0.45%) and should be filtered out by joining `users.role_id = 3`.

### 5.6 Distribution of recruiters per demand

For currently-open demands:

| # recruiters assigned | # demands |
|---|---|
| 0 | 4,095 |
| 1 | 12,316 |
| 2 | 6,942 |
| 3 | 5,396 |
| 4 | 5,954 |
| 5 | 4,998 |
| 6 | 5,021 |
| 7 | 4,902 |
| 8–10 | ~6,100 |
| 11–20 | ~3,800 |
| 21–50 | ~1,500 |
| 50+ | a few hundred |

**Implication:** demands are typically multi-recruiter. The mode is 1 recruiter, but the average is well above 1 — parallel sourcing is the norm. Do not expect a one-to-one mapping. When you compute "demands this recruiter is working on", count `DISTINCT job_posting_id`. When you compute "demand load for a DL", do not double-count demands that multiple of their recruiters share — use `COUNT(DISTINCT jp.id)`.

### 5.7 The "Dummy Record Lead" caveat

User ID **1170** (`'Dummy Record Lead'`) has 570 recruiters reporting to it and shows 33,228 open-demand assignments. This is clearly a catch-all bucket for recruiters who have not been properly placed under a real DL. **Always filter it out** when aggregating to the DL level. The next-largest real DL (Mehr Hashim) has 102 recruiters and 6,083 open-demand assignments — that's the realistic ceiling for a single DL.

```sql
LEFT JOIN users dl ON dl.id = u.reporting_to AND dl.id <> 1170
```

---

## 6. Recommended canonical query

For "current demand load per recruiter, rolled up to DL":

```sql
SELECT
  u.id AS recruiter_id,
  CONCAT(u.first_name, ' ', u.last_name) AS recruiter,
  dl.id AS dl_id,
  CONCAT(dl.first_name, ' ', dl.last_name) AS dl,
  COUNT(DISTINCT jp.id)        AS open_demands,
  SUM(jp.no_of_opening)        AS open_openings,
  SUM(CASE WHEN DATEDIFF(CURDATE(), jp.created_at) > 30 THEN 1 ELSE 0 END) AS aged_30plus,
  SUM(CASE WHEN DATEDIFF(CURDATE(), jp.created_at) > 60 THEN 1 ELSE 0 END) AS aged_60plus
FROM job_assignments ja
  JOIN job_postings jp ON jp.id = ja.job_posting_id AND jp.status = 1
  JOIN clients c       ON c.user_id = jp.client_id  AND c.id NOT IN (1, 2)
  JOIN users u         ON u.id = ja.user_id
                       AND u.role_id = 3
                       AND u.locked = 0
  LEFT JOIN users dl   ON dl.id = u.reporting_to AND dl.id <> 1170
GROUP BY u.id, dl.id
ORDER BY open_demands DESC;
```

**Filter checklist (do not omit any of these):**

1. `jp.status = 1` — only active postings (statuses: 0=draft, 1=active, 2=closed, 3=on-hold).
2. `c.id NOT IN (1, 2)` — exclude internal test clients (J2W convention).
3. `u.role_id = 3` — only recruiters (filters out the small noise from candidate/finance/etc. role rows).
4. `u.locked = 0` — exclude locked accounts.
5. Optional: `INNER JOIN user_details ud ON ud.user_id = u.id AND ud.status = 0` — only "active in org" recruiters. The `locked = 0` check is necessary but not sufficient; `user_details.status = 0` is the authoritative active filter.
6. `dl.id <> 1170` — exclude the "Dummy Record Lead" catch-all.

**To roll up further to AM and BH**, extend the joins:

```sql
LEFT JOIN users am ON am.id = dl.reporting_to
LEFT JOIN users bh ON bh.id = am.reporting_to
```

…and handle the skipped-DL teams by also checking `LEFT JOIN users am2 ON am2.id = u.reporting_to` for cases where the recruiter reports straight to an AM.

---

## 7. Variants you may need

### 7.1 "Just this one recruiter's plate today"

```sql
SELECT jp.id, jp.title, c.company_name,
       jp.no_of_opening,
       jp.created_at,
       DATEDIFF(CURDATE(), jp.created_at) AS age_days,
       (SELECT COUNT(*) FROM applied_jobs aj
         WHERE aj.job_posting_id = jp.id
           AND aj.applied_by_id = ?              -- this recruiter
           AND aj.current_step NOT IN (3,6,8,12,17,22,49,76,83,84,85)  -- terminal/reject states
       ) AS active_candidates
FROM job_assignments ja
  JOIN job_postings jp ON jp.id = ja.job_posting_id AND jp.status = 1
  JOIN clients c ON c.user_id = jp.client_id AND c.id NOT IN (1, 2)
WHERE ja.user_id = ?                              -- this recruiter
ORDER BY active_candidates DESC, jp.created_at DESC;
```

The subquery on `applied_jobs` orders the recruiter's plate by where they have **live pipeline**, not just where they're assigned — the most useful sort for daily-stand-up views.

### 7.2 "Demands assigned but inactive" — staleness detection

A demand may be assigned to a recruiter via `job_assignments` but show zero recent submissions from them. That's a useful signal:

```sql
SELECT ja.user_id AS recruiter_id,
       jp.id AS demand_id,
       DATEDIFF(CURDATE(), ja.created_at) AS days_since_assigned,
       MAX(aj.created_at) AS last_submission_from_this_recruiter
FROM job_assignments ja
  JOIN job_postings jp ON jp.id = ja.job_posting_id AND jp.status = 1
  LEFT JOIN applied_jobs aj
    ON aj.job_posting_id = jp.id
   AND aj.applied_by_id = ja.user_id
   AND aj.current_step > 6  -- past Client Submit
GROUP BY ja.user_id, jp.id, ja.created_at
HAVING last_submission_from_this_recruiter IS NULL
    OR last_submission_from_this_recruiter < DATE_SUB(CURDATE(), INTERVAL 14 DAY);
```

### 7.3 Behavioral fallback — "what they're actually working"

If you ever need a per-recruiter demand list that doesn't depend on `job_assignments` at all (e.g. for a recruiter who isn't covered, or to validate the assignment data):

```sql
SELECT applied_by_id AS recruiter_id,
       job_posting_id AS demand_id,
       MAX(created_at) AS last_action_at,
       COUNT(*)        AS candidate_actions
FROM applied_jobs
WHERE applied_by_id = ?
  AND created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY applied_by_id, job_posting_id
ORDER BY last_action_at DESC;
```

This shows demands the recruiter has *behaviorally* worked in the last 30 days, regardless of formal assignment.

---

## 8. Caveats and known footguns

1. **Multi-recruiter demands are normal.** Do not assume one recruiter per posting. Always `COUNT(DISTINCT jp.id)` when aggregating.
2. **Assignments are not exclusive over time.** A recruiter may have been assigned a posting six months ago and never touched it. Combine with `applied_jobs` activity to distinguish "formally assigned" from "actually working."
3. **`job_assignments` does not itself record un-assignment.** There is no `is_active` or end-date column. If recruiter X was assigned to demand Y in 2019 and is still in the table, they "look" assigned today. In practice the `status = 1` filter on the parent posting eliminates almost all of these (closed postings → 2 or 3, not visible). For very-old still-open postings, `ja.updated_at` may help if you want a recency cap.
4. **`job_postings.status` is the only signal of "open."** There is no `closed_at` column. Status codes: 0=draft, 1=active, 2=closed, 3=on-hold. Only `1` should count as open demand.
5. **`expected_client_closure` is sparsely populated.** Don't rely on it as a recency filter.
6. **`clients.id NOT IN (1, 2)`** is a J2W convention — these IDs are internal/test. Always include this filter.
7. **The Dummy Record Lead (user 1170) corrupts DL-level rollups** if not filtered. 570 recruiters parked under it.
8. **Both 3-level and 4-level reporting chains exist.** Some recruiters report straight to AM (skipping DL). When walking `reporting_to`, accommodate both — examples in existing helper code handle this with an `am2` alias.
9. **`validation_screens.user_id` does not exist** (a common false assumption). Use `vs.applied_candidate_id` for the candidate FK, and join `applied_jobs` on **both** `job_posting_id` AND `aj.user_id = vs.applied_candidate_id` to get the right recruiter — joining on `job_posting_id` alone causes multi-attribution.
10. **Email reports filter by BH-customer ownership, not reporting chain.** A recruiter under DL X's chain may submit only for BH Y's customers; email reports show those numbers under BH Y. For real-time dashboards, the reporting-chain attribution is fine and preferable.
11. **The `applied_jobs.current_step` "terminal" states for filtering live pipeline** are: 3 (Validation Reject), 6 (Internal Reject), 8 (Client Screen Reject), 12 (L1 Reject), 17 (L2 Reject), 22 (L3 Reject), 49 (Duplicate Profile), 76 (Client Submit – Position On Hold), 83 (No Feedback), 84 (Client Submit – Position Closed), 85 (Closed by Client). Anything else >6 is "still in play."

---

## 9. Other things ruled out (so you don't repeat the search)

- `attendances` — last data 2022, uses employee codes not user IDs. Dead.
- `validation_screens.user_id` — column does not exist.
- Numeric step ranges (9–13 for L1, 14–18 for L2) for interview detection — miss the on-hold (75/77), position-closed (86–89), and panel-unavailable (109/110) variants. Use regex on `candidate_work_flows.workflow_step` text instead.
- `users.reporting_to` traversal alone for BH attribution — works for activity rollups, but doesn't match BH email reports because email reports filter by customer ownership.

---

## 10. Quick-reference summary

| Question | Answer |
|---|---|
| Which table maps a demand to a recruiter? | **`job_assignments(job_posting_id, user_id)`** |
| Is it reliable? | Yes — 93% coverage on all open demands, 97% on demands < 30 days old |
| Is it currently maintained? | Yes — 40K rows added in 2026 alone |
| What's the natural granularity? | Many-to-many; demands often have 5+ assigned recruiters |
| Which user roles appear in it? | Mostly recruiters (role_id=3); also DLs, AMs. Filter to `role_id = 3` for cleanliness |
| What's the must-have filter? | `jp.status = 1`, `c.id NOT IN (1, 2)`, `u.role_id = 3`, `u.locked = 0`, `dl.id <> 1170` |
| What rolls up to DL/AM/BH? | `users.reporting_to` chain — same one used for all other recruitment metrics |
| Can a single recruiter own a demand exclusively? | Rarely — most demands are parallel-sourced |
| What about un-assigned demands? | ~7%, almost all >90 days old; treat as legacy noise |
| Behavioral fallback if assignment data is suspect for a given recruiter? | `applied_jobs.applied_by_id` filtered to last 30 days |

---

## 11. Bottom line

**Use `job_assignments` joined to `job_postings.status = 1`, restrict `users.role_id = 3`, exclude the Dummy Lead and internal clients, and you have a clean, currently-maintained per-recruiter demand list. Roll up to DL/AM/BH via `reporting_to` exactly like every other recruitment metric.**
