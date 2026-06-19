// RecruitAssist demo seed.
//
// Idempotent: wipes all ATS-domain rows under the default org (clients,
// demands, candidates, prospects, submissions, rubrics, question banks,
// taxonomy, plus the seeded users/memberships) and recreates them so a
// developer can re-run this any time without duplicates piling up.
//
// Auth-side rows (default organization, role permissions) are preserved
// since they're created by migration 0001/0010.
//
// Run with:  pnpm --filter @j2w/api db:seed
//
// Seeded login: every user gets the same dev password (`Recruiter#2026`)
// so you can sign in as any persona without keeping a list. Names are
// deterministic so re-running the seed gives stable test fixtures.

// Load .env before any module that reads env vars (the db client in @j2w/db
// reads DATABASE_URL at first use). Same pattern as seedAgents.ts.
import "../env.js";
import {
  assessmentAttempts,
  assessmentTemplates,
  asyncVideoAiArtifacts,
  asyncVideoAuditLog,
  asyncVideoCampaigns,
  asyncVideoQuestions,
  asyncVideoScorecards,
  asyncVideoShareLinks,
  asyncVideoSubmissions,
  candidates,
  candidateExperiences,
  candidateQualifications,
  candidateSkills,
  analyticsSavedViews,
  analyticsScheduledReports,
  analyticsExportJobs,
  callQaReviews,
  callRubrics,
  callSessions,
  clients,
  clientRecruiters,
  coachingScenarios,
  coachingRuns,
  coachingRunScores,
  coachingCurricula,
  coachingAssignments,
  coachingAuditEvents,
  db,
  DEFAULT_ORG_ID,
  demandAssignments,
  demandLocations,
  demandSkills,
  demands,
  disqualificationReasons,
  functionalAreas,
  industries,
  jobRoles,
  kbSources,
  documents,
  kbCollections,
  kbCollectionGrants,
  kbRetrievalEvents,
  kbEvalSuites,
  kbEvalCases,
  kbEvalRuns,
  kbEvalRunCases,
  kbAnswerFeedback,
  kbAudit,
  JOULESTOWATTS_ADMIN_EMAIL,
  JOULESTOWATTS_ORG_ID,
  JOULESTOWATTS_ORG_SLUG,
  locations,
  memberships,
  organizations,
  PROCTOR_SIGNAL_KINDS,
  proctorAuditEvents,
  proctorEvents,
  proctorIdentityChecks,
  proctorInterventions,
  proctorPolicies,
  proctorSessions,
  prospects,
  qaSamplingPolicies,
  qaQueueItems,
  qaGoldAnswers,
  qaCalibrationSessions,
  qaDisputes,
  qaAuditEvents,
  questionBanks,
  questionBankQuestions,
  questionVersions,
  questionReviews,
  questionUsageEvents,
  questionBankAudit,
  recruiterAdminEvents,
  recruiterCapacity,
  recruiterGoals,
  recruiterLeaderboards,
  recruiterNudges,
  roleCategories,
  type RubricCriterion,
  type ProctorSignalConfig,
  skills,
  submissions,
  submissionStageTransitions,
  recruiterPresence,
  callSupervisionSessions,
  teamSlaPolicies,
  teamAlerts,
  teamMonitorAudit,
  callRoutingEvents,
  triageAuditEvents,
  triageRoutingRules,
  triageRuleSets,
  voiceAgents,
  teams,
  teamMembers,
  users,
} from "@j2w/db";
import { randomUUID, createHash } from "node:crypto";
import { eq, sql, and, desc } from "drizzle-orm";
import { hashPassword } from "../auth/password.js";
import {
  computeRiskScore,
  DEFAULT_SIGNAL_SEVERITY,
  DEFAULT_SIGNAL_WEIGHTS,
  type RiskEventLike,
} from "../proctor/risk.js";
import { seedRichAssessmentsForOrg } from "./demo/assessments.js";

const SEED_PASSWORD = "Recruiter#2026";

interface UserSpec {
  email: string;
  name: string;
  role:
    | "recruiter"
    | "delivery_lead"
    | "account_manager"
    | "business_head"
    | "qa_reviewer"
    | "admin"
    | "client_user"
    | "proctor";
  jobTitle: string;
  reportingToEmail?: string;
  isPlatformAdmin?: boolean;
}

