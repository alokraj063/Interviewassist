// Candidates for Interview Assist.
//
// Candidates here are EPHEMERAL. The recruiter uploads a résumé at the start
// of the interview, we parse it inline, and the structured data is handed
// back to the caller — nothing is persisted to a `candidates` collection.
// The candidate's identity for the duration of the call lives inline on the
// `ia_callSessions` document (see routes/calls.ts), alongside the parsed
// résumé blob. After the call ends we keep the call session + transcript +
// AI verdict; we do NOT keep an addressable candidate row.
//
// This route therefore exposes only the resume parser. Old endpoints —
// list / create / get / patch — return 410 with a clear message so any
// stale client gets a deterministic error instead of an empty payload.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  blobStore,
  parseDocument,
  extractResumeFields,
  ResumeExtractionError,
} from "@j2w/ingest-shared";

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = [".pdf", ".docx", ".doc", ".txt", ".md"];

function allowedResume(mime: string, filename?: string): boolean {
  const name = (filename ?? "").toLowerCase();
  if (ALLOWED_EXT.some((e) => name.endsWith(e))) return true;
  return /pdf|word|text|octet-stream/.test((mime || "").toLowerCase());
}

async function ingestResume(req: FastifyRequest, reply: FastifyReply) {
  if (!req.isMultipart()) { void reply.code(400).send({ error: "expected_multipart" }); return null; }
  const part = await req.file({ limits: { fileSize: MAX_RESUME_BYTES } });
  if (!part) { void reply.code(400).send({ error: "no_file" }); return null; }
  if (!allowedResume(part.mimetype, part.filename)) {
    void reply.code(415).send({
      error: "unsupported_media_type",
      hint: "Upload a PDF, DOCX, DOC, TXT, or MD.",
    });
    return null;
  }
  let buf: Buffer;
  try { buf = await part.toBuffer(); }
  catch { void reply.code(413).send({ error: "file_too_large" }); return null; }

  // Resume blob is stashed only so the call session can refer back to it if
  // we want to display the original file in the post-call view. It's NOT a
  // candidate record.
  const { key, sha256, bytes } = await blobStore.put(buf);
  const { text, meta } = await parseDocument(buf, part.mimetype, part.filename);
  if (text.trim().length < 50) {
    void reply.code(422).send({ error: "unparseable_resume", blobKey: key });
    return null;
  }
  try {
    const { parsed, modelUsed } = await extractResumeFields(text, req.log);
    return {
      blobKey: key, sha256, bytes,
      mime: part.mimetype || "application/octet-stream",
      filename: part.filename ?? "resume",
      parsed, modelUsed, parseMeta: meta,
    };
  } catch (err) {
    if (err instanceof ResumeExtractionError && err.code === "openai_not_configured") {
      void reply.code(503).send({ error: "openai_not_configured" });
      return null;
    }
    req.log.error({ err: (err as Error).message }, "resume_extract_failed");
    void reply.code(502).send({ error: "extraction_failed" });
    return null;
  }
}

export async function candidatesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // GET /api/candidates — returns an empty list. Old clients should stop
  // calling this; the picker in the Interview Assist UI now uses the
  // resume-upload path instead. We return [] (not 410) so the legacy hook
  // doesn't surface a scary error toast in the meantime.
  app.get("/", async () => ({ candidates: [] }));

  // Dedup is moot for ephemeral candidates.
  app.post("/dedup-check", async () => ({ matches: [] }));

  // Parse a résumé without persisting. Caller passes the returned `parsed`
  // blob along when starting the call (POST /api/calls) so the call session
  // carries the candidate identity inline.
  app.post("/parse-resume-preview", async (req, reply) => {
    const result = await ingestResume(req, reply);
    if (!result) return;
    return result;
  });

  // Explicitly closed endpoints — anything that used to write a candidate
  // row. Returns 410 Gone so the old UI surfaces a precise error.
  app.post("/",         async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed", hint: "Use /api/calls with an inline candidate payload." }));
  app.get("/:id",       async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.patch("/:id",     async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.post("/:id/resume", async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.get("/:id/resumes/:rid/file", async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
}
