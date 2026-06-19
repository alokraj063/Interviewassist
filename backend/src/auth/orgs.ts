// Helpers for provisioning orgs (slug generation + permission matrix seeding).
// Extracted so both the legacy /api/auth/signup path (now disabled) and the
// new /api/platform/orgs path can reuse the same logic.
import { eq, sql } from "drizzle-orm";
import { db, organizations } from "@j2w/db";

export function slugifyName(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export async function uniqueOrgSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const [existing] = await db.select().from(organizations).where(eq(organizations.slug, slug));
    if (!existing) return slug;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  throw new Error("could_not_generate_slug");
}

/**
 * Copy the default org's permission matrix into a new org so each role starts
 * with a sensible baseline. Admins can then edit via Settings → Roles.
 */
export async function seedRolePermissionsFromDefault(orgId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO role_permissions (org_id, role, permission)
    SELECT ${orgId}, role, permission FROM role_permissions
     WHERE org_id = '00000000-0000-0000-0000-000000000000'
    ON CONFLICT DO NOTHING
  `);
}
