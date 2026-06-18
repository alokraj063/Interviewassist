// Pipeline domain: clients → demands → candidates → prospects → submissions
// → transitions → interviews → selections → offers → jd_match_runs.
// Stage timestamps are derived from the current stage so the dashboards
// look "lived-in" — old onboardings, mid-cycle interviews, fresh client
// submits all coexist.
import {
  STAGE_METADATA,
  type SubmissionStage,
  candidateExperiences,
  candidateQualifications,
  candidates,
  candidateSkills,
  clientRecruiters,
  clients,
  db,
  demandAssignments,
  demandLocations,
  demandSkills,
  demands,
  interviews,
  jdMatchRuns,
  offers,
  prospects,
  selections,
  submissionStageTransitions,
  submissions,
} from "@j2w/db";
import { DEMO_ORG_ID, VOLUMES } from "./constants.js";
import type { DemoContext } from "./context.js";
import {
  daysAgo,
  daysFromNow,
  dateString,
  intBetween,
  pick,
  pickN,
  type Rng,
} from "./rng.js";

interface ClientSpec {
  name: string;
  industry: string;
  tier: string;
  bhEmail: string;
}

const CLIENT_SPECS: ClientSpec[] = [
  { name: "Acme GCC India", industry: "Technology", tier: "strategic", bhEmail: "bh1@demo.recruitassist.local" },
  { name: "OmniBank Tech Center", industry: "BFSI", tier: "strategic", bhEmail: "bh2@demo.recruitassist.local" },
  { name: "Quantum Capability Hub", industry: "Fintech", tier: "growth", bhEmail: "bh2@demo.recruitassist.local" },
  { name: "NovaTech Bangalore GCC", industry: "Technology", tier: "growth", bhEmail: "bh1@demo.recruitassist.local" },
];

interface DemandSpec {
  title: string;
  jobRole: string;
  primaryLocation: string;
  vip: boolean;
  status: "active" | "on_hold" | "closed";
  minExp: number;
  maxExp: number;
  salaryFrom: number;
  salaryTo: number;
  openings: number;
  mustHaves: string[];
  niceToHaves: string[];
}

