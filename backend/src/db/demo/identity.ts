// Demo org row + the cast of users that populate every page. Volumes and
// names are tuned for visual variety on the recruiter and team-monitor
// surfaces, not stress testing.
import { db, memberships, organizations, users } from "@j2w/db";
import { sql } from "drizzle-orm";
import { hashPassword } from "../../auth/password.js";
import { seedRolePermissionsFromDefault } from "../../auth/orgs.js";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ORG_ID,
  DEMO_ORG_NAME,
  DEMO_ORG_SLUG,
  DEMO_PASSWORD,
  DEMO_USER_EMAIL_DOMAIN,
  VOLUMES,
} from "./constants.js";
import type { DemoContext, UserSpec } from "./context.js";

const RECRUITER_FIRST_NAMES = [
  "Anjali", "Rahul", "Sneha", "Vikram", "Priya", "Aditya",
  "Riya", "Karan", "Megha", "Suresh", "Neha", "Akash",
];
const RECRUITER_LAST_NAMES = [
  "Sharma", "Verma", "Iyer", "Nair", "Gupta", "Reddy",
  "Patel", "Khanna", "Mehta", "Joshi", "Pillai", "Rao",
];

function buildSpecs(): UserSpec[] {
  const specs: UserSpec[] = [
    {
      email: DEMO_ADMIN_EMAIL,
      name: "Demo Admin",
      role: "admin",
      jobTitle: "Workspace Admin",
    },
  ];

  for (let i = 0; i < VOLUMES.businessHeads; i += 1) {
    specs.push({
      email: `bh${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: ["Bharat Singh", "Bina Kapoor"][i] ?? `Business Head ${i + 1}`,
      role: "business_head",
      jobTitle: i === 0 ? "Business Head — Tech GCC" : "Business Head — Fintech",
    });
  }
  for (let i = 0; i < VOLUMES.accountManagers; i += 1) {
    specs.push({
      email: `am${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: ["Anita Rao", "Aniket Sharma", "Aarti Desai"][i] ?? `AM ${i + 1}`,
      role: "account_manager",
      jobTitle: "Account Manager",
      reportingToEmail: `bh${(i % VOLUMES.businessHeads) + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
    });
  }
  for (let i = 0; i < VOLUMES.deliveryLeads; i += 1) {
    specs.push({
      email: `dl${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: ["Divya Lead", "Dhiraj Lead", "Deepak Lead", "Diya Lead", "Devika Lead"][i] ?? `DL ${i + 1}`,
      role: "delivery_lead",
      jobTitle: "Delivery Lead",
      reportingToEmail: `am${(i % VOLUMES.accountManagers) + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
    });
  }
  for (let i = 0; i < VOLUMES.recruiters; i += 1) {
    const fn = RECRUITER_FIRST_NAMES[i % RECRUITER_FIRST_NAMES.length];
    const ln = RECRUITER_LAST_NAMES[i % RECRUITER_LAST_NAMES.length];
    specs.push({
      email: `recruiter${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: `${fn} ${ln}`,
      role: "recruiter",
      jobTitle: "Recruiter",
      reportingToEmail: `dl${(i % VOLUMES.deliveryLeads) + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
    });
  }
  for (let i = 0; i < VOLUMES.qa; i += 1) {
    specs.push({
      email: `qa${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: ["Quincy Mehta", "Quaid Shah"][i] ?? `QA ${i + 1}`,
      role: "qa_reviewer",
      jobTitle: "QA Reviewer",
    });
  }
  for (let i = 0; i < VOLUMES.proctors; i += 1) {
    specs.push({
      email: `proctor${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: "Pooja Proctor",
      role: "proctor",
      jobTitle: "Proctor",
    });
  }
  for (let i = 0; i < VOLUMES.clientUsers; i += 1) {
    specs.push({
      email: `client${i + 1}@${DEMO_USER_EMAIL_DOMAIN}`,
      name: "Cathy Client",
      role: "client_user",
      jobTitle: "Client Stakeholder",
    });
  }

  return specs;
}

export async function seedDemoIdentity(ctx: DemoContext): Promise<UserSpec[]> {
  await db
    .insert(organizations)
    .values({ id: DEMO_ORG_ID, name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG })
    .onConflictDoNothing();

  // Permission matrix: copy DEFAULT_ORG_ID's role_permissions so the demo
  // admin/recruiter/qa roles can actually see their sidebar entries. New
  // tenants normally get this via the platform-admin create-org flow; the
  // seed bypasses that flow, so we run the same baseline here.
  await seedRolePermissionsFromDefault(DEMO_ORG_ID);

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const specs = buildSpecs();

  const inserted = await db
    .insert(users)
    .values(
      specs.map((u) => ({
        email: u.email,
        passwordHash,
        name: u.name,
        jobTitle: u.jobTitle,
        emailVerifiedAt: new Date(),
        isPlatformAdmin: false,
      })),
    )
    .returning({ id: users.id, email: users.email });

  for (const r of inserted) ctx.userIdByEmail.set(r.email, r.id);

  await db.insert(memberships).values(
    specs.map((u) => ({
      userId: ctx.userIdByEmail.get(u.email)!,
      orgId: DEMO_ORG_ID,
      role: u.role,
      status: "active" as const,
      joinedAt: new Date(),
    })),
  );

  for (const u of specs) {
    if (!u.reportingToEmail) continue;
    const userId = ctx.userIdByEmail.get(u.email);
    const managerId = ctx.userIdByEmail.get(u.reportingToEmail);
    if (!userId || !managerId) continue;
    await db.execute(sql`
      UPDATE memberships SET reporting_to_user_id = ${managerId}
      WHERE user_id = ${userId} AND org_id = ${DEMO_ORG_ID}
    `);
  }

  ctx.adminUserId = ctx.userIdByEmail.get(DEMO_ADMIN_EMAIL)!;
  ctx.recruiterUserIds = specs
    .filter((s) => s.role === "recruiter")
    .map((s) => ctx.userIdByEmail.get(s.email)!);
  ctx.qaUserIds = specs
    .filter((s) => s.role === "qa_reviewer")
    .map((s) => ctx.userIdByEmail.get(s.email)!);
  ctx.deliveryLeadUserIds = specs
    .filter((s) => s.role === "delivery_lead")
    .map((s) => ctx.userIdByEmail.get(s.email)!);
  ctx.accountManagerUserIds = specs
    .filter((s) => s.role === "account_manager")
    .map((s) => ctx.userIdByEmail.get(s.email)!);
  ctx.proctorUserIds = specs
    .filter((s) => s.role === "proctor")
    .map((s) => ctx.userIdByEmail.get(s.email)!);
  ctx.clientUserIds = specs
    .filter((s) => s.role === "client_user")
    .map((s) => ctx.userIdByEmail.get(s.email)!);

  return specs;
}
