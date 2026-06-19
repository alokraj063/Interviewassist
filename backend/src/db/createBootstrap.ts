// One-shot bootstrap admin creator. Reads BOOTSTRAP_ADMIN_EMAIL/PASSWORD
// from env, argon2-hashes the password via the app's hashPassword helper,
// and inserts the user with is_platform_admin = true and email_verified_at
// set to now. Idempotent: if the user already exists, just promotes them.
//
// Run via: pnpm --filter @j2w/api db:bootstrap-admin
//
// First-deploy use: migrate.ts is a pure SQL runner and does not bootstrap
// any users. Public signup is closed (POST /api/auth/signup → 410). So on a
// fresh DB the only way to land a first user is this script (or a raw SQL
// insert). After this user exists they're a platform admin and can sign in
// at /platform/* to provision tenant orgs.
import "../env.js";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@j2w/db";
import { hashPassword } from "../auth/password.js";

async function main() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set");
    process.exit(2);
  }

  const [existing] = await db
    .select({ id: users.id, email: users.email, isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);

  if (existing) {
    if (!existing.isPlatformAdmin) {
      await db.update(users).set({ isPlatformAdmin: true }).where(eq(users.id, existing.id));
      console.log(`promoted existing user ${existing.email} to platform admin`);
    } else {
      console.log(`user ${existing.email} already exists and is platform admin`);
    }
    return;
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      name: email.split("@")[0],
      emailVerifiedAt: new Date(),
      isPlatformAdmin: true,
    } as any)
    .returning({ id: users.id, email: users.email });

  console.log(`created platform admin: ${created.email} (id=${created.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