const DEMAND_SPECS: DemandSpec[] = [
  { title: "Senior Java Backend Engineer", jobRole: "Senior Backend Engineer", primaryLocation: "Bengaluru", vip: true, status: "active", minExp: 5, maxExp: 9, salaryFrom: 22, salaryTo: 38, openings: 4, mustHaves: ["Java", "Spring Boot", "Microservices"], niceToHaves: ["Kafka", "AWS"] },
  { title: "Java Backend Engineer (Fintech)", jobRole: "Java Backend Engineer", primaryLocation: "Pune", vip: false, status: "active", minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 24, openings: 6, mustHaves: ["Java", "Spring Boot"], niceToHaves: ["PostgreSQL", "REST API"] },
  { title: "Senior Python Backend Engineer", jobRole: "Senior Backend Engineer", primaryLocation: "Bengaluru", vip: true, status: "active", minExp: 6, maxExp: 10, salaryFrom: 28, salaryTo: 45, openings: 2, mustHaves: ["Python", "Django", "PostgreSQL"], niceToHaves: ["AWS", "Kubernetes"] },
  { title: "Senior Full-stack Engineer", jobRole: "Senior Full-stack Engineer", primaryLocation: "Bengaluru", vip: true, status: "active", minExp: 6, maxExp: 10, salaryFrom: 28, salaryTo: 50, openings: 2, mustHaves: ["React", "Node.js", "TypeScript", "System Design"], niceToHaves: ["Next.js", "AWS"] },
  { title: "Frontend Engineer (React)", jobRole: "Frontend Engineer (React)", primaryLocation: "Gurgaon", vip: false, status: "active", minExp: 2, maxExp: 5, salaryFrom: 10, salaryTo: 20, openings: 4, mustHaves: ["React", "TypeScript", "JavaScript"], niceToHaves: ["Next.js"] },
  { title: "Senior Data Engineer", jobRole: "Senior Data Engineer", primaryLocation: "Hyderabad", vip: false, status: "active", minExp: 5, maxExp: 9, salaryFrom: 24, salaryTo: 42, openings: 2, mustHaves: ["Python", "SQL", "Kafka", "AWS"], niceToHaves: ["GCP"] },
  { title: "Senior DevOps Engineer", jobRole: "DevOps Engineer", primaryLocation: "Bengaluru", vip: false, status: "active", minExp: 5, maxExp: 9, salaryFrom: 24, salaryTo: 42, openings: 2, mustHaves: ["AWS", "Kubernetes", "Terraform", "CI/CD"], niceToHaves: ["GCP", "Linux"] },
  { title: "Site Reliability Engineer", jobRole: "Site Reliability Engineer", primaryLocation: "Bengaluru", vip: false, status: "active", minExp: 5, maxExp: 9, salaryFrom: 26, salaryTo: 45, openings: 2, mustHaves: ["AWS", "Kubernetes", "Linux", "System Design"], niceToHaves: ["Terraform"] },
  { title: "QA Automation Engineer", jobRole: "QA Automation Engineer", primaryLocation: "Chennai", vip: false, status: "on_hold", minExp: 2, maxExp: 5, salaryFrom: 8, salaryTo: 18, openings: 5, mustHaves: ["JavaScript", "REST API"], niceToHaves: ["TypeScript", "CI/CD"] },
  { title: "Solutions Architect", jobRole: "Solutions Architect", primaryLocation: "Bengaluru", vip: true, status: "on_hold", minExp: 10, maxExp: 16, salaryFrom: 50, salaryTo: 80, openings: 1, mustHaves: ["AWS", "System Design", "Microservices"], niceToHaves: ["Kubernetes", "Kafka"] },
  { title: "Data Scientist (BFSI)", jobRole: "Data Scientist", primaryLocation: "Mumbai", vip: false, status: "closed", minExp: 3, maxExp: 6, salaryFrom: 18, salaryTo: 32, openings: 2, mustHaves: ["Python", "SQL"], niceToHaves: ["AWS"] },
  { title: "Backend Engineer (BFSI)", jobRole: "Java Backend Engineer", primaryLocation: "Mumbai", vip: false, status: "closed", minExp: 3, maxExp: 6, salaryFrom: 14, salaryTo: 22, openings: 4, mustHaves: ["Java", "Spring Boot", "PostgreSQL"], niceToHaves: ["AWS"] },
];

const CANDIDATE_FIRST = ["Aarav", "Vihaan", "Aditya", "Krishna", "Ishaan", "Diya", "Ananya", "Saanvi", "Riya", "Myra", "Tara", "Zara", "Sara", "Nisha", "Kabir", "Arjun", "Reyansh", "Priya", "Megha", "Neha"];
const CANDIDATE_LAST = ["Sharma", "Verma", "Iyer", "Reddy", "Patel", "Nair", "Gupta", "Joshi", "Mehta", "Khan", "Singh", "Kumar", "Desai", "Rao", "Pandey"];
const CANDIDATE_COMPANIES = ["Infosys", "TCS", "Wipro", "HCL", "Razorpay", "Swiggy", "Flipkart", "Microsoft India", "Amazon India", "Goldman Sachs Bengaluru", "Walmart Labs", "Zoho"];
const CANDIDATE_TITLES = ["Software Engineer", "Senior Software Engineer", "Tech Lead", "Backend Engineer", "Frontend Engineer", "Full-stack Engineer", "Data Engineer", "DevOps Engineer"];

interface ParsedResume {
  contact: { email: string; phone: string; location: string };
  summary: string;
  skills: Array<{ name: string; years: number }>;
  experiences: Array<{ company: string; title: string; from: string; to: string | null; bullets: string[] }>;
  education: Array<{ degree: string; institution: string; year: number }>;
  certifications: string[];
  parsedBy: string;
  parsedAt: string;
}

