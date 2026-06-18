// Prospects API — pre-submission workspace.
//
// A prospect = (recruiter, demand, candidate) row capturing a candidate
// the recruiter is evaluating but hasn't pushed onto the demand yet.
// Promote-to-submission is the canonical "submit candidate" action;
// this endpoint runs in a transaction so the prospect status flip and
// the submission insert + audit row are atomic.

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  candidates,
  db,
  DISQUALIFICATION_REASON_CODES,
  PROSPECT_STATUSES,
  prospects,
  prospectCalls,
  STAGE_METADATA,
  submissionStageTransitions,
  submissions,
} from "@j2w/db";

const listQuerySchema = z.object({
  demandId: z.string().uuid().optional(),
  recruiterId: z.string().uuid().optional(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const createSchema = z.object({
  demandId: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: z.enum(PROSPECT_STATUSES).default("new"),
  interestLevel: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(5000).optional(),
});

const patchSchema = z.object({
  status: z.enum(PROSPECT_STATUSES).optional(),
  interestLevel: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(5000).optional(),
  lastContactedAt: z.string().datetime().optional(),
});

const disqualifySchema = z.object({
  reason: z.enum(DISQUALIFICATION_REASON_CODES),
  notes: z.string().max(2000).optional(),
});

export async function prospectsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---------- LIST ----------
  app.get("/", { preHandler: [app.requirePermission("prospects.read")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });

    const widerView =
      ctx.permissions.includes("demands.assign") ||
      ctx.role === "delivery_lead" ||
      ctx.role === "qa_reviewer";

    const wheres = [eq(prospects.orgId, ctx.orgId)];
    if (parsed.data.demandId) wheres.push(eq(prospects.demandId, parsed.data.demandId));
    if (parsed.data.status) wheres.push(eq(prospects.status, parsed.data.status));
    if (parsed.data.recruiterId) {
      wheres.push(eq(prospects.recruiterId, parsed.data.recruiterId));
    } else if (!widerView) {
      // Recruiters default to their own prospects.
      wheres.push(eq(prospects.recruiterId, ctx.id));
    }

    const rows = await db
      .select({
        id: prospects.id,
        demandId: prospects.demandId,
        candidateId: prospects.candidateId,
        recruiterId: prospects.recruiterId,
        status: prospects.status,
        interestLevel: prospects.interestLevel,
        notes: prospects.notes,
        lastContactedAt: prospects.lastContactedAt,
        createdAt: prospects.createdAt,
        candidateName: candidates.displayName,
        candidateEmail: candidates.email,
        candidatePhone: candidates.phone,
      })
      .from(prospects)
      .innerJoin(candidates, eq(candidates.id, prospects.candidateId))
      .where(and(...wheres))
      .orderBy(asc(prospects.status), desc(prospects.lastContactedAt))
      .limit(parsed.data.limit);

    return { prospects: rows };
  });

  // ---------- CREATE (recruiter starts working a candidate on a demand) ----------
  app.post("/", { preHandler: [app.requirePermission("prospects.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    // Candidate must belong to caller's org. (Demand FK is ON DELETE CASCADE
    // so a stale demandId throws on the insert; we validate up front for a
    // cleaner error message.)
    const [c] = await db
      .select({ id: candidates.id })
      .from(candidates)
      .where(and(eq(candidates.id, parsed.data.candidateId), eq(candidates.orgId, ctx.orgId)));
    if (!c) return reply.code(400).send({ error: "candidate_not_in_org" });

    try {
      const [row] = await db
        .insert(prospects)
        .values({
          orgId: ctx.orgId,
          demandId: parsed.data.demandId,
          candidateId: parsed.data.candidateId,
          recruiterId: ctx.id,
          status: parsed.data.status,
          interestLevel: parsed.data.interestLevel ?? null,
          notes: parsed.data.notes ?? null,
        })
        .returning({ id: prospects.id });
      return { prospectId: row.id };
    } catch (err) {
      // The (demand, candidate, recruiter) UNIQUE constraint kicks here
      // when a recruiter tries to add the same prospect twice.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("prospects_demand_candidate_recruiter_key")) {
        return reply.code(409).send({ error: "already_a_prospect" });
      }
      throw err;
    }
  });

  // ---------- PATCH ----------
  app.patch("/:id", { preHandler: [app.requirePermission("prospects.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
    if (parsed.data.interestLevel !== undefined) updates.interestLevel = parsed.data.interestLevel;
    if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
    if (parsed.data.lastContactedAt !== undefined) updates.lastContactedAt = new Date(parsed.data.lastContactedAt);

    const result = await db
      .update(prospects)
      .set(updates)
      .where(and(eq(prospects.id, id), eq(prospects.orgId, ctx.orgId)))
      .returning({ id: prospects.id });
    if (result.length === 0) return reply.code(404).send({ error: "prospect_not_found" });

    return { ok: true };
  });

  // ---------- PROMOTE TO SUBMISSION ----------
  app.post(
    "/:id/promote-to-submission",
    { preHandler: [app.requirePermission("submissions.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };

      const [p] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, id), eq(prospects.orgId, ctx.orgId)));
      if (!p) return reply.code(404).send({ error: "prospect_not_found" });
      if (p.status === "submitted") return reply.code(409).send({ error: "already_submitted" });

      // Single transaction: insert submission + audit row + flip prospect.
      const submissionId = await db.transaction(async (tx) => {
        const [sub] = await tx
          .insert(submissions)
          .values({
            orgId: ctx.orgId,
            demandId: p.demandId,
            candidateId: p.candidateId,
            submittedByUserId: ctx.id,
            currentStage: "internal_review",
            previousStage: null,
            recruiterNote: p.notes ?? null,
            status: "active",
          })
          .returning({ id: submissions.id });

        await tx.insert(submissionStageTransitions).values({
          submissionId: sub.id,
          fromStage: null,
          toStage: "internal_review",
          changedByUserId: ctx.id,
          reasonText: "Promoted from prospect.",
        });

        await tx
          .update(prospects)
          .set({ status: "submitted", updatedAt: new Date() })
          .where(eq(prospects.id, id));

        return sub.id;
      });

      return { submissionId, prospectId: id };
    },
  );

  // ---------- DISQUALIFY ----------
  app.post(
    "/:id/disqualify",
    { preHandler: [app.requirePermission("prospects.write")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };
      const parsed = disqualifySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });

      const result = await db
        .update(prospects)
        .set({
          status: "disqualified",
          disqualificationReason: parsed.data.reason,
          notes: parsed.data.notes ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(prospects.id, id), eq(prospects.orgId, ctx.orgId)))
        .returning({ id: prospects.id });
      if (result.length === 0) return reply.code(404).send({ error: "prospect_not_found" });
      return { ok: true };
    },
  );

  // ---------- CALL HISTORY ----------
  app.get(
    "/:id/calls",
    { preHandler: [app.requirePermission("prospects.read")] },
    async (req, reply) => {
      const ctx = req.authUser!;
      const { id } = req.params as { id: string };

      const [p] = await db
        .select({ id: prospects.id })
        .from(prospects)
        .where(and(eq(prospects.id, id), eq(prospects.orgId, ctx.orgId)));
      if (!p) return reply.code(404).send({ error: "prospect_not_found" });

      const rows = await db
        .select()
        .from(prospectCalls)
        .where(eq(prospectCalls.prospectId, id))
        .orderBy(desc(prospectCalls.createdAt));
      return { calls: rows };
    },
  );
}

// Submission stage transition helper used by submissions.ts to validate
// against the TS-side STAGE_METADATA map. Exported so we can test it without
// spinning up Fastify.
export function validateStageTransition(
  from: string | null | undefined,
  to: string,
  reason: string | null | undefined,
): { ok: true } | { ok: false; error: string } {
  const meta = STAGE_METADATA[to as keyof typeof STAGE_METADATA];
  if (!meta) return { ok: false, error: `unknown_stage:${to}` };
  if (meta.requiresReason && (!reason || reason.trim().length < 5)) {
    return { ok: false, error: "reason_required" };
  }
  if (from && from === to) return { ok: false, error: "no_op_transition" };
  return { ok: true };
}