const USER_SPECS: UserSpec[] = [
  // Admins (2)
  { email: "admin@recruitassist.local", name: "Asha Admin", role: "admin", jobTitle: "Workspace Admin" },
  { email: "ops@recruitassist.local", name: "Omar Ops", role: "admin", jobTitle: "Workspace Admin" },

  // Business heads (5)
  { email: "bh1@recruitassist.local", name: "Bharat Singh", role: "business_head", jobTitle: "Business Head — BFSI" },
  { email: "bh2@recruitassist.local", name: "Bina Kapoor", role: "business_head", jobTitle: "Business Head — Tech GCC" },
  { email: "bh3@recruitassist.local", name: "Balaji Iyer", role: "business_head", jobTitle: "Business Head — Pharma" },
  { email: "bh4@recruitassist.local", name: "Beena Joshi", role: "business_head", jobTitle: "Business Head — Retail" },
  { email: "bh5@recruitassist.local", name: "Bhavesh Patel", role: "business_head", jobTitle: "Business Head — Auto" },

  // Account managers (8)
  { email: "am1@recruitassist.local", name: "Anita Rao", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh2@recruitassist.local" },
  { email: "am2@recruitassist.local", name: "Aniket Sharma", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh2@recruitassist.local" },
  { email: "am3@recruitassist.local", name: "Aarti Desai", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh1@recruitassist.local" },
  { email: "am4@recruitassist.local", name: "Ajay Menon", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh1@recruitassist.local" },
  { email: "am5@recruitassist.local", name: "Akhil Verma", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh3@recruitassist.local" },
  { email: "am6@recruitassist.local", name: "Anjali Nair", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh4@recruitassist.local" },
  { email: "am7@recruitassist.local", name: "Arvind Khanna", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh5@recruitassist.local" },
  { email: "am8@recruitassist.local", name: "Ayesha Khan", role: "account_manager", jobTitle: "Account Manager", reportingToEmail: "bh2@recruitassist.local" },

  // Delivery leads (12)
  ...Array.from({ length: 12 }, (_, i): UserSpec => ({
    email: `dl${i + 1}@recruitassist.local`,
    name: ["Divya", "Dhiraj", "Deepak", "Diya", "Dev", "Daksh", "Damini", "Dipti", "Devika", "Dinesh", "Drishti", "Dilip"][i] + ` Lead${i + 1}`,
    role: "delivery_lead",
    jobTitle: "Delivery Lead",
    reportingToEmail: `am${(i % 8) + 1}@recruitassist.local`,
  })),

  // Recruiters (40)
  ...Array.from({ length: 40 }, (_, i): UserSpec => {
    const firstNames = [
      "Riya", "Rahul", "Reema", "Rohan", "Ruchi", "Ravi", "Renuka", "Rajat",
      "Roshni", "Rishi", "Rina", "Rakesh", "Radhika", "Ranjit", "Rekha", "Raj",
      "Riya", "Rohit", "Rupali", "Ramesh", "Rashmi", "Ritu", "Rajeev", "Rashi",
      "Rina", "Roopa", "Rishabh", "Rena", "Ronak", "Rumi", "Rakhi", "Rohan",
      "Reshma", "Rajiv", "Rinku", "Rohini", "Ronit", "Rashmi", "Ravi", "Radha",
    ];
    return {
      email: `recruiter${i + 1}@recruitassist.local`,
      name: `${firstNames[i]} R${i + 1}`,
      role: "recruiter",
      jobTitle: "Recruiter",
      reportingToEmail: `dl${(i % 12) + 1}@recruitassist.local`,
    };
  }),

  // QA reviewers (3)
  { email: "qa1@recruitassist.local", name: "Quincy Mehta", role: "qa_reviewer", jobTitle: "QA Reviewer" },
  { email: "qa2@recruitassist.local", name: "Quaid Shah", role: "qa_reviewer", jobTitle: "QA Reviewer" },
  { email: "qa3@recruitassist.local", name: "Qutub Ali", role: "qa_reviewer", jobTitle: "QA Reviewer" },

  // Placeholder roles (1 each)
  { email: "client@example-gcc.local", name: "Cathy Client", role: "client_user", jobTitle: "Client User (placeholder)" },
  { email: "proctor1@recruitassist.local", name: "Pooja Proctor", role: "proctor", jobTitle: "Proctor (placeholder)" },
];

const CLIENT_SPECS = [
  { name: "AcmeCorp GCC India", industry: "BFSI", tier: "strategic", bhEmail: "bh1@recruitassist.local" },
  { name: "OmniBank Tech Center", industry: "BFSI", tier: "strategic", bhEmail: "bh1@recruitassist.local" },
  { name: "GlobalMed Pharma", industry: "Pharma", tier: "growth", bhEmail: "bh3@recruitassist.local" },
  { name: "QuantumPay Capability Hub", industry: "Fintech", tier: "strategic", bhEmail: "bh2@recruitassist.local" },
  { name: "NovaTech Bangalore GCC", industry: "Technology", tier: "strategic", bhEmail: "bh2@recruitassist.local" },
  { name: "VeloRetail Engineering", industry: "Retail", tier: "growth", bhEmail: "bh4@recruitassist.local" },
  { name: "AutoMakers India Tech", industry: "Automotive", tier: "growth", bhEmail: "bh5@recruitassist.local" },
  { name: "AeroDynamics R&D Center", industry: "Aerospace", tier: "standard", bhEmail: "bh2@recruitassist.local" },
  { name: "BioGenix Labs", industry: "Pharma", tier: "growth", bhEmail: "bh3@recruitassist.local" },
  { name: "EduFirst Online Schooling", industry: "EdTech", tier: "standard", bhEmail: "bh4@recruitassist.local" },
];

const SKILL_SPECS = [
  { name: "Java", aliases: ["Java SE", "Java EE", "Core Java"] },
  { name: "Spring Boot", aliases: ["Spring", "SpringBoot"] },
  { name: "Python", aliases: ["Python 3"] },
  { name: "Django", aliases: [] },
  { name: "FastAPI", aliases: [] },
  { name: "JavaScript", aliases: ["JS", "ECMAScript"] },
  { name: "TypeScript", aliases: ["TS"] },
  { name: "React", aliases: ["ReactJS", "React.js"] },
  { name: "Next.js", aliases: ["NextJS"] },
  { name: "Node.js", aliases: ["NodeJS", "Node"] },
  { name: "Express", aliases: ["ExpressJS"] },
  { name: "AWS", aliases: ["Amazon Web Services"] },
  { name: "GCP", aliases: ["Google Cloud", "Google Cloud Platform"] },
  { name: "Azure", aliases: ["Microsoft Azure"] },
  { name: "Kubernetes", aliases: ["k8s"] },
  { name: "Docker", aliases: [] },
  { name: "Terraform", aliases: ["IaC"] },
  { name: "PostgreSQL", aliases: ["Postgres", "PG"] },
  { name: "MySQL", aliases: [] },
  { name: "MongoDB", aliases: ["Mongo"] },
  { name: "Redis", aliases: [] },
  { name: "Kafka", aliases: ["Apache Kafka"] },
  { name: "GraphQL", aliases: [] },
  { name: "REST API", aliases: ["REST", "RESTful API"] },
  { name: "Microservices", aliases: [] },
  { name: "System Design", aliases: ["High-Level Design", "HLD"] },
  { name: "SQL", aliases: ["Structured Query Language"] },
  { name: "Git", aliases: [] },
  { name: "CI/CD", aliases: ["Continuous Integration"] },
  { name: "Linux", aliases: [] },
];

const LOCATION_SPECS = [
  { city: "Bengaluru", state: "Karnataka" },
  { city: "Mumbai", state: "Maharashtra" },
  { city: "Pune", state: "Maharashtra" },
  { city: "Hyderabad", state: "Telangana" },
  { city: "Chennai", state: "Tamil Nadu" },
  { city: "Gurgaon", state: "Haryana" },
  { city: "Noida", state: "Uttar Pradesh" },
  { city: "Delhi", state: "Delhi" },
  { city: "Ahmedabad", state: "Gujarat" },
  { city: "Kolkata", state: "West Bengal" },
  { city: "Kochi", state: "Kerala" },
  { city: "Trivandrum", state: "Kerala" },
  { city: "Indore", state: "Madhya Pradesh" },
  { city: "Jaipur", state: "Rajasthan" },
  { city: "Coimbatore", state: "Tamil Nadu" },
];

const INDUSTRY_NAMES = [
  "BFSI", "Technology", "Fintech", "Pharma", "Healthcare", "Retail", "Automotive",
  "Aerospace", "EdTech", "Telecom", "Manufacturing", "Logistics",
];

const FUNCTIONAL_AREA_NAMES = [
  "Engineering", "Data & Analytics", "Product", "Design", "Quality Engineering",
  "DevOps & SRE", "Security", "Project Management", "Customer Success",
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
  { name: "ML Engineer", category: "Data Science" },
  { name: "DevOps Engineer", category: "DevOps" },
  { name: "Senior DevOps Engineer", category: "DevOps" },
  { name: "Site Reliability Engineer", category: "SRE" },
  { name: "QA Automation Engineer", category: "QA / SDET" },
  { name: "Senior SDET", category: "QA / SDET" },
  { name: "iOS Engineer", category: "Mobile" },
  { name: "Android Engineer", category: "Mobile" },
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

interface SeededIds {
  userIdByEmail: Map<string, string>;
  clientIdByName: Map<string, string>;
  skillIdByName: Map<string, string>;
  locationIdByCity: Map<string, string>;
  industryIdByName: Map<string, string>;
  functionalAreaIdByName: Map<string, string>;
  roleCategoryIdByName: Map<string, string>;
  jobRoleIdByName: Map<string, string>;
  demandIds: string[];
  candidateIds: string[];
}

function defaultRubricCriteria(): RubricCriterion[] {
  return [
    {
      id: "script_adherence",
      name: "Script adherence",
      description: "Did the recruiter follow the standard intro and qualification flow?",
      weight: 0.15,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: true,
      kind: "script_adherence",
    },
    {
      id: "jd_coverage",
      name: "JD coverage",
      description: "Did the recruiter probe the must-have skills and responsibilities from the JD?",
      weight: 0.25,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: true,
      kind: "jd_coverage",
    },
    {
      id: "salary_handling",
      name: "Compensation handling",
      description: "Were CTC expectations and salary range positioning handled cleanly?",
      weight: 0.2,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: false,
      kind: "salary_handling",
    },
    {
      id: "positioning",
      name: "Client positioning",
      description: "Was the client and the role positioned with relevant context (industry, scale, growth)?",
      weight: 0.15,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: true,
      kind: "positioning",
    },
    {
      id: "candidate_experience",
      name: "Candidate experience",
      description: "Did the recruiter give the candidate space to ask questions and respond to objections?",
      weight: 0.25,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: false,
      kind: "candidate_experience",
    },
  ];
}

function technicalRubricCriteria(): RubricCriterion[] {
  return [
    ...defaultRubricCriteria(),
    {
      id: "technical_depth",
      name: "Technical depth",
      description: "Did the recruiter probe technical skills with depth-appropriate questions?",
      weight: 0.3,
      bandThresholds: { fail: 40, pass: 65, excellent: 85 },
      autoScoreEnabled: true,
      kind: "technical_depth",
    },
  ];
}

function rngSeeded(seed: number): () => number {
  // Mulberry32 — small, deterministic PRNG so re-seeding yields stable IDs.
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

async function wipeAtsData(): Promise<void> {
  // Org-scoped to the demo workspace so the JoulesToWatts tenant's data
  // (synced from the Offer Letter MySQL DB) is never touched. Child rows
  // ride out via ON DELETE CASCADE — see schema.ts for the FK declarations.
  const demoOrg = sql`${DEFAULT_ORG_ID}::uuid`;

  // Cascade-bearing parents under the demo org. Order is FK-safe but most
  // children would also disappear via CASCADE if we got it wrong.
  // call_rubrics cascades ON DELETE SET NULL onto rubric_audit_log.rubric_id
  // (an UPDATE the append-only immutability trigger would block). Disable the
  // trigger for the duration of the maintenance delete, inside one transaction.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE rubric_audit_log DISABLE TRIGGER rubric_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM rubric_audit_log WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM call_rubrics       WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`ALTER TABLE rubric_audit_log ENABLE TRIGGER rubric_audit_log_no_mutate`);
  });

  // Coaching enterprise domain rows (scenarios/runs/scores/curricula/assignments
  // /audit). Delete BEFORE call_rubrics (scenarios.target_rubric_id is SET NULL)
  // and call_sessions (runs.call_id SET NULL) wipes — coaching rows are fully
  // re-created by seedCoachingForDefaultOrg. Order is FK-safe (children first):
  // audit + scores cascade off runs/scenarios, assignments off scenarios/runs,
  // but delete each explicitly by org_id for idempotency (org-wide audit rows
  // with NULL target ids wouldn't ride a cascade).
  await db.execute(sql`DELETE FROM coaching_audit_events WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM coaching_run_scores   WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM coaching_assignments  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM coaching_curricula    WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM coaching_runs         WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM coaching_scenarios    WHERE org_id = ${demoOrg}`);

  // Analytics report-engine demo rows (saved views / scheduled reports / export
  // jobs). Org-scoped; no append-only trigger so plain DELETE. Order is FK-safe
  // (children first): scheduled_reports + export_jobs reference saved_views,
  // export_jobs has no FK to submissions/candidates so this can run any time.
  await db.execute(sql`DELETE FROM analytics_export_jobs       WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM analytics_scheduled_reports WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM analytics_saved_views       WHERE org_id = ${demoOrg}`);

  // Knowledge-Base enterprise demo rows (collections/grants/telemetry/eval/
  // feedback/audit + the kb_sources/documents seeded for the default org).
  // Order is FK-safe (children first); kb_audit + kb_retrieval_events + feedback
  // carry org_id and have no append-only trigger so plain DELETE. Eval run-cases
  // CASCADE off runs, cases off suites, but delete each by org/suite for
  // idempotency. kb_sources rows seeded into the default org are removed last so
  // a re-seed starts clean (the rich DEMO_ORG sources are untouched).
  await db.execute(sql`DELETE FROM kb_audit              WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM kb_answer_feedback    WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM kb_retrieval_events   WHERE org_id = ${demoOrg}`);
  await db.execute(sql`
    DELETE FROM kb_eval_run_cases
    WHERE run_id IN (SELECT id FROM kb_eval_runs WHERE org_id = ${demoOrg})
  `);
  await db.execute(sql`DELETE FROM kb_eval_runs          WHERE org_id = ${demoOrg}`);
  await db.execute(sql`
    DELETE FROM kb_eval_cases
    WHERE suite_id IN (SELECT id FROM kb_eval_suites WHERE org_id = ${demoOrg})
  `);
  await db.execute(sql`DELETE FROM kb_eval_suites        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM kb_collection_grants  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`
    DELETE FROM documents
    WHERE source_id IN (SELECT id FROM kb_sources WHERE org_id = ${demoOrg})
  `);
  await db.execute(sql`DELETE FROM kb_sources            WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM kb_collections        WHERE org_id = ${demoOrg}`);

  // Proctor cockpit demo rows (sessions/events/identity/interventions/audit/
  // policies). Deleting policies + sessions cascades children; audit rows for
  // policy.update (session_id NULL) are removed explicitly. assessment_templates
  // + attempts created by the proctor seed cascade their proctor_sessions.
  await db.execute(sql`DELETE FROM proctor_audit_events  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM proctor_sessions      WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM proctor_policies      WHERE org_id = ${demoOrg}`);
  // assessment_audit_log is append-only (assessment_audit_log_no_mutate trigger
  // blocks DELETE). The rich assessment seed writes audit rows that would be
  // CASCADE-deleted when their template is removed — that CASCADE delete trips
  // the trigger. Disable it for the duration of the maintenance delete, inside
  // one transaction, mirroring the rubric_audit_log handling above. Also clear
  // assessment child tables (sections/items/versions) explicitly even though
  // they CASCADE — order is FK-safe and idempotent.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE assessment_audit_log DISABLE TRIGGER assessment_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM assessment_audit_log WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM assessment_attempts   WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM assessment_items      WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM assessment_versions   WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM assessment_sections   WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM assessment_templates  WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`ALTER TABLE assessment_audit_log ENABLE TRIGGER assessment_audit_log_no_mutate`);
  });
  // QA Review enterprise demo rows. Delete before call_qa_reviews / call_sessions:
  // queue_items / gold / disputes / audit reference those (CASCADE or SET NULL),
  // but policies + calibration sessions are org-scoped and survive the call wipe,
  // so clear the whole QA domain explicitly. Order is FK-safe (children first).
  await db.execute(sql`DELETE FROM qa_audit_events        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM qa_disputes            WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM qa_calibration_sessions WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM qa_gold_answers        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM qa_queue_items         WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM qa_sampling_policies   WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM call_qa_reviews    WHERE org_id = ${demoOrg}`);
  // Triage enterprise demo rows. Order: audit + rule sets + rules first
  // (triage_routing_rules.rule_set_id is ON DELETE SET NULL, but explicit
  // delete keeps it tidy), then the triage voice_agents the seed creates.
  // call_routing_events are scoped via org_id and cascade off call_sessions;
  // delete them explicitly so triage rules (rule_id FK SET NULL) clear cleanly.
  await db.execute(sql`DELETE FROM triage_audit_events  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM call_routing_events  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM triage_routing_rules WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM triage_rule_sets     WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM voice_agents         WHERE org_id = ${demoOrg} AND kind = 'triage'`);
  // Recruiter-call sessions (and their cascading transcript/score/qa children).
  // The seed re-creates a fresh, candidate-linked set so the QA review queue and
  // team-monitor surfaces are non-empty for the DEFAULT-org admin persona. This
  // also clears any stale legacy call_sessions whose candidate/recruiter FKs were
  // SET NULL by prior wipes (they showed up blank in the queue).
  await db.execute(sql`DELETE FROM call_sessions      WHERE org_id = ${demoOrg}`);
  // Async-video campaigns (cascade their questions/submissions/scorecards/etc).
  // async_video_audit_log is append-only (async_video_audit_log_no_mutate trigger
  // blocks DELETE) — both the explicit delete and the campaign-cascade trip it.
  // Disable the trigger for the maintenance delete inside one transaction, same
  // as rubric_audit_log / assessment_audit_log above.
  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE async_video_audit_log DISABLE TRIGGER async_video_audit_log_no_mutate`);
    await tx.execute(sql`DELETE FROM async_video_audit_log  WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`DELETE FROM async_video_campaigns   WHERE org_id = ${demoOrg}`);
    await tx.execute(sql`ALTER TABLE async_video_audit_log ENABLE TRIGGER async_video_audit_log_no_mutate`);
  });
  // Question-bank enterprise domain rows. question_versions / question_reviews /
  // question_usage_events / question_import_jobs all CASCADE off question_banks
  // (via question_id / bank_id FKs), but question_bank_audit rows with a NULL
  // bank_id AND NULL question_id (e.g. org-wide entries) and usage events tied
  // only to attempts won't always ride a CASCADE — delete the domain audit +
  // usage facts explicitly by org_id first so the seed re-creates a clean set.
  await db.execute(sql`DELETE FROM question_bank_audit  WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM question_usage_events WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM question_reviews     WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM question_versions    WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM question_import_jobs WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM question_banks     WHERE org_id = ${demoOrg}`);
  // Recruiters-page management config + audit (goals/capacity/leaderboards/
  // nudges/admin-events). Org-scoped; no append-only trigger here so plain DELETE.
  await db.execute(sql`DELETE FROM recruiter_admin_events WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM recruiter_nudges       WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM recruiter_leaderboards WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM recruiter_goals        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM recruiter_capacity     WHERE org_id = ${demoOrg}`);
  // Team Monitor supervisor surfaces (presence/supervision/SLA/alerts/audit).
  // Org-scoped; plain DELETE (no append-only trigger). call_supervision_sessions
  // and recruiter_presence also clear via the call_sessions delete above
  // (CASCADE / SET NULL respectively), but delete explicitly for idempotency and
  // to catch org-wide rows (sla policies, org alerts, audit) with no call FK.
  await db.execute(sql`DELETE FROM team_monitor_audit       WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM team_alerts              WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM team_sla_policies        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM call_supervision_sessions WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM recruiter_presence       WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM submissions        WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM prospects          WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM demands            WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM clients            WHERE org_id = ${demoOrg}`);
  await db.execute(sql`DELETE FROM candidates         WHERE org_id = ${demoOrg}`);

  // transcript_speaker_brackets references call_sessions (which carries the
  // org_id). Reach through call_sessions to scope the delete.
  await db.execute(sql`
    DELETE FROM transcript_speaker_brackets
    WHERE call_id IN (SELECT id FROM call_sessions WHERE org_id = ${demoOrg})
  `);

  // Taxonomy tables are global / org-agnostic — both orgs share the same
  // skill/location/industry catalog. We use DELETE (not TRUNCATE CASCADE)
  // because demands.industry_id / functional_area_id / role_category_id /
  // job_role_id are declared ON DELETE SET NULL — DELETE respects that
  // and just NULLs the columns on synced JoulesToWatts demands. TRUNCATE
  // CASCADE would unconditionally truncate every table with an FK
  // reference, including demands itself, regardless of the ON DELETE
  // action.
  await db.execute(sql`DELETE FROM job_roles`);
  await db.execute(sql`DELETE FROM role_categories`);
  await db.execute(sql`DELETE FROM functional_areas`);
  await db.execute(sql`DELETE FROM industries`);
  await db.execute(sql`DELETE FROM skills`);
  await db.execute(sql`DELETE FROM locations`);
  await db.execute(sql`DELETE FROM disqualification_reasons`);

  // Wipe seeded demo users only. The JoulesToWatts admin uses the
  // @joulestowatts.com domain and is preserved.
  await db.execute(sql`DELETE FROM memberships
    WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@recruitassist.local' OR email LIKE '%@example-gcc.local')`);
  await db.execute(sql`DELETE FROM users
    WHERE email LIKE '%@recruitassist.local' OR email LIKE '%@example-gcc.local'`);
}

async function bootstrapJoulestowattsAdmin(): Promise<void> {
  // Idempotent: ensures the JoulesToWatts org row, the operator's user
  // row, and an admin membership all exist. The migration creates the org
  // (0013) — this is dev-side belt-and-suspenders so /pnpm db:seed/ leaves
  // a working JoulesToWatts sign-in.
  await db
    .insert(organizations)
    .values({ id: JOULESTOWATTS_ORG_ID, name: "JoulesToWatts", slug: JOULESTOWATTS_ORG_SLUG })
    .onConflictDoNothing();

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(email) = lower(${JOULESTOWATTS_ADMIN_EMAIL})`)
    .limit(1);

  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
  } else {
    const [row] = await db
      .insert(users)
      .values({
        email: JOULESTOWATTS_ADMIN_EMAIL,
        passwordHash,
        name: "JoulesToWatts Admin",
        jobTitle: "Workspace Admin",
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    userId = row.id;
  }

  await db
    .insert(memberships)
    .values({
      userId,
      orgId: JOULESTOWATTS_ORG_ID,
      role: "admin",
      status: "active",
      joinedAt: new Date(),
    })
    .onConflictDoNothing();
}

async function seedTaxonomy(): Promise<Pick<SeededIds, "skillIdByName" | "locationIdByCity" | "industryIdByName" | "functionalAreaIdByName" | "roleCategoryIdByName" | "jobRoleIdByName">> {
  const skillRows = await db
    .insert(skills)
    .values(SKILL_SPECS.map((s) => ({ name: s.name, aliases: s.aliases })))
    .returning({ id: skills.id, name: skills.name });
  const skillIdByName = new Map(skillRows.map((r) => [r.name.toLowerCase(), r.id]));

  const locationRows = await db
    .insert(locations)
    .values(LOCATION_SPECS.map((l) => ({ city: l.city, state: l.state })))
    .returning({ id: locations.id, city: locations.city });
  const locationIdByCity = new Map(locationRows.map((r) => [r.city, r.id]));

  const industryRows = await db
    .insert(industries)
    .values(INDUSTRY_NAMES.map((name) => ({ name })))
    .returning({ id: industries.id, name: industries.name });
  const industryIdByName = new Map(industryRows.map((r) => [r.name, r.id]));

  const functionalAreaRows = await db
    .insert(functionalAreas)
    .values(FUNCTIONAL_AREA_NAMES.map((name) => ({ name })))
    .returning({ id: functionalAreas.id, name: functionalAreas.name });
  const functionalAreaIdByName = new Map(functionalAreaRows.map((r) => [r.name, r.id]));

  const roleCategoryRows = await db
    .insert(roleCategories)
    .values(ROLE_CATEGORY_NAMES.map((name) => ({ name })))
    .returning({ id: roleCategories.id, name: roleCategories.name });
  const roleCategoryIdByName = new Map(roleCategoryRows.map((r) => [r.name, r.id]));

  const jobRoleRows = await db
    .insert(jobRoles)
    .values(
      JOB_ROLE_SEEDS.map((j) => ({
        name: j.name,
        roleCategoryId: roleCategoryIdByName.get(j.category) ?? null,
      })),
    )
    .returning({ id: jobRoles.id, name: jobRoles.name });
  const jobRoleIdByName = new Map(jobRoleRows.map((r) => [r.name, r.id]));

  await db
    .insert(disqualificationReasons)
    .values(DISQUALIFICATION_SEEDS);

  return {
    skillIdByName,
    locationIdByCity,
    industryIdByName,
    functionalAreaIdByName,
    roleCategoryIdByName,
    jobRoleIdByName,
  };
}

async function seedUsers(): Promise<{ userIdByEmail: Map<string, string> }> {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const userIdByEmail = new Map<string, string>();

  // Insert users first; reporting-to FK is set in a second pass so the
  // chain can resolve regardless of insertion order.
  const userRows = await db
    .insert(users)
    .values(
      USER_SPECS.map((u) => ({
        email: u.email,
        passwordHash,
        name: u.name,
        jobTitle: u.jobTitle,
        emailVerifiedAt: new Date(),
        isPlatformAdmin: u.isPlatformAdmin ?? false,
      })),
    )
    .returning({ id: users.id, email: users.email });
  for (const r of userRows) userIdByEmail.set(r.email, r.id);

  // Memberships (skip platform admins).
  await db.insert(memberships).values(
    USER_SPECS.filter((u) => !u.isPlatformAdmin).map((u) => ({
      userId: userIdByEmail.get(u.email)!,
      orgId: DEFAULT_ORG_ID,
      role: u.role,
      status: "active" as const,
      joinedAt: new Date(),
    })),
  );

  // Wire reporting_to_user_id (one UPDATE per user with a manager).
  for (const u of USER_SPECS) {
    if (!u.reportingToEmail) continue;
    const userId = userIdByEmail.get(u.email);
    const managerId = userIdByEmail.get(u.reportingToEmail);
    if (!userId || !managerId) continue;
    await db.execute(sql`
      UPDATE memberships SET reporting_to_user_id = ${managerId}
      WHERE user_id = ${userId} AND org_id = ${DEFAULT_ORG_ID}
    `);
  }

  return { userIdByEmail };
}

async function seedClients(userIdByEmail: Map<string, string>): Promise<Map<string, string>> {
  const rows = await db
    .insert(clients)
    .values(
      CLIENT_SPECS.map((c) => ({
        orgId: DEFAULT_ORG_ID,
        companyName: c.name,
        slug: c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        industry: c.industry,
        tier: c.tier,
        bhUserId: userIdByEmail.get(c.bhEmail) ?? null,
        status: "active" as const,
      })),
    )
    .returning({ id: clients.id, companyName: clients.companyName });
  const clientIdByName = new Map(rows.map((r) => [r.companyName, r.id]));

  // Eligible recruiters per client (round-robin assignment of 8 recruiters
  // to each client so the demos always have someone to source).
  const recruiterIds = USER_SPECS.filter((u) => u.role === "recruiter").map(
    (u) => userIdByEmail.get(u.email)!,
  );
  const linkRows: Array<{ clientId: string; recruiterId: string }> = [];
  let cursor = 0;
  for (const c of rows) {
    for (let i = 0; i < 8; i += 1) {
      linkRows.push({ clientId: c.id, recruiterId: recruiterIds[(cursor + i) % recruiterIds.length] });
    }
    cursor += 3;
  }
  await db.insert(clientRecruiters).values(linkRows);

  return clientIdByName;
}

async function seedDemands(seeded: SeededIds, rng: () => number): Promise<string[]> {
  const demandTitles: Array<{ title: string; jobRole: string; primaryLocation: string; vip: boolean; minExp: number; maxExp: number; salaryFrom: number; salaryTo: number; openings: number; mustHaves: string[]; niceToHaves: string[] }> = [
    { title: "Senior Java Backend Engineer", jobRole: "Senior Backend Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 5, maxExp: 9, salaryFrom: 22, salaryTo: 38, openings: 4, mustHaves: ["Java", "Spring Boot", "Microservices"], niceToHaves: ["Kafka", "AWS"] },
    { title: "Java Backend Engineer", jobRole: "Java Backend Engineer", primaryLocation: "Pune", vip: false, minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 24, openings: 6, mustHaves: ["Java", "Spring Boot"], niceToHaves: ["PostgreSQL", "REST API"] },
    { title: "Python Backend Engineer", jobRole: "Python Backend Engineer", primaryLocation: "Hyderabad", vip: false, minExp: 3, maxExp: 7, salaryFrom: 16, salaryTo: 28, openings: 3, mustHaves: ["Python", "FastAPI"], niceToHaves: ["Django", "PostgreSQL"] },
    { title: "Senior Python Engineer", jobRole: "Senior Backend Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 6, maxExp: 10, salaryFrom: 28, salaryTo: 45, openings: 2, mustHaves: ["Python", "Django", "PostgreSQL"], niceToHaves: ["AWS", "Kubernetes"] },
    { title: "Full-stack Engineer (React + Node)", jobRole: "Full-stack Engineer", primaryLocation: "Mumbai", vip: false, minExp: 4, maxExp: 7, salaryFrom: 18, salaryTo: 30, openings: 5, mustHaves: ["React", "Node.js", "TypeScript"], niceToHaves: ["GraphQL", "AWS"] },
    { title: "Senior Full-stack Engineer", jobRole: "Senior Full-stack Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 6, maxExp: 10, salaryFrom: 28, salaryTo: 50, openings: 2, mustHaves: ["React", "Node.js", "TypeScript", "System Design"], niceToHaves: ["Next.js", "AWS"] },
    { title: "Frontend Engineer (React)", jobRole: "Frontend Engineer (React)", primaryLocation: "Gurgaon", vip: false, minExp: 2, maxExp: 5, salaryFrom: 10, salaryTo: 20, openings: 4, mustHaves: ["React", "TypeScript", "JavaScript"], niceToHaves: ["Next.js"] },
    { title: "Senior Frontend Engineer", jobRole: "Senior Frontend Engineer", primaryLocation: "Chennai", vip: false, minExp: 5, maxExp: 9, salaryFrom: 22, salaryTo: 35, openings: 2, mustHaves: ["React", "TypeScript", "System Design"], niceToHaves: ["Next.js", "GraphQL"] },
    { title: "Data Engineer", jobRole: "Data Engineer", primaryLocation: "Hyderabad", vip: false, minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 28, openings: 3, mustHaves: ["Python", "SQL", "PostgreSQL"], niceToHaves: ["Kafka", "AWS"] },
    { title: "Senior Data Engineer", jobRole: "Senior Data Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 5, maxExp: 9, salaryFrom: 24, salaryTo: 42, openings: 2, mustHaves: ["Python", "SQL", "Kafka", "AWS"], niceToHaves: ["GCP"] },
    { title: "DevOps Engineer", jobRole: "DevOps Engineer", primaryLocation: "Pune", vip: false, minExp: 3, maxExp: 6, salaryFrom: 16, salaryTo: 28, openings: 3, mustHaves: ["AWS", "Docker", "Kubernetes"], niceToHaves: ["Terraform", "CI/CD"] },
    { title: "Senior DevOps Engineer", jobRole: "Senior DevOps Engineer", primaryLocation: "Bengaluru", vip: false, minExp: 5, maxExp: 9, salaryFrom: 24, salaryTo: 42, openings: 2, mustHaves: ["AWS", "Kubernetes", "Terraform", "CI/CD"], niceToHaves: ["GCP", "Linux"] },
    { title: "Site Reliability Engineer", jobRole: "Site Reliability Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 5, maxExp: 9, salaryFrom: 26, salaryTo: 45, openings: 2, mustHaves: ["AWS", "Kubernetes", "Linux", "System Design"], niceToHaves: ["Terraform"] },
    { title: "QA Automation Engineer", jobRole: "QA Automation Engineer", primaryLocation: "Chennai", vip: false, minExp: 2, maxExp: 5, salaryFrom: 8, salaryTo: 18, openings: 5, mustHaves: ["JavaScript", "REST API"], niceToHaves: ["TypeScript", "CI/CD"] },
    { title: "Senior SDET", jobRole: "Senior SDET", primaryLocation: "Bengaluru", vip: false, minExp: 5, maxExp: 8, salaryFrom: 18, salaryTo: 30, openings: 2, mustHaves: ["Java", "REST API", "JavaScript"], niceToHaves: ["TypeScript"] },
    { title: "iOS Engineer", jobRole: "iOS Engineer", primaryLocation: "Bengaluru", vip: false, minExp: 3, maxExp: 7, salaryFrom: 16, salaryTo: 30, openings: 2, mustHaves: ["TypeScript"], niceToHaves: ["React"] },
    { title: "Android Engineer", jobRole: "Android Engineer", primaryLocation: "Mumbai", vip: false, minExp: 3, maxExp: 7, salaryFrom: 16, salaryTo: 28, openings: 2, mustHaves: ["Java"], niceToHaves: ["TypeScript"] },
    { title: "Solutions Architect", jobRole: "Solutions Architect", primaryLocation: "Bengaluru", vip: true, minExp: 10, maxExp: 16, salaryFrom: 50, salaryTo: 80, openings: 1, mustHaves: ["AWS", "System Design", "Microservices"], niceToHaves: ["Kubernetes", "Kafka"] },
    { title: "Backend Engineer (BFSI)", jobRole: "Java Backend Engineer", primaryLocation: "Mumbai", vip: false, minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 22, openings: 4, mustHaves: ["Java", "Spring Boot", "PostgreSQL"], niceToHaves: ["AWS"] },
    { title: "Backend Engineer (Fintech)", jobRole: "Java Backend Engineer", primaryLocation: "Bengaluru", vip: false, minExp: 4, maxExp: 7, salaryFrom: 18, salaryTo: 30, openings: 3, mustHaves: ["Java", "Spring Boot", "Kafka"], niceToHaves: ["AWS", "Kubernetes"] },
    { title: "Frontend Engineer (Pharma)", jobRole: "Frontend Engineer (React)", primaryLocation: "Hyderabad", vip: false, minExp: 2, maxExp: 5, salaryFrom: 10, salaryTo: 18, openings: 2, mustHaves: ["React", "JavaScript"], niceToHaves: ["TypeScript"] },
    { title: "Data Scientist", jobRole: "Data Scientist", primaryLocation: "Bengaluru", vip: false, minExp: 3, maxExp: 6, salaryFrom: 18, salaryTo: 32, openings: 2, mustHaves: ["Python", "SQL"], niceToHaves: ["AWS"] },
    { title: "ML Engineer", jobRole: "ML Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 4, maxExp: 8, salaryFrom: 24, salaryTo: 45, openings: 2, mustHaves: ["Python", "AWS"], niceToHaves: ["GCP"] },
    { title: "DevOps Engineer (Retail)", jobRole: "DevOps Engineer", primaryLocation: "Noida", vip: false, minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 26, openings: 2, mustHaves: ["AWS", "Docker", "CI/CD"], niceToHaves: ["Kubernetes"] },
    { title: "Backend Engineer (Auto)", jobRole: "Java Backend Engineer", primaryLocation: "Pune", vip: false, minExp: 3, maxExp: 6, salaryFrom: 12, salaryTo: 22, openings: 3, mustHaves: ["Java", "Spring Boot"], niceToHaves: ["MySQL"] },
    { title: "Senior Data Engineer (Aerospace)", jobRole: "Senior Data Engineer", primaryLocation: "Bengaluru", vip: false, minExp: 6, maxExp: 10, salaryFrom: 30, salaryTo: 50, openings: 1, mustHaves: ["Python", "SQL", "Kafka"], niceToHaves: ["AWS", "Kubernetes"] },
    { title: "Backend Engineer (EdTech)", jobRole: "Python Backend Engineer", primaryLocation: "Bengaluru", vip: false, minExp: 2, maxExp: 5, salaryFrom: 10, salaryTo: 20, openings: 3, mustHaves: ["Python", "Django"], niceToHaves: ["PostgreSQL"] },
    { title: "Full-stack Engineer (BFSI)", jobRole: "Full-stack Engineer", primaryLocation: "Hyderabad", vip: false, minExp: 4, maxExp: 7, salaryFrom: 18, salaryTo: 30, openings: 3, mustHaves: ["React", "Node.js", "PostgreSQL"], niceToHaves: ["TypeScript"] },
    { title: "Mobile Lead (Retail)", jobRole: "iOS Engineer", primaryLocation: "Bengaluru", vip: true, minExp: 7, maxExp: 12, salaryFrom: 35, salaryTo: 60, openings: 1, mustHaves: ["TypeScript", "System Design"], niceToHaves: ["React"] },
    { title: "Backend Engineer (Healthcare GCC)", jobRole: "Senior Backend Engineer", primaryLocation: "Trivandrum", vip: false, minExp: 5, maxExp: 8, salaryFrom: 20, salaryTo: 32, openings: 2, mustHaves: ["Java", "Spring Boot", "PostgreSQL"], niceToHaves: ["AWS"] },
  ];

  const accountManagerEmails = USER_SPECS.filter((u) => u.role === "account_manager").map((u) => u.email);
  const recruiterEmails = USER_SPECS.filter((u) => u.role === "recruiter").map((u) => u.email);
  const clientNames = Array.from(seeded.clientIdByName.keys());

  const insertedDemands: string[] = [];

  for (let i = 0; i < demandTitles.length; i += 1) {
    const spec = demandTitles[i];
    const clientName = clientNames[i % clientNames.length];
    const clientId = seeded.clientIdByName.get(clientName)!;
    const amEmail = accountManagerEmails[i % accountManagerEmails.length];
    const amId = seeded.userIdByEmail.get(amEmail)!;
    const jobRoleId = seeded.jobRoleIdByName.get(spec.jobRole) ?? null;

    const [row] = await db
      .insert(demands)
      .values({
        orgId: DEFAULT_ORG_ID,
        clientId,
        createdByUserId: amId,
        title: spec.title,
        designation: spec.title,
        description: `${spec.title} role at ${clientName}. Looking for ${spec.minExp}-${spec.maxExp} years of relevant experience. Salary band: ₹${spec.salaryFrom}-${spec.salaryTo} LPA. Primary location: ${spec.primaryLocation}.`,
        responsibilities: `Build and maintain production systems. Collaborate cross-functionally. Mentor juniors. Own production reliability for assigned services.`,
        experienceMinYears: String(spec.minExp),
        experienceMaxYears: String(spec.maxExp),
        salaryFrom: String(spec.salaryFrom),
        salaryTo: String(spec.salaryTo),
        numberOfOpenings: spec.openings,
        maxSubmissions: spec.openings * 4,
        primaryLocation: spec.primaryLocation,
        status: "active",
        isVip: spec.vip,
        clientInternalTicketId: `TKT-${1000 + i}`,
        requestedBy: pick(["VP Engineering", "Director of Engineering", "Head of Platform", "Engineering Manager"], rng),
        requestedDate: new Date(Date.now() - Math.floor(rng() * 30) * 86400_000).toISOString().slice(0, 10),
        expectedClosureDate: new Date(Date.now() + Math.floor(60 + rng() * 60) * 86400_000).toISOString().slice(0, 10),
        groupName: pick(["Platform", "Product", "Data", "Infrastructure"], rng),
        subGroupName: pick(["Core Services", "Customer-facing", "Internal Tools", "Pipeline"], rng),
        poOpportunityMrr: String((spec.salaryTo * spec.openings * 0.18).toFixed(2)),
        potentialGm: String((spec.salaryTo * spec.openings * 0.06).toFixed(2)),
        jobRoleId,
        probingDetails: {
          workMode: pick(["onsite", "hybrid", "remote"], rng),
          interviewType: "L1 tech, L2 tech, HR",
          acceptableNoticePeriodDays: pick([30, 45, 60, 90], rng) as number,
          feedbackEtaDays: pick([2, 3, 5, 7], rng) as number,
          urgency: spec.vip ? "high" : pick(["low", "normal", "high"], rng),
          projectSize: Math.floor(20 + rng() * 200),
          projectCount: Math.floor(1 + rng() * 5),
        },
        mandatoryChecks: ["bgv", "education_verification"],
      })
      .returning({ id: demands.id });

    insertedDemands.push(row.id);

    // Skills
    const mustHaveLinks = spec.mustHaves
      .map((s) => seeded.skillIdByName.get(s.toLowerCase()))
      .filter((id): id is string => Boolean(id))
      .map((skillId) => ({ demandId: row.id, skillId, isMandatory: true, weight: "2.0" }));
    const niceToHaveLinks = spec.niceToHaves
      .map((s) => seeded.skillIdByName.get(s.toLowerCase()))
      .filter((id): id is string => Boolean(id))
      .map((skillId) => ({ demandId: row.id, skillId, isMandatory: false, weight: "1.0" }));
    if (mustHaveLinks.length || niceToHaveLinks.length) {
      await db.insert(demandSkills).values([...mustHaveLinks, ...niceToHaveLinks]);
    }

    // Locations (primary + 1 alternate)
    const primaryLocId = seeded.locationIdByCity.get(spec.primaryLocation);
    if (primaryLocId) {
      const alts = LOCATION_SPECS.filter((l) => l.city !== spec.primaryLocation);
      const altCity = pick(alts, rng).city;
      const altLocId = seeded.locationIdByCity.get(altCity);
      const locValues: Array<{ demandId: string; locationId: string }> = [{ demandId: row.id, locationId: primaryLocId }];
      if (altLocId && altLocId !== primaryLocId) {
        locValues.push({ demandId: row.id, locationId: altLocId });
      }
      await db.insert(demandLocations).values(locValues);
    }

    // Recruiter assignments — 4 recruiters per demand (rotating)
    const assignmentValues: Array<{ demandId: string; recruiterId: string; assignedByUserId: string }> = [];
    for (let r = 0; r < 4; r += 1) {
      const recId = seeded.userIdByEmail.get(recruiterEmails[(i * 3 + r) % recruiterEmails.length])!;
      assignmentValues.push({ demandId: row.id, recruiterId: recId, assignedByUserId: amId });
    }
    await db.insert(demandAssignments).values(assignmentValues);
  }

  return insertedDemands;
}

async function seedCandidates(seeded: SeededIds, rng: () => number): Promise<string[]> {
  const firstNames = ["Aarav", "Vihaan", "Aditya", "Vivaan", "Reyansh", "Krishna", "Rudra", "Aarush", "Kabir", "Anaya",
    "Kiara", "Diya", "Ananya", "Saanvi", "Pari", "Riya", "Myra", "Aaradhya", "Avni", "Aditi",
    "Arjun", "Sai", "Ishaan", "Aditi", "Ira", "Tara", "Zara", "Alia", "Sara", "Nisha"];
  const lastNames = ["Sharma", "Verma", "Singh", "Kumar", "Patel", "Reddy", "Iyer", "Menon", "Gupta", "Joshi",
    "Nair", "Kapoor", "Khan", "Malhotra", "Mehta", "Pillai", "Khanna", "Rao", "Pandey", "Saxena"];
  const companies = ["Infosys", "TCS", "Wipro", "HCL", "Capgemini", "Cognizant", "Tech Mahindra",
    "Accenture", "Mindtree", "Mphasis", "Zoho", "Flipkart", "Razorpay", "Swiggy", "Zomato", "Uber India",
    "Goldman Sachs Bengaluru", "Walmart Labs", "Amazon India", "Microsoft India"];
  const titles = ["Software Engineer", "Senior Software Engineer", "Tech Lead", "Engineering Manager",
    "Backend Engineer", "Frontend Engineer", "Full-stack Engineer", "Data Engineer", "DevOps Engineer", "SDET"];

  const skillNames = SKILL_SPECS.map((s) => s.name);
  const candidateIds: string[] = [];

  for (let i = 0; i < 50; i += 1) {
    const fn = pick(firstNames, rng);
    const ln = pick(lastNames, rng);
    const phone = `+91${9000000000 + Math.floor(rng() * 99999999)}`;
    const phoneNorm = phone.slice(-10);
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i + 1}@example-candidate.com`;
    const expYears = 1 + Math.floor(rng() * 12);
    const currentCtc = +(4 + rng() * 30).toFixed(1);
    const expectedCtc = +(currentCtc * (1.2 + rng() * 0.6)).toFixed(1);
    const noticeDays = pick([15, 30, 45, 60, 90], rng) as number;
    const currentLoc = pick(LOCATION_SPECS, rng).city;
    const preferredLocs = Array.from(
      new Set([currentLoc, pick(LOCATION_SPECS, rng).city, pick(LOCATION_SPECS, rng).city]),
    );

    const [row] = await db
      .insert(candidates)
      .values({
        orgId: DEFAULT_ORG_ID,
        email,
        emailNormalized: email,
        phone,
        phoneE164Normalized: phoneNorm,
        firstName: fn,
        lastName: ln,
        displayName: `${fn} ${ln}`,
        currentTitle: pick(titles, rng),
        currentCompany: pick(companies, rng),
        totalExperienceYears: String(expYears),
        currentCtcLakhs: String(currentCtc),
        expectedCtcLakhs: String(expectedCtc),
        noticePeriodDays: noticeDays,
        noticePeriodNegotiable: rng() > 0.4,
        currentLocation: currentLoc,
        preferredLocations: preferredLocs,
        linkedinUrl: `https://www.linkedin.com/in/${fn.toLowerCase()}-${ln.toLowerCase()}-${i + 1}`,
        summary: `${expYears} yrs experienced ${pick(titles, rng).toLowerCase()} with hands-on exposure to ${pick(skillNames, rng)}, ${pick(skillNames, rng)}, and ${pick(skillNames, rng)}. Looking for senior IC roles in product engineering teams.`,
        source: pick(["naukri", "linkedin", "referral", "direct"], rng) as "naukri" | "linkedin" | "referral" | "direct",
      })
      .returning({ id: candidates.id });

    candidateIds.push(row.id);

    // 3 random skills per candidate
    const pickedSkillIds = new Set<string>();
    while (pickedSkillIds.size < 3) {
      const sName = pick(skillNames, rng);
      const sId = seeded.skillIdByName.get(sName.toLowerCase());
      if (sId) pickedSkillIds.add(sId);
    }
    await db.insert(candidateSkills).values(
      Array.from(pickedSkillIds).map((skillId) => ({
        candidateId: row.id,
        skillId,
        proficiencyLevel: 2 + Math.floor(rng() * 4),
        yearsOfExperience: String(Math.max(1, Math.floor(rng() * expYears))),
      })),
    );

    // 1-3 experiences
    const numExp = 1 + Math.floor(rng() * 3);
    const expValues = [] as Array<typeof candidateExperiences.$inferInsert>;
    let endYear = 2026 - Math.floor(rng() * 3);
    for (let e = 0; e < numExp; e += 1) {
      const startYear = endYear - 1 - Math.floor(rng() * 3);
      expValues.push({
        candidateId: row.id,
        companyName: pick(companies, rng),
        title: pick(titles, rng),
        startDate: `${startYear}-01-01`,
        endDate: e === 0 ? null : `${endYear}-12-31`,
        isCurrent: e === 0,
        description: `Worked on production systems using ${pick(skillNames, rng)} and ${pick(skillNames, rng)}.`,
      });
      endYear = startYear - 1;
    }
    await db.insert(candidateExperiences).values(expValues);

    // 1 qualification
    await db.insert(candidateQualifications).values({
      candidateId: row.id,
      degree: pick(["B.Tech", "B.E.", "MCA", "M.Tech"], rng),
      institution: pick(["IIT Bombay", "IIT Delhi", "NIT Trichy", "BITS Pilani", "VIT Vellore", "PES University", "Anna University", "Pune University"], rng),
      fieldOfStudy: pick(["Computer Science", "Information Technology", "Electronics & Communication"], rng),
      yearOfCompletion: 2026 - expYears - 4,
      marksOrGrade: `${(7 + rng() * 2.5).toFixed(2)} CGPA`,
    });
  }

  return candidateIds;
}

async function seedProspectsAndSubmissions(seeded: SeededIds, rng: () => number): Promise<void> {
  const recruiterUserIds = USER_SPECS.filter((u) => u.role === "recruiter").map((u) => seeded.userIdByEmail.get(u.email)!);
  const prospectStatuses = ["new", "contacted", "interested", "qualified", "submitted", "disqualified", "parked"] as const;

  const prospectRows: Array<typeof prospects.$inferInsert> = [];
  for (let i = 0; i < 100; i += 1) {
    const demandId = pick(seeded.demandIds, rng);
    const candidateId = pick(seeded.candidateIds, rng);
    const recruiterId = pick(recruiterUserIds, rng);
    const status = pick([...prospectStatuses], rng);
    prospectRows.push({
      orgId: DEFAULT_ORG_ID,
      demandId,
      candidateId,
      recruiterId,
      status,
      interestLevel: 1 + Math.floor(rng() * 5),
      notes: status === "disqualified"
        ? "Not aligned on compensation."
        : status === "interested"
          ? "Open to new opportunities; available to interview next week."
          : "Initial discovery call done.",
      lastContactedAt: new Date(Date.now() - Math.floor(rng() * 14) * 86400_000),
    });
  }
  // Allow duplicates to be silently dropped (UNIQUE on demand+candidate+recruiter).
  await db.insert(prospects).values(prospectRows).onConflictDoNothing();

  // Submissions: 25 across various stages.
  const stages = ["internal_review", "client_submit", "l1_scheduled", "l1_select", "l2_scheduled", "l2_select", "final_select", "offer_pending", "offer_accepted", "onboarded"] as const;
  // Pick distinct (demand, candidate) pairs to satisfy submissions_active_demand_candidate_key.
  const usedPairs = new Set<string>();
  const submissionRows: Array<typeof submissions.$inferInsert> = [];
  let attempts = 0;
  while (submissionRows.length < 25 && attempts < 500) {
    attempts += 1;
    const demandId = pick(seeded.demandIds, rng);
    const candidateId = pick(seeded.candidateIds, rng);
    const key = `${demandId}|${candidateId}`;
    if (usedPairs.has(key)) continue;
    usedPairs.add(key);
    const recruiterId = pick(recruiterUserIds, rng);
    submissionRows.push({
      orgId: DEFAULT_ORG_ID,
      demandId,
      candidateId,
      submittedByUserId: recruiterId,
      currentStage: pick([...stages], rng),
      previousStage: "internal_review",
      submittedAt: new Date(Date.now() - Math.floor(rng() * 14) * 86400_000),
      recruiterNote: "Strong match per JD-skill overlap.",
      status: "active",
    });
  }
  const inserted = await db.insert(submissions).values(submissionRows).returning({ id: submissions.id, currentStage: submissions.currentStage, submittedByUserId: submissions.submittedByUserId });

  // One stage transition per submission (to seed the audit trail).
  await db.insert(submissionStageTransitions).values(
    inserted.map((s) => ({
      submissionId: s.id,
      fromStage: "internal_review" as const,
      toStage: s.currentStage,
      changedByUserId: s.submittedByUserId,
      reasonText: "Initial seed transition",
    })),
  );
}

async function seedRubricsAndQuestionBanks(): Promise<void> {
  await db.insert(callRubrics).values([
    {
      orgId: DEFAULT_ORG_ID,
      name: "General Screening",
      version: 1,
      purpose: "general_screen",
      criteria: defaultRubricCriteria(),
      isDefault: true,
    },
    {
      orgId: DEFAULT_ORG_ID,
      name: "Technical Screening",
      version: 1,
      purpose: "technical_screen",
      criteria: technicalRubricCriteria(),
      isDefault: true,
    },
    {
      orgId: DEFAULT_ORG_ID,
      name: "Senior Technical Screening",
      version: 1,
      purpose: "senior_technical",
      criteria: technicalRubricCriteria(),
      isDefault: true,
    },
  ]);

  // Two question banks: one for Java/backend, one for React/frontend.
  const banks = await db
    .insert(questionBanks)
    .values([
      { orgId: DEFAULT_ORG_ID, name: "Java + Spring Backend", description: "Standard Java + Spring Boot screening questions, junior to staff." },
      { orgId: DEFAULT_ORG_ID, name: "React + TypeScript Frontend", description: "React + TypeScript + state management screening questions." },
    ])
    .returning({ id: questionBanks.id, name: questionBanks.name });

  const javaBank = banks.find((b) => b.name.startsWith("Java"))!.id;
  const reactBank = banks.find((b) => b.name.startsWith("React"))!.id;

  const baseQbqRows: Array<Partial<typeof questionBankQuestions.$inferInsert> & { bankId: string; prompt: string }> = [
    // Java
    { bankId: javaBank, level: "junior", difficulty: 2, prompt: "Explain the difference between == and equals() in Java.", expectedAnswerHints: "== checks reference equality; equals() checks logical equality based on the class's override.", evaluationRubric: ["Mentions reference vs value", "Mentions Object.equals default", "Mentions String / Integer caching subtleties for senior+"], commonMistakes: ["Confusing equals() with hashCode()"] },
    { bankId: javaBank, level: "mid", difficulty: 3, prompt: "What is the difference between @Component, @Service, and @Repository?", expectedAnswerHints: "All are stereotype annotations; @Repository adds exception translation; @Service is semantic.", evaluationRubric: ["Mentions all three are bean annotations", "Mentions exception translation for @Repository"] },
    { bankId: javaBank, level: "mid", difficulty: 3, prompt: "How does Spring Boot's auto-configuration work?", expectedAnswerHints: "META-INF/spring.factories, conditional annotations, classpath detection.", evaluationRubric: ["Mentions @ConditionalOnClass and @ConditionalOnMissingBean", "Mentions classpath scanning"] },
    { bankId: javaBank, level: "senior", difficulty: 4, prompt: "How would you design a service to handle 10K concurrent webhook deliveries with retry?", expectedAnswerHints: "Async queue (Kafka/SQS), idempotency keys, exponential backoff, DLQ.", evaluationRubric: ["Mentions queue", "Mentions idempotency", "Mentions backoff + DLQ"] },
    { bankId: javaBank, level: "senior", difficulty: 4, prompt: "Walk through how you'd diagnose a sudden Java GC pause causing latency spikes.", expectedAnswerHints: "GC logs, jstat, heap dumps, look at allocation rate, consider ZGC/Shenandoah.", evaluationRubric: ["Mentions GC logs", "Mentions allocation rate", "Mentions tuning options"] },
    { bankId: javaBank, level: "staff", difficulty: 5, prompt: "Compare optimistic vs pessimistic locking in JPA. When would you choose each?", expectedAnswerHints: "Optimistic uses @Version; pessimistic uses select-for-update. Optimistic for low contention; pessimistic for high contention or financial flows.", evaluationRubric: ["Mentions @Version", "Mentions FOR UPDATE", "Discusses contention tradeoff"] },

    // React
    { bankId: reactBank, level: "junior", difficulty: 2, prompt: "Explain the difference between useState and useReducer in React.", expectedAnswerHints: "useState for simple values; useReducer for complex state with multiple actions or transitions.", evaluationRubric: ["Mentions reducer pattern", "Mentions when to choose each"] },
    { bankId: reactBank, level: "mid", difficulty: 3, prompt: "What's the difference between useEffect and useLayoutEffect?", expectedAnswerHints: "useEffect runs after paint; useLayoutEffect runs synchronously before paint. Use Layout for DOM measurements.", evaluationRubric: ["Mentions paint timing", "Mentions DOM measurement use case"] },
    { bankId: reactBank, level: "mid", difficulty: 3, prompt: "How would you avoid prop drilling in a deep component tree?", expectedAnswerHints: "React Context, state managers (Zustand/Redux), composition pattern.", evaluationRubric: ["Mentions Context", "Mentions state library or composition"] },
    { bankId: reactBank, level: "senior", difficulty: 4, prompt: "When would you reach for React Server Components, and what tradeoffs does that introduce?", expectedAnswerHints: "Reduces JS shipped to browser, runs on server with DB access; tradeoffs: no useState/useEffect, requires Next.js or similar runtime.", evaluationRubric: ["Mentions reduced JS bundle", "Mentions limitations on hooks", "Mentions runtime requirement"] },
    { bankId: reactBank, level: "senior", difficulty: 4, prompt: "Describe how you'd structure a large form with cross-field validation.", expectedAnswerHints: "Form library like react-hook-form with Zod resolver; controlled vs uncontrolled tradeoff; debounced async validators.", evaluationRubric: ["Mentions form library", "Mentions schema validation", "Mentions performance"] },
    { bankId: reactBank, level: "staff", difficulty: 5, prompt: "Walk through how you'd diagnose a memory leak in a long-running React SPA.", expectedAnswerHints: "Chrome devtools heap snapshots, look for detached DOM, check for unsubscribed effects, audit refs.", evaluationRubric: ["Mentions devtools", "Mentions cleanup functions", "Mentions detached nodes"] },
  ];

  // Inject the enterprise NOT-NULL columns (org_id, content_hash) + sensible
  // tagging/governance defaults so these base questions are queryable by the
  // rewritten route's filters. These are the "already-approved corpus" rows.
  await db.insert(questionBankQuestions).values(
    baseQbqRows.map((r) => ({
      ...r,
      orgId: DEFAULT_ORG_ID,
      status: "approved" as const,
      language: "en" as const,
      questionType: "verbal" as const,
      roleFamily: r.bankId === javaBank ? "backend" : "frontend",
      contentHash: sha256Hex(r.prompt),
    })),
  );
}

// sha256(lower(trim(prompt))) hex — mirrors the migration's content_hash backfill
// and the route's duplicate-detection key. Used by the seed to populate
// content_hash on freshly inserted questions.
function sha256Hex(prompt: string): string {
  return createHash("sha256").update(prompt.trim().toLowerCase()).digest("hex");
}

// Enrich the DEFAULT-org question banks with enterprise governance data so the
// rewritten Question Bank page (review queue, version history, calibration,
// usage stats, activity timeline) renders real content under the e2e /
// integration admin persona (admin@recruitassist.local in DEFAULT_ORG_ID).
// Mirrors seedProctorForDefaultOrg / seedTeamMonitorForDefaultOrg: this is the
// e2e-visible data; the rich demo lives in DEMO_ORG and is invisible here.
// Idempotent — wipeAtsData clears question-bank domain rows first, and this
// runs after seedRubricsAndQuestionBanks (re)created the banks/questions.
async function seedQuestionBankEnterpriseForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const admin = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const qa = userIdByEmail.get("qa1@recruitassist.local") ?? admin;

  // Read back the freshly-seeded approved questions for the DEFAULT org.
  const questions = await db
    .select({
      id: questionBankQuestions.id,
      bankId: questionBankQuestions.bankId,
      prompt: questionBankQuestions.prompt,
      level: questionBankQuestions.level,
      difficulty: questionBankQuestions.difficulty,
      skillId: questionBankQuestions.skillId,
      roleFamily: questionBankQuestions.roleFamily,
      language: questionBankQuestions.language,
      questionType: questionBankQuestions.questionType,
    })
    .from(questionBankQuestions)
    .where(eq(questionBankQuestions.orgId, DEFAULT_ORG_ID));

  if (questions.length === 0) return;

  // Governance variety: leave most "approved", move a couple to "in_review"
  // (so the review queue is non-empty) and one to "draft" (so the lifecycle
  // filter has every status represented). Also stamp calibration + exposure
  // on a slice so the calibration UI shows real numbers.
  const inReview = questions.slice(0, 2);
  const draft = questions.slice(2, 3);
  const calibrated = questions.slice(0, Math.min(6, questions.length));

  for (const q of inReview) {
    await db
      .update(questionBankQuestions)
      .set({ status: "in_review", createdByUserId: admin, updatedAt: new Date() })
      .where(eq(questionBankQuestions.id, q.id));
  }
  for (const q of draft) {
    await db
      .update(questionBankQuestions)
      .set({ status: "draft", createdByUserId: admin, updatedAt: new Date() })
      .where(eq(questionBankQuestions.id, q.id));
  }

  // Calibrated difficulty (p-value cache) + exposure — one over-used item so
  // the over-use warning badge renders.
  for (let i = 0; i < calibrated.length; i++) {
    const q = calibrated[i];
    const pValue = (0.35 + rng() * 0.5).toFixed(3); // 0.35..0.85
    const exposure = i === 0 ? 240 : Math.floor(20 + rng() * 60);
    await db
      .update(questionBankQuestions)
      .set({
        calibratedDifficulty: pValue,
        exposureCount: exposure,
        lastUsedAt: new Date(Date.now() - Math.floor(rng() * 14) * 86_400_000),
        approvedByUserId: admin,
      })
      .where(eq(questionBankQuestions.id, q.id));
  }

  // v1 version snapshot per question (per-item versioning depth bullet).
  await db.insert(questionVersions).values(
    questions.map((q) => ({
      orgId: DEFAULT_ORG_ID,
      questionId: q.id,
      version: 1,
      reason: "created" as const,
      authorUserId: admin,
      snapshot: {
        prompt: q.prompt,
        level: q.level,
        difficulty: q.difficulty,
        skillId: q.skillId,
        roleFamily: q.roleFamily,
        language: q.language,
        questionType: q.questionType,
      } as Record<string, unknown>,
    })),
  );

  // Review history: the two in_review items have a "submitted" decision (pending
  // an approval) → review queue is non-empty and shows real submissions.
  if (inReview.length > 0) {
    await db.insert(questionReviews).values(
      inReview.map((q) => ({
        orgId: DEFAULT_ORG_ID,
        questionId: q.id,
        decision: "submitted" as const,
        reviewerUserId: admin,
        note: "Submitted for calibration review.",
      })),
    );
  }

  // Usage facts tied to seeded assessment attempts so POST /recalibrate has
  // something to roll up and the calibration panel is non-empty.
  const attempts = await db
    .select({ id: assessmentAttempts.id })
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.orgId, DEFAULT_ORG_ID))
    .limit(8);

  if (attempts.length > 0) {
    const usageRows: Array<typeof questionUsageEvents.$inferInsert> = [];
    for (const q of calibrated) {
      for (let a = 0; a < Math.min(attempts.length, 4); a++) {
        usageRows.push({
          orgId: DEFAULT_ORG_ID,
          questionId: q.id,
          source: "assessment_attempt",
          attemptId: attempts[a].id,
          scored: true,
          correct: rng() > 0.4,
          scoreFraction: rng().toFixed(3),
        });
      }
    }
    if (usageRows.length > 0) await db.insert(questionUsageEvents).values(usageRows);
  }

  // Audit history so the activity timeline renders on first view (A9).
  const auditRows: Array<typeof questionBankAudit.$inferInsert> = [];
  const banks = await db
    .select({ id: questionBanks.id })
    .from(questionBanks)
    .where(eq(questionBanks.orgId, DEFAULT_ORG_ID));
  for (const b of banks) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: admin, action: "bank.created", bankId: b.id, payload: { seeded: true } });
  }
  for (const q of questions.slice(0, 8)) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: admin, action: "question.created", bankId: q.bankId, questionId: q.id, payload: { seeded: true } });
  }
  for (const q of inReview) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: admin, action: "question.submitted_for_review", bankId: q.bankId, questionId: q.id, payload: { seeded: true } });
  }
  if (qa && inReview.length > 0) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: qa, action: "question.approved", bankId: inReview[0].bankId, questionId: inReview[0].id, payload: { note: "calibrated" } });
  }
  if (auditRows.length > 0) await db.insert(questionBankAudit).values(auditRows);
}