function buildResume(args: {
  email: string;
  phone: string;
  location: string;
  expYears: number;
  title: string;
  company: string;
  skillNames: string[];
}): ParsedResume {
  const { email, phone, location, expYears, title, company, skillNames } = args;
  const summary = `${expYears} years experienced ${title} with strong production exposure to ${skillNames.slice(0, 3).join(", ")}. Looking for senior IC roles in product engineering teams.`;
  const skills = skillNames.slice(0, 6).map((name, idx) => ({
    name,
    years: Math.max(1, Math.min(expYears, expYears - idx)),
  }));
  const expFrom = new Date();
  expFrom.setFullYear(expFrom.getFullYear() - expYears);
  return {
    contact: { email, phone, location },
    summary,
    skills,
    experiences: [
      {
        company,
        title,
        from: dateString(new Date(expFrom.getTime() + 86400_000 * 365)),
        to: null,
        bullets: [
          `Owned a tier-0 production service in the ${skillNames[0]} stack with 99.95% SLA.`,
          `Cut p95 latency by ~40% via index redesign and async batching.`,
          `Mentored 3-4 juniors; ran the team's on-call rotation.`,
        ],
      },
      {
        company: "Infosys",
        title: "Software Engineer",
        from: dateString(expFrom),
        to: dateString(new Date(expFrom.getTime() + 86400_000 * 365)),
        bullets: [`Worked on ${skillNames[1] ?? "REST API"} services and ${skillNames[2] ?? "PostgreSQL"} schemas.`],
      },
    ],
    education: [
      { degree: "B.Tech", institution: "VIT Vellore", year: new Date().getFullYear() - expYears - 4 },
    ],
    certifications: ["AWS Certified Developer — Associate"],
    parsedBy: "demo-resume-parser-v1",
    parsedAt: new Date().toISOString(),
  };
}

export async function seedDemoClients(ctx: DemoContext): Promise<void> {
  const rows = await db
    .insert(clients)
    .values(
      CLIENT_SPECS.map((c) => ({
        orgId: DEMO_ORG_ID,
        companyName: c.name,
        slug: c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        industry: c.industry,
        tier: c.tier,
        bhUserId: ctx.userIdByEmail.get(c.bhEmail) ?? null,
        status: "active" as const,
      })),
    )
    .returning({ id: clients.id, companyName: clients.companyName });
  for (const r of rows) ctx.clientIdByName.set(r.companyName, r.id);

  // Round-robin all 12 recruiters across the 4 clients (3 each).
  const links: Array<{ clientId: string; recruiterId: string }> = [];
  ctx.recruiterUserIds.forEach((rid, i) => {
    const c = rows[i % rows.length];
    links.push({ clientId: c.id, recruiterId: rid });
  });
  if (links.length) {
    await db.insert(clientRecruiters).values(links).onConflictDoNothing();
  }
}

