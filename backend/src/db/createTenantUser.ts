// One-shot tenant user creator. Reads TENANT_USER_EMAIL / TENANT_USER_PASSWORD
// / TENANT_USER_NAME / TENANT_ORG_SLUG / TENANT_USER_ROLE from env. Creates
// the user (argon2-hashed, email-verified) and a membership in the named
// org. Idempotent — re-runs are safe. If the user exists, ensures the
// membership exists; if both exist, no-ops.
//
// Run via: pnpm --filter @j2w/api db:create-tenant-user
//
// Use case: provisioning known internal employees (recruiters / AMs / leads)
// directly during early-stage rollout, bypassing the /accept-invite email
// flow. Standard production flow is to invite via the /api/orgs/:id/invites
// surface; this script is for cases where the invite flow is overkill.
import "../env.js";
import { and, eq, sql } from "drizzle-orm";
import { db, memberships, organizations, ROLES, users } from "@j2w/db";
import { hashPassword } from "../auth/password.js";

async function main() {
  const email = (process.env.TENANT_USER_EMAIL || "").trim().toLowerCase();
  const password = process.env.TENANT_USER_PASSWORD || "";
  const name = (process.env.TENANT_USER_NAME || "").trim() || email.split("@")[0];
  const orgSlug = (process.env.TENANT_ORG_SLUG || "").trim().toLowerCase();
  const role = (process.env.TENANT_USER_ROLE || "").trim();

  if (!email || !password || !orgSlug || !role) {
    console.error(
      "TENANT_USER_EMAIL, TENANT_USER_PASSWORD, TENANT_ORG_SLUG, TENANT_USER_ROLE must be set",
    );
    process.exit(2);
  }
  if (!(ROLES as readonly string[]).includes(role)) {
    console.error(`TENANT_USER_ROLE must be one of: ${ROLES.join(", ")}`);
    process.exit(2);
  }

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug));
  if (!org) {
    console.error(`org with slug "${orgSlug}" not found`);
    process.exit(1);
  }

  let userId: string;
  const [existing] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);
  if (existing) {
    userId = existing.id;
    console.log(`user ${existing.email} exists (id=${userId})`);
  } else {
    const passwordHash = await hashPassword(password);
    const [created] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        name,
        emailVerifiedAt: new Date(),
      } as any)
      .returning({ id: users.id, email: users.email });
    userId = created.id;
    console.log(`created user: ${created.email} (id=${userId})`);
  }

  const [existingMembership] = await db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, org.id)));
  if (existingMembership) {
    console.log(
      `membership exists in ${org.name}: role=${existingMembership.role}, status=${existingMembership.status}`,
    );
    return;
  }

  await db.insert(memberships).values({
    userId,
    orgId: org.id,
    role: role as (typeof ROLES)[number],
    status: "active",
    joinedAt: new Date(),
  } as any);
  console.log(`created membership in ${org.name}: role=${role}, status=active`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