// Seed a realistic set of ended recruiter calls + QA reviews for the DEFAULT
// org so the QA review queue (/qa-review), call detail, and team-monitor
// surfaces render under the e2e / integration admin persona (who belongs to
// DEFAULT_ORG_ID — the rich demo seed's call/QA data lives in the separate
// DEMO_ORG and is invisible here). Deterministic (seeded RNG); idempotent
// (wipeAtsData clears call_sessions for the org first). Returns nothing.
async function seedCallsAndQaForDefaultOrg(
  userIdByEmail: Map<string, string>,
  candidateIds: string[],
  demandIds: string[],
  rng: () => number,
): Promise<void> {
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  const qaIds = [
    userIdByEmail.get("qa1@recruitassist.local"),
    userIdByEmail.get("qa2@recruitassist.local"),
    userIdByEmail.get("qa3@recruitassist.local"),
  ].filter((x): x is string => !!x);
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  if (candidateIds.length === 0 || recruiterIds.length === 0) return;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

  // 36 ended browser-mixed calls anchored to real candidates/recruiters/demands.
  const N = 36;
  const callRows = Array.from({ length: N }, (_, i) => {
    const startedAt = daysAgo(intBetween(0, 25));
    const durationMs = intBetween(4, 18) * 60_000;
    return {
      id: randomUUID(),
      orgId: DEFAULT_ORG_ID,
      recruiterUserId: recruiterIds[i % recruiterIds.length],
      candidateId: candidateIds[(i * 13) % candidateIds.length],
      demandId: demandIds.length ? demandIds[(i * 7) % demandIds.length] : null,
      status: "ended" as const,
      origin: "web" as const,
      mode: "browser_mixed" as const,
      startedAt,
      endedAt: new Date(startedAt.getTime() + durationMs),
      recordingDurationMs: durationMs,
      createdByUserId: recruiterIds[i % recruiterIds.length],
    };
  });
  const inserted = await db
    .insert(callSessions)
    .values(callRows)
    .returning({ id: callSessions.id });

  // ~20 of the calls get a QA review (mix of accept/override/escalate) so the
  // "reviewed" tab + QA agreement stats are non-trivial; the rest stay in the
  // "needs review" tab. Reviewers come from the seeded QA reviewers / admin.
  const reviewers = qaIds.length ? [...qaIds, adminId].filter((x): x is string => !!x) : [adminId].filter((x): x is string => !!x);
  const reviewedCount = Math.min(20, inserted.length);
  const qaRows: Array<typeof callQaReviews.$inferInsert> = [];
  for (let i = 0; i < reviewedCount; i += 1) {
    const decision = i < 13 ? "accept" : i < 17 ? "override" : "escalate";
    const reviewerScore = decision === "override" ? intBetween(60, 85) : intBetween(70, 95);
    const aiScore = decision === "override" ? reviewerScore - intBetween(5, 15) : reviewerScore + intBetween(-3, 3);
    qaRows.push({
      callId: inserted[i].id,
      reviewerUserId: reviewers.length ? pick(reviewers) : null,
      orgId: DEFAULT_ORG_ID,
      decision: decision as "accept" | "override" | "escalate",
      note:
        decision === "override"
          ? "Recruiter covered must-haves more thoroughly than the AI credited."
          : decision === "escalate"
            ? "Salary handling unclear; routing to delivery lead for a second listen."
            : "Looks good — confirmed the AI scoring.",
      criterionOverrides:
        decision === "override"
          ? {
              jd_coverage: { aiScore, reviewerScore: reviewerScore + 5, reason: "Probed must-haves more thoroughly." },
              salary_handling: { aiScore: aiScore - 5, reviewerScore: reviewerScore - 3, reason: "Slight pressure observed; deduct 5." },
            }
          : {},
      reviewerScore,
      aiScore: String(aiScore),
      timeSpentMs: intBetween(45_000, 240_000),
      createdAt: daysAgo(intBetween(0, 14)),
    });
  }
  if (qaRows.length) await db.insert(callQaReviews).values(qaRows);
}

