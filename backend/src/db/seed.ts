// Mongo seed — demo org, users, role permissions, and a little demo data
// (clients / demands / candidates / question bank) so the Live Assist feature
// is usable immediately. Idempotent: wipes the feature collections and re-inserts.
//
//   pnpm db:seed
import { randomUUID } from "node:crypto";
import "../env.js";
import { connectMongo, ensureIndexes, collections, closeMongo } from "../mongo.js";
import { hashPassword } from "../auth/password.js";

const ORG_ID = "00000000-0000-0000-0000-000000000000";
const PASSWORD = "Recruiter#2026";

const RECRUITER_PERMS = [
  "demands.read", "demands.write", "candidates.read", "candidates.write",
  "prospects.read", "prospects.write", "calls.read", "calls.write", "calls.end",
  "question_banks.read", "question_banks.write", "live_assist.read",
  "workspace.read", "users.read", "teams.read", "roles.read",
];
const ADMIN_PERMS = [...RECRUITER_PERMS, "demands.assign", "clients.write", "platform.read"];

async function run() {
  await connectMongo();
  await ensureIndexes();
  const now = new Date();

  for (const c of [
    collections.organizations(), collections.users(), collections.memberships(),
    collections.rolePermissions(), collections.clients(), collections.demands(),
    collections.candidates(), collections.prospects(), collections.questionBanks(),
    collections.questionBankQuestions(), collections.questionBankDemandLinks(),
  ]) {
    await c.deleteMany({});
  }

  await collections.organizations().insertOne({ id: ORG_ID, name: "JoulesToWatts", createdAt: now });

  const permRows = [
    ...RECRUITER_PERMS.map((p) => ({ orgId: ORG_ID, role: "recruiter", permission: p })),
    ...ADMIN_PERMS.map((p) => ({ orgId: ORG_ID, role: "admin", permission: p })),
  ];
  await collections.rolePermissions().insertMany(permRows);

  const hash = await hashPassword(PASSWORD);
  const mkUser = (email: string, name: string) => ({
    id: randomUUID(), email, emailNormalized: email.toLowerCase(), name,
    passwordHash: hash, isPlatformAdmin: false, suspendedAt: null,
    emailVerifiedAt: now, mfaEnrolledAt: null, lastActiveAt: null, createdAt: now,
  });
  const recruiter = mkUser("recruiter1@recruitassist.local", "Recruiter One");
  const admin = mkUser("admin@recruitassist.local", "Admin");
  await collections.users().insertMany([recruiter, admin]);
  await collections.memberships().insertMany([
    { id: randomUUID(), userId: recruiter.id, orgId: ORG_ID, role: "recruiter", status: "active", createdAt: now },
    { id: randomUUID(), userId: admin.id, orgId: ORG_ID, role: "admin", status: "active", createdAt: now },
  ]);

  const clientId = randomUUID();
  await collections.clients().insertOne({ id: clientId, orgId: ORG_ID, companyName: "Acme GCC India", createdAt: now });

  const demand = {
    id: randomUUID(), orgId: ORG_ID, clientId, title: "Senior Java Backend Engineer",
    designation: "Senior Java Backend Engineer",
    description: "Must have: Java, Spring Boot, Microservices, Kafka, AWS. 5+ years building production backend systems.",
    responsibilities: null, experienceMinYears: "5", experienceMaxYears: "9",
    salaryFrom: "22", salaryTo: "38", primaryLocation: "Bengaluru",
    status: "active", isVip: true, probingDetails: { workMode: "hybrid" }, createdAt: now, updatedAt: now,
  };
  await collections.demands().insertOne(demand);

  const mkCandidate = (first: string, title: string, company: string, yrs: string, loc: string) => ({
    id: randomUUID(), orgId: ORG_ID, firstName: first, lastName: null,
    displayName: first, email: `${first.toLowerCase()}@example-candidate.com`, phone: null,
    currentTitle: title, currentCompany: company, totalExperienceYears: yrs,
    currentCtcLakhs: null, expectedCtcLakhs: null, noticePeriodDays: 30, currentLocation: loc,
    source: "direct", createdAt: now,
  });
  await collections.candidates().insertMany([
    mkCandidate("Aarav", "Backend Engineer", "Razorpay", "6", "Bengaluru"),
    mkCandidate("Rudra", "Frontend Engineer", "Swiggy", "2", "Kochi"),
  ]);

  const bankId = randomUUID();
  await collections.questionBanks().insertOne({
    id: bankId, orgId: ORG_ID, name: "Java + Spring Backend", description: "Backend screening questions.",
    status: "active", defaultLanguage: "en", version: 1, archivedAt: null, createdAt: now, updatedAt: now,
  });
  const qs: Array<[string, string]> = [
    ["Easy", "What is the JVM and its role in Java apps?"],
    ["Medium", "How do you handle transactions in Spring Boot?"],
    ["Hard", "Explain Kafka consumer rebalancing and how to avoid storms."],
  ];
  await collections.questionBankQuestions().insertMany(qs.map(([level, prompt]) => ({
    id: randomUUID(), orgId: ORG_ID, bankId, level: level.toLowerCase(), difficulty: 3,
    prompt, skillId: null, language: "en", questionType: "verbal", roleFamily: "backend",
    expectedAnswerHints: null, followUpQuestions: [], status: "approved", createdAt: now, updatedAt: now,
  })));
  await collections.questionBankDemandLinks().insertOne({ bankId, demandId: demand.id });

  console.log("[seed] done — org, role permissions, users (recruiter1 / admin, password Recruiter#2026), 1 client, 1 demand, 2 candidates, 1 question bank.");
  await closeMongo();
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
