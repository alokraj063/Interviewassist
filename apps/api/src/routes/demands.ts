// Demands API — recruiter ATS demand (open role) CRUD + assignment.
//
// All endpoints are tenant-scoped via req.authUser.orgId. Permission
// gating uses the `demands.*` permissions seeded in 0010_recruitassist_foundation.
//   - demands.read    : recruiters / DLs / AMs / BHs / admin
//   - demands.write   : AMs / BHs / admin
//   - demands.assign  : AMs / BHs / admin
//
// Recruiters who only have demands.read can still see demands they're
// assigned to (the GET /api/demands handler scopes by demand_assignments
// when assignedToMe=true).

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseDocument } from "@j2w/ingest-shared";
import { env } from "../env.js";
import { generateJdQuestionBank } from "./assist.js";
import {
  candidates,
  clients,
  db,
  demandAssignments,
  demandLocations,
  demandSkills,
  demands,
  industries,
  jobRoles,
  locations,
  prospects,
  skills,
  submissions,
  users,
} from "@j2w/db";

const listQuerySchema = z.object({
  status: z.enum(["draft", "active", "on_hold", "closed", "cancelled"]).optional(),
  clientId: z.string().uuid().optional(),
  isVip: z.enum(["true", "false"]).optional(),
  assignedToMe: z.enum(["true", "false"]).optional(),
  // When assignedToMe=true and activeOnly=true, restrict the list to
  // assignments where the recruiter has live applied_jobs activity (count
  // > 0). Default off — the recruiter's full assignment pool is visible
  // and sorted with active candidates at the top.
  activeOnly: z.enum(["true", "false"]).optional(),
  q: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const createSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  designation: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  responsibilities: z.string().max(20_000).optional(),
  experienceMinYears: z.number().min(0).max(50).optional(),
  experienceMaxYears: z.number().min(0).max(50).optional(),
  salaryFrom: z.number().min(0).optional(),
  salaryTo: z.number().min(0).optional(),
  numberOfOpenings: z.number().int().min(1).max(500).default(1),
  maxSubmissions: z.number().int().min(1).max(2000).optional(),
  primaryLocation: z.string().max(120).optional(),
  // Free-text emphasis for question/interview generation (e.g. "give extra
  // weight to VMS and IDOC integration").
  assessmentNotes: z.string().max(4000).optional(),
  status: z.enum(["draft", "active", "on_hold", "closed", "cancelled"]).default("draft"),
  isVip: z.boolean().default(false),
  clientInternalTicketId: z.string().max(80).optional(),
  expectedClosureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  industryId: z.string().uuid().optional(),
  jobRoleId: z.string().uuid().optional(),
  probingDetails: z.record(z.unknown()).optional(),
  mandatoryChecks: z.array(z.string()).default([]),
  skillIds: z.array(z.string().uuid()).default([]),
  mustHaveSkillIds: z.array(z.string().uuid()).default([]),
  locationIds: z.array(z.string().uuid()).default([]),
});

const patchSchema = createSchema.partial().omit({ clientId: true });

const assignSchema = z.object({
  recruiterIds: z.array(z.string().uuid()).min(1),
});