// Seed the QA Review enterprise console for the DEFAULT org so /qa-review is a
// populated quality-management surface for the e2e / integration admin persona
// (admin@recruitassist.local in DEFAULT_ORG_ID). Mirrors
// seedCallsAndQaForDefaultOrg / seedProctorForDefaultOrg: the rich demo lives in
// DEMO_ORG and is invisible here, so we hydrate DEFAULT_ORG directly. Runs AFTER
// seedCallsAndQaForDefaultOrg (depends on its call_sessions + call_qa_reviews).
// Idempotent — wipeAtsData clears the whole qa_* domain for the org first.
// Builds: 2 sampling policies, ~40 queue items (pending/in_review/completed/
// disputed, incl. blind slot-2 items), ~6 published gold answers (+ gold_variance
// backfill), 1 closed + 1 open calibration session, 3 disputes with threads, and
// a realistic qa_audit_events trail so timelines render.
async function seedQaReviewForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const qaIds = [
    userIdByEmail.get("qa1@recruitassist.local"),
    userIdByEmail.get("qa2@recruitassist.local"),
    userIdByEmail.get("qa3@recruitassist.local"),
  ].filter((x): x is string => !!x);
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  const dlId = userIdByEmail.get("dl1@recruitassist.local") ?? null;
  const reviewers = qaIds.length ? qaIds : adminId ? [adminId] : [];
  if (reviewers.length === 0) return;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const hoursFrom = (base: Date, h: number) => new Date(base.getTime() + h * 3_600_000);

  // Pull the calls + reviews seedCallsAndQaForDefaultOrg already inserted for
  // this org (it does not return ids). Newest first; we only need ~40.
  const calls = await db
    .select({ id: callSessions.id, endedAt: callSessions.endedAt, recruiterUserId: callSessions.recruiterUserId })
    .from(callSessions)
    .where(eq(callSessions.orgId, DEFAULT_ORG_ID))
    .orderBy(desc(callSessions.endedAt))
    .limit(40);
  if (calls.length === 0) return;

  const reviews = await db
    .select({
      id: callQaReviews.id,
      callId: callQaReviews.callId,
      decision: callQaReviews.decision,
      reviewerScore: callQaReviews.reviewerScore,
      reviewerUserId: callQaReviews.reviewerUserId,
    })
    .from(callQaReviews)
    .where(eq(callQaReviews.orgId, DEFAULT_ORG_ID));
  const reviewByCall = new Map(reviews.map((r) => [r.callId, r]));

  const rubric = await db
    .select({ id: callRubrics.id })
    .from(callRubrics)
    .where(eq(callRubrics.orgId, DEFAULT_ORG_ID))
    .limit(1);
  const rubricId = rubric[0]?.id ?? null;

  // ---- 1) Two sampling policies ----
  const policyRows = await db
    .insert(qaSamplingPolicies)
    .values([
      {
        orgId: DEFAULT_ORG_ID,
        name: "Daily 20% sample",
        description: "Random 20% of ended recruiter calls, blind single-review, 48h SLA.",
        strategy: "percentage",
        samplePercent: 20,
        blindReview: true,
        requireDoubleReview: false,
        routing: "least_loaded",
        slaHours: 48,
        isActive: true,
        createdByUserId: adminId,
      },
      {
        orgId: DEFAULT_ORG_ID,
        name: "Risk: low AI scores",
        description: "Calls scored below 65 by the AI get a blind double-review for calibration.",
        strategy: "risk_weighted",
        minAiScore: 65,
        blindReview: true,
        requireDoubleReview: true,
        routing: "round_robin",
        slaHours: 24,
        isActive: true,
        createdByUserId: adminId,
      },
    ])
    .returning({ id: qaSamplingPolicies.id });
  const dailyPolicyId = policyRows[0]?.id ?? null;
  const riskPolicyId = policyRows[1]?.id ?? null;

  // ---- 2) Queue items: one slot-1 row per call; ~8 calls also get a blind
  // slot-2 (double-review). Status mix + assignment + SLA. ----
  type QueueSeed = typeof qaQueueItems.$inferInsert;
  const queueRows: QueueSeed[] = [];
  const doubleReviewCalls = new Set(calls.slice(0, 8).map((c) => c.id));
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const hasReview = reviewByCall.has(c.id);
    const review = reviewByCall.get(c.id);
    const base = c.endedAt ?? daysAgo(intBetween(0, 20));
    let status: QueueSeed["status"];
    if (hasReview) status = i % 11 === 0 ? "disputed" : "completed";
    else if (i % 5 === 0) status = "in_review";
    else status = "pending";
    const policyId = doubleReviewCalls.has(c.id) ? riskPolicyId : dailyPolicyId;
    const assigned =
      status === "pending" && i % 3 === 0
        ? null
        : review?.reviewerUserId ?? (reviewers.length ? pick(reviewers) : null);
    queueRows.push({
      orgId: DEFAULT_ORG_ID,
      callId: c.id,
      policyId,
      assignedReviewerId: assigned,
      reviewSlot: 1,
      status,
      priority: doubleReviewCalls.has(c.id) ? 1 : 0,
      dueAt: hoursFrom(base, 48),
      reviewId: hasReview ? review?.id ?? null : null,
      createdAt: base,
      updatedAt: base,
    });
    // Blind slot-2 for the double-review calls (still pending — secondary reviewer).
    if (doubleReviewCalls.has(c.id)) {
      const secondary = reviewers.length > 1 ? reviewers[(i + 1) % reviewers.length] : reviewers[0];
      queueRows.push({
        orgId: DEFAULT_ORG_ID,
        callId: c.id,
        policyId: riskPolicyId,
        assignedReviewerId: secondary,
        reviewSlot: 2,
        status: "pending",
        priority: 2,
        dueAt: hoursFrom(base, 24),
        reviewId: null,
        createdAt: base,
        updatedAt: base,
      });
    }
  }
  const insertedQueue = queueRows.length
    ? await db
        .insert(qaQueueItems)
        .values(queueRows)
        .onConflictDoNothing({ target: [qaQueueItems.callId, qaQueueItems.reviewSlot] })
        .returning({ id: qaQueueItems.id, callId: qaQueueItems.callId, reviewSlot: qaQueueItems.reviewSlot })
    : [];

  // Link slot-1 queue items back onto their review rows + stamp review_slot.
  for (const q of insertedQueue) {
    if (q.reviewSlot !== 1) continue;
    const review = reviewByCall.get(q.callId);
    if (review) {
      await db
        .update(callQaReviews)
        .set({ queueItemId: q.id, reviewSlot: 1 })
        .where(eq(callQaReviews.id, review.id));
    }
  }

  // ---- 3) Gold answers (published) for ~6 reviewed calls + gold_variance backfill ----
  const reviewedCalls = calls.filter((c) => reviewByCall.has(c.id)).slice(0, 6);
  const goldRows: Array<typeof qaGoldAnswers.$inferInsert> = [];
  for (const c of reviewedCalls) {
    const review = reviewByCall.get(c.id)!;
    const goldOverall = Math.max(0, Math.min(100, (review.reviewerScore ?? 80) + intBetween(-6, 6)));
    goldRows.push({
      orgId: DEFAULT_ORG_ID,
      callId: c.id,
      rubricId,
      criterionScores: {
        jd_coverage: { score: Math.max(0, Math.min(100, goldOverall + intBetween(-5, 5))), rationale: "Covered must-have skills with concrete examples." },
        salary_handling: { score: Math.max(0, Math.min(100, goldOverall + intBetween(-8, 4))), rationale: "Comp expectations probed but follow-up could be sharper." },
        communication: { score: Math.max(0, Math.min(100, goldOverall + intBetween(-3, 6))), rationale: "Clear, structured Hinglish; candidate understood throughout." },
      },
      goldOverallScore: goldOverall,
      notes: "Calibration gold authored by QA lead.",
      authoredByUserId: adminId,
      isPublished: true,
      createdAt: daysAgo(intBetween(2, 12)),
    });
  }
  if (goldRows.length) {
    await db.insert(qaGoldAnswers).values(goldRows).onConflictDoNothing({ target: qaGoldAnswers.callId });
    // Backfill gold_variance on the matching reviews.
    for (const g of goldRows) {
      const review = reviewByCall.get(g.callId);
      if (review && review.reviewerScore != null && g.goldOverallScore != null) {
        await db
          .update(callQaReviews)
          .set({ goldVariance: Math.abs(review.reviewerScore - g.goldOverallScore) })
          .where(eq(callQaReviews.id, review.id));
      }
    }
  }

  // ---- 4) Calibration sessions: 1 closed (with results), 1 open ----
  const goldCallIds = reviewedCalls.map((c) => c.id);
  await db.insert(qaCalibrationSessions).values([
    {
      orgId: DEFAULT_ORG_ID,
      name: "Q2 calibration — screening rubric",
      rubricId,
      callIds: goldCallIds,
      reviewerIds: reviewers,
      status: "closed",
      results: {
        kappa: 0.72,
        meanAbsErrorVsGold: 7.4,
        perReviewer: reviewers.reduce<Record<string, { meanAbsError: number; n: number }>>((acc, r) => {
          acc[r] = { meanAbsError: 5 + Math.round(rng() * 8), n: goldCallIds.length };
          return acc;
        }, {}),
      },
      createdByUserId: adminId,
      createdAt: daysAgo(9),
      closedAt: daysAgo(7),
    },
    {
      orgId: DEFAULT_ORG_ID,
      name: "Mid-quarter drift check",
      rubricId,
      callIds: goldCallIds.slice(0, 3),
      reviewerIds: reviewers,
      status: "open",
      results: null,
      createdByUserId: adminId,
      createdAt: daysAgo(2),
    },
  ]);

  // ---- 5) Disputes (open / under_review / overturned) with threads ----
  const disputableReviews = reviews.slice(0, 3);
  const disputeStatuses: Array<typeof qaDisputes.$inferInsert["status"]> = ["open", "under_review", "overturned"];
  const disputeIds: string[] = [];
  for (let i = 0; i < disputableReviews.length; i += 1) {
    const r = disputableReviews[i];
    const status = disputeStatuses[i];
    const raisedBy = recruiterIds.length ? recruiterIds[i % recruiterIds.length] : dlId ?? adminId;
    if (!raisedBy) continue;
    const createdAt = daysAgo(intBetween(1, 6));
    const resolver = status === "overturned" ? adminId ?? pick(reviewers) : null;
    const thread: Array<{ userId: string; name?: string; body: string; at: string }> = [
      { userId: raisedBy, body: "Score feels low — candidate clearly hit the must-have Java skills.", at: createdAt.toISOString() },
      { userId: pick(reviewers), body: "Re-listening to the JD-coverage segment now.", at: hoursFrom(createdAt, 3).toISOString() },
    ];
    if (status === "overturned" && resolver) {
      thread.push({ userId: resolver, body: "Agreed — bumping jd_coverage by 8. Overturning.", at: hoursFrom(createdAt, 20).toISOString() });
    }
    const dispute = await db
      .insert(qaDisputes)
      .values({
        orgId: DEFAULT_ORG_ID,
        reviewId: r.id,
        callId: r.callId,
        raisedByUserId: raisedBy,
        reason: "The reviewer score under-credits JD coverage; requesting re-grade of the must-have skills.",
        requestedScores: { jd_coverage: 85 },
        status,
        resolverUserId: resolver,
        resolutionNote: status === "overturned" ? "Upheld appeal; jd_coverage corrected." : null,
        thread,
        createdAt,
        resolvedAt: status === "overturned" ? hoursFrom(createdAt, 20) : null,
      })
      .returning({ id: qaDisputes.id });
    if (dispute[0]) disputeIds.push(dispute[0].id);
  }

  // ---- 6) Audit trail ----
  const auditRows: Array<typeof qaAuditEvents.$inferInsert> = [];
  if (dailyPolicyId) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: adminId, action: "qa.policy.create", targetType: "policy", targetId: dailyPolicyId, before: null, after: { name: "Daily 20% sample" }, createdAt: daysAgo(14) });
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: adminId, action: "qa.policy.run", targetType: "policy", targetId: dailyPolicyId, after: { inserted: insertedQueue.length }, createdAt: daysAgo(13) });
  }
  for (const r of reviews.slice(0, 8)) {
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      actorUserId: r.reviewerUserId ?? pick(reviewers),
      action: r.decision === "override" ? "qa.review.override" : "qa.review.submit",
      targetType: "review",
      targetId: r.id,
      callId: r.callId,
      before: { aiScore: null },
      after: { decision: r.decision, reviewerScore: r.reviewerScore },
      createdAt: daysAgo(intBetween(0, 10)),
    });
  }
  for (const g of goldRows.slice(0, 4)) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: adminId, action: "qa.gold.publish", targetType: "gold", targetId: g.callId, callId: g.callId, after: { isPublished: true, goldOverallScore: g.goldOverallScore }, createdAt: daysAgo(intBetween(2, 10)) });
  }
  for (let i = 0; i < disputeIds.length; i += 1) {
    auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: recruiterIds.length ? recruiterIds[i % recruiterIds.length] : adminId, action: "qa.dispute.raise", targetType: "dispute", targetId: disputeIds[i], createdAt: daysAgo(intBetween(1, 6)) });
    if (i === 2) {
      auditRows.push({ orgId: DEFAULT_ORG_ID, actorUserId: adminId, action: "qa.dispute.resolve", targetType: "dispute", targetId: disputeIds[i], before: { status: "under_review" }, after: { status: "overturned" }, createdAt: daysAgo(1) });
    }
  }
  if (auditRows.length) await db.insert(qaAuditEvents).values(auditRows);
}

