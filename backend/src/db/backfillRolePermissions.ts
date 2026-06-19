// One-off backfill: copy any missing role_permissions rows from the default
// org (00000000-0000-0000-0000-000000000000) into every other org. Use after
// adding new permissions to the seeded matrix so existing tenants gain the
// new sidebar entries / route gates without manual matrix-editing.
//
// Idempotent: ON CONFLICT DO NOTHING ensures repeated runs are safe.
//
// Run with: pnpm --filter @j2w/api exec tsx src/db/backfillRolePermissions.ts
import "../env.js";
import { sql } from "drizzle-orm";
import { db, organizations } from "@j2w/db";

async function run() {
  const orgs = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  console.log(`Found ${orgs.length} org(s).`);

  for (const o of orgs) {
    if (o.id === "00000000-0000-0000-0000-000000000000") {
      console.log(`Skipping default org ${o.name} (source of truth).`);
      continue;
    }
    const before = await db.execute(sql`SELECT COUNT(*)::int AS c FROM role_permissions WHERE org_id = ${o.id}`);
    const beforeCount = (before.rows?.[0] as { c: number } | undefined)?.c ?? 0;

    await db.execute(sql`
      INSERT INTO role_permissions (org_id, role, permission)
      SELECT ${o.id}, role, permission
        FROM role_permissions
       WHERE org_id = '00000000-0000-0000-0000-000000000000'
      ON CONFLICT DO NOTHING
    `);

    const after = await db.execute(sql`SELECT COUNT(*)::int AS c FROM role_permissions WHERE org_id = ${o.id}`);
    const afterCount = (after.rows?.[0] as { c: number } | undefined)?.c ?? 0;

    console.log(`Org ${o.name} (${o.id}): ${beforeCount} → ${afterCount} role_permissions (added ${afterCount - beforeCount}).`);
  }
}

run()
  .then(() => {
    console.log("backfill complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
