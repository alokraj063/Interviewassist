// Question Banks API (MongoDB) — list (JD-linked) / questions / link-demand.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";

export async function questionBanksRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  const read = app.requirePermission("question_banks.read");
  const write = app.requirePermission("question_banks.write");

  // List banks. With ?demandId=, only banks linked to that JD.
  app.get("/", { preHandler: [read] }, async (req) => {
    const orgId = req.authUser!.orgId;
    const demandId = (req.query as { demandId?: string }).demandId;
    let bankIds: string[] | null = null;
    if (demandId) {
      const links = await collections.questionBankDemandLinks().find<{ bankId: string }>({ demandId }).toArray();
      bankIds = links.map((l) => l.bankId);
      if (bankIds.length === 0) return { banks: [], nextCursor: null };
    }
    const filter: Record<string, unknown> = { orgId };
    if (bankIds) filter.id = { $in: bankIds };
    const rows = await collections.questionBanks().find(filter, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(100).toArray();

    const banks = await Promise.all(rows.map(async (b) => {
      const questionCount = await collections.questionBankQuestions().countDocuments({ bankId: b.id, status: { $ne: "archived" } });
      const linkedDemandsCount = await collections.questionBankDemandLinks().countDocuments({ bankId: b.id });
      return {
        id: b.id, name: b.name, description: b.description ?? null, status: b.status ?? "active",
        defaultLanguage: b.defaultLanguage ?? "en", version: b.version ?? 1,
        questionCount, skillsCovered: 0, linkedDemandsCount,
        updatedAt: (b.updatedAt instanceof Date ? b.updatedAt : new Date(b.updatedAt ?? Date.now())).toISOString(),
      };
    }));
    return { banks, nextCursor: null };
  });

  // Questions in a bank.
  app.get<{ Params: { id: string } }>("/:id/questions", { preHandler: [read] }, async (req, reply) => {
    const bank = await collections.questionBanks().findOne({ id: req.params.id, orgId: req.authUser!.orgId });
    if (!bank) return reply.code(404).send({ error: "not_found" });
    const rows = await collections.questionBankQuestions().find({ bankId: req.params.id }, { projection: { _id: 0 } }).limit(200).toArray();
    const questions = rows.map((q) => ({
      id: q.id, bankId: q.bankId, skillId: q.skillId ?? null, level: q.level ?? "mid", difficulty: q.difficulty ?? 3,
      language: q.language ?? "en", questionType: q.questionType ?? "verbal", roleFamily: q.roleFamily ?? null,
      prompt: q.prompt, expectedAnswerHints: q.expectedAnswerHints ?? null,
      followUpQuestions: q.followUpQuestions ?? [], status: q.status ?? "approved",
    }));
    return { questions, nextCursor: null, totalApprox: questions.length };
  });

  // Bank metadata.
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [read] }, async (req, reply) => {
    const bank = await collections.questionBanks().findOne({ id: req.params.id, orgId: req.authUser!.orgId }, { projection: { _id: 0 } });
    if (!bank) return reply.code(404).send({ error: "not_found" });
    const counts = { total: await collections.questionBankQuestions().countDocuments({ bankId: bank.id }) };
    const links = await collections.questionBankDemandLinks().find<{ demandId: string }>({ bankId: bank.id }).toArray();
    return { ...bank, counts, linkedDemandIds: links.map((l) => l.demandId) };
  });

  // Link a bank to a demand.
  app.post<{ Params: { id: string } }>("/:id/link-demand", { preHandler: [write] }, async (req, reply) => {
    const body = z.object({ demandId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_payload" });
    const bank = await collections.questionBanks().findOne({ id: req.params.id, orgId: req.authUser!.orgId });
    if (!bank) return reply.code(404).send({ error: "not_found" });
    await collections.questionBankDemandLinks().updateOne(
      { bankId: bank.id, demandId: body.data.demandId },
      { $setOnInsert: { bankId: bank.id, demandId: body.data.demandId } },
      { upsert: true },
    );
    return { ok: true, bankId: bank.id, demandId: body.data.demandId };
  });
}