// Seed an async-video review surface for the DEFAULT org (campaigns + ordered
// questions + a spread of submissions, some reviewed with scorecards) so the
// /async-video list and review pages are non-empty for the e2e / integration
// admin persona. Same rationale as seedCallsAndQaForDefaultOrg: the rich data
// lives in DEMO_ORG and is invisible to DEFAULT_ORG_ID. Idempotent (wipeAtsData
// clears async_video_campaigns for the org, which cascades its children).
async function seedAsyncVideoForDefaultOrg(
  userIdByEmail: Map<string, string>,
  candidateIds: string[],
  demandIds: string[],
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  const reviewerPool = [
    userIdByEmail.get("qa1@recruitassist.local"),
    userIdByEmail.get("qa2@recruitassist.local"),
    adminId,
  ].filter((x): x is string => !!x);
  if (candidateIds.length === 0 || reviewerPool.length === 0) return;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000);

  // Write ONE small placeholder webm to the local blob store and reuse its
  // (content-addressed) key for every seeded clip. Without real bytes on disk,
  // GET /submissions/:id/video/:i 404s with clip_file_missing and the reviewer
  // can't watch anything — the page's core job. The store dedupes by sha256, so
  // a single put() backs all clips. The bytes start with an EBML/Matroska magic
  // so the response is at least typed as a webm container.
  const { blobStore } = await import("@j2w/ingest-shared");
  const placeholder = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // EBML magic
    Buffer.from("recruitassist-seed-placeholder-webm-clip", "utf8"),
    Buffer.alloc(256, 0),
  ]);
  const { key: clipBlobKey } = await blobStore.put(placeholder);

  const CAMPAIGNS: Array<{ title: string; status: "draft" | "published"; questions: string[] }> = [
    {
      title: "Backend Screen — Self-introduction",
      status: "published",
      questions: [
        "Walk us through your career so far in two minutes.",
        "Describe a production system you built that you're proud of.",
        "Tell us about a time you handled a production incident.",
      ],
    },
    {
      title: "Frontend Screen — Code Walkthrough",
      status: "published",
      questions: [
        "Walk us through the component tree of your most recent React project.",
        "How would you refactor a component that's grown beyond 500 lines?",
        "Explain how you'd debug a re-render performance issue.",
      ],
    },
    {
      title: "QA Automation — Strategy (draft)",
      status: "draft",
      questions: [
        "What's your test-pyramid philosophy?",
        "How would you stabilise a flaky end-to-end suite?",
      ],
    },
  ];

  for (const spec of CAMPAIGNS) {
    const [campaign] = await db
      .insert(asyncVideoCampaigns)
      .values({
        orgId: DEFAULT_ORG_ID,
        demandId: demandIds.length ? pick(demandIds) : null,
        title: spec.title,
        introText: "Please record short responses to each prompt.",
        outroText: "Thanks for recording — our team will review shortly.",
        prompts: spec.questions.map((text, idx) => ({ id: `q${idx}`, text })),
        maxSecondsPerPrompt: 120,
        maxRetakes: 1,
        status: spec.status,
        isPublished: spec.status === "published",
        requireDeviceCheck: true,
        createdByUserId: adminId,
      })
      .returning({ id: asyncVideoCampaigns.id });

    const qRows = await db
      .insert(asyncVideoQuestions)
      .values(
        spec.questions.map((text, i) => ({
          orgId: DEFAULT_ORG_ID,
          campaignId: campaign.id,
          position: i,
          kind: "video" as const,
          text,
          prepSeconds: 30,
          maxSeconds: 120,
          maxRetakes: 1,
        })),
      )
      .returning({ id: asyncVideoQuestions.id, position: asyncVideoQuestions.position });

    await db.insert(asyncVideoAuditLog).values({
      orgId: DEFAULT_ORG_ID,
      actorUserId: adminId,
      action: "campaign.create",
      targetType: "campaign",
      targetId: campaign.id,
      payload: { title: spec.title, questionCount: spec.questions.length },
    });

    if (spec.status !== "published") continue;

    // ~14 submissions per published campaign across every status.
    for (let i = 0; i < 14; i += 1) {
      const candidateId = candidateIds[(i * 11) % candidateIds.length];
      const status = pick<"invited" | "started" | "submitted" | "reviewed" | "expired">([
        "invited",
        "started",
        "submitted",
        "submitted",
        "reviewed",
        "reviewed",
        "expired",
      ]);
      const submitted = status === "submitted" || status === "reviewed";
      const startedAt = status === "invited" ? null : daysAgo(intBetween(0, 22));
      const submittedAt = submitted ? daysAgo(intBetween(0, 18)) : null;
      const reviewerId = status === "reviewed" ? pick(reviewerPool) : null;
      const videos = submitted
        ? qRows.map((q) => ({
            promptIndex: q.position,
            // Real, content-addressed key whose bytes exist on disk (see
            // clipBlobKey above) so the reviewer can actually stream the clip.
            blobKey: clipBlobKey,
            durationSec: intBetween(45, 150),
            recordedAt: (submittedAt ?? new Date()).toISOString(),
          }))
        : [];

      const [sub] = await db
        .insert(asyncVideoSubmissions)
        .values({
          orgId: DEFAULT_ORG_ID,
          campaignId: campaign.id,
          candidateId,
          inviteToken: `seed-av-${campaign.id.slice(0, 8)}-${i}-${Math.floor(rng() * 1_000_000)}`,
          invitedByUserId: recruiterIds.length ? pick(recruiterIds) : adminId,
          status,
          shortlisted: status === "reviewed" && rng() > 0.6,
          deviceCheck:
            status !== "invited"
              ? { camera: true, mic: true, bandwidthKbps: intBetween(800, 6000), checkedAt: (startedAt ?? new Date()).toISOString() }
              : null,
          expiresAt: status === "expired" ? daysAgo(intBetween(1, 6)) : daysFromNow(intBetween(2, 14)),
          videos,
          reviewerUserId: reviewerId,
          reviewerDecision: status === "reviewed" ? pick(["forward", "hold", "reject"] as const) : null,
          reviewerNotes: status === "reviewed" ? "Clear communicator with strong ownership stories." : null,
          reviewerScore: status === "reviewed" ? intBetween(55, 95) : null,
          startedAt,
          submittedAt,
          reviewedAt: status === "reviewed" ? daysAgo(intBetween(0, 10)) : null,
        })
        .returning({ id: asyncVideoSubmissions.id });

      // Multi-reviewer scorecards on reviewed submissions → non-trivial agreement.
      if (status === "reviewed") {
        const n = Math.min(2, reviewerPool.length);
        const seen = new Set<string>();
        for (let r = 0; r < n; r += 1) {
          let rId = pick(reviewerPool);
          if (seen.has(rId)) rId = reviewerPool[(reviewerPool.indexOf(rId) + 1) % reviewerPool.length];
          seen.add(rId);
          const questionScores = qRows.map((q) => ({ questionId: q.id, score: intBetween(2, 5) }));
          const overall =
            Math.round((questionScores.reduce((a, b) => a + b.score, 0) / questionScores.length / 5) * 100 * 10) / 10;
          await db.insert(asyncVideoScorecards).values({
            orgId: DEFAULT_ORG_ID,
            submissionId: sub.id,
            reviewerUserId: rId,
            questionScores,
            overallScore: overall,
            recommendation: pick(["strong_yes", "yes", "maybe", "no"] as const),
            summaryNote: "Recommend advancing — strong fundamentals.",
            submitted: true,
          });
        }
      }

      // For submitted/reviewed submissions, seed AI artifacts (stub) +
      // shareable review links so the reviewer cockpit panels render non-empty
      // for the e2e/itest persona (B.5: transcript/summary/skills labeled AI;
      // active + expired + revoked share links).
      if (submitted) {
        // Per-question stub transcripts.
        for (const q of qRows) {
          await db.insert(asyncVideoAiArtifacts).values({
            orgId: DEFAULT_ORG_ID,
            submissionId: sub.id,
            questionId: q.id,
            kind: "transcript",
            status: "ready",
            provider: "stub",
            model: "seed-stub",
            content: { text: "[stub transcript] Candidate gave a clear, structured answer with concrete examples." },
          });
        }
        // Whole-submission summary + skills (question_id NULL).
        await db.insert(asyncVideoAiArtifacts).values({
          orgId: DEFAULT_ORG_ID,
          submissionId: sub.id,
          questionId: null,
          kind: "summary",
          status: "ready",
          provider: "stub",
          model: "seed-stub",
          content: { summary: "Strong communicator; solid ownership stories; some depth gaps on system design." },
        });
        await db.insert(asyncVideoAiArtifacts).values({
          orgId: DEFAULT_ORG_ID,
          submissionId: sub.id,
          questionId: null,
          kind: "skills",
          status: "ready",
          provider: "stub",
          model: "seed-stub",
          content: { skills: ["communication", "ownership", "problem-solving"] },
        });

        // One share link per submitted submission, cycling active/expired/revoked
        // across the seeded set so all three states are demonstrable from seed.
        const linkVariant = i % 3; // 0=active, 1=expired, 2=revoked
        await db.insert(asyncVideoShareLinks).values({
          orgId: DEFAULT_ORG_ID,
          submissionId: sub.id,
          token: `seed-share-${sub.id.slice(0, 8)}-${i}-${Math.floor(rng() * 1_000_000)}`,
          label: pick(["Hiring manager", "Panel lead", "Skip-level"]),
          canScore: true,
          createdByUserId: adminId,
          expiresAt: linkVariant === 1 ? daysAgo(intBetween(1, 5)) : daysFromNow(intBetween(3, 20)),
          revokedAt: linkVariant === 2 ? daysAgo(intBetween(0, 3)) : null,
        });
      }
    }
  }
}

/** Armed signal config covering every kind, used by the seeded default policy. */
function buildSeedSignalConfig(): ProctorSignalConfig {
  const cfg: ProctorSignalConfig = {};
  for (const kind of PROCTOR_SIGNAL_KINDS) {
    cfg[kind] = {
      armed: true,
      severity: DEFAULT_SIGNAL_SEVERITY[kind] ?? "low",
      weight: DEFAULT_SIGNAL_WEIGHTS[kind] ?? 5,
    };
  }
  return cfg;
}

// Seed a realistic, non-empty proctor cockpit for the DEFAULT org so the
// /proctor roster, review queue, session detail, chain-of-custody, and policy
// surfaces all render under the e2e / integration admin persona (who belongs
// to DEFAULT_ORG_ID — the demo seed's proctor data lives in the separate
// DEMO_ORG and is invisible here). Deterministic (seeded RNG), idempotent
// (wipeAtsData clears the prior rows).
async function seedProctorForDefaultOrg(
  userIdByEmail: Map<string, string>,
  candidateIds: string[],
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const qaId = userIdByEmail.get("qa1@recruitassist.local") ?? null;
  const proctorId = userIdByEmail.get("proctor1@recruitassist.local") ?? null;
  const reviewers = [qaId, proctorId, adminId].filter((x): x is string => !!x);
  if (candidateIds.length === 0 || reviewers.length === 0) return;

  const signalConfig = buildSeedSignalConfig();

  // An assessment template + attempts to anchor the sessions (proctor_sessions
  // requires exactly one of assessment_attempt_id / async_video_submission_id).
  const [template] = await db
    .insert(assessmentTemplates)
    .values({
      orgId: DEFAULT_ORG_ID,
      title: "Backend Screening — proctored",
      description: "Proctored take-home coding screen.",
      status: "published",
      isPublished: true,
      publishedVersion: 1,
      passScore: 60,
      proctoringPolicy: { requireWebcam: true, requireIdentity: true } as Record<string, unknown>,
      createdByUserId: adminId,
    })
    .returning({ id: assessmentTemplates.id });

  // Policies: one org-default (armed, no auto-terminate) + one template policy
  // that auto-terminates at 85.
  const insertedPolicies = await db
    .insert(proctorPolicies)
    .values([
      {
        orgId: DEFAULT_ORG_ID,
        name: "Org default — standard proctoring",
        assessmentTemplateId: null,
        isDefault: true,
        signalConfig,
        requireIdentity: true,
        requireWebcam: true,
        requireScreen: false,
        lockdownBrowser: false,
        autoFlagRiskScore: 40,
        autoTerminateRiskScore: null,
        createdByUserId: adminId,
      },
      {
        orgId: DEFAULT_ORG_ID,
        name: "Backend Screening — strict",
        assessmentTemplateId: template.id,
        isDefault: false,
        signalConfig,
        requireIdentity: true,
        requireWebcam: true,
        requireScreen: true,
        lockdownBrowser: true,
        autoFlagRiskScore: 35,
        autoTerminateRiskScore: 85,
        createdByUserId: adminId,
      },
    ])
    .returning({ id: proctorPolicies.id, isDefault: proctorPolicies.isDefault });
  const defaultPolicyId = insertedPolicies.find((p) => p.isDefault)?.id ?? null;
  const policySnapshot = {
    policyId: defaultPolicyId,
    name: "Org default — standard proctoring",
    signalConfig,
    requireIdentity: true,
    requireWebcam: true,
    requireScreen: false,
    lockdownBrowser: false,
    autoFlagRiskScore: 40,
    autoTerminateRiskScore: null,
  } as Record<string, unknown>;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000);
  const kinds = PROCTOR_SIGNAL_KINDS.filter(
    (k) => k !== "id_photo_captured" && k !== "env_scan_captured",
  );

  // 14 sessions: a couple live, the rest completed (some past-SLA, some
  // un-reviewed for the review queue).
  const N = 14;
  interface Seeded {
    id: string;
    attemptId: string;
    candidateId: string;
    status: "live" | "completed";
    startedAt: Date;
    events: Array<{ kind: string; severity: "low" | "medium" | "high"; flagged: boolean; offsetMs: number; acked: boolean; evidenceBlobKey: string | null }>;
    riskScore: number;
    flagCount: number;
    assignedReviewerUserId: string | null;
    reviewSlaDueAt: Date;
    decision: "clean" | "flagged" | "invalidated" | null;
  }
  const seeded: Seeded[] = [];

  for (let i = 0; i < N; i += 1) {
    const candidateId = candidateIds[(i * 17) % candidateIds.length];
    const [attempt] = await db
      .insert(assessmentAttempts)
      .values({
        orgId: DEFAULT_ORG_ID,
        templateId: template.id,
        candidateId,
        inviteToken: `proctor-seed-${i}-${Math.floor(rng() * 1e9)}`,
        status: i < 2 ? "started" : "submitted",
        startedAt: daysAgo(intBetween(0, 20)),
      })
      .returning({ id: assessmentAttempts.id });

    const status: "live" | "completed" = i < 2 ? "live" : "completed";
    const startedAt = daysAgo(intBetween(0, 20));
    const durationMs = 25 * 60_000;
    const nEvents = intBetween(0, 5);
    const events: Seeded["events"] = [];
    for (let e = 0; e < nEvents; e += 1) {
      const kind = pick(kinds);
      const severity = DEFAULT_SIGNAL_SEVERITY[kind] ?? "low";
      const flagged = severity !== "low" || rng() > 0.4;
      events.push({
        kind,
        severity,
        flagged,
        offsetMs: Math.round((e + 1) * (durationMs / (nEvents + 1))),
        acked: rng() > 0.5,
        evidenceBlobKey: rng() > 0.5 ? `demo-proctor/${attempt.id}-${e}.jpg` : null,
      });
    }
    const riskScore = computeRiskScore(events as RiskEventLike[], signalConfig);
    const flagCount = events.filter((e) => e.flagged).length;
    const assigned = status === "completed" && rng() > 0.4 ? pick(reviewers) : null;
    // Leave roughly half of completed sessions un-reviewed for the queue, with a
    // mix of past-due (SLA-breached) and future SLAs.
    const reviewed = status === "completed" && rng() > 0.5;
    const decision: Seeded["decision"] = reviewed
      ? riskScore > 60
        ? "flagged"
        : riskScore > 30
          ? (rng() > 0.5 ? "flagged" : "clean")
          : "clean"
      : null;
    const reviewSlaDueAt =
      status === "completed" && !reviewed && rng() > 0.5 ? daysAgo(intBetween(0, 2)) : daysFromNow(intBetween(0, 2));

    seeded.push({
      id: "",
      attemptId: attempt.id,
      candidateId,
      status,
      startedAt,
      events,
      riskScore,
      flagCount,
      assignedReviewerUserId: assigned,
      reviewSlaDueAt,
      decision,
    });
  }

  const sessionRows = seeded.map((s) => ({
    orgId: DEFAULT_ORG_ID,
    assessmentAttemptId: s.attemptId,
    candidateId: s.candidateId,
    status: s.status,
    liveState: s.status === "live" ? ("active" as const) : ("ended" as const),
    riskScore: s.riskScore,
    policyId: defaultPolicyId,
    policySnapshot,
    startedAt: s.startedAt,
    endedAt: s.status === "live" ? null : daysAgo(intBetween(0, 18)),
    flagCount: s.flagCount,
    assignedReviewerUserId: s.assignedReviewerUserId,
    reviewSlaDueAt: s.reviewSlaDueAt,
    reviewedAt: s.decision ? daysAgo(intBetween(0, 10)) : null,
    reviewerUserId: s.decision ? s.assignedReviewerUserId ?? pick(reviewers) : null,
    reviewerDecision: s.decision,
    reviewerNotes:
      s.decision && s.decision !== "clean"
        ? "Multiple integrity signals near the end of the attempt. Recommend retake or human follow-up."
        : null,
  }));
  const insertedSessions = await db
    .insert(proctorSessions)
    .values(sessionRows)
    .returning({ id: proctorSessions.id, assessmentAttemptId: proctorSessions.assessmentAttemptId });
  // Map back the generated session ids onto the seeded rows (by attempt).
  const idByAttempt = new Map(insertedSessions.map((r) => [r.assessmentAttemptId, r.id]));
  for (const s of seeded) s.id = idByAttempt.get(s.attemptId) ?? "";

  // Events.
  const eventRows = seeded.flatMap((s) =>
    s.events.map((e) => ({
      sessionId: s.id,
      kind: e.kind,
      severity: e.severity,
      payload: { confidence: +(0.6 + rng() * 0.35).toFixed(2), context: { detected: true } },
      flagged: e.flagged,
      reviewerAcked: e.acked,
      offsetMs: e.offsetMs,
      evidenceBlobKey: e.evidenceBlobKey,
      createdAt: new Date(s.startedAt.getTime() + e.offsetMs),
    })),
  );
  if (eventRows.length) await db.insert(proctorEvents).values(eventRows);

  // Identity checks — one per session, mixed statuses.
  const identityRows = seeded.map((s) => {
    const status = pick(["pending", "verified", "verified", "mismatch"]) as
      | "pending"
      | "verified"
      | "mismatch";
    return {
      orgId: DEFAULT_ORG_ID,
      sessionId: s.id,
      status,
      idPhotoBlobKey: `demo-proctor/${s.id}-id.jpg`,
      selfieBlobKey: `demo-proctor/${s.id}-selfie.jpg`,
      envScanBlobKey: `demo-proctor/${s.id}-env.jpg`,
      matchScore: status === "mismatch" ? intBetween(20, 55) : intBetween(72, 99),
      matchProvider: "stub",
      verifiedByUserId: status === "pending" ? null : pick(reviewers),
      verifiedAt: status === "pending" ? null : daysAgo(intBetween(0, 8)),
    };
  });
  if (identityRows.length) await db.insert(proctorIdentityChecks).values(identityRows);

  // Interventions on higher-risk sessions.
  const interventionRows: Array<typeof proctorInterventions.$inferInsert> = [];
  for (const s of seeded.filter((x) => x.riskScore >= 35)) {
    interventionRows.push({
      orgId: DEFAULT_ORG_ID,
      sessionId: s.id,
      kind: "warn",
      actorUserId: null,
      message: `Auto-flagged: risk score ${s.riskScore} ≥ threshold 40`,
      createdAt: new Date(s.startedAt.getTime() + 8 * 60_000),
    });
    interventionRows.push({
      orgId: DEFAULT_ORG_ID,
      sessionId: s.id,
      kind: s.riskScore >= 70 ? "terminate" : "chat",
      actorUserId: pick(reviewers),
      message:
        s.riskScore >= 70
          ? "Terminated after repeated multi-face detections and a confirmed second device."
          : "Please keep your face centered in the webcam and close all other tabs.",
      createdAt: new Date(s.startedAt.getTime() + 12 * 60_000),
    });
  }
  if (interventionRows.length) await db.insert(proctorInterventions).values(interventionRows);

  // Chain-of-custody audit so the audit tab is populated.
  const auditRows: Array<typeof proctorAuditEvents.$inferInsert> = [];
  for (const s of seeded) {
    const actor = s.assignedReviewerUserId ?? pick(reviewers);
    auditRows.push({ orgId: DEFAULT_ORG_ID, sessionId: s.id, actorUserId: actor, action: "session.view", createdAt: daysAgo(intBetween(0, 8)) });
    if (s.assignedReviewerUserId && adminId) {
      auditRows.push({ orgId: DEFAULT_ORG_ID, sessionId: s.id, actorUserId: adminId, action: "session.assign", fromValue: null, toValue: s.assignedReviewerUserId, createdAt: daysAgo(intBetween(0, 7)) });
    }
    if (s.decision) {
      auditRows.push({ orgId: DEFAULT_ORG_ID, sessionId: s.id, actorUserId: actor, action: "session.review", fromValue: null, toValue: s.decision, createdAt: daysAgo(intBetween(0, 6)) });
    }
    if (s.riskScore >= 35) {
      auditRows.push({ orgId: DEFAULT_ORG_ID, sessionId: s.id, actorUserId: null, action: "intervention.send", toValue: "warn", payload: { auto: true, riskScore: s.riskScore }, createdAt: daysAgo(intBetween(0, 6)) });
    }
  }
  if (auditRows.length) await db.insert(proctorAuditEvents).values(auditRows);
}

// The rich Assessment Authoring dataset (5 templates spanning all 8 typed item
// types, immutable v1 versions, graded attempts with real item-analysis data,
// and an append-only audit timeline) — seeded into DEFAULT_ORG_ID so the
// e2e/admin persona (admin@recruitassist.local) sees the same explorable
// builder/results/item-analysis surface as the demo org, not a near-empty
// Templates list. Mirrors seedProctorForDefaultOrg / seedAsyncVideoForDefaultOrg:
// the demo module's data lives in DEMO_ORG (11111111-…) which the e2e persona
// cannot see. Idempotent — wipeAtsData clears the prior rows (and disables the
// append-only audit trigger for the cascading delete). Delegates to the shared
// seedRichAssessmentsForOrg helper so demo and default orgs stay in lockstep.
async function seedAssessmentForDefaultOrg(
  userIdByEmail: Map<string, string>,
  candidateIds: string[],
  rng: () => number,
): Promise<void> {
  const adminUserId = userIdByEmail.get("admin@recruitassist.local");
  if (!adminUserId || candidateIds.length === 0) return;

  const recruiterUserIds = USER_SPECS.filter((u) => u.role === "recruiter")
    .map((u) => userIdByEmail.get(u.email))
    .filter((x): x is string => !!x);
  const qaUserIds = USER_SPECS.filter((u) => u.role === "qa_reviewer")
    .map((u) => userIdByEmail.get(u.email))
    .filter((x): x is string => !!x);

  await seedRichAssessmentsForOrg(
    {
      orgId: DEFAULT_ORG_ID,
      adminUserId,
      recruiterUserIds,
      qaUserIds,
      candidateIds,
    },
    rng,
  );
}

