// Promote a user to platform-admin (super-admin). Run with:
//   pnpm --filter @j2w/api exec tsx src/db/promotePlatformAdmin.ts <email>
// Or via npm script: pnpm --filter @j2w/api db:promote-platform-admin <email>
//
// Platform admins have no membership; they administer tenants from the
// /api/platform/* routes. The user must already exist (sign them up via the
// invitation flow first, or insert manually); this script just flips the bit.
import "../env.js";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@j2w/db";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("usage: tsx src/db/promotePlatformAdmin.ts <email>");
    process.exit(2);
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`);

  if (!user) {
    console.error(`no user found with email ${email}`);
    console.error("hint: invite them via the existing /api/users/invite flow first");
    process.exit(1);
  }

  if (user.isPlatformAdmin) {
    console.log(`user ${user.email} is already a platform admin`);
    process.exit(0);
  }

  await db
    .update(users)
    .set({ isPlatformAdmin: true })
    .where(eq(users.id, user.id));

  console.log(`promoted ${user.email} (id=${user.id}) to platform admin`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
