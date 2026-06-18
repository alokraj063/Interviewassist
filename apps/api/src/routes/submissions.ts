// Submissions API.
//
// Most submissions land via prospects/:id/promote-to-submission. This route
// gives QA/leads the ability to inspect, list, and transition submissions
// through the J2W-style stage funnel. Stage transitions validate against
// the TS-side STAGE_METADATA map (apps/api/src/routes/prospects.ts) — the
// CHECK constraint on the column only enforces "value is in the universe."

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  db,
  demands,
  STAGE_METADATA,
  SUBMISSION_STAGES,
  submissionStageTransitions,
  submissions,
  users,
} from "@j2w/db";
import { validateStageTransition } from "./prospects.js";

const listQuerySchema = z.object({
  demandId: z.string().uuid().optional(),
  candidateId: z.string().uuid().optional(),
  recruiterId: z.string().uuid().optional(),
  stage: z.enum(SUBMISSION_STAGES).optional(),
  status: z.enum(["active", "withdrawn", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const transitionSchema = z.object({
  toStage: z.enum(SUBMISSION_STAGES),
  reason: z.string().max(2000).optional(),
});

export async function submissionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---------- LIST ----------
  app.get("/", { preHandler: [app.requirePermission("submissions.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });

    const wheres = [eq(submissions.orgId, ctx.orgId)];
    if (parsed.data.demandId) wheres.push(eq(submissions.demandId, parsed.data.demandId));
    if (parsed.data.candidateId) wheres.push(eq(submissions.candidateId, parsed.data.candidateId));
    if (parsed.data.recruiterId) wheres.push(eq(submissions.submittedByUserId, parsed.data.recruiterId));
    if (parsed.data.stage) wheres.push(eq(submissions.currentStage, parsed.data.stage));
    if (parsed.data.status) wheres.push(eq(submissions.status, parsed.data.status));

    const rows = await db
      .select({
        id: submissions.id,
        currentStage: submissions.currentStage,
        previousStage: submissions.previousStage,
        submittedAt: submissions.submittedAt,
        updatedAt: submissions.updatedAt,
        status: submissions.status,
        recruiterNote: submissions.recruiterNote,
        demandId: submissions.demandId,
        demandTitle: demands.title,
        candidateId: submissions.candidateId,
        candidateName: candidates.displayName,
        recruiterId: submissions.submittedByUserId,
        recruiterName: users.name,
      })
      .from(submissions)
      .leftJoin(demands, eq(demands.id, submissions.demandId))
      .leftJoin(candidates, eq(candidates.id, submissions.candidateId))
      .leftJoin(users, eq(users.id, submissions.submittedByUserId))
      .where(and(...wheres))
      .orderBy(desc(submissions.submittedAt))
      .limit(parsed.data.limit);

    return { submissions: rows };
  });

  // ---------- DETAIL ----------
  app.get("/:id", { preHandler: [app.requirePermission("submissions.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };

    const [row] = await db
      .select({
        submission: submissions,
        demandTitle: demands.title,
        candidateName: candidates.displayName,
        recruiterName: users.name,
      })
      .from(submissions)
      .leftJoin(demands, eq(demands.id, submissions.demandId))
      .leftJoin(candidates, eq(candidates.id, submissions.candidateId))
      .leftJoin(users, eq(users.id, submissions.submittedByUserId))
      .where(and(eq(submissions.id, id), eq(submissions.orgId, ctx.orgId)));
    if (!row) return reply.code(404).send({ error: "submission_not_found" });

    const transitions = await db
      .select({
        id: submissionStageTransitions.id,
        fromStage: submissionStageTransitions.fromStage,
        toStage: submissionStageTransitions.toStage,
        reasonText: submissionStageTransitions.reasonText,
        createdAt: submissionStageTransitions.createdAt,
        changedByUserId: submissionStageTransitions.changedByUserId,
        changedByName: users.name,
      })
      .from(submissionStageTransitions)
      .leftJoin(users, eq(users.id, submissionStageTransitions.changedByUserId))
      .where(eq(submissionStageTransitions.submissionId, id))
      .orderBy(desc(submissionStageTransitions.createdAt));

    return {
      submission: row.submission,
      demandTitle: row.demandTitle,
      candidateName: row.candidateName,
      recruiterName: row.recruiterName,
      transitions,
      stageMetadata: STAGE_METADATA,
    };
  });

  // ---------- TRANSITION ----------
  app.post("/:id/transition", { preHandler: [app.requirePermission("submissions.transition")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const [s] = await db
      .select()
      .from(submissions)
      .where(and(eq(submissions.id, id), eq(submissions.orgId, ctx.orgId)));
    if (!s) return reply.code(404).send({ error: "submission_not_found" });

    const check = validateStageTransition(s.currentStage, parsed.data.toStage, parsed.data.reason ?? null);
    if (!check.ok) return reply.code(400).send({ error: check.error });

    const meta = STAGE_METADATA[parsed.data.toStage];
    const status = meta.isTerminal && parsed.data.toStage !== "withdrawn" ? "closed" : s.status;

    await db.transaction(async (tx) => {
      await tx
        .update(submissions)
        .set({
          previousStage: s.currentStage,
          currentStage: parsed.data.toStage,
          status,
          updatedAt: new Date(),
        })
        .where(eq(submissions.id, id));

      await tx.insert(submissionStageTransitions).values({
        submissionId: id,
        fromStage: s.currentStage,
        toStage: parsed.data.toStage,
        changedByUserId: ctx.id,
        reasonText: parsed.data.reason ?? null,
      });
    });

    return { ok: true, currentStage: parsed.data.toStage };
  });

  // ---------- WITHDRAW (terminal convenience) ----------
  app.post("/:id/withdraw", { preHandler: [app.requirePermission("submissions.transition")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? "Withdrawn";

    const [s] = await db
      .select()
      .from(submissions)
      .where(and(eq(submissions.id, id), eq(submissions.orgId, ctx.orgId)));
    if (!s) return reply.code(404).send({ error: "submission_not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(submissions)
        .set({
          previousStage: s.currentStage,
          currentStage: "withdrawn",
          status: "withdrawn",
          updatedAt: new Date(),
        })
        .where(eq(submissions.id, id));
      await tx.insert(submissionStageTransitions).values({
        submissionId: id,
        fromStage: s.currentStage,
        toStage: "withdrawn",
        changedByUserId: ctx.id,
        reasonText: reason,
      });
    });

    return { ok: true };
  });
}