// Seed the Triage call-routing console for the DEFAULT org: a triage flow
// (voice_agents kind='triage'), a routing team + members, live mutable rules,
// two published rule-set versions + a dirty draft, ~80 historical calls with
// full routing-event chains across 14 days (with no-match + SLA-breach noise),
// a few live "now" sessions, and a handful of config-audit events. Mirrors the
// seedCallsAndQaForDefaultOrg / seedProctorForDefaultOrg pattern so the data is
// visible to the DEFAULT-org admin persona (api itest + Playwright e2e). All
// rows are cleared first in wipeAtsData.
async function seedTriageForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  if (recruiterIds.length === 0) return;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  // --- routing team + members (so the human_team destination resolves) ---
  const [team] = await db
    .insert(teams)
    .values({ orgId: DEFAULT_ORG_ID, name: "Front-desk Pod" })
    .returning({ id: teams.id });
  const teamMemberIds = recruiterIds.slice(0, Math.min(4, recruiterIds.length));
  await db
    .insert(teamMembers)
    .values(teamMemberIds.map((userId) => ({ teamId: team.id, userId })))
    .onConflictDoNothing();

  // --- a specialist voice agent to route specialist intents to ---
  const [specialist] = await db
    .insert(voiceAgents)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "Notice-period Screener",
      kind: "specialist",
      status: "active",
      purpose: "Autonomous notice-period + comp screener",
    })
    .returning({ id: voiceAgents.id });

  // --- the triage flow itself ---
  const intentVocab = ["interview_reschedule", "job_inquiry", "status_check", "complaint", "other"];
  const [flow] = await db
    .insert(voiceAgents)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "Front-desk Triage",
      kind: "triage",
      status: "active",
      purpose: "Inbound front-door classifier routing candidate calls",
      phoneNumber: "+918041000000",
      routing: { intentVocabulary: intentVocab, confidenceThreshold: 0.6 },
    })
    .returning({ id: voiceAgents.id });

  // --- live mutable rules (the editable draft) ---
  type SeedRule = {
    priority: number;
    intent: string;
    destinationType: "human_team" | "voice_agent" | "voicemail";
    destinationRef: string;
    destinationLabel: string;
    handoffMode: "warm" | "cold" | "voicemail";
    slaTargetSec: number | null;
    routingStrategy: "first_idle" | "round_robin" | "weighted" | "least_loaded";
    weight: number;
  };
  const ruleSpecs: SeedRule[] = [
    {
      priority: 1,
      intent: "interview_reschedule",
      destinationType: "human_team",
      destinationRef: team.id,
      destinationLabel: "Front-desk Pod",
      handoffMode: "warm",
      slaTargetSec: 45,
      routingStrategy: "round_robin",
      weight: 2,
    },
    {
      priority: 2,
      intent: "status_check",
      destinationType: "voice_agent",
      destinationRef: specialist.id,
      destinationLabel: "Notice-period Screener",
      handoffMode: "warm",
      slaTargetSec: 30,
      routingStrategy: "first_idle",
      weight: 1,
    },
    {
      priority: 3,
      intent: "complaint",
      destinationType: "human_team",
      destinationRef: team.id,
      destinationLabel: "Front-desk Pod",
      handoffMode: "warm",
      slaTargetSec: 60,
      routingStrategy: "least_loaded",
      weight: 3,
    },
    {
      priority: 4,
      intent: "job_inquiry",
      destinationType: "human_team",
      destinationRef: team.id,
      destinationLabel: "Front-desk Pod",
      handoffMode: "cold",
      slaTargetSec: 90,
      routingStrategy: "weighted",
      weight: 2,
    },
    {
      priority: 99,
      intent: "*",
      destinationType: "voicemail",
      destinationRef: "voicemail",
      destinationLabel: "Voicemail",
      handoffMode: "voicemail",
      slaTargetSec: null,
      routingStrategy: "first_idle",
      weight: 1,
    },
  ];

  const insertedRules = await db
    .insert(triageRoutingRules)
    .values(
      ruleSpecs.map((r) => ({
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        triageAgentId: flow.id,
        priority: r.priority,
        intent: r.intent,
        destinationType: r.destinationType,
        destinationRef: r.destinationRef,
        destinationLabel: r.destinationLabel,
        handoffMode: r.handoffMode,
        enabled: true,
        slaTargetSec: r.slaTargetSec,
        routingStrategy: r.routingStrategy,
        weight: r.weight,
        uiPosition: { x: 720, y: 60 + r.priority * 140 },
      })),
    )
    .returning();
  const ruleByIntent = new Map(insertedRules.map((r) => [r.intent, r]));

  const snapshot = insertedRules.map((r) => ({
    id: r.id,
    flowId: flow.id,
    priority: r.priority,
    intent: r.intent,
    destinationType: r.destinationType,
    destinationRef: r.destinationRef,
    destinationLabel: r.destinationLabel,
    handoffMode: r.handoffMode,
    enabled: r.enabled,
    slaTargetSec: r.slaTargetSec,
    routingStrategy: r.routingStrategy,
    weight: r.weight,
    uiPosition: r.uiPosition,
  }));

  // --- two published rule-set versions (so history + rollback render) ---
  // v1 is an archived earlier snapshot (a 4-rule subset), v2 the current
  // published; the live mutable rules above are a "dirty draft" past v2.
  const [v1] = await db
    .insert(triageRuleSets)
    .values({
      orgId: DEFAULT_ORG_ID,
      triageAgentId: flow.id,
      version: 1,
      status: "archived",
      rulesSnapshot: snapshot.filter((r) => r.intent !== "job_inquiry"),
      note: "Initial front-desk routing",
      publishedByUserId: adminId,
      publishedAt: daysAgo(12),
    })
    .returning({ id: triageRuleSets.id });
  const [v2] = await db
    .insert(triageRuleSets)
    .values({
      orgId: DEFAULT_ORG_ID,
      triageAgentId: flow.id,
      version: 2,
      status: "published",
      rulesSnapshot: snapshot,
      note: "Added job_inquiry routing + SLA targets",
      publishedByUserId: adminId,
      publishedAt: daysAgo(5),
    })
    .returning({ id: triageRuleSets.id });
  // Stamp the live rules with the current published version.
  await db
    .update(triageRoutingRules)
    .set({ ruleSetId: v2.id })
    .where(eq(triageRoutingRules.triageAgentId, flow.id));

  // --- historical calls with full routing-event chains across 14 days ---
  const intents = ["interview_reschedule", "status_check", "complaint", "job_inquiry"];
  const N = 80;
  for (let i = 0; i < N; i += 1) {
    const startedAt = daysAgo(intBetween(0, 13));
    const endedAt = new Date(startedAt.getTime() + intBetween(2, 9) * 60_000);
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flow.id,
      recruiterUserId: pick(teamMemberIds),
      candidateRefOrPhone: `+9190${String(10000000 + intBetween(0, 89999999))}`,
      status: "ended",
      origin: "vapi",
      mode: "browser_mixed",
      startedAt,
      endedAt,
      createdByUserId: adminId,
    });

    // ~8% no-match (unknown intent), ~6% SLA-breach (slow handoff).
    const noMatch = rng() < 0.08;
    const intent = noMatch ? "unknown_intent" : pick(intents);
    const confidence = +(0.55 + rng() * 0.44).toFixed(2);
    const sentiment = +(-0.4 + rng() * 0.8).toFixed(2);
    const rule = ruleByIntent.get(intent) ?? ruleByIntent.get("*")!;
    let seq = 0;
    const at = (offsetSec: number) => new Date(startedAt.getTime() + offsetSec * 1000);

    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "triage_started",
      fromRef: { type: "voice_agent", id: flow.id, label: "Front-desk Triage" },
      createdAt: at(0),
    });
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "classified",
      classification: { intent, confidence, sentiment, language: "en" },
      createdAt: at(8),
    });

    if (noMatch) {
      await db.insert(callRoutingEvents).values({
        callId,
        orgId: DEFAULT_ORG_ID,
        seq: seq++,
        kind: "handoff_failed",
        classification: { intent, confidence, sentiment },
        providerData: { reason: "no_matching_rule" },
        createdAt: at(12),
      });
      continue;
    }

    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "route_decision",
      toRef: { type: rule.destinationType, id: rule.destinationRef, label: rule.destinationLabel },
      classification: { intent, confidence, sentiment },
      ruleId: rule.id,
      createdAt: at(12),
    });
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "handoff_initiated",
      toRef: { type: rule.destinationType, id: rule.destinationRef, label: rule.destinationLabel },
      ruleId: rule.id,
      createdAt: at(14),
    });
    // SLA breach: handoff completes after the rule's SLA target on ~6% of calls.
    const slaTarget = rule.slaTargetSec ?? 120;
    const breach = rng() < 0.06;
    const completeAt = at(14 + (breach ? slaTarget + intBetween(10, 40) : intBetween(3, Math.max(4, slaTarget - 5))));
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "handoff_completed",
      toRef: { type: rule.destinationType, id: rule.destinationRef, label: rule.destinationLabel },
      ruleId: rule.id,
      createdAt: completeAt,
    });
  }

  // --- a few live "now" sessions (started < 5 min ago, mixed statuses) ---
  for (let i = 0; i < 5; i += 1) {
    const startedAt = minutesAgo(intBetween(1, 4));
    const callId = randomUUID();
    await db.insert(callSessions).values({
      id: callId,
      orgId: DEFAULT_ORG_ID,
      voiceAgentId: flow.id,
      recruiterUserId: pick(teamMemberIds),
      candidateRefOrPhone: `+9198${String(10000000 + intBetween(0, 89999999))}`,
      status: i % 2 === 0 ? "assigned" : "active",
      origin: "vapi",
      mode: "browser_mixed",
      startedAt,
      createdByUserId: adminId,
    });
    const intent = pick(intents);
    const rule = ruleByIntent.get(intent)!;
    let seq = 0;
    const at = (offsetSec: number) => new Date(startedAt.getTime() + offsetSec * 1000);
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "triage_started",
      fromRef: { type: "voice_agent", id: flow.id, label: "Front-desk Triage" },
      createdAt: at(0),
    });
    await db.insert(callRoutingEvents).values({
      callId,
      orgId: DEFAULT_ORG_ID,
      seq: seq++,
      kind: "classified",
      classification: { intent, confidence: 0.82, sentiment: 0.1, language: "en" },
      createdAt: at(6),
    });
    if (i >= 2) {
      await db.insert(callRoutingEvents).values({
        callId,
        orgId: DEFAULT_ORG_ID,
        seq: seq++,
        kind: "route_decision",
        toRef: { type: rule.destinationType, id: rule.destinationRef, label: rule.destinationLabel },
        classification: { intent, confidence: 0.82 },
        ruleId: rule.id,
        createdAt: at(10),
      });
      if (i >= 4) {
        await db.insert(callRoutingEvents).values({
          callId,
          orgId: DEFAULT_ORG_ID,
          seq: seq++,
          kind: "handoff_initiated",
          toRef: { type: rule.destinationType, id: rule.destinationRef, label: rule.destinationLabel },
          ruleId: rule.id,
          createdAt: at(12),
        });
      }
    }
  }

  // --- config audit events for the timeline ---
  await db.insert(triageAuditEvents).values([
    {
      orgId: DEFAULT_ORG_ID,
      triageAgentId: flow.id,
      actorUserId: adminId,
      action: "ruleset.published",
      targetType: "rule_set",
      targetId: v1.id,
      diff: { version: 1, ruleCount: 4 },
      createdAt: daysAgo(12),
    },
    {
      orgId: DEFAULT_ORG_ID,
      triageAgentId: flow.id,
      actorUserId: adminId,
      action: "ruleset.published",
      targetType: "rule_set",
      targetId: v2.id,
      diff: { version: 2, ruleCount: 5, note: "Added job_inquiry routing + SLA targets" },
      createdAt: daysAgo(5),
    },
    {
      orgId: DEFAULT_ORG_ID,
      triageAgentId: flow.id,
      actorUserId: adminId,
      action: "ruleset.saved_draft",
      targetType: "flow",
      targetId: flow.id,
      diff: { ruleCount: 5 },
      createdAt: daysAgo(1),
    },
  ]);
}

// ---------- Recruiters page (enterprise) — DEFAULT org ----------
// Seeds manager-authored config + audit so /recruiters renders non-empty for the
// admin / e2e persona: capacity caps (some over-allocated), live quarterly goals
// (attainment spanning ~40–130%), shared leaderboards, nudges, and matching
// admin-event timeline rows. KPI aggregates are computed live off submissions /
// calls / demand_assignments already seeded above. Idempotent — wipeAtsData clears
// the recruiter_* tables for the org first.
async function seedRecruitersForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const amId = userIdByEmail.get("am1@recruitassist.local") ?? adminId;
  const dlId = userIdByEmail.get("dl1@recruitassist.local") ?? adminId;
  const recruiters = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([email, id]) => ({ email, id }));
  if (recruiters.length === 0) return;

  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  // Current quarter window (UTC).
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const qStart = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const qEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Capacity: vary caps so ~1/3 of recruiters end up over-allocated against
  // their open-demand load. Lower caps for some recruiters force the warning.
  for (let i = 0; i < recruiters.length; i += 1) {
    const r = recruiters[i];
    const tight = i % 3 === 0; // tight cap → likelier over-allocated
    await db.insert(recruiterCapacity).values({
      orgId: DEFAULT_ORG_ID,
      recruiterUserId: r.id,
      maxActiveDemands: tight ? intBetween(2, 4) : intBetween(8, 14),
      maxActiveProspects: intBetween(25, 60),
      weeklyCallTarget: intBetween(15, 35),
      notes: tight ? "Reduced capacity — onboarding new account." : null,
      updatedByUserId: dlId,
    });
  }

  // Goals: a live quarterly goal per recruiter for 2–3 metrics, targets
  // calibrated so attainment varies. We don't read actuals here (cheap), just
  // pick plausible targets.
  //
  // NOTE: deliberately exclude the "offers" metric from the seeded current-quarter
  // goals. The recruiters e2e creates an *offers* quarterly goal for whatever
  // recruiter sorts first; seeding an offers goal in the same window would make
  // that create a deterministic 409 goal_exists. submissions + selects keep the
  // goals panel rich without claiming the metric the e2e authors.
  const goalMetrics: Array<{ metric: "submissions" | "selects" | "calls"; lo: number; hi: number }> = [
    { metric: "submissions", lo: 12, hi: 40 },
    { metric: "selects", lo: 3, hi: 12 },
    { metric: "calls", lo: 40, hi: 120 },
  ];
  for (const r of recruiters) {
    const howMany = intBetween(2, 3);
    for (let g = 0; g < howMany; g += 1) {
      const spec = goalMetrics[g % goalMetrics.length];
      await db
        .insert(recruiterGoals)
        .values({
          orgId: DEFAULT_ORG_ID,
          recruiterUserId: r.id,
          metric: spec.metric,
          period: "quarterly",
          periodStart: iso(qStart),
          periodEnd: iso(qEnd),
          targetValue: intBetween(spec.lo, spec.hi),
          note: "Quarterly target set in capacity review.",
          createdByUserId: amId,
        })
        .onConflictDoNothing();
      await db.insert(recruiterAdminEvents).values({
        orgId: DEFAULT_ORG_ID,
        recruiterUserId: r.id,
        actorUserId: amId,
        action: "goal.set",
        after: { metric: spec.metric, period: "quarterly" },
        createdAt: daysAgo(intBetween(2, 30)),
      });
    }
  }

  // Shared leaderboards (configurable + fairness-guarded).
  await db.insert(recruiterLeaderboards).values([
    {
      orgId: DEFAULT_ORG_ID,
      name: "Throughput Q-board",
      isShared: true,
      createdByUserId: dlId,
      config: {
        window: "qtd",
        weights: [
          { metric: "submissions", weight: 0.4 },
          { metric: "selects", weight: 0.4 },
          { metric: "joins", weight: 0.2 },
        ],
        minTenureDays: 30,
        normalizeByCapacity: false,
        excludeOnLeave: true,
      },
    },
    {
      orgId: DEFAULT_ORG_ID,
      name: "Quality board (per-capacity)",
      isShared: true,
      createdByUserId: amId,
      config: {
        window: "90d",
        weights: [
          { metric: "conversion", weight: 0.6 },
          { metric: "joins", weight: 0.4 },
        ],
        minTenureDays: 0,
        normalizeByCapacity: true,
        excludeOnLeave: true,
      },
    },
  ]);
  await db.insert(recruiterAdminEvents).values({
    orgId: DEFAULT_ORG_ID,
    recruiterUserId: null,
    actorUserId: dlId,
    action: "leaderboard.save",
    after: { name: "Throughput Q-board", isShared: true },
    createdAt: daysAgo(7),
  });

  // A handful of nudges + matching admin events so the detail timeline is rich.
  const nudgeKinds: Array<"coaching" | "capacity" | "kudos" | "sla_breach"> = [
    "coaching",
    "capacity",
    "kudos",
    "sla_breach",
  ];
  for (let i = 0; i < Math.min(6, recruiters.length); i += 1) {
    const r = recruiters[i];
    const kind = nudgeKinds[i % nudgeKinds.length];
    const [n] = await db
      .insert(recruiterNudges)
      .values({
        orgId: DEFAULT_ORG_ID,
        recruiterUserId: r.id,
        kind,
        message:
          kind === "kudos"
            ? "Great work closing two offers this week — keep the momentum!"
            : kind === "capacity"
              ? "You're over your demand cap — let's rebalance a couple of reqs."
              : kind === "sla_breach"
                ? "A few submissions have aged past SLA — please follow up with the client."
                : "Let's review your conversion on the Acme demand — book 15 mins?",
        delivery: "in_app_only",
        sentByUserId: dlId,
      })
      .returning({ id: recruiterNudges.id });
    await db.insert(recruiterAdminEvents).values({
      orgId: DEFAULT_ORG_ID,
      recruiterUserId: r.id,
      actorUserId: dlId,
      action: "nudge.send",
      after: { id: n.id, kind },
      createdAt: daysAgo(intBetween(1, 14)),
    });
  }
}