export async function demandsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---------- LIST ----------
  app.get("/", { preHandler: [app.requirePermission("demands.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });

    const { status, clientId, isVip, assignedToMe, activeOnly, q, limit } = parsed.data;
    const scopedToMe = assignedToMe === "true";

    const wheres = [eq(demands.orgId, ctx.orgId)];
    if (status) wheres.push(eq(demands.status, status));
    if (clientId) wheres.push(eq(demands.clientId, clientId));
    if (isVip === "true") wheres.push(eq(demands.isVip, true));
    if (isVip === "false") wheres.push(eq(demands.isVip, false));
    if (q) {
      wheres.push(
        or(
          ilike(demands.title, `%${q}%`),
          ilike(demands.designation, `%${q}%`),
        )!,
      );
    }
    if (scopedToMe) {
      const myActiveAssignment = and(
        eq(demandAssignments.demandId, demands.id),
        eq(demandAssignments.recruiterId, ctx.id),
        eq(demandAssignments.status, "active"),
      );
      const myActiveAndWorking = and(
        myActiveAssignment,
        sql`${demandAssignments.activeCandidatesCount} > 0`,
      );
      wheres.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(demandAssignments)
            .where(activeOnly === "true" ? myActiveAndWorking : myActiveAssignment),
        ),
      );
    }

    // When scoped to "my demands", surface live pipeline first
    // (active_candidates_count DESC), then most recently touched, then VIP,
    // then most recently updated. Otherwise (admin / cross-recruiter view)
    // keep the prior VIP-then-updated ordering.
    const baseSelect = db
      .select({
        id: demands.id,
        title: demands.title,
        designation: demands.designation,
        status: demands.status,
        isVip: demands.isVip,
        primaryLocation: demands.primaryLocation,
        salaryFrom: demands.salaryFrom,
        salaryTo: demands.salaryTo,
        experienceMinYears: demands.experienceMinYears,
        experienceMaxYears: demands.experienceMaxYears,
        numberOfOpenings: demands.numberOfOpenings,
        maxSubmissions: demands.maxSubmissions,
        expectedClosureDate: demands.expectedClosureDate,
        clientId: demands.clientId,
        clientName: clients.companyName,
        createdAt: demands.createdAt,
        updatedAt: demands.updatedAt,
        activeCandidatesCount: scopedToMe
          ? demandAssignments.activeCandidatesCount
          : sql<number | null>`null::integer`,
        lastRecruiterActivityAt: scopedToMe
          ? demandAssignments.lastRecruiterActivityAt
          : sql<Date | null>`null::timestamptz`,
      })
      .from(demands)
      .leftJoin(clients, eq(clients.id, demands.clientId));

    const withAssignmentJoin = scopedToMe
      ? baseSelect.leftJoin(
          demandAssignments,
          and(
            eq(demandAssignments.demandId, demands.id),
            eq(demandAssignments.recruiterId, ctx.id),
            eq(demandAssignments.status, "active"),
          ),
        )
      : baseSelect;

    const ordering = scopedToMe
      ? [
          sql`${demandAssignments.activeCandidatesCount} DESC NULLS LAST`,
          sql`${demandAssignments.lastRecruiterActivityAt} DESC NULLS LAST`,
          desc(demands.isVip),
          desc(demands.updatedAt),
        ]
      : [desc(demands.isVip), desc(demands.updatedAt)];

    const rows = await withAssignmentJoin
      .where(and(...wheres))
      .orderBy(...ordering)
      .limit(limit);

    return { demands: rows };
  });

  // ---------- DETAIL ----------
  app.get("/:id", { preHandler: [app.requirePermission("demands.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [row] = await db
      .select({
        demand: demands,
        clientName: clients.companyName,
        industryName: industries.name,
        jobRoleName: jobRoles.name,
      })
      .from(demands)
      .leftJoin(clients, eq(clients.id, demands.clientId))
      .leftJoin(industries, eq(industries.id, demands.industryId))
      .leftJoin(jobRoles, eq(jobRoles.id, demands.jobRoleId))
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!row) return reply.code(404).send({ error: "demand_not_found" });

    const skillRows = await db
      .select({
        skillId: skills.id,
        name: skills.name,
        isMandatory: demandSkills.isMandatory,
        weight: demandSkills.weight,
      })
      .from(demandSkills)
      .innerJoin(skills, eq(skills.id, demandSkills.skillId))
      .where(eq(demandSkills.demandId, id))
      .orderBy(desc(demandSkills.isMandatory), asc(skills.name));

    const locationRows = await db
      .select({ locationId: locations.id, city: locations.city, state: locations.state })
      .from(demandLocations)
      .innerJoin(locations, eq(locations.id, demandLocations.locationId))
      .where(eq(demandLocations.demandId, id))
      .orderBy(asc(locations.city));

    const assignmentRows = await db
      .select({
        recruiterId: demandAssignments.recruiterId,
        assignedAt: demandAssignments.assignedAt,
        status: demandAssignments.status,
        recruiterName: users.name,
        recruiterEmail: users.email,
      })
      .from(demandAssignments)
      .innerJoin(users, eq(users.id, demandAssignments.recruiterId))
      .where(and(eq(demandAssignments.demandId, id), eq(demandAssignments.status, "active")))
      .orderBy(asc(users.name));

    return {
      demand: row.demand,
      clientName: row.clientName,
      industryName: row.industryName,
      jobRoleName: row.jobRoleName,
      skills: skillRows,
      locations: locationRows,
      assignments: assignmentRows,
    };
  });

  // ---------- CREATE ----------
  app.post("/", { preHandler: [app.requirePermission("demands.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    // Client must belong to caller's org.
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, parsed.data.clientId), eq(clients.orgId, ctx.orgId)));
    if (!client) return reply.code(400).send({ error: "client_not_in_org" });

    const [row] = await db
      .insert(demands)
      .values({
        orgId: ctx.orgId,
        clientId: parsed.data.clientId,
        createdByUserId: ctx.id,
        title: parsed.data.title,
        designation: parsed.data.designation ?? null,
        description: parsed.data.description ?? null,
        responsibilities: parsed.data.responsibilities ?? null,
        experienceMinYears: parsed.data.experienceMinYears != null ? String(parsed.data.experienceMinYears) : null,
        experienceMaxYears: parsed.data.experienceMaxYears != null ? String(parsed.data.experienceMaxYears) : null,
        salaryFrom: parsed.data.salaryFrom != null ? String(parsed.data.salaryFrom) : null,
        salaryTo: parsed.data.salaryTo != null ? String(parsed.data.salaryTo) : null,
        numberOfOpenings: parsed.data.numberOfOpenings,
        maxSubmissions: parsed.data.maxSubmissions ?? null,
        primaryLocation: parsed.data.primaryLocation ?? null,
        status: parsed.data.status,
        isVip: parsed.data.isVip,
        clientInternalTicketId: parsed.data.clientInternalTicketId ?? null,
        expectedClosureDate: parsed.data.expectedClosureDate ?? null,
        industryId: parsed.data.industryId ?? null,
        jobRoleId: parsed.data.jobRoleId ?? null,
        probingDetails: parsed.data.probingDetails ?? null,
        mandatoryChecks: parsed.data.mandatoryChecks,
        assessmentNotes: parsed.data.assessmentNotes ?? null,
      })
      .returning({ id: demands.id });

    // Skills (must-haves first, then nice-to-haves).
    if (parsed.data.mustHaveSkillIds.length > 0) {
      await db.insert(demandSkills).values(
        parsed.data.mustHaveSkillIds.map((skillId) => ({
          demandId: row.id,
          skillId,
          isMandatory: true,
          weight: "2.0",
        })),
      );
    }
    const niceOnly = parsed.data.skillIds.filter((s) => !parsed.data.mustHaveSkillIds.includes(s));
    if (niceOnly.length > 0) {
      await db.insert(demandSkills).values(
        niceOnly.map((skillId) => ({ demandId: row.id, skillId, isMandatory: false, weight: "1.0" })),
      );
    }
    if (parsed.data.locationIds.length > 0) {
      await db.insert(demandLocations).values(
        parsed.data.locationIds.map((locationId) => ({ demandId: row.id, locationId })),
      );
    }

    return { demandId: row.id };
  });

  // ---------- JD FILE UPLOAD → TEXT ----------
  // Extract plain text from an uploaded JD (PDF/DOCX/TXT) so the Add-job form
  // can drop it into the description (which drives the interview questions).
  app.post("/parse-jd", { preHandler: [app.requirePermission("demands.write")] }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "expected_multipart" });
    const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!part) return reply.code(400).send({ error: "no_file" });
    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch {
      return reply.code(413).send({ error: "file_too_large" });
    }
    try {
      const { text } = await parseDocument(buf, part.mimetype, part.filename);
      if (text.trim().length < 20) {
        return reply.code(422).send({ error: "unparseable_jd", hint: "Couldn't extract text from this file." });
      }
      return { ok: true, text: text.trim().slice(0, 20_000), filename: part.filename ?? "jd" };
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "parse_jd_failed");
      return reply.code(502).send({ error: "parse_failed" });
    }
  });

  // ---------- PATCH ----------
  app.patch("/:id", { preHandler: [app.requirePermission("demands.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const d = parsed.data;
    if (d.title !== undefined) updates.title = d.title;
    if (d.designation !== undefined) updates.designation = d.designation;
    if (d.description !== undefined) updates.description = d.description;
    if (d.responsibilities !== undefined) updates.responsibilities = d.responsibilities;
    if (d.experienceMinYears !== undefined) updates.experienceMinYears = String(d.experienceMinYears);
    if (d.experienceMaxYears !== undefined) updates.experienceMaxYears = String(d.experienceMaxYears);
    if (d.salaryFrom !== undefined) updates.salaryFrom = String(d.salaryFrom);
    if (d.salaryTo !== undefined) updates.salaryTo = String(d.salaryTo);
    if (d.numberOfOpenings !== undefined) updates.numberOfOpenings = d.numberOfOpenings;
    if (d.maxSubmissions !== undefined) updates.maxSubmissions = d.maxSubmissions;
    if (d.primaryLocation !== undefined) updates.primaryLocation = d.primaryLocation;
    if (d.status !== undefined) updates.status = d.status;
    if (d.isVip !== undefined) updates.isVip = d.isVip;
    if (d.clientInternalTicketId !== undefined) updates.clientInternalTicketId = d.clientInternalTicketId;
    if (d.expectedClosureDate !== undefined) updates.expectedClosureDate = d.expectedClosureDate;
    if (d.industryId !== undefined) updates.industryId = d.industryId;
    if (d.jobRoleId !== undefined) updates.jobRoleId = d.jobRoleId;
    if (d.probingDetails !== undefined) updates.probingDetails = d.probingDetails;
    if (d.mandatoryChecks !== undefined) updates.mandatoryChecks = d.mandatoryChecks;
    if (d.assessmentNotes !== undefined) updates.assessmentNotes = d.assessmentNotes;

    const result = await db
      .update(demands)
      .set(updates)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)))
      .returning({ id: demands.id });
    if (result.length === 0) return reply.code(404).send({ error: "demand_not_found" });

    return { ok: true };
  });

  // ---------- JD QUESTION BANK (cached per demand, skill-wise) ----------
  // Build the JD text the generator reads from a demand row + its client.
  async function buildJdText(d: {
    title: string | null;
    designation: string | null;
    description: string | null;
    responsibilities: string | null;
    experienceMinYears: string | null;
    experienceMaxYears: string | null;
    primaryLocation: string | null;
    clientId: string | null;
  }): Promise<string> {
    let client: string | null = null;
    if (d.clientId) {
      const [c] = await db.select({ name: clients.companyName }).from(clients).where(eq(clients.id, d.clientId));
      client = c?.name ?? null;
    }
    const exp = [d.experienceMinYears, d.experienceMaxYears].filter(Boolean).join("–");
    return [
      `ROLE: ${d.title ?? "(untitled)"}${d.designation ? ` (${d.designation})` : ""}`,
      client ? `CLIENT: ${client}` : "",
      exp ? `EXPERIENCE REQUIRED: ${exp} years` : "",
      d.primaryLocation ? `LOCATION: ${d.primaryLocation}` : "",
      d.description ? `\nJOB DESCRIPTION:\n${d.description}` : "",
      d.responsibilities ? `\nRESPONSIBILITIES:\n${d.responsibilities}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  // Return the cached bank (or null) for a demand.
  app.get("/:id/question-bank", { preHandler: [app.requirePermission("demands.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [row] = await db
      .select({ bank: demands.questionBank, generatedAt: demands.questionBankGeneratedAt, notes: demands.assessmentNotes })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!row) return reply.code(404).send({ error: "demand_not_found" });
    return { ok: true, bank: row.bank ?? null, generatedAt: row.generatedAt ?? null, assessmentNotes: row.notes ?? "" };
  });

  // Generate (and cache) the bank for a demand. Reuses the cached bank unless
  // `force` is set — so the same JD is never regenerated again and again.
  app.post("/:id/question-bank", { preHandler: [app.requirePermission("demands.write")] }, async (req, reply) => {
    if (!env.OPENAI_API_KEY) return reply.code(503).send({ ok: false, error: "openai_not_configured" });
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const force = (req.body as { force?: boolean } | undefined)?.force === true;

    const [row] = await db
      .select({
        title: demands.title,
        designation: demands.designation,
        description: demands.description,
        responsibilities: demands.responsibilities,
        experienceMinYears: demands.experienceMinYears,
        experienceMaxYears: demands.experienceMaxYears,
        primaryLocation: demands.primaryLocation,
        clientId: demands.clientId,
        assessmentNotes: demands.assessmentNotes,
        bank: demands.questionBank,
        generatedAt: demands.questionBankGeneratedAt,
      })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!row) return reply.code(404).send({ ok: false, error: "demand_not_found" });

    // Reuse the cached bank unless the caller explicitly forces a regenerate.
    if (row.bank && !force) {
      return { ok: true, cached: true, bank: row.bank, generatedAt: row.generatedAt, assessmentNotes: row.assessmentNotes ?? "" };
    }

    const jd = await buildJdText(row);
    if (!jd) return reply.code(400).send({ ok: false, error: "demand_has_no_jd" });

    const bank = await generateJdQuestionBank(jd, row.assessmentNotes ?? "", {
      orgId: ctx.orgId,
      operation: "plan",
    });
    const generatedAt = new Date();
    await db
      .update(demands)
      .set({ questionBank: bank as unknown as Record<string, unknown>, questionBankGeneratedAt: generatedAt, updatedAt: generatedAt })
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));

    return { ok: true, cached: false, bank, generatedAt: generatedAt.toISOString(), assessmentNotes: row.assessmentNotes ?? "" };
  });

  // ---------- ASSIGN RECRUITERS ----------
  app.post("/:id/assignments", { preHandler: [app.requirePermission("demands.assign")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    // Demand must belong to caller's org.
    const [d] = await db
      .select({ id: demands.id })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!d) return reply.code(404).send({ error: "demand_not_found" });

    const now = new Date();
    const values = parsed.data.recruiterIds.map((recruiterId) => ({
      demandId: id,
      recruiterId,
      assignedAt: now,
      assignedByUserId: ctx.id,
      status: "active" as const,
    }));
    await db.insert(demandAssignments).values(values).onConflictDoNothing();

    return { ok: true, assigned: parsed.data.recruiterIds.length };
  });

  // ---------- RELEASE A RECRUITER ----------
  app.delete(
    "/:id/assignments/:recruiterId",
    { preHandler: [app.requirePermission("demands.assign")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id, recruiterId } = req.params as { id: string; recruiterId: string };

      const [d] = await db
        .select({ id: demands.id })
        .from(demands)
        .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
      if (!d) return reply.code(404).send({ error: "demand_not_found" });

      await db
        .update(demandAssignments)
        .set({ status: "released", releasedAt: new Date() })
        .where(
          and(
            eq(demandAssignments.demandId, id),
            eq(demandAssignments.recruiterId, recruiterId),
            eq(demandAssignments.status, "active"),
          ),
        );
      return { ok: true };
    },
  );

  // ---------- PROSPECTS ON THIS DEMAND ----------
  app.get("/:id/prospects", { preHandler: [app.requirePermission("prospects.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [d] = await db
      .select({ id: demands.id })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!d) return reply.code(404).send({ error: "demand_not_found" });

    // Recruiters see only their own prospects on this demand. Anything DL+
    // sees the full set.
    const widerView = ctx.permissions.includes("demands.assign") ||
      ctx.role === "delivery_lead" ||
      ctx.role === "qa_reviewer";

    const filters = [eq(prospects.demandId, id)];
    if (!widerView) filters.push(eq(prospects.recruiterId, ctx.id));

    const rows = await db
      .select({
        id: prospects.id,
        status: prospects.status,
        interestLevel: prospects.interestLevel,
        notes: prospects.notes,
        lastContactedAt: prospects.lastContactedAt,
        createdAt: prospects.createdAt,
        candidateId: candidates.id,
        candidateName: candidates.displayName,
        candidateEmail: candidates.email,
        candidatePhone: candidates.phone,
        currentTitle: candidates.currentTitle,
        currentCompany: candidates.currentCompany,
        recruiterId: prospects.recruiterId,
        recruiterName: users.name,
        recruiterEmail: users.email,
      })
      .from(prospects)
      .innerJoin(candidates, eq(candidates.id, prospects.candidateId))
      .leftJoin(users, eq(users.id, prospects.recruiterId))
      .where(and(...filters))
      .orderBy(asc(prospects.status), desc(prospects.lastContactedAt));

    return { prospects: rows };
  });

  // ---------- SUBMISSIONS ON THIS DEMAND ----------
  app.get("/:id/submissions", { preHandler: [app.requirePermission("submissions.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [d] = await db
      .select({ id: demands.id })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)));
    if (!d) return reply.code(404).send({ error: "demand_not_found" });

    const rows = await db
      .select({
        id: submissions.id,
        currentStage: submissions.currentStage,
        previousStage: submissions.previousStage,
        submittedAt: submissions.submittedAt,
        status: submissions.status,
        candidateId: candidates.id,
        candidateName: candidates.displayName,
        currentTitle: candidates.currentTitle,
        currentCompany: candidates.currentCompany,
        recruiterId: submissions.submittedByUserId,
        recruiterName: users.name,
      })
      .from(submissions)
      .innerJoin(candidates, eq(candidates.id, submissions.candidateId))
      .leftJoin(users, eq(users.id, submissions.submittedByUserId))
      .where(eq(submissions.demandId, id))
      .orderBy(desc(submissions.submittedAt));

    return { submissions: rows };
  });

  // ---------- INSIGHTS ----------
  // Real rollup: time-to-submit, conversion ratios per stage, recruiter
  // leaderboard for the demand, source mix.
  app.get("/:id/insights", { preHandler: [app.requirePermission("demands.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const [d] = await db
      .select({ id: demands.id })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)))
      .limit(1);
    if (!d) return reply.code(404).send({ error: "demand_not_found" });

    // Stage funnel
    const stageRows = await db
      .select({
        stage: submissions.currentStage,
        n: sql<number>`count(*)::int`,
      })
      .from(submissions)
      .where(eq(submissions.demandId, id))
      .groupBy(submissions.currentStage);

    // Recruiter leaderboard
    const leaderboard = await db
      .select({
        recruiterUserId: submissions.submittedByUserId,
        recruiterName: users.name,
        recruiterEmail: users.email,
        total: sql<number>`count(*)::int`,
        active: sql<number>`sum(case when ${submissions.status} = 'active' then 1 else 0 end)::int`,
      })
      .from(submissions)
      .leftJoin(users, eq(users.id, submissions.submittedByUserId))
      .where(eq(submissions.demandId, id))
      .groupBy(submissions.submittedByUserId, users.name, users.email);

    // Source mix from candidates
    const candidateIds = await db
      .select({ candidateId: submissions.candidateId })
      .from(submissions)
      .where(eq(submissions.demandId, id));
    const distinctIds = Array.from(new Set(candidateIds.map((r) => r.candidateId)));

    let sourceMix: Array<{ source: string; n: number }> = [];
    if (distinctIds.length > 0) {
      sourceMix = (
        await db
          .select({
            source: candidates.source,
            n: sql<number>`count(*)::int`,
          })
          .from(candidates)
          .where(inArray(candidates.id, distinctIds))
          .groupBy(candidates.source)
      ).map((r) => ({ source: r.source ?? "unknown", n: r.n }));
    }

    // Avg time-to-first-submit: from prospect created → submission submittedAt
    const timeToSubmit = await db.execute<{ avg_hours: number | null }>(sql`
      SELECT EXTRACT(EPOCH FROM AVG(s.submitted_at - p.created_at)) / 3600.0 AS avg_hours
      FROM submissions s
      JOIN prospects p ON p.id = s.metadata->>'fromProspectId'
      WHERE s.demand_id = ${id}::uuid
        AND p.created_at IS NOT NULL
    `);
    const avgHoursRows = (timeToSubmit.rows ?? []) as Array<{ avg_hours: number | null }>;
    const avgHours = avgHoursRows[0]?.avg_hours ?? null;

    return {
      stageFunnel: stageRows,
      recruiterLeaderboard: leaderboard.sort((a, b) => b.total - a.total),
      sourceMix,
      avgTimeToSubmitHours: avgHours,
    };
  });
}
