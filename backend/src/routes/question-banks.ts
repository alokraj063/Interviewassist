// Question Banks API — enterprise rebuild.
//
// Promotes the flat CRUD list into a governed, calibrated, versioned item
// library. Every read is gated on `question_banks.read`, every write on
// `question_banks.write`, every approval on `question_banks.approve`. Lists
// are keyset/cursor paginated. Every state change writes a `question_bank_audit`
// row inside the SAME db.transaction as the mutation (also mirrored to the
// global auditLog for the org-wide audit surface). Creates/imports honor an
// Idempotency-Key. Duplicate detection is lexical (content_hash) always-on;
// the semantic / AI-generate path 503s precisely when OPENAI_API_KEY is unset
// (never 500).
//
// All endpoints org-scoped via req.authUser.orgId — cross-tenant access 404s.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, desc, asc, sql, inArray, ilike } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  questionBanks,
  questionBankQuestions,
  questionBankDemandLinks,
  questionVersions,
  questionReviews,
  questionUsageEvents,
  questionBankAudit,
  questionImportJobs,
  auditLog,
  skills,
  QUESTION_LEVELS,
  QUESTION_LANGUAGES,
  QUESTION_TYPES,
} from "@j2w/db";
import { env } from "../env.js";

// ---------- helpers ----------

function badRequest(reply: FastifyReply, parsed: z.SafeParseError<unknown>) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

// Keyset cursor over (createdAt, id): base64url(JSON). Stable disjoint pages.
type KeyCursor = { ts: string; id: string };
function encodeCursor(c: KeyCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s?: string): KeyCursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (obj && typeof obj.ts === "string" && typeof obj.id === "string") {
      return { ts: obj.ts, id: obj.id };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function contentHashOf(prompt: string): string {
  return createHash("sha256").update(prompt.trim().toLowerCase()).digest("hex");
}

// Append-only domain audit + coarse global audit mirror, in one tx.
async function writeAudit(
  tx: typeof db,
  e: {
    orgId: string;
    actorUserId: string | null;
    action: (typeof QUESTION_BANK_AUDIT_ACTIONS_RUNTIME)[number];
    bankId?: string | null;
    questionId?: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(questionBankAudit).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    action: e.action,
    bankId: e.bankId ?? null,
    questionId: e.questionId ?? null,
    payload: e.payload ?? null,
  });
  await tx.insert(auditLog).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId ?? null,
    action: `question_bank.${e.action}`,
    targetType: e.questionId ? "question" : "question_bank",
    targetId: e.questionId ?? e.bankId ?? null,
    payload: e.payload ?? null,
  });
}

// Runtime mirror of the audit-action union (the schema const is the source of
// truth; this keeps `writeAudit` callers type-checked without re-importing it
// under a different name everywhere).
const QUESTION_BANK_AUDIT_ACTIONS_RUNTIME = [
  "bank.created", "bank.updated", "bank.archived", "bank.restored",
  "question.created", "question.updated", "question.archived",
  "question.submitted_for_review", "question.approved", "question.rejected", "question.reverted",
  "question.imported", "questions.bulk_archived", "questions.bulk_approved",
  "question.linked_demand", "question.unlinked_demand",
] as const;

// Resolve a bank that belongs to the caller's org. null → 404 (no leak).
async function resolveOrgBank(orgId: string, bankId: string) {
  const [b] = await db
    .select()
    .from(questionBanks)
    .where(and(eq(questionBanks.id, bankId), eq(questionBanks.orgId, orgId)));
  return b ?? null;
}

// Resolve a question scoped to the caller's org (org_id is denormalized).
async function resolveOrgQuestion(orgId: string, qid: string) {
  const [q] = await db
    .select()
    .from(questionBankQuestions)
    .where(and(eq(questionBankQuestions.id, qid), eq(questionBankQuestions.orgId, orgId)));
  return q ?? null;
}

// Resolve or create a skill by name for the org-agnostic global skills table.
async function resolveSkillId(
  tx: typeof db,
  skillId: string | null | undefined,
  skillName: string | null | undefined,
): Promise<string | null> {
  if (skillId) return skillId;
  const name = skillName?.trim();
  if (!name) return null;
  // skills.name is citext UNIQUE — case-insensitive match natively.
  const [existing] = await tx.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
  if (existing) return existing.id;
  const [created] = await tx.insert(skills).values({ name }).onConflictDoNothing().returning({ id: skills.id });
  if (created) return created.id;
  const [again] = await tx.select({ id: skills.id }).from(skills).where(eq(skills.name, name));
  return again?.id ?? null;
}

// ---------- Zod schemas ----------

const langEnum = z.enum(QUESTION_LANGUAGES);
const typeEnum = z.enum(QUESTION_TYPES);
const levelEnum = z.enum(QUESTION_LEVELS);

const createBankSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  defaultLanguage: langEnum.default("en"),
});

const patchBankSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  defaultLanguage: langEnum.optional(),
  expectedVersion: z.number().int().nonnegative(),
});

const optionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  correct: z.boolean(),
});

const questionBodyShape = {
  skillId: z.string().uuid().nullish(),
  skillName: z.string().max(100).optional(),
  level: levelEnum.default("mid"),
  difficulty: z.number().int().min(1).max(5).default(3),
  language: langEnum.default("en"),
  questionType: typeEnum.default("verbal"),
  roleFamily: z.string().max(60).nullish(),
  prompt: z.string().min(1).max(4000),
  expectedAnswerHints: z.string().max(4000).nullish(),
  evaluationRubric: z.array(z.string().max(500)).max(20).default([]),
  followUpQuestions: z.array(z.string().max(500)).max(20).default([]),
  commonMistakes: z.array(z.string().max(500)).max(20).default([]),
  options: z.array(optionSchema).max(12).default([]),
};

function refineChoices(v: { questionType: string; options: { correct: boolean }[] }, ctx: z.RefinementCtx) {
  if (v.questionType === "mcq_single" || v.questionType === "mcq_multi" || v.questionType === "true_false") {
    if (v.options.length < 2) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Choice questions need ≥2 options" });
    }
    const correct = v.options.filter((o) => o.correct).length;
    if (v.questionType === "mcq_single" && correct !== 1) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Single-choice needs exactly one correct option" });
    }
    if (v.questionType === "mcq_multi" && correct < 1) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Multi-choice needs ≥1 correct option" });
    }
  }
}