// Seed the Team Monitor supervisor floor for the DEFAULT org so the e2e /
// integration admin persona sees a live floor: heartbeat-backed presence,
// LIVE (active/queued) calls, configurable SLA policies, raised alerts,
// supervision sessions (whisper/barge/takeover), and a non-empty audit
// timeline for shift replay. Mirrors seedCallsAndQaForDefaultOrg /
// seedProctorForDefaultOrg: rich data lives in DEMO_ORG and is invisible to
// DEFAULT_ORG_ID, so we seed straight into the default org here. Idempotent —
// wipeAtsData clears the prior rows.
async function seedTeamMonitorForDefaultOrg(
  userIdByEmail: Map<string, string>,
  candidateIds: string[],
  demandIds: string[],
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  const dlId = userIdByEmail.get("dl1@recruitassist.local") ?? adminId;
  const amId = userIdByEmail.get("am1@recruitassist.local") ?? adminId;
  if (recruiterIds.length === 0) return;

  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
  const pickArr = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  // --- 1) LIVE calls (active + queued) so the floor + live-calls panel render.
  // The existing seedCallsAndQaForDefaultOrg only inserts ENDED calls; live
  // supervision needs in-progress rows. Anchor to real candidates/recruiters.
  type LiveCall = { id: string; recruiterUserId: string; status: "active" | "queued" };
  const liveCalls: LiveCall[] = [];
  const ACTIVE_N = 8; // recruiters currently on a call
  const QUEUED_N = 4; // calls waiting in queue (feeds queue_depth SLA)
  const callRows: Array<typeof callSessions.$inferInsert> = [];
  for (let i = 0; i < ACTIVE_N + QUEUED_N; i += 1) {
    const status: "active" | "queued" = i < ACTIVE_N ? "active" : "queued";
    const id = randomUUID();
    const recruiterUserId = recruiterIds[i % recruiterIds.length];
    const startedAt = minutesAgo(status === "active" ? intBetween(1, 45) : 0);
    callRows.push({
      id,
      orgId: DEFAULT_ORG_ID,
      recruiterUserId: status === "active" ? recruiterUserId : null,
      candidateId: candidateIds.length ? candidateIds[(i * 17) % candidateIds.length] : null,
      demandId: demandIds.length ? demandIds[(i * 5) % demandIds.length] : null,
      status,
      origin: "web" as const,
      mode: "browser_mixed" as const,
      startedAt,
      assignedAt: status === "active" ? startedAt : null,
      acceptedAt: status === "active" ? startedAt : null,
      createdByUserId: recruiterUserId,
    });
    liveCalls.push({ id, recruiterUserId, status });
  }
  if (callRows.length) await db.insert(callSessions).values(callRows);
  const activeCalls = liveCalls.filter((c) => c.status === "active");

  // --- 2) Presence rows: realistic activity mix. on_call recruiters link to an
  // active call; 2 idle recruiters get a stale lastActivityChangeAt so the
  // recruiter_idle_ms SLA fires.
  const presenceRows: Array<typeof recruiterPresence.$inferInsert> = [];
  const onCallRecruiters = new Set(activeCalls.map((c) => c.recruiterUserId));
  let idleAssigned = 0;
  for (let i = 0; i < recruiterIds.length; i += 1) {
    const userId = recruiterIds[i];
    const active = activeCalls.find((c) => c.recruiterUserId === userId);
    let activity: "on_call" | "idle" | "in_meeting" | "offline";
    let lastActivityChangeAt: Date;
    if (active) {
      activity = "on_call";
      lastActivityChangeAt = minutesAgo(intBetween(1, 30));
    } else if (idleAssigned < 6) {
      activity = "idle";
      // First two idle recruiters breach the 10m idle SLA (stale change time).
      lastActivityChangeAt = minutesAgo(idleAssigned < 2 ? intBetween(15, 40) : intBetween(1, 8));
      idleAssigned += 1;
    } else if (i % 5 === 0) {
      activity = "in_meeting";
      lastActivityChangeAt = minutesAgo(intBetween(5, 25));
    } else {
      activity = "offline";
      lastActivityChangeAt = minutesAgo(intBetween(60, 240));
    }
    presenceRows.push({
      orgId: DEFAULT_ORG_ID,
      userId,
      currentActivity: activity,
      activeCallId: active ? active.id : null,
      lastHeartbeatAt: activity === "offline" ? minutesAgo(intBetween(30, 120)) : minutesAgo(intBetween(0, 2)),
      lastActivityChangeAt,
      statusNote: activity === "in_meeting" ? "Pipeline review" : activity === "idle" && idleAssigned <= 2 ? "Between calls" : null,
    });
  }
  if (presenceRows.length) await db.insert(recruiterPresence).values(presenceRows);

  // --- 3) SLA policies (the 5 metrics). Comparator per metric is implicit:
  // higher-is-worse for queue_depth/duration/idle/abandoned; lower-is-worse for
  // answer_rate (rates are percent*100).
  const slaRows: Array<typeof teamSlaPolicies.$inferInsert> = [
    { orgId: DEFAULT_ORG_ID, metric: "queue_depth", warningThreshold: 5, criticalThreshold: 10, updatedByUserId: adminId },
    { orgId: DEFAULT_ORG_ID, metric: "call_duration_ms", warningThreshold: 20 * 60_000, criticalThreshold: 40 * 60_000, updatedByUserId: adminId },
    { orgId: DEFAULT_ORG_ID, metric: "recruiter_idle_ms", warningThreshold: 10 * 60_000, criticalThreshold: 30 * 60_000, updatedByUserId: adminId },
    { orgId: DEFAULT_ORG_ID, metric: "abandoned_rate", warningThreshold: 1000, criticalThreshold: 2000, updatedByUserId: adminId },
    { orgId: DEFAULT_ORG_ID, metric: "answer_rate", warningThreshold: 8000, criticalThreshold: 6000, updatedByUserId: adminId },
  ];
  await db.insert(teamSlaPolicies).values(slaRows).onConflictDoNothing();
  const policyByMetric = new Map(
    (
      await db
        .select({ id: teamSlaPolicies.id, metric: teamSlaPolicies.metric })
        .from(teamSlaPolicies)
        .where(sql`org_id = ${DEFAULT_ORG_ID}::uuid`)
    ).map((r) => [r.metric, r.id] as const),
  );

  // --- 4) Alerts: a mix of open (2 critical, 3 warning) + 1 acked. Subjects tie
  // to seeded recruiters / live calls so the Alerts tab renders non-empty and
  // the open-dedupe partial-unique is exercised (distinct subject per metric).
  const idleRecruiters = presenceRows.filter((p) => p.currentActivity === "idle").slice(0, 2);
  const longCall = activeCalls[0];
  const alertRows: Array<typeof teamAlerts.$inferInsert> = [
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("queue_depth") ?? null,
      metric: "queue_depth",
      severity: "critical",
      state: "open",
      subjectType: "org",
      subjectId: null,
      observedValue: QUEUED_N + 8,
      thresholdValue: 10,
      message: `Queue depth at ${QUEUED_N + 8} — above critical threshold of 10.`,
      createdAt: minutesAgo(intBetween(1, 6)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("recruiter_idle_ms") ?? null,
      metric: "recruiter_idle_ms",
      severity: "critical",
      state: "open",
      subjectType: "user",
      subjectId: idleRecruiters[0]?.userId ?? recruiterIds[0],
      observedValue: 32 * 60_000,
      thresholdValue: 30 * 60_000,
      message: "Recruiter idle 32m — above critical idle threshold.",
      createdAt: minutesAgo(intBetween(2, 8)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("recruiter_idle_ms") ?? null,
      metric: "recruiter_idle_ms",
      severity: "warning",
      state: "open",
      subjectType: "user",
      subjectId: idleRecruiters[1]?.userId ?? recruiterIds[1 % recruiterIds.length],
      observedValue: 16 * 60_000,
      thresholdValue: 10 * 60_000,
      message: "Recruiter idle 16m — above warning idle threshold.",
      createdAt: minutesAgo(intBetween(2, 10)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("call_duration_ms") ?? null,
      metric: "call_duration_ms",
      severity: "warning",
      state: "open",
      subjectType: "call",
      subjectId: longCall?.id ?? null,
      observedValue: 24 * 60_000,
      thresholdValue: 20 * 60_000,
      message: "Active call running 24m — above warning duration threshold.",
      createdAt: minutesAgo(intBetween(1, 5)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("answer_rate") ?? null,
      metric: "answer_rate",
      severity: "warning",
      state: "open",
      subjectType: "org",
      subjectId: "answer_rate",
      observedValue: 7400,
      thresholdValue: 8000,
      message: "Answer rate 74% — below warning threshold of 80%.",
      createdAt: minutesAgo(intBetween(3, 12)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      policyId: policyByMetric.get("abandoned_rate") ?? null,
      metric: "abandoned_rate",
      severity: "warning",
      state: "acked",
      subjectType: "org",
      subjectId: "abandoned_rate",
      observedValue: 1300,
      thresholdValue: 1000,
      message: "Abandoned rate 13% — above warning threshold.",
      ackedByUserId: dlId,
      ackedAt: minutesAgo(intBetween(1, 4)),
      createdAt: minutesAgo(intBetween(10, 20)),
    },
  ];
  // Insert one-by-one with onConflictDoNothing so the open-dedupe partial-unique
  // (org, metric, subject) never aborts the whole batch.
  for (const a of alertRows) {
    await db.insert(teamAlerts).values(a).onConflictDoNothing();
  }

  // --- 5) Supervision sessions: 1 ended whisper, 1 active barge, 1 ended
  // takeover — on active live calls — plus matching audit rows so replay is
  // non-empty.
  const auditRows: Array<typeof teamMonitorAudit.$inferInsert> = [];
  const superRows: Array<typeof callSupervisionSessions.$inferInsert> = [];
  const superSpecs: Array<{ mode: "whisper" | "barge" | "takeover"; state: "active" | "ended" }> = [
    { mode: "whisper", state: "ended" },
    { mode: "barge", state: "active" },
    { mode: "takeover", state: "ended" },
  ];
  for (let i = 0; i < superSpecs.length && i < activeCalls.length; i += 1) {
    const spec = superSpecs[i];
    const call = activeCalls[i];
    const id = randomUUID();
    const startedAt = minutesAgo(intBetween(2, 20));
    const supervisor = dlId ?? adminId ?? recruiterIds[0];
    superRows.push({
      id,
      orgId: DEFAULT_ORG_ID,
      callId: call.id,
      supervisorUserId: supervisor,
      recruiterUserId: call.recruiterUserId,
      mode: spec.mode,
      state: spec.state,
      idempotencyKey: `seed-${spec.mode}-${id}`,
      provider: "stub",
      startedAt,
      endedAt: spec.state === "ended" ? new Date(startedAt.getTime() + intBetween(30, 180) * 1000) : null,
      endedReason: spec.state === "ended" ? "supervisor_ended" : null,
    });
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      actorUserId: supervisor,
      action: `supervision.${spec.mode}.start`,
      targetType: "call",
      targetId: call.id,
      payload: { mode: spec.mode, sessionId: id },
      createdAt: startedAt,
    });
    if (spec.state === "ended") {
      auditRows.push({
        orgId: DEFAULT_ORG_ID,
        actorUserId: supervisor,
        action: `supervision.${spec.mode}.end`,
        targetType: "call",
        targetId: call.id,
        payload: { mode: spec.mode, sessionId: id },
        createdAt: new Date(startedAt.getTime() + 120_000),
      });
    }
  }
  if (superRows.length) await db.insert(callSupervisionSessions).values(superRows).onConflictDoNothing();

  // --- 6) A few reassign + alert.ack audit rows so the replay timeline shows
  // the full range of supervisor verbs.
  if (activeCalls.length) {
    const fromR = recruiterIds[0];
    const toR = recruiterIds[1 % recruiterIds.length];
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      actorUserId: dlId ?? adminId,
      action: "call.reassign",
      targetType: "call",
      targetId: pickArr(liveCalls.filter((c) => c.status === "queued")).id ?? liveCalls[0].id,
      payload: { fromUserId: fromR, toUserId: toR, reason: "Rebalancing off overloaded recruiter." },
      createdAt: minutesAgo(intBetween(5, 30)),
    });
  }
  auditRows.push({
    orgId: DEFAULT_ORG_ID,
    actorUserId: dlId ?? adminId,
    action: "alert.ack",
    targetType: "alert",
    targetId: "abandoned_rate",
    payload: { metric: "abandoned_rate" },
    createdAt: minutesAgo(intBetween(1, 4)),
  });
  auditRows.push({
    orgId: DEFAULT_ORG_ID,
    actorUserId: amId ?? adminId,
    action: "sla_policy.update",
    targetType: "policy",
    targetId: "queue_depth",
    payload: { warningThreshold: 5, criticalThreshold: 10 },
    createdAt: minutesAgo(intBetween(20, 60)),
  });
  if (auditRows.length) await db.insert(teamMonitorAudit).values(auditRows);
}

// Coaching enterprise demo data for the integration admin persona
// (admin@recruitassist.local in DEFAULT_ORG_ID). Mirrors
// seedQaReviewForDefaultOrg / seedQuestionBankEnterpriseForDefaultOrg: this is
// the e2e/itest-visible seed (the rich demo seed lives in db/demo/coaching.ts
// under DEMO_ORG, unreachable by the e2e persona). Seeds 6 enriched scenarios
// (objections/successCriteria/openingLine/language, published), completed +
// in-progress runs with REAL per-criterion coaching_run_scores rows (engine-
// shaped, not a cached blob), 2 curricula, ~20 assignments across recruiters
// with a status mix, and a handful of audit events so the timeline renders.
// Idempotent — wipeAtsData clears the whole coaching domain for the org first.
async function seedCoachingForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const dlId = userIdByEmail.get("dl1@recruitassist.local") ?? adminId;
  const recruiterIds = [...userIdByEmail.entries()]
    .filter(([email]) => /^recruiter\d+@recruitassist\.local$/.test(email))
    .map(([, id]) => id);
  if (recruiterIds.length === 0 || !adminId) return;

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const daysAhead = (n: number) => new Date(Date.now() + n * 86400_000);

  // Link the general-screen rubric so run scores map onto real criteria.
  const rubric = await db
    .select({ id: callRubrics.id, criteria: callRubrics.criteria })
    .from(callRubrics)
    .where(eq(callRubrics.orgId, DEFAULT_ORG_ID))
    .orderBy(desc(callRubrics.isDefault))
    .limit(1);
  const rubricId = rubric[0]?.id ?? null;
  const criteria: RubricCriterion[] = (rubric[0]?.criteria ?? []) as RubricCriterion[];

  // ---- 1) Six enriched, published scenarios ----
  type ScenarioSeed = typeof coachingScenarios.$inferInsert;
  const sc = (
    title: string,
    difficulty: ScenarioSeed["difficulty"],
    persona: Record<string, unknown>,
    objections: string[],
    openingLine: string,
    tags: string[],
  ): ScenarioSeed => ({
    orgId: DEFAULT_ORG_ID,
    title,
    description: `Practice scenario: ${title}. Talk to an AI candidate and get scored against the linked rubric.`,
    difficulty,
    candidatePersona: persona,
    targetRubricId: rubricId,
    tags,
    isPublished: true,
    language: "hinglish",
    openingLine,
    objections,
    successCriteria: [
      { id: "sc-rapport", label: "Builds rapport early", weight: 1 },
      { id: "sc-discovery", label: "Uncovers hidden context", weight: 2 },
      { id: "sc-close", label: "Secures a clear next step", weight: 1 },
    ],
    estimatedMinutes: intBetween(6, 12),
    version: 1,
    publishedVersion: 1,
    publishedAt: daysAgo(intBetween(10, 40)),
    createdByUserId: dlId,
  });

  const scenarioSeeds: ScenarioSeed[] = [
    sc(
      "Notice-period negotiation",
      "medium",
      { candidateName: "Krishna", mood: "logical", noticePeriodDays: 90, resistance: "medium", hiddenContext: "Has 22 days of leave; will use if asked." },
      ["My notice is 90 days, non-negotiable.", "HR won't buy me out."],
      "Haan boliye, aap notice period ke baare mein puchhna chahte the?",
      ["negotiation", "notice-period"],
    ),
    sc(
      "Comp expectation gap",
      "hard",
      { candidateName: "Anjali", mood: "firm", currentCtcLakhs: 28, expectedCtcLakhs: 50, resistance: "high", hiddenContext: "Will accept 38 + variable if growth is clear." },
      ["I won't move for less than 50 LPA.", "My current company is counter-offering."],
      "Hi Anjali, thanks for taking the call — shall we start with what you're looking for?",
      ["negotiation", "compensation"],
    ),
    sc(
      "Cold outreach to a wary candidate",
      "hard",
      { candidateName: "Riya", mood: "annoyed", resistance: "high", hiddenContext: "Warms up if recruiter acknowledges past spam and gets to the point." },
      ["You people keep spamming me.", "I'm in a meeting, make it quick."],
      "Riya, I know recruiters bug you a lot — 60 seconds, then you decide?",
      ["sourcing", "objection-handling"],
    ),
    sc(
      "Drawing out an introverted senior engineer",
      "medium",
      { candidateName: "Ishaan", mood: "introverted", resistance: "low", hiddenContext: "Knows depth but won't volunteer; open-ended questions unlock detail." },
      ["It was fine, nothing special.", "I just did my part of the system."],
      "Ishaan, tell me about a system you're genuinely proud of.",
      ["discovery", "technical-screen"],
    ),
    sc(
      "Counter-offer save",
      "hard",
      { candidateName: "Aarav", mood: "torn", resistance: "high", hiddenContext: "Counter is +25% but no role change; test counter-pitch on growth + scope." },
      ["My current company offered me 25% more.", "Why should I still switch?"],
      "Aarav, congrats on the counter — can we talk about what it doesn't fix?",
      ["negotiation", "closing"],
    ),
    sc(
      "First-call interest gauge",
      "easy",
      { candidateName: "Meera", mood: "curious", resistance: "low", hiddenContext: "Open to listening if the role's growth story lands in the first two minutes." },
      ["I'm not actively looking.", "Tell me why this is different."],
      "Meera, two minutes — if it's not a fit, I'll let you go.",
      ["sourcing", "interest-gauge"],
    ),
  ];
  const scenarioRows = await db
    .insert(coachingScenarios)
    .values(scenarioSeeds)
    .returning({ id: coachingScenarios.id, title: coachingScenarios.title });

  // ---- 2) Runs (completed + in-progress) with REAL per-criterion scores ----
  type RunSeed = typeof coachingRuns.$inferInsert;
  type ScoreSeed = typeof coachingRunScores.$inferInsert;
  const auditRows: Array<typeof coachingAuditEvents.$inferInsert> = [];
  const bandFor = (s: number): ScoreSeed["band"] => (s >= 80 ? "excellent" : s >= 60 ? "pass" : "fail");

  for (const scenario of scenarioRows) {
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      action: "scenario.created",
      actorUserId: dlId,
      scenarioId: scenario.id,
      detail: { seeded: true, title: scenario.title },
    });
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      action: "scenario.published",
      actorUserId: dlId,
      scenarioId: scenario.id,
      detail: { version: 1 },
    });

    // 2-4 runs per scenario across random recruiters.
    const runCount = intBetween(2, 4);
    for (let i = 0; i < runCount; i += 1) {
      const recruiterId = pick(recruiterIds);
      const completed = i < runCount - 1; // last one left in-progress
      const startedAt = daysAgo(intBetween(1, 45));
      const overall = completed ? intBetween(52, 94) : null;
      const runRows = await db
        .insert(coachingRuns)
        .values({
          orgId: DEFAULT_ORG_ID,
          scenarioId: scenario.id,
          recruiterUserId: recruiterId,
          status: completed ? "completed" : "live",
          mode: "ai_roleplay",
          scenarioVersion: 1,
          startedAt,
          completedAt: completed ? new Date(startedAt.getTime() + intBetween(6, 14) * 60_000) : null,
          cachedOverallScore: overall != null ? String(overall) : null,
          scoringStatus: completed ? "scored" : "pending",
          scoreSource: completed ? "ai" : null,
          scoredAt: completed ? new Date(startedAt.getTime() + 16 * 60_000) : null,
          feedback: completed
            ? {
                strengths: ["Opened with a warm, on-language hook.", "Acknowledged the candidate's main objection before pitching."],
                improvements: ["Probe hidden context earlier.", "Confirm a concrete next step before closing."],
                generatedBy: "stub",
                modelVersion: "stub-v1",
              }
            : null,
        } satisfies RunSeed)
        .returning({ id: coachingRuns.id });
      const runId = runRows[0]?.id;
      if (!runId) continue;

      auditRows.push({
        orgId: DEFAULT_ORG_ID,
        action: "run.started",
        actorUserId: recruiterId,
        scenarioId: scenario.id,
        runId,
        detail: { mode: "ai_roleplay" },
      });

      if (completed && criteria.length > 0) {
        const scoreRows: ScoreSeed[] = criteria.map((c) => {
          const s = Math.max(0, Math.min(100, (overall ?? 70) + intBetween(-12, 12)));
          return {
            orgId: DEFAULT_ORG_ID,
            runId,
            criterionId: c.id,
            criterionName: c.name,
            weight: String(c.weight ?? 1),
            score: String(s),
            band: bandFor(s),
            evidence: `Observed in transcript: candidate response to "${scenario.title}" probe.`,
            source: "ai",
          };
        });
        if (scoreRows.length) await db.insert(coachingRunScores).values(scoreRows);
        auditRows.push({
          orgId: DEFAULT_ORG_ID,
          action: "run.scored",
          actorUserId: null,
          scenarioId: scenario.id,
          runId,
          detail: { overall, generatedBy: "stub", criteria: scoreRows.length },
        });
      }
    }
  }

  // ---- 3) Two curricula (ordered scenario sets) ----
  const allScenarioIds = scenarioRows.map((s) => s.id);
  const curriculumRows = await db
    .insert(coachingCurricula)
    .values([
      {
        orgId: DEFAULT_ORG_ID,
        name: "New recruiter onboarding",
        description: "Foundational practice loop for recruiters in their first month.",
        scenarioIds: allScenarioIds.slice(0, 3),
        isPublished: true,
        createdByUserId: dlId,
      },
      {
        orgId: DEFAULT_ORG_ID,
        name: "Objection handling mastery",
        description: "Hard scenarios focused on negotiation and pushback.",
        scenarioIds: allScenarioIds.slice(2),
        isPublished: true,
        createdByUserId: dlId,
      },
    ])
    .returning({ id: coachingCurricula.id });
  for (const cur of curriculumRows) {
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      action: "curriculum.created",
      actorUserId: dlId,
      curriculumId: cur.id,
      detail: { seeded: true },
    });
  }

  // ---- 4) ~20 assignments across recruiters, mixed status + due dates ----
  type AssignmentSeed = typeof coachingAssignments.$inferInsert;
  const statuses: AssignmentSeed["status"][] = ["assigned", "in_progress", "completed", "overdue"];
  const assignmentSeeds: AssignmentSeed[] = [];
  for (let i = 0; i < 20; i += 1) {
    const assignee = pick(recruiterIds);
    const status = statuses[i % statuses.length];
    const useCurriculum = i % 4 === 0 && curriculumRows.length > 0;
    const dueAt = status === "overdue" ? daysAgo(intBetween(1, 7)) : daysAhead(intBetween(2, 21));
    assignmentSeeds.push({
      orgId: DEFAULT_ORG_ID,
      scenarioId: useCurriculum ? null : pick(allScenarioIds),
      curriculumId: useCurriculum ? pick(curriculumRows).id : null,
      assigneeUserId: assignee,
      assignedByUserId: dlId,
      status,
      dueAt,
      completedAt: status === "completed" ? daysAgo(intBetween(1, 10)) : null,
      minPassScore: i % 3 === 0 ? "70" : null,
    });
  }
  const assignmentRows = await db
    .insert(coachingAssignments)
    .values(assignmentSeeds)
    .returning({ id: coachingAssignments.id, assigneeUserId: coachingAssignments.assigneeUserId, status: coachingAssignments.status });
  for (const a of assignmentRows) {
    auditRows.push({
      orgId: DEFAULT_ORG_ID,
      action: "assignment.created",
      actorUserId: dlId,
      assignmentId: a.id,
      detail: { assignee: a.assigneeUserId },
    });
    if (a.status === "completed") {
      auditRows.push({
        orgId: DEFAULT_ORG_ID,
        action: "assignment.completed",
        actorUserId: a.assigneeUserId,
        assignmentId: a.id,
        detail: { seeded: true },
      });
    }
  }

  if (auditRows.length) await db.insert(coachingAuditEvents).values(auditRows);
}

