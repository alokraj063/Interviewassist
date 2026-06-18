// Client portal — surfaces a buyer's hiring manager view of their open
// demands and the submissions against them. Gated by the client_user
// role + a membership.client_id linkage. The recruiter UI under
// /demands/* is the authoritative read path; this route is the curated,
// scope-filtered version a non-employee can see.
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  clients,
  db,
  demands,
  memberships,
  submissions,
  submissionClientFeedback,
  users,
  SUBMISSION_CLIENT_FEEDBACK_DECISIONS,
} from "@j2w/db";

async function resolveClientId(
  app: FastifyInstance,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [m] = await db
    .select({ clientId: memberships.clientId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  void app;
  if (!m) return null;
  if (m.role !== "client_user") return null;
  return m.clientId ?? null;
}

const feedbackSchema = z.object({
  decision: z.enum(SUBMISSION_CLIENT_FEEDBACK_DECISIONS),
  note: z.string().max(2000).optional(),
  proposedInterviewSlots: z
    .array(
      z.object({
        slotIso: z.string().datetime(),
        durationMins: z.number().int().min(15).max(240),
        note: z.string().max(200).optional(),
      }),
    )
    .max(5)
    .optional(),
});

export async function clientPortalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Hard-gate the entire portal on the client_user role.
  app.addHook("preHandler", async (req, reply) => {
    const ctx = req.authUser;
    if (!ctx) return reply.code(401).send({ error: "unauthenticated" });
    const cId = await resolveClientId(app, ctx.id, ctx.orgId);
    if (!cId) {
      return reply
        .code(403)
        .send({ error: "client_user_required", hint: "Membership must be role=client_user with a clientId" });
    }
    // Stash on the request for downstream handlers.
    (req as unknown as { _clientId: string })._clientId = cId;
  });

  // ---------- HEADER ----------
  app.get("/me", async (req) => {
    const ctx = req.authUser!;
    const cId = (req as unknown as { _clientId: string })._clientId;
    const [client] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, cId))
      .limit(1);
    return {
      client,
      user: { id: ctx.id, email: ctx.email, name: ctx.name },
    };
  });

  // ---------- DEMANDS ----------
  app.get("/demands", async (req) => {
    const cId = (req as unknown as { _clientId: string })._clientId;
    const ctx = req.authUser!;
    const rows = await db
      .select({
        id: demands.id,
        title: demands.title,
        designation: demands.designation,
        primaryLocation: demands.primaryLocation,
        numberOfOpenings: demands.numberOfOpenings,
        status: demands.status,
        createdAt: demands.createdAt,
      })
      .from(demands)
      .where(and(eq(demands.orgId, ctx.orgId), eq(demands.clientId, cId)))
      .orderBy(desc(demands.createdAt));

    if (rows.length === 0) return { demands: [] };

    const subRows = await db
      .select({
        demandId: submissions.demandId,
        currentStage: submissions.currentStage,
        status: submissions.status,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.orgId, ctx.orgId),
          inArray(
            submissions.demandId,
            rows.map((r) => r.id),
          ),
        ),
      );

    const counts = new Map<
      string,
      {
        submitted: number;
        awaitingFeedback: number;
        inInterview: number;
        offered: number;
      }
    >();
    for (const r of rows) {
      counts.set(r.id, { submitted: 0, awaitingFeedback: 0, inInterview: 0, offered: 0 });
    }
    for (const s of subRows) {
      const c = counts.get(s.demandId);
      if (!c) continue;
      c.submitted += 1;
      if (s.currentStage === "client_submit") c.awaitingFeedback += 1;
      if (
        s.currentStage === "l1_scheduled" ||
        s.currentStage === "l2_scheduled" ||
        s.currentStage === "l3_scheduled"
      ) {
        c.inInterview += 1;
      }
      if (
        s.currentStage === "offer_pending" ||
        s.currentStage === "offer_released" ||
        s.currentStage === "offer_accepted"
      ) {
        c.offered += 1;
      }
    }

    return {
      demands: rows.map((r) => ({
        ...r,
        ...(counts.get(r.id) ?? {
          submitted: 0,
          awaitingFeedback: 0,
          inInterview: 0,
          offered: 0,
        }),
      })),
    };
  });

  // ---------- SUBMISSIONS PER DEMAND ----------
  app.get("/demands/:id/submissions", async (req, reply) => {
    const cId = (req as unknown as { _clientId: string })._clientId;
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [demand] = await db
      .select({ id: demands.id, clientId: demands.clientId, title: demands.title })
      .from(demands)
      .where(and(eq(demands.id, id), eq(demands.orgId, ctx.orgId)))
      .limit(1);
    if (!demand) return reply.code(404).send({ error: "demand_not_found" });
    if (demand.clientId !== cId) return reply.code(403).send({ error: "not_your_demand" });

    const rows = await db
      .select({
        id: submissions.id,
        currentStage: submissions.currentStage,
        submittedAt: submissions.submittedAt,
        recruiterNote: submissions.recruiterNote,
        candidateId: candidates.id,
        candidateName: candidates.displayName,
        candidateFirstName: candidates.firstName,
        candidateLastName: candidates.lastName,
        currentCompany: candidates.currentCompany,
        totalExperienceYears: candidates.totalExperienceYears,
        expectedCtcLakhs: candidates.expectedCtcLakhs,
        noticePeriodDays: candidates.noticePeriodDays,
      })
      .from(submissions)
      .leftJoin(candidates, eq(candidates.id, submissions.candidateId))
      .where(
        and(
          eq(submissions.demandId, id),
          eq(submissions.orgId, ctx.orgId),
          eq(submissions.status, "active"),
        ),
      )
      .orderBy(desc(submissions.submittedAt));

    if (rows.length === 0) return { demand, submissions: [] };

    // Latest feedback per submission for this client.
    const fb = await db
      .select({
        submissionId: submissionClientFeedback.submissionId,
        decision: submissionClientFeedback.decision,
        note: submissionClientFeedback.note,
        createdAt: submissionClientFeedback.createdAt,
      })
      .from(submissionClientFeedback)
      .where(
        inArray(
          submissionClientFeedback.submissionId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(desc(submissionClientFeedback.createdAt));

    const lastFb = new Map<string, (typeof fb)[number]>();
    for (const f of fb) if (!lastFb.has(f.submissionId)) lastFb.set(f.submissionId, f);

    return {
      demand,
      submissions: rows.map((r) => ({
        ...r,
        latestFeedback: lastFb.get(r.id) ?? null,
      })),
    };
  });

  // ---------- FEEDBACK ----------
  app.post("/submissions/:id/feedback", async (req, reply) => {
    const cId = (req as unknown as { _clientId: string })._clientId;
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }

    // Confirm the submission belongs to one of this client's demands.
    const [s] = await db
      .select({
        id: submissions.id,
        demandId: submissions.demandId,
        demandClientId: demands.clientId,
      })
      .from(submissions)
      .leftJoin(demands, eq(demands.id, submissions.demandId))
      .where(and(eq(submissions.id, id), eq(submissions.orgId, ctx.orgId)))
      .limit(1);
    if (!s) return reply.code(404).send({ error: "submission_not_found" });
    if (s.demandClientId !== cId) return reply.code(403).send({ error: "not_your_submission" });

    const [row] = await db
      .insert(submissionClientFeedback)
      .values({
        submissionId: id,
        clientUserId: ctx.id,
        decision: parsed.data.decision,
        note: parsed.data.note ?? null,
        proposedInterviewSlots: parsed.data.proposedInterviewSlots ?? null,
      })
      .returning();
    return reply.code(201).send({ feedback: row });
  });

  // ---------- HISTORY ----------
  app.get("/submissions/:id/feedback", async (req, reply) => {
    const cId = (req as unknown as { _clientId: string })._clientId;
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [s] = await db
      .select({ demandClientId: demands.clientId })
      .from(submissions)
      .leftJoin(demands, eq(demands.id, submissions.demandId))
      .where(and(eq(submissions.id, id), eq(submissions.orgId, ctx.orgId)))
      .limit(1);
    if (!s) return reply.code(404).send({ error: "submission_not_found" });
    if (s.demandClientId !== cId) return reply.code(403).send({ error: "not_your_submission" });

    const rows = await db
      .select({
        id: submissionClientFeedback.id,
        decision: submissionClientFeedback.decision,
        note: submissionClientFeedback.note,
        proposedInterviewSlots: submissionClientFeedback.proposedInterviewSlots,
        createdAt: submissionClientFeedback.createdAt,
        clientUserId: submissionClientFeedback.clientUserId,
        clientUserName: users.name,
        clientUserEmail: users.email,
      })
      .from(submissionClientFeedback)
      .leftJoin(users, eq(users.id, submissionClientFeedback.clientUserId))
      .where(eq(submissionClientFeedback.submissionId, id))
      .orderBy(desc(submissionClientFeedback.createdAt));
    return { feedback: rows };
  });
}