export async function seedDemoDemands(ctx: DemoContext, rng: Rng): Promise<void> {
  const clientNames = Array.from(ctx.clientIdByName.keys());
  const insertedIds: string[] = [];

  for (let i = 0; i < DEMAND_SPECS.length; i += 1) {
    const spec = DEMAND_SPECS[i];
    const clientName = clientNames[i % clientNames.length];
    const clientId = ctx.clientIdByName.get(clientName)!;
    const amId = ctx.accountManagerUserIds[i % ctx.accountManagerUserIds.length];
    const jobRoleId = ctx.jobRoleIdByName.get(spec.jobRole) ?? null;
    const requestedDaysAgo = intBetween(0, 60, rng);

    const [row] = await db
      .insert(demands)
      .values({
        orgId: DEMO_ORG_ID,
        clientId,
        createdByUserId: amId,
        title: spec.title,
        designation: spec.title,
        description: `${spec.title} role at ${clientName}. Looking for ${spec.minExp}-${spec.maxExp} years of relevant experience. Salary band ₹${spec.salaryFrom}-${spec.salaryTo} LPA. Primary location: ${spec.primaryLocation}.`,
        responsibilities: "Build and maintain production systems. Collaborate cross-functionally. Mentor juniors. Own production reliability for assigned services.",
        experienceMinYears: String(spec.minExp),
        experienceMaxYears: String(spec.maxExp),
        salaryFrom: String(spec.salaryFrom),
        salaryTo: String(spec.salaryTo),
        numberOfOpenings: spec.openings,
        maxSubmissions: spec.openings * 4,
        primaryLocation: spec.primaryLocation,
        status: spec.status,
        isVip: spec.vip,
        clientInternalTicketId: `TKT-${5000 + i}`,
        requestedBy: pick(["VP Engineering", "Director of Engineering", "Engineering Manager", "Head of Platform"], rng),
        requestedDate: dateString(daysAgo(requestedDaysAgo)),
        expectedClosureDate: dateString(daysFromNow(intBetween(30, 120, rng))),
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
          projectSize: intBetween(20, 200, rng),
          projectCount: intBetween(1, 6, rng),
        },
        mandatoryChecks: ["bgv", "education_verification"],
      })
      .returning({ id: demands.id });

    insertedIds.push(row.id);
    ctx.demandIdByTitle.set(spec.title, row.id);

    // Skills.
    const links: Array<{ demandId: string; skillId: string; isMandatory: boolean; weight: string }> = [];
    for (const s of spec.mustHaves) {
      const id = ctx.skillIdByName.get(s.toLowerCase());
      if (id) links.push({ demandId: row.id, skillId: id, isMandatory: true, weight: "2.0" });
    }
    for (const s of spec.niceToHaves) {
      const id = ctx.skillIdByName.get(s.toLowerCase());
      if (id) links.push({ demandId: row.id, skillId: id, isMandatory: false, weight: "1.0" });
    }
    if (links.length) await db.insert(demandSkills).values(links).onConflictDoNothing();

    // Locations.
    const primaryLocId = ctx.locationIdByCity.get(spec.primaryLocation);
    if (primaryLocId) {
      await db.insert(demandLocations).values({ demandId: row.id, locationId: primaryLocId }).onConflictDoNothing();
    }

    // Recruiter assignments — 4 per demand, rotating.
    const assignmentValues = [] as Array<{ demandId: string; recruiterId: string; assignedByUserId: string; activeCandidatesCount: number; lastRecruiterActivityAt: Date }>;
    for (let r = 0; r < 4; r += 1) {
      const rid = ctx.recruiterUserIds[(i * 3 + r) % ctx.recruiterUserIds.length];
      assignmentValues.push({
        demandId: row.id,
        recruiterId: rid,
        assignedByUserId: amId,
        activeCandidatesCount: intBetween(0, 6, rng),
        lastRecruiterActivityAt: daysAgo(intBetween(0, 14, rng)),
      });
    }
    await db.insert(demandAssignments).values(assignmentValues).onConflictDoNothing();
  }

  ctx.demandIds = insertedIds;
}