// Seeds the analytics report-engine surfaces for the DEFAULT-org admin persona
// (admin@recruitassist.local in DEFAULT_ORG_ID) so the page renders non-empty
// for BOTH the api-itest admin and the e2e persona. Mirrors
// seedCoachingForDefaultOrg / seedTeamMonitorForDefaultOrg: the underlying
// aggregate data (submissions / stage transitions / candidate sources / calls /
// rubric scores) is already seeded richly upstream — this only seeds the
// persisted report-engine config (saved views, scheduled reports, export jobs).
// Idempotent: wipeAtsData clears these three tables for the org first.
async function seedAnalyticsForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const adminId = userIdByEmail.get("admin@recruitassist.local") ?? null;
  if (!adminId) return;
  const dlId = userIdByEmail.get("dl1@recruitassist.local") ?? adminId;
  const amId = userIdByEmail.get("am1@recruitassist.local") ?? adminId;

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const daysAhead = (n: number) => new Date(Date.now() + n * 86400_000);
  const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  // ---- 1) Saved views (3 active + 1 shared org-wide + 1 archived) ----
  type ViewSeed = typeof analyticsSavedViews.$inferInsert;
  const viewSeeds: ViewSeed[] = [
    {
      orgId: DEFAULT_ORG_ID,
      ownerUserId: adminId,
      name: "Q2 Funnel Health",
      description: "Stage funnel + velocity for the current quarter, all recruiters.",
      config: {
        range: { token: "this_quarter" },
        compare: true,
        granularity: "week",
        pinned: ["funnel", "velocity", "source_effectiveness"],
      },
      isShared: true,
      isArchived: false,
      updatedAt: daysAgo(2),
    },
    {
      orgId: DEFAULT_ORG_ID,
      ownerUserId: adminId,
      name: "Source ROI — last 90d",
      description: "Which sourcing channels convert to onboarded, last 90 days.",
      config: {
        range: { token: "last_90d" },
        compare: false,
        granularity: "month",
        pinned: ["source_effectiveness", "recruiter_productivity"],
      },
      isShared: false,
      isArchived: false,
      updatedAt: daysAgo(5),
    },
    {
      orgId: DEFAULT_ORG_ID,
      ownerUserId: dlId,
      name: "My Pod — last 30d",
      description: "Delivery-lead pod productivity and quality, rolling 30 days.",
      config: {
        range: { token: "last_30d" },
        compare: true,
        granularity: "day",
        segments: {},
        pinned: ["recruiter_productivity", "quality_distribution", "call_volume"],
      },
      isShared: false,
      isArchived: false,
      updatedAt: daysAgo(1),
    },
    {
      orgId: DEFAULT_ORG_ID,
      ownerUserId: adminId,
      name: "Old Quarterly Board (archived)",
      description: "Superseded by Q2 Funnel Health.",
      config: { range: { token: "last_quarter" }, pinned: ["funnel"] },
      isShared: false,
      isArchived: true,
      updatedAt: daysAgo(60),
    },
  ];
  const viewRows = await db
    .insert(analyticsSavedViews)
    .values(viewSeeds)
    .returning({ id: analyticsSavedViews.id, name: analyticsSavedViews.name });

  const viewByName = new Map(viewRows.map((v) => [v.name, v.id]));
  const funnelViewId = viewByName.get("Q2 Funnel Health") ?? viewRows[0].id;
  const sourceViewId = viewByName.get("Source ROI — last 90d") ?? viewRows[0].id;

  // ---- 2) Scheduled reports (weekly funnel + monthly source-effectiveness) ----
  type SchedSeed = typeof analyticsScheduledReports.$inferInsert;
  const schedSeeds: SchedSeed[] = [
    {
      orgId: DEFAULT_ORG_ID,
      savedViewId: funnelViewId,
      createdByUserId: adminId,
      name: "Weekly Funnel — Delivery Lead",
      format: "csv",
      cadence: "weekly",
      recipients: ["dl1@recruitassist.local"],
      isEnabled: true,
      nextRunAt: daysAhead(intBetween(1, 6)),
      lastRunAt: daysAgo(intBetween(2, 6)),
    },
    {
      orgId: DEFAULT_ORG_ID,
      savedViewId: sourceViewId,
      createdByUserId: amId,
      name: "Monthly Source Effectiveness",
      format: "csv",
      cadence: "monthly",
      recipients: ["am1@recruitassist.local", "admin@recruitassist.local"],
      isEnabled: true,
      nextRunAt: daysAhead(intBetween(7, 20)),
      lastRunAt: daysAgo(intBetween(20, 30)),
    },
  ];
  await db.insert(analyticsScheduledReports).values(schedSeeds);

  // ---- 3) Export jobs (2 ready CSV blobs so the download path is exercisable) ----
  type ExportSeed = typeof analyticsExportJobs.$inferInsert;
  const exportSeeds: ExportSeed[] = [
    {
      orgId: DEFAULT_ORG_ID,
      requestedByUserId: adminId,
      reportKey: "funnel",
      format: "csv",
      params: { range: "last_30d" },
      status: "ready",
      rowCount: 6,
      blobKey: `analytics-exports/${DEFAULT_ORG_ID}/funnel-seed.csv`,
      idempotencyKey: `seed-funnel-${DEFAULT_ORG_ID}`,
      completedAt: daysAgo(1),
    },
    {
      orgId: DEFAULT_ORG_ID,
      requestedByUserId: dlId,
      reportKey: "source_effectiveness",
      format: "csv",
      params: { range: "last_90d" },
      status: "ready",
      rowCount: 5,
      blobKey: `analytics-exports/${DEFAULT_ORG_ID}/source-seed.csv`,
      idempotencyKey: `seed-source-${DEFAULT_ORG_ID}`,
      completedAt: daysAgo(3),
    },
  ];
  await db.insert(analyticsExportJobs).values(exportSeeds);
}

// Knowledge Base enterprise demo data for the integration admin persona
// (admin@recruitassist.local in DEFAULT_ORG_ID). Mirrors
// seedAnalyticsForDefaultOrg / seedQuestionBankEnterpriseForDefaultOrg: this is
// the e2e-visible data (the rich KB demo lives in DEMO_ORG and is invisible to
// the e2e persona). Idempotent — wipeAtsData clears the whole kb_* domain for
// the org first, then this hydrates collections + sources + telemetry + eval +
// feedback + audit so every tab renders non-empty and metrics actually move.
async function seedKnowledgeBaseForDefaultOrg(
  userIdByEmail: Map<string, string>,
  rng: () => number,
): Promise<void> {
  const admin = userIdByEmail.get("admin@recruitassist.local") ?? null;
  const qa = userIdByEmail.get("qa1@recruitassist.local") ?? admin;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
  const queryHash = (q: string) =>
    createHash("sha256").update(q.toLowerCase().trim()).digest("hex");

  // 1. Three collections, one per corpus, with staleness policies.
  const [jdCol] = await db
    .insert(kbCollections)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "JD library",
      description: "Job descriptions and role briefs that power JD-match + Copilot.",
      corpus: "jd",
      status: "active",
      staleAfterDays: 30,
      createdByUserId: admin,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(2),
    })
    .returning({ id: kbCollections.id });
  const [companyCol] = await db
    .insert(kbCollections)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "Company knowledge",
      description: "Policies, benefits, and process docs the voice agents answer from.",
      corpus: "company",
      status: "active",
      staleAfterDays: 180,
      createdByUserId: admin,
      createdAt: daysAgo(58),
      updatedAt: daysAgo(5),
    })
    .returning({ id: kbCollections.id });
  const [qbCol] = await db
    .insert(kbCollections)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "Technical question bank",
      description: "Curated technical probes for live-assist + post-call extraction.",
      corpus: "question_bank",
      status: "active",
      staleAfterDays: null,
      createdByUserId: admin,
      createdAt: daysAgo(55),
      updatedAt: daysAgo(10),
    })
    .returning({ id: kbCollections.id });

  // 2. Sources assigned to collections by corpus. One stale (last_indexed 200d
  //    ago) and one deprecated so the staleness flag + lifecycle filter both
  //    have real rows.
  const sourceSpecs: {
    name: string;
    type: "URL" | "Upload" | "Confluence" | "SharePoint";
    collectionId: string;
    status: "indexing" | "indexed" | "error" | "deprecated";
    lastIndexedDays: number;
    createdDays: number;
  }[] = [
    { name: "Senior Java Backend — JD", type: "Upload", collectionId: jdCol.id, status: "indexed", lastIndexedDays: 4, createdDays: 50 },
    { name: "React Frontend Engineer — JD", type: "Upload", collectionId: jdCol.id, status: "indexed", lastIndexedDays: 200, createdDays: 48 },
    { name: "Data Engineer — JD", type: "URL", collectionId: jdCol.id, status: "indexed", lastIndexedDays: 9, createdDays: 45 },
    { name: "Leave & Benefits Policy", type: "Confluence", collectionId: companyCol.id, status: "indexed", lastIndexedDays: 30, createdDays: 40 },
    { name: "Notice Period & Buyout Guide", type: "Confluence", collectionId: companyCol.id, status: "indexed", lastIndexedDays: 12, createdDays: 38 },
    { name: "Legacy Relocation Policy (2023)", type: "Upload", collectionId: companyCol.id, status: "deprecated", lastIndexedDays: 220, createdDays: 60 },
    { name: "Spring Boot Deep-Dive Questions", type: "Upload", collectionId: qbCol.id, status: "indexed", lastIndexedDays: 8, createdDays: 35 },
    { name: "System Design Probes", type: "Upload", collectionId: qbCol.id, status: "indexing", lastIndexedDays: 0, createdDays: 1 },
  ];

  const sourceRows = await db
    .insert(kbSources)
    .values(
      sourceSpecs.map((s) => ({
        orgId: DEFAULT_ORG_ID,
        name: s.name,
        type: s.type,
        status: s.status,
        collectionId: s.collectionId,
        createdAt: daysAgo(s.createdDays),
        lastIndexedAt: s.status === "indexing" ? null : daysAgo(s.lastIndexedDays),
        deprecatedAt: s.status === "deprecated" ? daysAgo(5) : null,
        lastRetrievedAt: s.status === "deprecated" ? null : daysAgo(Math.floor(rng() * 5)),
      })),
    )
    .returning({ id: kbSources.id, name: kbSources.name, collectionId: kbSources.collectionId });

  // 3. One document per source (ingestion-visibility) with a chunk-count proxy.
  for (const s of sourceRows) {
    await db.insert(documents).values({
      sourceId: s.id,
      title: `${s.name}.pdf`,
      mime: "application/pdf",
      bytes: 40_000 + Math.floor(rng() * 200_000),
      storageKey: `seed/kb/${s.id}.pdf`,
      status: "indexed",
      createdAt: daysAgo(Math.floor(5 + rng() * 30)),
    });
  }

  // 4. Per-collection grants: recruiter → read on JD + Company; qa_reviewer →
  //    read on the technical bank. (admin is implicit via knowledge.* perms.)
  await db.insert(kbCollectionGrants).values([
    { orgId: DEFAULT_ORG_ID, collectionId: jdCol.id, role: "recruiter", level: "read" },
    { orgId: DEFAULT_ORG_ID, collectionId: companyCol.id, role: "recruiter", level: "read" },
    { orgId: DEFAULT_ORG_ID, collectionId: qbCol.id, role: "qa_reviewer", level: "read" },
  ]);

  // 5. Retrieval telemetry: ~2.5k events over the last 30 days across sources,
  //    varying score, ~8% zero-result (had_results=false) to feed content gaps.
  //    Written in batches so retrievals7d / avg latency / gap report are real.
  const gapQueries = [
    "what is the WFH policy for contractors",
    "relocation reimbursement amount 2026",
    "gratuity eligibility after 4 years",
    "ESPP enrollment window",
  ];
  const hitQueries = [
    "spring boot transaction isolation",
    "react useeffect cleanup",
    "notice period buyout calculation",
    "java backend senior responsibilities",
    "data pipeline orchestration airflow",
    "system design rate limiter",
  ];
  const surfaces = ["suggest", "kb_search", "live_rubric"] as const;
  const liveSources = sourceRows.filter((s) => true);
  const events: (typeof kbRetrievalEvents.$inferInsert)[] = [];
  const EVENT_COUNT = 2500;
  for (let i = 0; i < EVENT_COUNT; i++) {
    const ageDays = rng() * 30;
    const isGap = rng() < 0.08;
    const surface = surfaces[Math.floor(rng() * surfaces.length)];
    if (isGap) {
      const q = gapQueries[Math.floor(rng() * gapQueries.length)];
      events.push({
        orgId: DEFAULT_ORG_ID,
        collectionId: null,
        sourceId: null,
        corpus: rng() < 0.5 ? "company" : "jd",
        surface,
        queryHash: queryHash(q),
        rank: 0,
        score: null,
        isTopHit: false,
        hadResults: false,
        latencyMs: 30 + Math.floor(rng() * 120),
        createdAt: daysAgo(ageDays),
      });
    } else {
      const q = hitQueries[Math.floor(rng() * hitQueries.length)];
      const src = liveSources[Math.floor(rng() * liveSources.length)];
      const topK = 1 + Math.floor(rng() * 3);
      for (let r = 0; r < topK; r++) {
        events.push({
          orgId: DEFAULT_ORG_ID,
          collectionId: src.collectionId,
          sourceId: src.id,
          corpus: null,
          surface,
          queryHash: queryHash(q),
          rank: r,
          score: 0.55 + rng() * 0.4,
          isTopHit: r === 0,
          hadResults: true,
          latencyMs: 40 + Math.floor(rng() * 160),
          createdAt: daysAgo(ageDays),
        });
      }
    }
  }
  for (let i = 0; i < events.length; i += 500) {
    await db.insert(kbRetrievalEvents).values(events.slice(i, i + 500));
  }

  // 6. One eval suite ("JD retrieval smoke") with 6 cases + one completed run
  //    (used_real_embeddings=false stub) so the Eval tab is non-empty on load.
  const jdSources = sourceRows.filter((s) => s.collectionId === jdCol.id);
  const [suite] = await db
    .insert(kbEvalSuites)
    .values({
      orgId: DEFAULT_ORG_ID,
      name: "JD retrieval smoke",
      corpus: "jd",
      createdByUserId: admin,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(3),
    })
    .returning({ id: kbEvalSuites.id });

  const caseSpecs = [
    { query: "senior java backend responsibilities", src: jdSources[0], snippet: "Java" },
    { query: "react frontend engineer requirements", src: jdSources[1] ?? jdSources[0], snippet: "React" },
    { query: "data engineer airflow pipeline", src: jdSources[2] ?? jdSources[0], snippet: "Data" },
    { query: "spring boot experience needed", src: jdSources[0], snippet: "Spring" },
    { query: "frontend state management", src: jdSources[1] ?? jdSources[0], snippet: "Frontend" },
    { query: "etl batch processing role", src: jdSources[2] ?? jdSources[0], snippet: "Engineer" },
  ];
  const caseRows = await db
    .insert(kbEvalCases)
    .values(
      caseSpecs.map((c) => ({
        suiteId: suite.id,
        query: c.query,
        expectedSourceId: c.src.id,
        expectedCollectionId: jdCol.id,
        expectedSnippetContains: c.snippet,
        createdAt: daysAgo(18),
      })),
    )
    .returning({ id: kbEvalCases.id, query: kbEvalCases.query });

  const hits = caseRows.map((_, i) => i !== 5); // 5/6 hit
  const hitRate = hits.filter(Boolean).length / hits.length;
  const reciprocals = hits.map((h) => (h ? 1 / (1 + Math.floor(rng() * 2)) : 0));
  const mrr = reciprocals.reduce((a, b) => a + b, 0) / reciprocals.length;
  const citationOk = caseRows.map((_, i) => i % 3 !== 2); // 4/6 citation-accurate
  const [run] = await db
    .insert(kbEvalRuns)
    .values({
      orgId: DEFAULT_ORG_ID,
      suiteId: suite.id,
      status: "completed",
      caseCount: caseRows.length,
      hitRate,
      mrr,
      citationAccuracy: citationOk.filter(Boolean).length / citationOk.length,
      usedRealEmbeddings: false,
      triggeredByUserId: admin,
      createdAt: daysAgo(3),
      completedAt: daysAgo(3),
    })
    .returning({ id: kbEvalRuns.id });

  await db.insert(kbEvalRunCases).values(
    caseRows.map((c, i) => ({
      runId: run.id,
      caseId: c.id,
      query: c.query,
      hit: hits[i],
      rankOfExpected: hits[i] ? 1 + Math.floor(rng() * 2) : null,
      citationOk: citationOk[i],
      topSourceId: caseSpecs[i].src.id,
      topSnippet: `…${caseSpecs[i].snippet} engineer with relevant experience…`,
    })),
  );

  // 7. Answer feedback queue: mix of open/actioned, up/down with reasons.
  const fbSrc = sourceRows;
  await db.insert(kbAnswerFeedback).values([
    {
      orgId: DEFAULT_ORG_ID, sourceId: fbSrc[5].id, collectionId: companyCol.id,
      query: "relocation reimbursement amount 2026", rating: "down", reason: "outdated",
      comment: "Cited the 2023 relocation policy — numbers are stale.", status: "open",
      submittedByUserId: qa, createdAt: daysAgo(2),
    },
    {
      orgId: DEFAULT_ORG_ID, sourceId: fbSrc[0].id, collectionId: jdCol.id,
      query: "senior java backend responsibilities", rating: "up", reason: "helpful",
      status: "open", submittedByUserId: admin, createdAt: daysAgo(4),
    },
    {
      orgId: DEFAULT_ORG_ID, sourceId: fbSrc[4].id, collectionId: companyCol.id,
      query: "notice period buyout calculation", rating: "down", reason: "incomplete",
      comment: "Missing the manager-approval step.", status: "actioned",
      submittedByUserId: qa, resolvedByUserId: admin, createdAt: daysAgo(9), resolvedAt: daysAgo(6),
    },
    {
      orgId: DEFAULT_ORG_ID, sourceId: fbSrc[6].id, collectionId: qbCol.id,
      query: "spring boot transaction isolation", rating: "up", reason: "helpful",
      status: "open", submittedByUserId: admin, createdAt: daysAgo(1),
    },
    {
      orgId: DEFAULT_ORG_ID, sourceId: fbSrc[1].id, collectionId: jdCol.id,
      query: "react frontend engineer requirements", rating: "down", reason: "irrelevant",
      comment: "Returned the Java JD instead.", status: "dismissed",
      submittedByUserId: qa, resolvedByUserId: admin, createdAt: daysAgo(12), resolvedAt: daysAgo(11),
    },
  ]);

  // 8. Audit timeline mirroring the create/grant/upload/deprecate/eval actions.
  const auditRows: (typeof kbAudit.$inferInsert)[] = [
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "collection", entityId: jdCol.id, action: "collection.create", detail: { name: "JD library", corpus: "jd" }, createdAt: daysAgo(60) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "collection", entityId: companyCol.id, action: "collection.create", detail: { name: "Company knowledge" }, createdAt: daysAgo(58) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "collection", entityId: qbCol.id, action: "collection.create", detail: { name: "Technical question bank" }, createdAt: daysAgo(55) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "grant", entityId: jdCol.id, action: "grant.add", detail: { role: "recruiter", level: "read" }, createdAt: daysAgo(54) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "source", entityId: sourceRows[0].id, action: "source.create", detail: { name: sourceRows[0].name }, createdAt: daysAgo(50) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "source", entityId: sourceRows[5].id, action: "source.deprecate", detail: { reason: "superseded by 2026 policy" }, createdAt: daysAgo(5) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "eval_run", entityId: run.id, action: "eval.run", detail: { suite: "JD retrieval smoke", hitRate, usedRealEmbeddings: false }, createdAt: daysAgo(3) },
    { orgId: DEFAULT_ORG_ID, actorUserId: admin, entityType: "feedback", entityId: fbSrc[4].id, action: "feedback.resolve", detail: { status: "actioned" }, createdAt: daysAgo(6) },
  ];
  await db.insert(kbAudit).values(auditRows);
}

export async function runSeed(): Promise<void> {
  // Make sure the default org exists (created by 0001 migration; this is a
  // belt-and-suspenders insert in case the DB was set up out-of-order).
  await db
    .insert(organizations)
    .values({ id: DEFAULT_ORG_ID, name: "Default Workspace", slug: "default" })
    .onConflictDoNothing();

  console.log("[seed] wiping ATS-domain rows…");
  await wipeAtsData();

  console.log("[seed] users + memberships + reporting chain…");
  const { userIdByEmail } = await seedUsers();

  console.log("[seed] taxonomy (skills, locations, industries, roles, …)…");
  const taxonomy = await seedTaxonomy();

  console.log("[seed] clients + recruiter eligibility…");
  const clientIdByName = await seedClients(userIdByEmail);

  const seeded: SeededIds = {
    userIdByEmail,
    clientIdByName,
    ...taxonomy,
    demandIds: [],
    candidateIds: [],
  };

  const rng = rngSeeded(20260429);

  console.log("[seed] demands + skills + locations + assignments…");
  seeded.demandIds = await seedDemands(seeded, rng);

  console.log("[seed] candidates + skills + experiences + qualifications…");
  seeded.candidateIds = await seedCandidates(seeded, rng);

  console.log("[seed] prospects + submissions + stage transitions…");
  await seedProspectsAndSubmissions(seeded, rng);

  console.log("[seed] rubrics + question banks…");
  await seedRubricsAndQuestionBanks();

  console.log("[seed] recruiter calls + QA review queue (DEFAULT org)…");
  await seedCallsAndQaForDefaultOrg(userIdByEmail, seeded.candidateIds, seeded.demandIds, rng);

  console.log("[seed] QA Review console (policies + queue items + gold + calibration + disputes + audit, DEFAULT org)…");
  await seedQaReviewForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] async-video campaigns + submissions + scorecards (DEFAULT org)…");
  await seedAsyncVideoForDefaultOrg(userIdByEmail, seeded.candidateIds, seeded.demandIds, rng);

  console.log("[seed] assessment authoring (templates + items + versions + graded attempts, DEFAULT org)…");
  await seedAssessmentForDefaultOrg(userIdByEmail, seeded.candidateIds, rng);

  console.log("[seed] question bank enterprise (governance + versions + reviews + usage + audit, DEFAULT org)…");
  await seedQuestionBankEnterpriseForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] proctor cockpit (policies + sessions + identity + audit)…");
  await seedProctorForDefaultOrg(userIdByEmail, seeded.candidateIds, rng);

  console.log("[seed] triage console (flow + rules + versioned rule sets + history + audit, DEFAULT org)…");
  await seedTriageForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] recruiters management (capacity + goals + leaderboards + nudges + audit, DEFAULT org)…");
  await seedRecruitersForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] team monitor floor (presence + live calls + SLA + alerts + supervision + audit, DEFAULT org)…");
  await seedTeamMonitorForDefaultOrg(userIdByEmail, seeded.candidateIds, seeded.demandIds, rng);

  console.log("[seed] coaching enterprise demo (scenarios/runs/scores/curricula/assignments/audit)…");
  await seedCoachingForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] analytics report-engine demo (saved views + scheduled reports + export jobs)…");
  await seedAnalyticsForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] knowledge base (collections + sources + telemetry + eval + feedback + audit, DEFAULT org)…");
  await seedKnowledgeBaseForDefaultOrg(userIdByEmail, rng);

  console.log("[seed] bootstrapping JoulesToWatts org admin…");
  await bootstrapJoulestowattsAdmin();

  console.log("[seed] done.");
  console.log(`        Login as any seeded user with password: ${SEED_PASSWORD}`);
  console.log("        Examples: admin@recruitassist.local / recruiter1@recruitassist.local / am1@recruitassist.local");
  console.log(`        JoulesToWatts admin: ${JOULESTOWATTS_ADMIN_EMAIL} / ${SEED_PASSWORD}`);
}

const isDirectExec = import.meta.url === `file://${process.argv[1]}`;
if (isDirectExec) {
  runSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