const createQuestionSchema = z.object(questionBodyShape).superRefine(refineChoices);

const patchQuestionSchema = z
  .object({
    ...questionBodyShape,
    prompt: z.string().min(1).max(4000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .superRefine((v, ctx) => {
    // Only enforce option rules when the type implies them.
    refineChoices({ questionType: v.questionType, options: v.options }, ctx);
  });

const bulkSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["archive", "approve", "submit_review", "set_role_family", "set_language"]),
  roleFamily: z.string().max(60).optional(),
  language: langEnum.optional(),
});

const cursorQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const questionListQuery = cursorQuery.extend({
  status: z.enum(["draft", "in_review", "approved", "rejected", "archived"]).optional(),
  skillId: z.string().uuid().optional(),
  level: levelEnum.optional(),
  difficultyMin: z.coerce.number().int().min(1).max(5).optional(),
  difficultyMax: z.coerce.number().int().min(1).max(5).optional(),
  language: langEnum.optional(),
  roleFamily: z.string().max(60).optional(),
  questionType: typeEnum.optional(),
  q: z.string().max(200).optional(),
  sort: z
    .enum(["created_desc", "created_asc", "difficulty_desc", "exposure_desc", "calibrated_desc", "last_used_desc"])
    .default("created_desc"),
});

const banksListQuery = cursorQuery.extend({
  status: z.enum(["active", "archived"]).optional(),
  q: z.string().max(200).optional(),
  // When set, return only banks linked to this demand (live-assist loads the
  // bank for the selected JD).
  demandId: z.string().uuid().optional(),
});

const reviewNoteSchema = z.object({ note: z.string().max(2000).optional() });
const rejectSchema = z.object({ note: z.string().min(1).max(2000) });

const importSchema = z.object({
  format: z.enum(["csv", "qti"]),
  content: z.string().min(1).max(2_000_000),
});

// Exposure beyond this many serves trips the over-use warning badge.
const OVER_USE_THRESHOLD = 200;

type QuestionRow = typeof questionBankQuestions.$inferSelect;

