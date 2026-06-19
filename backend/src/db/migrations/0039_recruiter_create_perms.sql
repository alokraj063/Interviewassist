-- 0039: let the recruiter role create JDs (demands) and link question banks.
-- This makes the Live Assist "Settings" tab (add candidates / add jobs /
-- link a question bank to a JD) fully usable by the recruiter persona, not
-- just admins/account-managers. Candidates were already writable by recruiters.

-- Default org (source of truth for backfillRolePermissions.ts).
INSERT INTO role_permissions (org_id, role, permission)
SELECT '00000000-0000-0000-0000-000000000000', x.r, x.p
FROM (VALUES
  ('recruiter','demands.write'),
  ('recruiter','question_banks.write')
) AS x(r, p)
ON CONFLICT DO NOTHING;

-- Mirror the same grants into every other org that already has rows.
INSERT INTO role_permissions (org_id, role, permission)
SELECT DISTINCT rp.org_id, x.r, x.p
FROM role_permissions rp
CROSS JOIN (VALUES
  ('recruiter','demands.write'),
  ('recruiter','question_banks.write')
) AS x(r, p)
ON CONFLICT DO NOTHING;