export async function seedDemoCandidates(ctx: DemoContext, rng: Rng): Promise<void> {
  const skillNames = Array.from(ctx.skillIdByName.keys());
  const candidateIds: string[] = [];

  for (let i = 0; i < VOLUMES.candidates; i += 1) {
    const fn = pick(CANDIDATE_FIRST, rng);
    const ln = pick(CANDIDATE_LAST, rng);
    const phone = `+91${9000000000 + intBetween(0, 99999999, rng)}`;
    const phoneNorm = phone.slice(-10);
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}.demo${i + 1}@example-candidate.local`;
    const expYears = intBetween(2, 12, rng);
    const currentCtc = +(4 + rng() * 30).toFixed(1);
    const expectedCtc = +(currentCtc * (1.2 + rng() * 0.6)).toFixed(1);
    const noticeDays = pick([15, 30, 45, 60, 90], rng) as number;
    const currentLoc = pick(["Bengaluru", "Mumbai", "Pune", "Hyderabad", "Chennai", "Gurgaon"], rng);
    const currentTitle = pick(CANDIDATE_TITLES, rng);
    const currentCompany = pick(CANDIDATE_COMPANIES, rng);
    const sampleSkills = pickN(skillNames, 6, rng);

    const [row] = await db
      .insert(candidates)
      .values({
        orgId: DEMO_ORG_ID,
        email,
        emailNormalized: email,
        phone,
        phoneE164Normalized: phoneNorm,
        firstName: fn,
        lastName: ln,
        displayName: `${fn} ${ln}`,
        currentTitle,
        currentCompany,
        totalExperienceYears: String(expYears),
        currentCtcLakhs: String(currentCtc),
        expectedCtcLakhs: String(expectedCtc),
        noticePeriodDays: noticeDays,
        noticePeriodNegotiable: rng() > 0.4,
        currentLocation: currentLoc,
        preferredLocations: Array.from(new Set([currentLoc, pick(["Bengaluru", "Pune", "Hyderabad"], rng)])),
        linkedinUrl: `https://www.linkedin.com/in/${fn.toLowerCase()}-${ln.toLowerCase()}-demo${i + 1}`,
        summary: `${expYears} yrs experienced ${currentTitle.toLowerCase()} with hands-on exposure to ${sampleSkills.slice(0, 3).join(", ")}. Looking for senior IC roles in product engineering teams.`,
        source: pick(["naukri", "linkedin", "referral", "direct"], rng) as "naukri" | "linkedin" | "referral" | "direct",
        parsedResumeJson: buildResume({
          email,
          phone,
          location: currentLoc,
          expYears,
          title: currentTitle,
          company: currentCompany,
          skillNames: sampleSkills,
        }) as unknown as Record<string, unknown>,
      })
      .returning({ id: candidates.id });

    candidateIds.push(row.id);
    ctx.candidateIdByEmail.set(email, row.id);

    // Skills (3 per candidate).
    const skillRows: Array<{ candidateId: string; skillId: string; proficiencyLevel: number; yearsOfExperience: string }> = [];
    for (const sName of pickN(skillNames, 3, rng)) {
      const sid = ctx.skillIdByName.get(sName);
      if (!sid) continue;
      skillRows.push({
        candidateId: row.id,
        skillId: sid,
        proficiencyLevel: intBetween(2, 5, rng),
        yearsOfExperience: String(Math.max(1, expYears - intBetween(0, 2, rng))),
      });
    }
    if (skillRows.length) await db.insert(candidateSkills).values(skillRows).onConflictDoNothing();

    // Experiences (1-3).
    const numExp = intBetween(1, 3, rng);
    let endYear = new Date().getFullYear() - intBetween(0, 2, rng);
    const expValues = [] as Array<typeof candidateExperiences.$inferInsert>;
    for (let e = 0; e < numExp; e += 1) {
      const startYear = endYear - 1 - intBetween(0, 2, rng);
      expValues.push({
        candidateId: row.id,
        companyName: pick(CANDIDATE_COMPANIES, rng),
        title: pick(CANDIDATE_TITLES, rng),
        startDate: `${startYear}-01-01`,
        endDate: e === 0 ? null : `${endYear}-12-31`,
        isCurrent: e === 0,
        description: `Owned production systems using ${pick(skillNames, rng)} and ${pick(skillNames, rng)}.`,
      });
      endYear = startYear - 1;
    }
    await db.insert(candidateExperiences).values(expValues);

    // Qualification.
    await db.insert(candidateQualifications).values({
      candidateId: row.id,
      degree: pick(["B.Tech", "B.E.", "MCA", "M.Tech"], rng),
      institution: pick(["IIT Bombay", "IIT Delhi", "NIT Trichy", "BITS Pilani", "VIT Vellore", "PES University", "Anna University"], rng),
      fieldOfStudy: pick(["Computer Science", "Information Technology", "Electronics & Communication"], rng),
      yearOfCompletion: new Date().getFullYear() - expYears - 4,
      marksOrGrade: `${(7 + rng() * 2.5).toFixed(2)} CGPA`,
    });
  }

  ctx.candidateIds = candidateIds;
}

