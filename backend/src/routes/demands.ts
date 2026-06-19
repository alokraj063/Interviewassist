// Demands (JD) API (MongoDB) — list / create / JD parse / prospects for Live Assist.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import { parseDocument } from "@j2w/ingest-shared";

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
  primaryLocation: z.string().max(120).optional(),
  status: z.enum(["draft", "active", "on_hold", "closed", "cancelled"]).default("active"),
  isVip: z.boolean().default(false),
});

async function clientNameMap(orgId: string): Promise<Map<string, string>> {
  const rows = await collections.clients().find<{ id: string; companyName: string }>({ orgId }).toArray();
  return new Map(rows.map((r) => [r.id, r.companyName]));
}

export async function demandsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  const read = app.requirePermission("demands.read");
  const write = app.requirePermission("demands.write");

  app.get("/", { preHandler: [read] }, async (req) => {
    const orgId = req.authUser!.orgId;
    const rows = await collections.demands().find({ orgId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(500).toArray();
    const clients = await clientNameMap(orgId);
    const demands = rows.map((d) => ({
      id: d.id, title: d.title ?? null, designation: d.designation ?? null, status: d.status ?? "active",
      isVip: !!d.isVip, primaryLocation: d.primaryLocation ?? null,
      salaryFrom: d.salaryFrom ?? null, salaryTo: d.salaryTo ?? null,
      experienceMinYears: d.experienceMinYears ?? null, experienceMaxYears: d.experienceMaxYears ?? null,
      numberOfOpenings: d.numberOfOpenings ?? 1, maxSubmissions: d.maxSubmissions ?? null,
      expectedClosureDate: d.expectedClosureDate ?? null,
      clientId: d.clientId ?? null, clientName: d.clientId ? clients.get(d.clientId) ?? null : null,
    }));
    return { demands };
  });

  app.post("/", { preHandler: [write] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const d = parsed.data;
    const client = await collections.clients().findOne({ id: d.clientId, orgId: req.authUser!.orgId });
    if (!client) return reply.code(400).send({ error: "client_not_found" });
    const id = randomUUID();
    const now = new Date();
    await collections.demands().insertOne({
      id, orgId: req.authUser!.orgId, clientId: d.clientId, title: d.title,
      designation: d.designation ?? d.title, description: d.description ?? null,
      responsibilities: d.responsibilities ?? null,
      experienceMinYears: d.experienceMinYears != null ? String(d.experienceMinYears) : null,
      experienceMaxYears: d.experienceMaxYears != null ? String(d.experienceMaxYears) : null,
      salaryFrom: d.salaryFrom != null ? String(d.salaryFrom) : null,
      salaryTo: d.salaryTo != null ? String(d.salaryTo) : null,
      primaryLocation: d.primaryLocation ?? null, status: d.status, isVip: d.isVip,
      numberOfOpenings: 1, probingDetails: {}, createdAt: now, updatedAt: now,
    });
    return { demandId: id };
  });

  // JD file → text.
  app.post("/parse-jd", { preHandler: [write] }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "expected_multipart" });
    const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!part) return reply.code(400).send({ error: "no_file" });
    let buf: Buffer;
    try { buf = await part.toBuffer(); } catch { return reply.code(413).send({ error: "file_too_large" }); }
    try {
      const { text } = await parseDocument(buf, part.mimetype, part.filename);
      if (text.trim().length < 20) return reply.code(422).send({ error: "unparseable_jd" });
      return { ok: true, text: text.trim().slice(0, 20_000), filename: part.filename ?? "jd" };
    } catch (err) {
      req.log.error({ err: (err as Error).message }, "parse_jd_failed");
      return reply.code(502).send({ error: "parse_failed" });
    }
  });

  app.get<{ Params: { id: string } }>("/:id", { preHandler: [read] }, async (req, reply) => {
    const d = await collections.demands().findOne({ id: req.params.id, orgId: req.authUser!.orgId }, { projection: { _id: 0 } });
    if (!d) return reply.code(404).send({ error: "not_found" });
    return d;
  });

  app.get<{ Params: { id: string } }>("/:id/prospects", { preHandler: [read] }, async (req) => {
    const rows = await collections.prospects().find({ demandId: req.params.id, orgId: req.authUser!.orgId }, { projection: { _id: 0 } }).toArray();
    return { prospects: rows };
  });
}