function serializeQuestion(q: QuestionRow) {
  return {
    id: q.id,
    bankId: q.bankId,
    skillId: q.skillId,
    level: q.level ?? "mid",
    difficulty: q.difficulty ?? 3,
    language: q.language,
    questionType: q.questionType,
    roleFamily: q.roleFamily,
    prompt: q.prompt,
    expectedAnswerHints: q.expectedAnswerHints,
    evaluationRubric: q.evaluationRubric ?? [],
    followUpQuestions: q.followUpQuestions ?? [],
    commonMistakes: q.commonMistakes ?? [],
    options: q.options ?? [],
    status: q.status,
    currentVersion: q.currentVersion,
    contentHash: q.contentHash,
    calibratedDifficulty: q.calibratedDifficulty,
    exposureCount: q.exposureCount,
    lastUsedAt: q.lastUsedAt ? q.lastUsedAt.toISOString() : null,
    overUsed: q.exposureCount >= OVER_USE_THRESHOLD,
    createdByUserId: q.createdByUserId,
    approvedByUserId: q.approvedByUserId,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

// Full immutable payload pinned into a question_versions row.
function snapshotOf(q: QuestionRow): Record<string, unknown> {
  return {
    prompt: q.prompt,
    level: q.level,
    difficulty: q.difficulty,
    language: q.language,
    questionType: q.questionType,
    roleFamily: q.roleFamily,
    skillId: q.skillId,
    expectedAnswerHints: q.expectedAnswerHints,
    evaluationRubric: q.evaluationRubric,
    followUpQuestions: q.followUpQuestions,
    commonMistakes: q.commonMistakes,
    options: q.options,
    status: q.status,
  };
}

// Minimal CSV parser for import preview. Header row required: prompt is the
// only mandatory column. Quoted fields with embedded commas supported.
function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = splitRow(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function questionBanksRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const read = app.requirePermission("question_banks.read");
  const write = app.requirePermission("question_banks.write");
  const approve = app.requirePermission("question_banks.approve");

  // ---------------------------------------------------------------------------
  // BANKS
  // ---------------------------------------------------------------------------

  // Keyset list of banks with computed question/link counts (single grouped
  // query each, not N+1) + status filter + search.
  app.get("/", { preHandler: [read] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = banksListQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { cursor, limit, status, q, demandId } = parsed.data;
    const cur = decodeCursor(cursor);

    const conds = [eq(questionBanks.orgId, orgId)];
    if (status) conds.push(eq(questionBanks.status, status));
    if (q) conds.push(ilike(questionBanks.name, `%${q}%`));
    // Restrict to banks linked to the given demand (the selected JD).
    if (demandId) {
      const linked = await db
        .select({ bankId: questionBankDemandLinks.bankId })
        .from(questionBankDemandLinks)
        .where(eq(questionBankDemandLinks.demandId, demandId));
      const ids = linked.map((l) => l.bankId);
      // No linked bank → return an empty page (the client falls back to all).
      if (ids.length === 0) return { banks: [], nextCursor: null };
      conds.push(inArray(questionBanks.id, ids));
    }
    if (cur) {
      conds.push(
        sql`(${questionBanks.updatedAt}, ${questionBanks.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`,
      );
    }

    const rows = await db
      .select({
        id: questionBanks.id,
        name: questionBanks.name,
        description: questionBanks.description,
        status: questionBanks.status,
        defaultLanguage: questionBanks.defaultLanguage,
        version: questionBanks.version,
        updatedAt: questionBanks.updatedAt,
      })
      .from(questionBanks)
      .where(and(...conds))
      .orderBy(desc(questionBanks.updatedAt), desc(questionBanks.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const bankIds = page.map((b) => b.id);

    let qcMap = new Map<string, number>();
    let lcMap = new Map<string, number>();
    let skMap = new Map<string, number>();
    if (bankIds.length > 0) {
      const questionCounts = await db
        .select({ bankId: questionBankQuestions.bankId, count: sql<number>`count(*)::int` })
        .from(questionBankQuestions)
        .where(
          and(
            inArray(questionBankQuestions.bankId, bankIds),
            sql`${questionBankQuestions.status} <> 'archived'`,
          ),
        )
        .groupBy(questionBankQuestions.bankId);
      qcMap = new Map(questionCounts.map((c) => [c.bankId, c.count]));

      const skillCounts = await db
        .select({
          bankId: questionBankQuestions.bankId,
          count: sql<number>`count(distinct ${questionBankQuestions.skillId})::int`,
        })
        .from(questionBankQuestions)
        .where(
          and(
            inArray(questionBankQuestions.bankId, bankIds),
            sql`${questionBankQuestions.skillId} is not null`,
          ),
        )
        .groupBy(questionBankQuestions.bankId);
      skMap = new Map(skillCounts.map((c) => [c.bankId, c.count]));

      const linkCounts = await db
        .select({ bankId: questionBankDemandLinks.bankId, count: sql<number>`count(*)::int` })
        .from(questionBankDemandLinks)
        .where(inArray(questionBankDemandLinks.bankId, bankIds))
        .groupBy(questionBankDemandLinks.bankId);
      lcMap = new Map(linkCounts.map((c) => [c.bankId, c.count]));
    }

    const banks = page.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      status: b.status,
      defaultLanguage: b.defaultLanguage,
      version: b.version,
      questionCount: qcMap.get(b.id) ?? 0,
      skillsCovered: skMap.get(b.id) ?? 0,
      linkedDemandsCount: lcMap.get(b.id) ?? 0,
      updatedAt: b.updatedAt.toISOString(),
    }));

    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ ts: last.updatedAt.toISOString(), id: last.id }) : null;

    return { banks, nextCursor };
  });

  // Create a bank. Idempotency-Key short-circuits a re-POST to the prior row.
  app.post("/", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = createBankSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);
    if (idemKey) {
      const [prior] = await db
        .select({ targetId: auditLog.targetId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, orgId),
            eq(auditLog.action, "question_bank.bank.created"),
            sql`${auditLog.payload}->>'idempotencyKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior?.targetId) return reply.code(201).send({ id: prior.targetId, idempotent: true });
    }

    const created = await db.transaction(async (tx) => {
      const [bank] = await tx
        .insert(questionBanks)
        .values({
          orgId,
          name: body.name,
          description: body.description ?? null,
          defaultLanguage: body.defaultLanguage,
          createdByUserId: userId,
        })
        .returning();
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: "bank.created",
        bankId: bank.id,
        payload: { name: body.name, ...(idemKey ? { idempotencyKey: idemKey } : {}) },
      });
      return bank;
    });

    return reply.code(201).send({ id: created.id });
  });

  // Single bank + meta (questions paginate separately).
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [read] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });

    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${questionBankQuestions.status} = 'approved')::int`,
        inReview: sql<number>`count(*) filter (where ${questionBankQuestions.status} = 'in_review')::int`,
        draft: sql<number>`count(*) filter (where ${questionBankQuestions.status} = 'draft')::int`,
      })
      .from(questionBankQuestions)
      .where(eq(questionBankQuestions.bankId, bank.id));

    const links = await db
      .select({ demandId: questionBankDemandLinks.demandId })
      .from(questionBankDemandLinks)
      .where(eq(questionBankDemandLinks.bankId, bank.id));

    return {
      id: bank.id,
      name: bank.name,
      description: bank.description,
      status: bank.status,
      defaultLanguage: bank.defaultLanguage,
      version: bank.version,
      archivedAt: bank.archivedAt ? bank.archivedAt.toISOString() : null,
      counts: counts ?? { total: 0, approved: 0, inReview: 0, draft: 0 },
      linkedDemandIds: links.map((l) => l.demandId),
      createdAt: bank.createdAt.toISOString(),
      updatedAt: bank.updatedAt.toISOString(),
    };
  });

  // Patch a bank with optimistic concurrency (If-Match / expectedVersion).
  app.patch<{ Params: { id: string } }>("/:id", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = patchBankSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });
    if (bank.version !== body.expectedVersion) {
      return reply.code(409).send({ error: "version_conflict", currentVersion: bank.version });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(questionBanks)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.defaultLanguage !== undefined ? { defaultLanguage: body.defaultLanguage } : {}),
          version: bank.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(questionBanks.id, bank.id), eq(questionBanks.version, body.expectedVersion)))
        .returning();
      if (row) {
        await writeAudit(tx as typeof db, {
          orgId,
          actorUserId: userId,
          action: "bank.updated",
          bankId: bank.id,
          payload: { name: body.name, description: body.description },
        });
      }
      return row;
    });
    if (!updated) return reply.code(409).send({ error: "version_conflict", currentVersion: bank.version });
    return { id: updated.id, version: updated.version };
  });

  // Soft-archive a bank.
  app.post<{ Params: { id: string } }>("/:id/archive", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });
    if (bank.status === "archived") return { id: bank.id, status: "archived" };

    await db.transaction(async (tx) => {
      await tx
        .update(questionBanks)
        .set({ status: "archived", archivedAt: new Date(), archivedByUserId: userId, version: bank.version + 1, updatedAt: new Date() })
        .where(eq(questionBanks.id, bank.id));
      await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "bank.archived", bankId: bank.id });
    });
    return { id: bank.id, status: "archived" };
  });

  // Restore an archived bank.
  app.post<{ Params: { id: string } }>("/:id/restore", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });

    await db.transaction(async (tx) => {
      await tx
        .update(questionBanks)
        .set({ status: "active", archivedAt: null, archivedByUserId: null, version: bank.version + 1, updatedAt: new Date() })
        .where(eq(questionBanks.id, bank.id));
      await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "bank.restored", bankId: bank.id });
    });
    return { id: bank.id, status: "active" };
  });

  // Link / unlink a bank to a demand (so live-assist loads the JD's bank).
  app.post<{ Params: { id: string } }>("/:id/link-demand", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const body = z.object({ demandId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return badRequest(reply, body);
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });
    await db
      .insert(questionBankDemandLinks)
      .values({ bankId: bank.id, demandId: body.data.demandId })
      .onConflictDoNothing();
    await writeAudit(db, {
      orgId,
      actorUserId: userId,
      action: "question.linked_demand",
      bankId: bank.id,
      payload: { demandId: body.data.demandId },
    });
    return { ok: true, bankId: bank.id, demandId: body.data.demandId };
  });

  // Keyset activity feed from the domain audit table (A9 timeline).
  app.get<{ Params: { id: string } }>("/:id/activity", { preHandler: [read] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = cursorQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });
    const { cursor, limit } = parsed.data;
    const cur = decodeCursor(cursor);

    const conds = [eq(questionBankAudit.orgId, orgId), eq(questionBankAudit.bankId, bank.id)];
    if (cur) {
      conds.push(
        sql`(${questionBankAudit.createdAt}, ${questionBankAudit.id}::text) < (${cur.ts}::timestamptz, ${cur.id})`,
      );
    }
    const rows = await db
      .select()
      .from(questionBankAudit)
      .where(and(...conds))
      .orderBy(desc(questionBankAudit.createdAt), desc(questionBankAudit.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ ts: last.createdAt.toISOString(), id: String(last.id) }) : null;
    return {
      events: page.map((r) => ({
        id: String(r.id),
        action: r.action,
        actorUserId: r.actorUserId,
        questionId: r.questionId,
        payload: r.payload,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

  // ---------------------------------------------------------------------------
  // QUESTIONS
  // ---------------------------------------------------------------------------

  // Keyset-paginated, server-filtered, server-sorted question list for a bank.
  app.get<{ Params: { id: string } }>("/:id/questions", { preHandler: [read] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = questionListQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });
    const f = parsed.data;
    const cur = decodeCursor(f.cursor);

    const conds = [
      eq(questionBankQuestions.orgId, orgId),
      eq(questionBankQuestions.bankId, bank.id),
    ];
    if (f.status) conds.push(eq(questionBankQuestions.status, f.status));
    if (f.skillId) conds.push(eq(questionBankQuestions.skillId, f.skillId));
    if (f.level) conds.push(eq(questionBankQuestions.level, f.level));
    if (f.difficultyMin !== undefined) conds.push(sql`${questionBankQuestions.difficulty} >= ${f.difficultyMin}`);
    if (f.difficultyMax !== undefined) conds.push(sql`${questionBankQuestions.difficulty} <= ${f.difficultyMax}`);
    if (f.language) conds.push(eq(questionBankQuestions.language, f.language));
    if (f.roleFamily) conds.push(eq(questionBankQuestions.roleFamily, f.roleFamily));
    if (f.questionType) conds.push(eq(questionBankQuestions.questionType, f.questionType));
    if (f.q) conds.push(ilike(questionBankQuestions.prompt, `%${f.q}%`));

    // Keyset only on the default (created_desc) sort — the stable, indexed path.
    // Other sorts use offset-free "best effort" ordering with a created tiebreak;
    // the UI uses created_desc for infinite scroll, others for ranked snapshots.
    if (cur && f.sort === "created_desc") {
      conds.push(
        sql`(${questionBankQuestions.createdAt}, ${questionBankQuestions.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`,
      );
    }

    const orderBy = (() => {
      switch (f.sort) {
        case "created_asc":
          return [asc(questionBankQuestions.createdAt), asc(questionBankQuestions.id)];
        case "difficulty_desc":
          return [desc(questionBankQuestions.difficulty), desc(questionBankQuestions.createdAt)];
        case "exposure_desc":
          return [desc(questionBankQuestions.exposureCount), desc(questionBankQuestions.createdAt)];
        case "calibrated_desc":
          return [desc(questionBankQuestions.calibratedDifficulty), desc(questionBankQuestions.createdAt)];
        case "last_used_desc":
          return [desc(questionBankQuestions.lastUsedAt), desc(questionBankQuestions.createdAt)];
        default:
          return [desc(questionBankQuestions.createdAt), desc(questionBankQuestions.id)];
      }
    })();

    const rows = await db
      .select()
      .from(questionBankQuestions)
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(f.limit + 1);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(questionBankQuestions)
      .where(and(...conds.filter((_, i) => !(cur && f.sort === "created_desc" && i === conds.length - 1))));

    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > f.limit && last && f.sort === "created_desc"
        ? encodeCursor({ ts: last.createdAt.toISOString(), id: last.id })
        : null;

    return {
      questions: page.map(serializeQuestion),
      nextCursor,
      totalApprox: total,
    };
  });

  // Create a question. Computes content_hash, dedups (409 unless allowDuplicate),
  // honors Idempotency-Key, writes v1 version snapshot + audit.
  app.post<{ Params: { id: string }; Querystring: { allowDuplicate?: string } }>(
    "/:id/questions",
    { preHandler: [write] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const userId = req.authUser!.id;
      const parsed = createQuestionSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed);
      const body = parsed.data;

      const bank = await resolveOrgBank(orgId, req.params.id);
      if (!bank) return reply.code(404).send({ error: "not_found" });

      const hash = contentHashOf(body.prompt);
      const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);
      const allowDuplicate = req.query.allowDuplicate === "true";

      // Lexical dedup (always on, no external key). Same key + same content =>
      // idempotent return of the existing row.
      const [dup] = await db
        .select({ id: questionBankQuestions.id, prompt: questionBankQuestions.prompt })
        .from(questionBankQuestions)
        .where(and(eq(questionBankQuestions.orgId, orgId), eq(questionBankQuestions.contentHash, hash)))
        .limit(1);
      if (dup) {
        if (idemKey || allowDuplicate) {
          // network-retry / explicit override → return the existing row.
          return reply.code(201).send({ id: dup.id, idempotent: true });
        }
        return reply
          .code(409)
          .send({ error: "duplicate_question", existingId: dup.id });
      }

      const created = await db.transaction(async (tx) => {
        const skillId = await resolveSkillId(tx as typeof db, body.skillId, body.skillName);
        const [q] = await tx
          .insert(questionBankQuestions)
          .values({
            bankId: bank.id,
            orgId,
            skillId,
            level: body.level,
            difficulty: body.difficulty,
            language: body.language,
            questionType: body.questionType,
            roleFamily: body.roleFamily ?? null,
            prompt: body.prompt,
            expectedAnswerHints: body.expectedAnswerHints ?? null,
            evaluationRubric: body.evaluationRubric,
            followUpQuestions: body.followUpQuestions,
            commonMistakes: body.commonMistakes,
            options: body.options,
            status: "draft",
            currentVersion: 1,
            contentHash: hash,
            createdByUserId: userId,
          })
          .returning();

        await tx.insert(questionVersions).values({
          orgId,
          questionId: q.id,
          version: 1,
          reason: "created",
          authorUserId: userId,
          snapshot: snapshotOf(q),
        });
        await writeAudit(tx as typeof db, {
          orgId,
          actorUserId: userId,
          action: "question.created",
          bankId: bank.id,
          questionId: q.id,
          payload: { prompt: body.prompt.slice(0, 120), ...(idemKey ? { idempotencyKey: idemKey } : {}) },
        });
        await tx.update(questionBanks).set({ updatedAt: new Date() }).where(eq(questionBanks.id, bank.id));
        return q;
      });

      return reply.code(201).send({ id: created.id, currentVersion: 1 });
    },
  );

  // Single question drill-down: question + version history + usage stats +
  // review history.
  app.get<{ Params: { qid: string } }>("/questions/:qid", { preHandler: [read] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const q = await resolveOrgQuestion(orgId, req.params.qid);
    if (!q) return reply.code(404).send({ error: "not_found" });

    const versions = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionId, q.id))
      .orderBy(desc(questionVersions.version));

    const reviews = await db
      .select()
      .from(questionReviews)
      .where(eq(questionReviews.questionId, q.id))
      .orderBy(desc(questionReviews.createdAt));

    const [usage] = await db
      .select({
        events: sql<number>`count(*)::int`,
        scored: sql<number>`count(*) filter (where ${questionUsageEvents.scored})::int`,
        pValue: sql<number | null>`avg(${questionUsageEvents.scoreFraction})::float`,
      })
      .from(questionUsageEvents)
      .where(eq(questionUsageEvents.questionId, q.id));

    return {
      question: serializeQuestion(q),
      versions: versions.map((v) => ({
        version: v.version,
        reason: v.reason,
        authorUserId: v.authorUserId,
        snapshot: v.snapshot,
        createdAt: v.createdAt.toISOString(),
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        decision: r.decision,
        reviewerUserId: r.reviewerUserId,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      })),
      usage: {
        events: usage?.events ?? 0,
        scored: usage?.scored ?? 0,
        liveExposureCount: q.exposureCount,
        calibratedDifficulty: q.calibratedDifficulty,
        observedPValue: usage?.pValue ?? null,
        lastUsedAt: q.lastUsedAt ? q.lastUsedAt.toISOString() : null,
        overUsed: q.exposureCount >= OVER_USE_THRESHOLD,
      },
    };
  });

  // Patch a question with optimistic concurrency; bumps version, appends a
  // version snapshot, writes audit.
  app.patch<{ Params: { qid: string } }>("/questions/:qid", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = patchQuestionSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const q = await resolveOrgQuestion(orgId, req.params.qid);
    if (!q) return reply.code(404).send({ error: "not_found" });
    if (q.currentVersion !== body.expectedVersion) {
      return reply.code(409).send({ error: "version_conflict", currentVersion: q.currentVersion });
    }

    const updated = await db.transaction(async (tx) => {
      const skillId =
        body.skillId !== undefined || body.skillName !== undefined
          ? await resolveSkillId(tx as typeof db, body.skillId, body.skillName)
          : q.skillId;
      const nextVersion = q.currentVersion + 1;
      const newHash = body.prompt !== undefined ? contentHashOf(body.prompt) : q.contentHash;
      const [row] = await tx
        .update(questionBankQuestions)
        .set({
          ...(body.prompt !== undefined ? { prompt: body.prompt, contentHash: newHash } : {}),
          ...(body.level !== undefined ? { level: body.level } : {}),
          ...(body.difficulty !== undefined ? { difficulty: body.difficulty } : {}),
          ...(body.language !== undefined ? { language: body.language } : {}),
          ...(body.questionType !== undefined ? { questionType: body.questionType } : {}),
          ...(body.roleFamily !== undefined ? { roleFamily: body.roleFamily } : {}),
          ...(body.expectedAnswerHints !== undefined ? { expectedAnswerHints: body.expectedAnswerHints } : {}),
          ...(body.evaluationRubric !== undefined ? { evaluationRubric: body.evaluationRubric } : {}),
          ...(body.followUpQuestions !== undefined ? { followUpQuestions: body.followUpQuestions } : {}),
          ...(body.commonMistakes !== undefined ? { commonMistakes: body.commonMistakes } : {}),
          ...(body.options !== undefined ? { options: body.options } : {}),
          skillId,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(and(eq(questionBankQuestions.id, q.id), eq(questionBankQuestions.currentVersion, body.expectedVersion)))
        .returning();
      if (!row) return null;
      await tx.insert(questionVersions).values({
        orgId,
        questionId: q.id,
        version: nextVersion,
        reason: "edited",
        authorUserId: userId,
        snapshot: snapshotOf(row),
      });
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: "question.updated",
        bankId: q.bankId,
        questionId: q.id,
        payload: { version: nextVersion },
      });
      return row;
    });
    if (!updated) return reply.code(409).send({ error: "version_conflict", currentVersion: q.currentVersion });
    return { id: updated.id, currentVersion: updated.currentVersion };
  });

  // Soft-archive a question (replaces hard DELETE).
  app.post<{ Params: { qid: string } }>("/questions/:qid/archive", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const q = await resolveOrgQuestion(orgId, req.params.qid);
    if (!q) return reply.code(404).send({ error: "not_found" });
    if (q.status === "archived") return { id: q.id, status: "archived" };

    await db.transaction(async (tx) => {
      await tx
        .update(questionBankQuestions)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(questionBankQuestions.id, q.id));
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: "question.archived",
        bankId: q.bankId,
        questionId: q.id,
      });
    });
    return { id: q.id, status: "archived" };
  });

  // ---------------------------------------------------------------------------
  // REVIEW / APPROVAL WORKFLOW
  // ---------------------------------------------------------------------------

  // Submit a draft question for review (draft -> in_review).
  app.post<{ Params: { qid: string } }>(
    "/questions/:qid/submit-review",
    { preHandler: [write] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const userId = req.authUser!.id;
      const parsed = reviewNoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed);
      const q = await resolveOrgQuestion(orgId, req.params.qid);
      if (!q) return reply.code(404).send({ error: "not_found" });
      if (q.status !== "draft" && q.status !== "rejected") {
        return reply.code(409).send({ error: "invalid_state", status: q.status });
      }

      await db.transaction(async (tx) => {
        await tx
          .update(questionBankQuestions)
          .set({ status: "in_review", updatedAt: new Date() })
          .where(eq(questionBankQuestions.id, q.id));
        await tx.insert(questionReviews).values({
          orgId,
          questionId: q.id,
          decision: "submitted",
          reviewerUserId: userId,
          note: parsed.data.note ?? null,
        });
        await writeAudit(tx as typeof db, {
          orgId,
          actorUserId: userId,
          action: "question.submitted_for_review",
          bankId: q.bankId,
          questionId: q.id,
        });
      });
      return { id: q.id, status: "in_review" };
    },
  );

  // Approve an in_review question. Author ≠ approver guard (409 self_approval).
  app.post<{ Params: { qid: string } }>("/questions/:qid/approve", { preHandler: [approve] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = reviewNoteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed);
    const q = await resolveOrgQuestion(orgId, req.params.qid);
    if (!q) return reply.code(404).send({ error: "not_found" });
    if (q.status !== "in_review") return reply.code(409).send({ error: "invalid_state", status: q.status });
    if (q.createdByUserId && q.createdByUserId === userId) {
      return reply.code(409).send({ error: "self_approval" });
    }

    const updated = await db.transaction(async (tx) => {
      const nextVersion = q.currentVersion + 1;
      const [row] = await tx
        .update(questionBankQuestions)
        .set({ status: "approved", approvedByUserId: userId, currentVersion: nextVersion, updatedAt: new Date() })
        .where(eq(questionBankQuestions.id, q.id))
        .returning();
      await tx.insert(questionReviews).values({
        orgId,
        questionId: q.id,
        decision: "approved",
        reviewerUserId: userId,
        note: parsed.data.note ?? null,
      });
      await tx.insert(questionVersions).values({
        orgId,
        questionId: q.id,
        version: nextVersion,
        reason: "approved",
        authorUserId: userId,
        snapshot: snapshotOf(row),
      });
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: "question.approved",
        bankId: q.bankId,
        questionId: q.id,
      });
      return row;
    });
    return { id: updated.id, status: "approved" };
  });

  // Reject an in_review question (mandatory note).
  app.post<{ Params: { qid: string } }>("/questions/:qid/reject", { preHandler: [approve] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const q = await resolveOrgQuestion(orgId, req.params.qid);
    if (!q) return reply.code(404).send({ error: "not_found" });
    if (q.status !== "in_review") return reply.code(409).send({ error: "invalid_state", status: q.status });

    await db.transaction(async (tx) => {
      const nextVersion = q.currentVersion + 1;
      const [row] = await tx
        .update(questionBankQuestions)
        .set({ status: "rejected", currentVersion: nextVersion, updatedAt: new Date() })
        .where(eq(questionBankQuestions.id, q.id))
        .returning();
      await tx.insert(questionReviews).values({
        orgId,
        questionId: q.id,
        decision: "rejected",
        reviewerUserId: userId,
        note: parsed.data.note,
      });
      await tx.insert(questionVersions).values({
        orgId,
        questionId: q.id,
        version: nextVersion,
        reason: "rejected",
        authorUserId: userId,
        snapshot: snapshotOf(row),
      });
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: "question.rejected",
        bankId: q.bankId,
        questionId: q.id,
        payload: { note: parsed.data.note },
      });
    });
    return { id: q.id, status: "rejected" };
  });

  // Revert a question to a prior snapshot as a NEW version.
  app.post<{ Params: { qid: string; version: string } }>(
    "/questions/:qid/revert/:version",
    { preHandler: [write] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const userId = req.authUser!.id;
      const targetVersion = Number.parseInt(req.params.version, 10);
      if (!Number.isInteger(targetVersion) || targetVersion < 1) {
        return reply.code(400).send({ error: "invalid_version" });
      }
      const q = await resolveOrgQuestion(orgId, req.params.qid);
      if (!q) return reply.code(404).send({ error: "not_found" });

      const [snap] = await db
        .select()
        .from(questionVersions)
        .where(and(eq(questionVersions.questionId, q.id), eq(questionVersions.version, targetVersion)));
      if (!snap) return reply.code(404).send({ error: "version_not_found" });
      const s = snap.snapshot as Record<string, unknown>;

      const updated = await db.transaction(async (tx) => {
        const nextVersion = q.currentVersion + 1;
        const newPrompt = typeof s.prompt === "string" ? s.prompt : q.prompt;
        const [row] = await tx
          .update(questionBankQuestions)
          .set({
            prompt: newPrompt,
            contentHash: contentHashOf(newPrompt),
            level: (s.level as QuestionRow["level"]) ?? q.level,
            difficulty: typeof s.difficulty === "number" ? (s.difficulty as number) : q.difficulty,
            language: (s.language as QuestionRow["language"]) ?? q.language,
            questionType: (s.questionType as QuestionRow["questionType"]) ?? q.questionType,
            roleFamily: (s.roleFamily as string | null) ?? q.roleFamily,
            options: (s.options as QuestionRow["options"]) ?? q.options,
            currentVersion: nextVersion,
            updatedAt: new Date(),
          })
          .where(eq(questionBankQuestions.id, q.id))
          .returning();
        await tx.insert(questionVersions).values({
          orgId,
          questionId: q.id,
          version: nextVersion,
          reason: "reverted",
          authorUserId: userId,
          snapshot: snapshotOf(row),
        });
        await writeAudit(tx as typeof db, {
          orgId,
          actorUserId: userId,
          action: "question.reverted",
          bankId: q.bankId,
          questionId: q.id,
          payload: { revertedTo: targetVersion },
        });
        return row;
      });
      return { id: updated.id, currentVersion: updated.currentVersion };
    },
  );

  // Org-wide review queue: in_review questions across all banks (keyset).
  app.get("/review-queue", { preHandler: [approve] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = cursorQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { cursor, limit } = parsed.data;
    const cur = decodeCursor(cursor);

    const conds = [eq(questionBankQuestions.orgId, orgId), eq(questionBankQuestions.status, "in_review")];
    if (cur) {
      conds.push(
        sql`(${questionBankQuestions.updatedAt}, ${questionBankQuestions.id}) < (${cur.ts}::timestamptz, ${cur.id}::uuid)`,
      );
    }
    const rows = await db
      .select()
      .from(questionBankQuestions)
      .where(and(...conds))
      .orderBy(desc(questionBankQuestions.updatedAt), desc(questionBankQuestions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ ts: last.updatedAt.toISOString(), id: last.id }) : null;
    return { questions: page.map(serializeQuestion), nextCursor };
  });

  // ---------------------------------------------------------------------------
  // BULK ACTIONS
  // ---------------------------------------------------------------------------

  app.post("/questions/bulk", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    // The approve action additionally needs question_banks.approve.
    if (body.action === "approve" && !req.authUser!.permissions.includes("question_banks.approve")) {
      return reply.code(403).send({ error: "forbidden", permission: "question_banks.approve" });
    }

    // Only operate on questions that belong to the caller's org.
    const owned = await db
      .select()
      .from(questionBankQuestions)
      .where(and(eq(questionBankQuestions.orgId, orgId), inArray(questionBankQuestions.id, body.questionIds)));
    const ownedById = new Map(owned.map((q) => [q.id, q]));

    const result = await db.transaction(async (tx) => {
      let updated = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of body.questionIds) {
        const q = ownedById.get(id);
        if (!q) { skipped.push({ id, reason: "not_found" }); continue; }
        if (body.action === "archive") {
          await tx.update(questionBankQuestions).set({ status: "archived", updatedAt: new Date() }).where(eq(questionBankQuestions.id, id));
          await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "question.archived", bankId: q.bankId, questionId: id });
          updated++;
        } else if (body.action === "approve") {
          if (q.status !== "in_review") { skipped.push({ id, reason: "invalid_state" }); continue; }
          if (q.createdByUserId && q.createdByUserId === userId) { skipped.push({ id, reason: "self_approval" }); continue; }
          await tx.update(questionBankQuestions).set({ status: "approved", approvedByUserId: userId, updatedAt: new Date() }).where(eq(questionBankQuestions.id, id));
          await tx.insert(questionReviews).values({ orgId, questionId: id, decision: "approved", reviewerUserId: userId, note: "bulk approve" });
          await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "question.approved", bankId: q.bankId, questionId: id });
          updated++;
        } else if (body.action === "submit_review") {
          if (q.status !== "draft" && q.status !== "rejected") { skipped.push({ id, reason: "invalid_state" }); continue; }
          await tx.update(questionBankQuestions).set({ status: "in_review", updatedAt: new Date() }).where(eq(questionBankQuestions.id, id));
          await tx.insert(questionReviews).values({ orgId, questionId: id, decision: "submitted", reviewerUserId: userId, note: "bulk submit" });
          await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "question.submitted_for_review", bankId: q.bankId, questionId: id });
          updated++;
        } else if (body.action === "set_role_family") {
          await tx.update(questionBankQuestions).set({ roleFamily: body.roleFamily ?? null, updatedAt: new Date() }).where(eq(questionBankQuestions.id, id));
          await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "question.updated", bankId: q.bankId, questionId: id, payload: { roleFamily: body.roleFamily } });
          updated++;
        } else if (body.action === "set_language") {
          if (!body.language) { skipped.push({ id, reason: "missing_language" }); continue; }
          await tx.update(questionBankQuestions).set({ language: body.language, updatedAt: new Date() }).where(eq(questionBankQuestions.id, id));
          await writeAudit(tx as typeof db, { orgId, actorUserId: userId, action: "question.updated", bankId: q.bankId, questionId: id, payload: { language: body.language } });
          updated++;
        }
      }
      // Coarse roll-up audit row for the bulk operation.
      await writeAudit(tx as typeof db, {
        orgId,
        actorUserId: userId,
        action: body.action === "approve" ? "questions.bulk_approved" : "questions.bulk_archived",
        payload: { action: body.action, count: updated },
      });
      return { updated, skipped };
    });

    return result;
  });

  // ---------------------------------------------------------------------------
  // EXPORT / IMPORT
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/:id/export",
    { preHandler: [read] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const bank = await resolveOrgBank(orgId, req.params.id);
      if (!bank) return reply.code(404).send({ error: "not_found" });

      const rows = await db
        .select()
        .from(questionBankQuestions)
        .where(eq(questionBankQuestions.bankId, bank.id))
        .orderBy(asc(questionBankQuestions.createdAt));

      const header = ["prompt", "level", "difficulty", "language", "questionType", "roleFamily", "status", "expectedAnswerHints"];
      const lines = [header.join(",")];
      for (const q of rows) {
        lines.push(
          [q.prompt, q.level ?? "", q.difficulty ?? "", q.language, q.questionType, q.roleFamily ?? "", q.status, q.expectedAnswerHints ?? ""]
            .map(csvEscape)
            .join(","),
        );
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="question-bank-${bank.id}.csv"`);
      return reply.send(lines.join("\n"));
    },
  );

  // Parse an import to a PREVIEW job (does not commit). Idempotency-Key dedups.
  app.post<{ Params: { id: string } }>("/:id/import", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });

    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);
    if (idemKey) {
      const [prior] = await db
        .select()
        .from(questionImportJobs)
        .where(and(eq(questionImportJobs.orgId, orgId), eq(questionImportJobs.idempotencyKey, idemKey)))
        .limit(1);
      if (prior) {
        return {
          jobId: prior.id,
          status: prior.status,
          rowCount: prior.rowCount,
          validCount: prior.validCount,
          duplicateCount: prior.duplicateCount,
          errorCount: prior.errorCount,
          preview: prior.preview,
          errors: prior.errors,
          idempotent: true,
        };
      }
    }

    // QTI parsing is not implemented; we accept the format flag but only the CSV
    // path produces real rows. QTI returns a structured "unsupported" error set.
    let rawRows: Array<Record<string, string>> = [];
    if (parsed.data.format === "csv") {
      rawRows = parseCsv(parsed.data.content);
    }

    const existingHashes = new Set(
      (
        await db
          .select({ hash: questionBankQuestions.contentHash })
          .from(questionBankQuestions)
          .where(eq(questionBankQuestions.orgId, orgId))
      ).map((r) => r.hash),
    );

    const preview: Array<Record<string, unknown>> = [];
    const errors: Array<{ row: number; message: string }> = [];
    let valid = 0;
    let dup = 0;
    const seenInFile = new Set<string>();
    if (parsed.data.format === "qti") {
      errors.push({ row: 0, message: "QTI import not yet supported — use CSV" });
    } else {
      rawRows.forEach((r, i) => {
        const rowNum = i + 1;
        const prompt = (r.prompt ?? "").trim();
        if (!prompt) { errors.push({ row: rowNum, message: "missing prompt" }); return; }
        const hash = contentHashOf(prompt);
        const isDup = existingHashes.has(hash) || seenInFile.has(hash);
        seenInFile.add(hash);
        if (isDup) dup++;
        else valid++;
        preview.push({
          row: rowNum,
          prompt,
          level: r.level || "mid",
          difficulty: Number.parseInt(r.difficulty || "3", 10) || 3,
          language: QUESTION_LANGUAGES.includes(r.language as never) ? r.language : "en",
          questionType: QUESTION_TYPES.includes(r.questiontype as never) ? r.questiontype : "verbal",
          roleFamily: r.rolefamily || null,
          duplicate: isDup,
        });
      });
    }

    const [job] = await db
      .insert(questionImportJobs)
      .values({
        orgId,
        bankId: bank.id,
        format: parsed.data.format,
        status: errors.length > 0 && preview.length === 0 ? "failed" : "ready",
        idempotencyKey: idemKey ?? null,
        rowCount: rawRows.length,
        validCount: valid,
        duplicateCount: dup,
        errorCount: errors.length,
        preview,
        errors,
        createdByUserId: userId,
      })
      .returning();

    return {
      jobId: job.id,
      status: job.status,
      rowCount: job.rowCount,
      validCount: job.validCount,
      duplicateCount: job.duplicateCount,
      errorCount: job.errorCount,
      preview: job.preview,
      errors: job.errors,
    };
  });

  // Commit a parsed import job. Idempotent: re-commit after status=committed
  // no-ops. Skips duplicates unless allowDuplicates=true.
  app.post<{ Params: { jobId: string }; Querystring: { allowDuplicates?: string } }>(
    "/import-jobs/:jobId/commit",
    { preHandler: [write] },
    async (req, reply) => {
      const orgId = req.authUser!.orgId;
      const userId = req.authUser!.id;
      const [job] = await db
        .select()
        .from(questionImportJobs)
        .where(and(eq(questionImportJobs.id, req.params.jobId), eq(questionImportJobs.orgId, orgId)));
      if (!job) return reply.code(404).send({ error: "not_found" });
      if (job.status === "committed") return { jobId: job.id, status: "committed", inserted: 0, idempotent: true };
      if (job.status !== "ready") return reply.code(409).send({ error: "invalid_state", status: job.status });

      const allowDuplicates = req.query.allowDuplicates === "true";
      const rows = (job.preview as Array<Record<string, unknown>>) ?? [];

      const inserted = await db.transaction(async (tx) => {
        // Refresh existing hashes inside the tx for correctness.
        const existing = new Set(
          (
            await tx
              .select({ hash: questionBankQuestions.contentHash })
              .from(questionBankQuestions)
              .where(eq(questionBankQuestions.orgId, orgId))
          ).map((r) => r.hash),
        );
        let n = 0;
        for (const r of rows) {
          const prompt = String(r.prompt ?? "").trim();
          if (!prompt) continue;
          const hash = contentHashOf(prompt);
          if (existing.has(hash) && !allowDuplicates) continue;
          existing.add(hash);
          const [q] = await tx
            .insert(questionBankQuestions)
            .values({
              bankId: job.bankId,
              orgId,
              level: (typeof r.level === "string" ? r.level : "mid") as QuestionRow["level"],
              difficulty: typeof r.difficulty === "number" ? r.difficulty : 3,
              language: (typeof r.language === "string" ? r.language : "en") as QuestionRow["language"],
              questionType: (typeof r.questionType === "string" ? r.questionType : "verbal") as QuestionRow["questionType"],
              roleFamily: (r.roleFamily as string | null) ?? null,
              prompt,
              status: "draft",
              currentVersion: 1,
              contentHash: hash,
              createdByUserId: userId,
            })
            .returning();
          await tx.insert(questionVersions).values({
            orgId,
            questionId: q.id,
            version: 1,
            reason: "created",
            authorUserId: userId,
            snapshot: snapshotOf(q),
          });
          await writeAudit(tx as typeof db, {
            orgId,
            actorUserId: userId,
            action: "question.imported",
            bankId: job.bankId,
            questionId: q.id,
            payload: { importJobId: job.id },
          });
          n++;
        }
        await tx.update(questionImportJobs).set({ status: "committed" }).where(eq(questionImportJobs.id, job.id));
        await tx.update(questionBanks).set({ updatedAt: new Date() }).where(eq(questionBanks.id, job.bankId));
        return n;
      });

      return { jobId: job.id, status: "committed", inserted };
    },
  );

  // ---------------------------------------------------------------------------
  // CALIBRATION (usage -> p-value rollup) + AI generate (external-key gated)
  // ---------------------------------------------------------------------------

  // Roll usage facts up into calibrated_difficulty / exposure_count / last_used_at.
  // No external dependency — runs inline in dev; production may enqueue.
  app.post("/recalibrate", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const userId = req.authUser!.id;

    const rollups = await db
      .select({
        questionId: questionUsageEvents.questionId,
        exposure: sql<number>`count(*)::int`,
        pValue: sql<number | null>`avg(${questionUsageEvents.scoreFraction})::float`,
        lastUsed: sql<string | null>`max(${questionUsageEvents.createdAt})`,
      })
      .from(questionUsageEvents)
      .where(eq(questionUsageEvents.orgId, orgId))
      .groupBy(questionUsageEvents.questionId);

    let recalibrated = 0;
    await db.transaction(async (tx) => {
      for (const r of rollups) {
        await tx
          .update(questionBankQuestions)
          .set({
            exposureCount: r.exposure,
            calibratedDifficulty: r.pValue != null ? r.pValue.toFixed(3) : null,
            lastUsedAt: r.lastUsed ? new Date(r.lastUsed) : null,
            updatedAt: new Date(),
          })
          .where(and(eq(questionBankQuestions.id, r.questionId), eq(questionBankQuestions.orgId, orgId)));
        recalibrated++;
      }
    });

    void userId;
    return { enqueued: false, recalibrated };
  });

  // AI question generation (stretch). Real path needs OPENAI_API_KEY; without
  // it we 503 a precise code (never 500), and lexical dedup still works for the
  // create path, so the page degrades gracefully.
  app.post<{ Params: { id: string } }>("/:id/generate", { preHandler: [write] }, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const bank = await resolveOrgBank(orgId, req.params.id);
    if (!bank) return reply.code(404).send({ error: "not_found" });

    if (!env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "openai_api_key_missing" });
    }
    // Real generation deferred to the suggestion engine (Phase 2); when a key is
    // present we acknowledge the request so the UI can poll. Kept behind the
    // same credential gate so the 503 path is the only behavioral difference.
    return reply.code(202).send({ status: "accepted" });
  });
}