export async function seedDemoProspects(ctx: DemoContext, rng: Rng): Promise<void> {
  const statuses = ["new", "contacted", "interested", "qualified", "submitted", "disqualified", "parked", "not_interested"] as const;
  const inserted: string[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  while (inserted.length < VOLUMES.prospects && attempts < 1000) {
    attempts += 1;
    const demandId = pick(ctx.demandIds, rng);
    const candidateId = pick(ctx.candidateIds, rng);
    const recruiterId = pick(ctx.recruiterUserIds, rng);
    const key = `${demandId}|${candidateId}|${recruiterId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = pick([...statuses], rng);
    const [row] = await db
      .insert(prospects)
      .values({
        orgId: DEMO_ORG_ID,
        demandId,
        candidateId,
        recruiterId,
        status,
        interestLevel: intBetween(1, 5, rng),
        notes:
          status === "disqualified" || status === "not_interested"
            ? "Not aligned on compensation; deferred to senior pool."
            : status === "interested" || status === "qualified"
              ? "Open to new opportunities; available to interview next week."
              : "Initial discovery call done. Awaiting recruiter follow-up.",
        lastContactedAt: daysAgo(intBetween(0, 14, rng)),
      })
      .onConflictDoNothing()
      .returning({ id: prospects.id });
    if (row) inserted.push(row.id);
  }
  ctx.prospectIds = inserted;
}

interface SubmissionPlan {
  stage: SubmissionStage;
  count: number;
  daysAgoMin: number;
  daysAgoMax: number;
}

const SUBMISSION_PLAN: SubmissionPlan[] = [
  { stage: "internal_review", count: 4, daysAgoMin: 0, daysAgoMax: 3 },
  { stage: "client_submit", count: 4, daysAgoMin: 4, daysAgoMax: 10 },
  { stage: "l1_scheduled", count: 5, daysAgoMin: 7, daysAgoMax: 18 },
  { stage: "l1_select", count: 4, daysAgoMin: 12, daysAgoMax: 22 },
  { stage: "l2_scheduled", count: 3, daysAgoMin: 15, daysAgoMax: 25 },
  { stage: "l2_select", count: 2, daysAgoMin: 18, daysAgoMax: 30 },
  { stage: "final_select", count: 3, daysAgoMin: 25, daysAgoMax: 40 },
  { stage: "offer_pending", count: 2, daysAgoMin: 30, daysAgoMax: 45 },
  { stage: "offer_released", count: 2, daysAgoMin: 35, daysAgoMax: 55 },
  { stage: "offer_accepted", count: 2, daysAgoMin: 40, daysAgoMax: 60 },
  { stage: "onboarded", count: 2, daysAgoMin: 60, daysAgoMax: 110 },
  { stage: "offer_rejected", count: 1, daysAgoMin: 30, daysAgoMax: 50 },
  { stage: "client_screen_reject", count: 1, daysAgoMin: 8, daysAgoMax: 18 },
];

const STAGES_BUCKET_PROGRESS: SubmissionStage[] = [
  "internal_review",
  "client_submit",
  "l1_scheduled",
  "l1_select",
  "l2_scheduled",
  "l2_select",
  "final_select",
  "offer_pending",
  "offer_released",
  "offer_accepted",
  "onboarded",
];

function priorStagePath(target: SubmissionStage): SubmissionStage[] {
  const idx = STAGES_BUCKET_PROGRESS.indexOf(target);
  if (idx >= 0) return STAGES_BUCKET_PROGRESS.slice(0, idx + 1);
  // Terminal/branch stages: use the parent path until the closest progress stage.
  if (target === "client_screen_reject") return ["internal_review", "client_submit", target];
  if (target === "offer_rejected") return [...STAGES_BUCKET_PROGRESS.slice(0, STAGES_BUCKET_PROGRESS.indexOf("offer_released") + 1), target];
  if (target === "internal_reject") return ["internal_review", target];
  return [target];
}

export async function seedDemoSubmissionsAndDownstream(ctx: DemoContext, rng: Rng): Promise<void> {
  const usedPairs = new Set<string>();
  const recruiters = ctx.recruiterUserIds;
  const inserted: string[] = [];

  for (const plan of SUBMISSION_PLAN) {
    let placed = 0;
    let tries = 0;
    while (placed < plan.count && tries < 200) {
      tries += 1;
      const demandId = pick(ctx.demandIds, rng);
      const candidateId = pick(ctx.candidateIds, rng);
      const key = `${demandId}|${candidateId}`;
      if (usedPairs.has(key)) continue;
      usedPairs.add(key);
      placed += 1;

      const recruiterId = pick(recruiters, rng);
      const submittedDaysAgo = intBetween(plan.daysAgoMin, plan.daysAgoMax, rng);
      const submittedAt = daysAgo(submittedDaysAgo);
      const path = priorStagePath(plan.stage);
      const previousStage: SubmissionStage = path.length >= 2 ? path[path.length - 2] : "applied";

      const [row] = await db
        .insert(submissions)
        .values({
          orgId: DEMO_ORG_ID,
          demandId,
          candidateId,
          submittedByUserId: recruiterId,
          currentStage: plan.stage,
          previousStage,
          submittedAt,
          recruiterNote: "Strong skill overlap per JD-match. Profile matches must-have stack and notice period.",
          status:
            plan.stage === "offer_rejected" || plan.stage === "client_screen_reject"
              ? ("closed" as const)
              : ("active" as const),
        })
        .returning({ id: submissions.id });
      inserted.push(row.id);

      // Stage transitions: walk the path with monotonically increasing
      // timestamps. Spread the elapsed days across N transitions so each one
      // has its own moment in the audit trail.
      const totalElapsedDays = Math.max(1, submittedDaysAgo);
      const stepDays = totalElapsedDays / Math.max(1, path.length - 1);
      const transitionRows = [] as Array<typeof submissionStageTransitions.$inferInsert>;
      for (let s = 0; s < path.length; s += 1) {
        const fromStage = s === 0 ? null : path[s - 1];
        const toStage = path[s];
        const ago = totalElapsedDays - stepDays * s;
        transitionRows.push({
          submissionId: row.id,
          fromStage: fromStage ?? "applied",
          toStage,
          changedByUserId: recruiterId,
          reasonText: STAGE_METADATA[toStage].requiresReason ? "Reviewer notes captured in submission detail." : null,
          createdAt: daysAgo(Math.max(0, ago)),
        });
      }
      await db.insert(submissionStageTransitions).values(transitionRows);

      // Interviews — one per *_scheduled / *_select stage in the path.
      const interviewRows = [] as Array<typeof interviews.$inferInsert>;
      for (const stage of path) {
        const m = /^l(\d)_(scheduled|select)$/.exec(stage);
        if (!m) continue;
        const level = (`l${m[1]}`) as "l1" | "l2" | "l3";
        const isCurrent = stage === plan.stage;
        const inFuture = isCurrent && stage.endsWith("_scheduled");
        interviewRows.push({
          submissionId: row.id,
          level,
          scheduledAt: inFuture ? daysFromNow(intBetween(1, 10, rng)) : daysAgo(intBetween(0, totalElapsedDays, rng)),
          mode: pick(["video", "phone", "in_person"], rng),
          venue: pick(["Google Meet", "Zoom", "Onsite — Bengaluru office", "Phone"], rng),
          interviewerName: pick(["Suresh Krishnan", "Anita Mehra", "Vikram Pillai", "Anjali Bose"], rng),
          clientSpoc: pick(["Priya R.", "Aniket V.", "Ravi K.", "Meera S."], rng),
          outcome: inFuture ? "pending" : stage.endsWith("_select") ? "select" : "select",
          feedbackText: inFuture
            ? null
            : "Strong technical depth on async patterns and DB internals. Shipped a relevant production system in last 6 months. Proceed to next round.",
        });
      }
      if (interviewRows.length) await db.insert(interviews).values(interviewRows);

      // Selections + offers when the path crosses final_select.
      const reachedFinalSelect = path.includes("final_select");
      if (reachedFinalSelect) {
        const finalSelectIdx = path.indexOf("final_select");
        const finalSelectAgo = totalElapsedDays - stepDays * finalSelectIdx;
        const offeredCtc = +(intBetween(28, 60, rng)).toFixed(1);
        const currentCandidateCtc = +(offeredCtc * (0.55 + rng() * 0.25)).toFixed(1);
        const [selRow] = await db
          .insert(selections)
          .values({
            submissionId: row.id,
            selectedAt: daysAgo(Math.max(0, finalSelectAgo)),
            tentativeDojDate: dateString(daysFromNow(intBetween(20, 60, rng))),
            currentCtcLakhs: String(currentCandidateCtc),
            offeredCtcLakhs: String(offeredCtc),
            poValueLakhs: String(+(offeredCtc * 1.18).toFixed(2)),
            marginLakhs: String(+(offeredCtc * 0.18).toFixed(2)),
          })
          .returning({ id: selections.id });

        if (path.some((p) => p.startsWith("offer_") || p === "onboarded")) {
          const offerStatus =
            plan.stage === "offer_pending"
              ? "pending_approval"
              : plan.stage === "offer_released"
                ? "released"
                : plan.stage === "offer_accepted"
                  ? "accepted"
                  : plan.stage === "onboarded"
                    ? "onboarded"
                    : plan.stage === "offer_rejected"
                      ? "rejected"
                      : "draft";
          await db.insert(offers).values({
            selectionId: selRow.id,
            status: offerStatus,
            joiningDate: dateString(daysFromNow(intBetween(15, 45, rng))),
            clientOnboardDate: plan.stage === "onboarded" ? dateString(daysAgo(intBetween(20, 80, rng))) : null,
            poValueLakhs: String(+(offeredCtc * 1.18).toFixed(2)),
            marginLakhs: String(+(offeredCtc * 0.18).toFixed(2)),
            employeeType: "permanent",
            releasedAt:
              ["released", "accepted", "onboarded"].includes(offerStatus)
                ? daysAgo(intBetween(5, 25, rng))
                : null,
            acceptedAt:
              ["accepted", "onboarded"].includes(offerStatus)
                ? daysAgo(intBetween(0, 15, rng))
                : null,
          });
        }
      }
    }
  }

  ctx.submissionIds = inserted;
}

export async function seedDemoJdMatchRuns(ctx: DemoContext, rng: Rng): Promise<void> {
  // One run per demand-candidate pair where a submission or strong prospect
  // exists. For demo, just produce ~60 deterministic combinations from the
  // first N demands × M candidates.
  const rows = [] as Array<typeof jdMatchRuns.$inferInsert>;
  const targetCount = 60;
  let i = 0;
  while (rows.length < targetCount && i < ctx.demandIds.length * ctx.candidateIds.length) {
    const demandId = ctx.demandIds[i % ctx.demandIds.length];
    const candidateId = ctx.candidateIds[(i * 7) % ctx.candidateIds.length];
    const overall = +(50 + rng() * 45).toFixed(2);
    const verdict =
      overall >= 80 ? "strong_match" : overall >= 65 ? "partial_match" : overall >= 50 ? "weak_match" : "no_match";
    rows.push({
      demandId,
      candidateId,
      triggeredByUserId: pick(ctx.recruiterUserIds, rng),
      triggeredBy: pick(["manual", "submission", "post_call", "batch"], rng),
      modelVersion: "demo-jd-match-v0.1",
      overallScore: String(overall),
      mustHavesScore: String(+(40 + rng() * 55).toFixed(2)),
      niceToHavesScore: String(+(40 + rng() * 55).toFixed(2)),
      experienceFitScore: String(+(50 + rng() * 45).toFixed(2)),
      compensationFitScore: String(+(40 + rng() * 55).toFixed(2)),
      locationFitScore: String(+(50 + rng() * 50).toFixed(2)),
      noticePeriodFitScore: String(+(50 + rng() * 50).toFixed(2)),
      semanticScore: String(+(50 + rng() * 45).toFixed(2)),
      explanation: [
        { factor: "skill_overlap", weight: 0.35, score: overall, note: "5 of 6 must-have skills present in resume" },
        { factor: "experience_fit", weight: 0.25, score: 75, note: "Within demand experience band" },
        { factor: "location_fit", weight: 0.15, score: 90, note: "Candidate prefers primary location" },
        { factor: "notice_period", weight: 0.1, score: 70, note: "60d notice; demand acceptable up to 60d" },
      ],
      gaps: overall < 80 ? [{ category: "skill", item: "Kafka", severity: "medium", note: "Light hands-on; 1y exposure only" }] : [],
      strengths: [
        { category: "skill", item: "Java + Spring Boot", note: "Strong production exposure across last 4 years" },
        { category: "behaviour", item: "Notice period flexible", note: "Buyout option mentioned" },
      ],
      verdict,
      createdAt: daysAgo(intBetween(0, 30, rng)),
    });
    i += 1;
  }
  if (rows.length) await db.insert(jdMatchRuns).values(rows);
}
