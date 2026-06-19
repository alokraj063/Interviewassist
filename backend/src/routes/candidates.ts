// Candidates API (MongoDB) — list / create / résumé parse for Live Assist.
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { collections } from "../mongo.js";
import {
  blobStore,
  parseDocument,
  extractResumeFields,
  ResumeExtractionError,
} from "@j2w/ingest-shared";

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const ALLOWED = [".pdf", ".docx", ".doc", ".txt", ".md"];
function allowedResume(mime: string, filename?: string): boolean {
  const n = (filename ?? "").toLowerCase();
  return ALLOWED.some((e) => n.endsWith(e)) || /pdf|word|text|octet-stream/.test((mime || "").toLowerCase());
}

const createSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(4).max(20).optional(),
  firstName: z.string().min(1).max(120),
  lastName: z.string().max(120).optional(),
  displayName: z.string().max(240).optional(),
  currentTitle: z.string().max(200).optional(),
  currentCompany: z.string().max(200).optional(),
  totalExperienceYears: z.number().min(0).max(50).optional(),
  currentCtcLakhs: z.number().min(0).optional(),
  expectedCtcLakhs: z.number().min(0).optional(),
  noticePeriodDays: z.number().int().min(0).max(365).optional(),
  currentLocation: z.string().max(120).optional(),
  summary: z.string().max(10_000).optional(),
  linkedinUrl: z.string().url().optional(),
  githubUrl: z.string().url().optional(),
  source: z.enum(["naukri", "linkedin", "referral", "direct", "internal_db", "imported", "other"]).default("direct"),
  skillNames: z.array(z.string().min(1)).optional(),
  skillIds: z.array(z.string()).optional(),
  confirmDuplicate: z.boolean().default(false),
  resumeBlobKey: z.string().max(500).optional(),
  parsedResumeJson: z.record(z.unknown()).optional(),
  resumeMeta: z.record(z.unknown()).optional(),
  experiences: z.array(z.record(z.unknown())).optional(),
  qualifications: z.array(z.record(z.unknown())).optional(),
});

async function ingestResume(req: FastifyRequest, reply: FastifyReply) {
  if (!req.isMultipart()) { void reply.code(400).send({ error: "expected_multipart" }); return null; }
  const part = await req.file({ limits: { fileSize: MAX_RESUME_BYTES } });
  if (!part) { void reply.code(400).send({ error: "no_file" }); return null; }
  if (!allowedResume(part.mimetype, part.filename)) {
    void reply.code(415).send({ error: "unsupported_media_type", hint: "Upload a PDF, DOCX, DOC, TXT, or MD." });
    return null;
  }
  let buf: Buffer;
  try { buf = await part.toBuffer(); } catch { void reply.code(413).send({ error: "file_too_large" }); return null; }
  const { key, sha256, bytes } = await blobStore.put(buf);
  const { text, meta } = await parseDocument(buf, part.mimetype, part.filename);
  if (text.trim().length < 50) {
    void reply.code(422).send({ error: "unparseable_resume", blobKey: key });
    return null;
  }
  try {
    const { parsed, modelUsed } = await extractResumeFields(text, req.log);
    return { blobKey: key, sha256, bytes, mime: part.mimetype || "application/octet-stream", filename: part.filename ?? "resume", parsed, modelUsed, parseMeta: meta };
  } catch (err) {
    if (err instanceof ResumeExtractionError && err.code === "openai_not_configured") {
      void reply.code(503).send({ error: "openai_not_configured" }); return null;
    }
    req.log.error({ err: (err as Error).message }, "resume_extract_failed");
    void reply.code(502).send({ error: "extraction_failed" });
    return null;
  }
}

export async function candidatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  const read = app.requirePermission("candidates.read");
  const write = app.requirePermission("candidates.write");

  app.get("/", { preHandler: [read] }, async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    const filter: Record<string, unknown> = { orgId: req.authUser!.orgId };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ displayName: rx }, { firstName: rx }, { lastName: rx }, { email: rx }, { currentTitle: rx }, { currentCompany: rx }];
    }
    const rows = await collections.candidates().find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
    return { candidates: rows };
  });

  app.post("/dedup-check", { preHandler: [read] }, async () => ({ matches: [] }));

  app.post("/parse-resume-preview", { preHandler: [write] }, async (req, reply) => {
    const result = await ingestResume(req, reply);
    if (!result) return;
    return result;
  });

  app.post("/", { preHandler: [write] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    const d = parsed.data;
    const id = randomUUID();
    const displayName = d.displayName ?? `${d.firstName}${d.lastName ? " " + d.lastName : ""}`;
    await collections.candidates().insertOne({
      id, orgId: req.authUser!.orgId,
      firstName: d.firstName, lastName: d.lastName ?? null, displayName,
      email: d.email ?? null, phone: d.phone ?? null,
      currentTitle: d.currentTitle ?? null, currentCompany: d.currentCompany ?? null,
      totalExperienceYears: d.totalExperienceYears != null ? String(d.totalExperienceYears) : null,
      currentCtcLakhs: d.currentCtcLakhs != null ? String(d.currentCtcLakhs) : null,
      expectedCtcLakhs: d.expectedCtcLakhs != null ? String(d.expectedCtcLakhs) : null,
      noticePeriodDays: d.noticePeriodDays ?? null, currentLocation: d.currentLocation ?? null,
      summary: d.summary ?? null, linkedinUrl: d.linkedinUrl ?? null, githubUrl: d.githubUrl ?? null,
      source: d.source, skillNames: d.skillNames ?? [],
      resumeBlobKey: d.resumeBlobKey ?? null, parsedResumeJson: d.parsedResumeJson ?? null,
      experiences: d.experiences ?? [], qualifications: d.qualifications ?? [],
      createdAt: new Date(),
    });
    return reply.code(201).send({ candidateId: id });
  });

  app.get<{ Params: { id: string } }>("/:id", { preHandler: [read] }, async (req, reply) => {
    const row = await collections.candidates().findOne({ id: req.params.id, orgId: req.authUser!.orgId }, { projection: { _id: 0 } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    return row;
  });
}
