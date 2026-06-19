// Taxonomy is global (skills/locations/industries/etc. are shared across
// every org), so this module never wipes — it only ensures the rows we
// reference exist. ON CONFLICT DO NOTHING leaves the DEFAULT_ORG_ID seed's
// catalog intact and just adds anything missing.
import {
  db,
  disqualificationReasons,
  functionalAreas,
  industries,
  jobRoles,
  locations,
  roleCategories,
  skills,
} from "@j2w/db";
import { sql } from "drizzle-orm";
import type { DemoContext } from "./context.js";

const SKILL_NAMES = [
  "Java", "Spring Boot", "Python", "Django", "FastAPI", "JavaScript", "TypeScript",
  "React", "Next.js", "Node.js", "Express", "AWS", "GCP", "Azure", "Kubernetes",
  "Docker", "Terraform", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Kafka",
  "GraphQL", "REST API", "Microservices", "System Design", "SQL", "Git",
  "CI/CD", "Linux",
];

const LOCATION_SPECS: Array<{ city: string; state: string }> = [
  { city: "Bengaluru", state: "Karnataka" },
  { city: "Mumbai", state: "Maharashtra" },
  { city: "Pune", state: "Maharashtra" },
  { city: "Hyderabad", state: "Telangana" },
  { city: "Chennai", state: "Tamil Nadu" },
  { city: "Gurgaon", state: "Haryana" },
  { city: "Noida", state: "Uttar Pradesh" },
  { city: "Delhi", state: "Delhi" },
];

const INDUSTRY_NAMES = [
  "BFSI", "Technology", "Fintech", "Pharma", "Healthcare", "Retail",
  "Automotive", "EdTech",
];
const FUNCTIONAL_AREA_NAMES = [
  "Engineering", "Data & Analytics", "Product", "Quality Engineering",
  "DevOps & SRE", "Security",
];
const ROLE_CATEGORY_NAMES = [
  "Backend", "Frontend", "Full-stack", "Data Engineering", "Data Science",
  "DevOps", "SRE", "QA / SDET", "Mobile", "Architect",
];
const JOB_ROLE_SEEDS: Array<{ name: string; category: string }> = [
  { name: "Java Backend Engineer", category: "Backend" },
  { name: "Python Backend Engineer", category: "Backend" },
  { name: "Senior Backend Engineer", category: "Backend" },
  { name: "Frontend Engineer (React)", category: "Frontend" },
  { name: "Senior Frontend Engineer", category: "Frontend" },
  { name: "Full-stack Engineer", category: "Full-stack" },
  { name: "Senior Full-stack Engineer", category: "Full-stack" },
  { name: "Data Engineer", category: "Data Engineering" },
  { name: "Senior Data Engineer", category: "Data Engineering" },
  { name: "Data Scientist", category: "Data Science" },
  { name: "DevOps Engineer", category: "DevOps" },
  { name: "Site Reliability Engineer", category: "SRE" },
  { name: "QA Automation Engineer", category: "QA / SDET" },
  { name: "Solutions Architect", category: "Architect" },
];
const DISQUALIFICATION_SEEDS = [
  { code: "experience_mismatch", label: "Experience mismatch", sortOrder: 10 },
  { code: "skill_mismatch", label: "Skill / tech-stack mismatch", sortOrder: 20 },
  { code: "location_mismatch", label: "Location mismatch", sortOrder: 30 },
  { code: "compensation_mismatch", label: "Compensation expectation mismatch", sortOrder: 40 },
  { code: "notice_period_mismatch", label: "Notice period mismatch", sortOrder: 50 },
  { code: "not_interested", label: "Candidate not interested", sortOrder: 60 },
  { code: "unreachable", label: "Candidate unreachable", sortOrder: 70 },
  { code: "duplicate", label: "Duplicate / already in pipeline", sortOrder: 80 },
  { code: "other", label: "Other", sortOrder: 999 },
];

export async function ensureDemoTaxonomy(ctx: DemoContext): Promise<void> {
  await db
    .insert(skills)
    .values(SKILL_NAMES.map((name) => ({ name })))
    .onConflictDoNothing();
  await db
    .insert(locations)
    .values(LOCATION_SPECS)
    .onConflictDoNothing();
  await db
    .insert(industries)
    .values(INDUSTRY_NAMES.map((name) => ({ name })))
    .onConflictDoNothing();
  await db
    .insert(functionalAreas)
    .values(FUNCTIONAL_AREA_NAMES.map((name) => ({ name })))
    .onConflictDoNothing();
  await db
    .insert(roleCategories)
    .values(ROLE_CATEGORY_NAMES.map((name) => ({ name })))
    .onConflictDoNothing();
  await db
    .insert(disqualificationReasons)
    .values(DISQUALIFICATION_SEEDS)
    .onConflictDoNothing();

  // Read back the IDs we'll need downstream.
  const skillRows = await db.select({ id: skills.id, name: skills.name }).from(skills);
  for (const r of skillRows) ctx.skillIdByName.set(r.name.toLowerCase(), r.id);

  const locRows = await db.select({ id: locations.id, city: locations.city }).from(locations);
  for (const r of locRows) ctx.locationIdByCity.set(r.city, r.id);

  const indRows = await db.select({ id: industries.id, name: industries.name }).from(industries);
  for (const r of indRows) ctx.industryIdByName.set(r.name, r.id);

  const faRows = await db.select({ id: functionalAreas.id, name: functionalAreas.name }).from(functionalAreas);
  for (const r of faRows) ctx.functionalAreaIdByName.set(r.name, r.id);

  const rcRows = await db.select({ id: roleCategories.id, name: roleCategories.name }).from(roleCategories);
  for (const r of rcRows) ctx.roleCategoryIdByName.set(r.name, r.id);

  // job_roles uniques on (name, role_category_id) — insert each via raw upsert
  // so re-runs are idempotent across both orgs.
  for (const j of JOB_ROLE_SEEDS) {
    const categoryId = ctx.roleCategoryIdByName.get(j.category);
    if (!categoryId) continue;
    await db.execute(sql`
      INSERT INTO job_roles (name, role_category_id)
      VALUES (${j.name}, ${sql`${categoryId}::uuid`})
      ON CONFLICT (name, role_category_id) DO NOTHING
    `);
  }
  const jrRows = await db.select({ id: jobRoles.id, name: jobRoles.name }).from(jobRoles);
  for (const r of jrRows) ctx.jobRoleIdByName.set(r.name, r.id);
}
