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
import { ObjectId } from "mongodb";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  blobStore,
  parseDocument,
  extractResumeFields,
  ResumeExtractionError,
} from "@j2w/ingest-shared";
import { collections } from "../mongo.js";
import { env } from "../env.js";

// ── OfferLetter résumé fetch (S3) ────────────────────────────────────────────
// OL stores candidate documents at
//   <prefix>candidate_documents/<uid>/resume/<file>
// where <uid> is the candidate's short uid OR their Mongo _id hex, and the
// stored filename doesn't match Mongo's docuemntPath. So we LIST the résumé
// folder (trying each id form) and fetch the newest object — robust to the
// filename mismatch. Bucket defaults to the shared AWS_BUCKET_NAME.
let _olS3: S3Client | null = null;
function olS3(): S3Client | null {
  const accessKeyId = env.AWS_S3_ACCESS_KEY;
  const secretAccessKey = env.AWS_S3_SECRET_KEY;
  const region = env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) return null;
  if (!_olS3) _olS3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  return _olS3;
}
async function fetchOlResume(idForms: string[]): Promise<{ buf: Buffer; filename: string } | null> {
  const bucket = env.OFFER_LETTER_S3_BUCKET || env.AWS_BUCKET_NAME;
  const client = olS3();
  if (!bucket || !client) return null;
  const prefix = (env.OFFER_LETTER_S3_PREFIX || "").replace(/^\/+/, "");
  for (const id of idForms) {
    if (!id) continue;
    const folder = `${prefix}candidate_documents/${id}/resume/`;
    let listed;
    try { listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: folder, MaxKeys: 25 })); }
    catch { continue; }
    const objs = (listed.Contents ?? []).filter((o) => o.Key && (o.Size ?? 0) > 0);
    if (objs.length === 0) continue;
    objs.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
    const key = objs[0].Key as string;
    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) continue;
    return { buf: Buffer.from(await body.transformToByteArray()), filename: key.split("/").pop() || "resume" };
  }
  return null;
}

function mimeForExt(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "doc") return "application/msword";
  if (ext === "txt" || ext === "md") return "text/plain";
  return "application/octet-stream";
}

interface OlCandUser {
  _id: ObjectId;
  uid?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
}
function candidateName(u: { firstName?: string; middleName?: string; lastName?: string; email?: string }): string {
  return [u.firstName, u.middleName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Candidate";
}

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

  // Search the WHOLE OfferLetter candidate pool (type = UserCandidate) by
  // name / email. Anchored-prefix regex rides the existing
  // {type, firstName, lastName} + {email} indexes, so it stays fast at 1.4M.
  // Returns lightweight rows; the résumé is fetched later on select.
  app.get("/search", async (req) => {
    const q = String((req.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { candidates: [] };
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const limit = Math.min(30, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 15));
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchored = new RegExp("^" + esc, "i");

    const users = await collections.olUsers()
      .find<OlCandUser>(
        { type: "UserCandidate", $or: [{ firstName: anchored }, { lastName: anchored }, { email: anchored }] },
        { projection: { firstName: 1, middleName: 1, lastName: 1, email: 1 } },
      )
      .limit(limit)
      .toArray();
    if (users.length === 0) return { candidates: [] };

    const ids = users.map((u) => u._id as ObjectId);
    const [profiles, resumeDocs] = await Promise.all([
      collections.olCandidateProfiles()
        .find({ userId: { $in: ids } }, { projection: { userId: 1, designation: 1, employer: 1, totalExperience: 1, currentLocation: 1 } })
        .toArray(),
      collections.olCandidateDocuments()
        .find({ userId: { $in: ids }, documentType: "resume" }, { projection: { userId: 1 } })
        .toArray(),
    ]);
    const profByUser = new Map(profiles.map((p) => [String(p.userId), p]));
    const withResume = new Set(resumeDocs.map((d) => String(d.userId)));

    const candidates = users.map((u) => {
      const p = (profByUser.get(String(u._id)) ?? {}) as {
        designation?: string; employer?: string; totalExperience?: number; currentLocation?: string;
      };
      return {
        userId: String(u._id),
        name: candidateName(u),
        email: (u.email as string) ?? null,
        currentTitle: p.designation ?? null,
        currentCompany: p.employer ?? null,
        totalExperienceYears: typeof p.totalExperience === "number" ? p.totalExperience : null,
        currentLocation: p.currentLocation ?? null,
        hasResume: withResume.has(String(u._id)),
      };
    });
    return { candidates };
  });

  // Resolve an OfferLetter candidate into the inline-candidate shape used by
  // POST /api/calls: fetch their latest résumé from OL's S3, parse it, and
  // stash it in our blob store so the report can merge the original file.
  // Falls back to the OL profile fields when the file can't be fetched/parsed.
  app.post("/from-offer-letter", async (req, reply) => {
    const userId = String(((req.body ?? {}) as { userId?: string }).userId ?? "").trim();
    let oid: ObjectId;
    try { oid = new ObjectId(userId); } catch { return reply.code(400).send({ error: "invalid_user_id" }); }

    const user = await collections.olUsers().findOne<OlCandUser>(
      { _id: oid, type: "UserCandidate" },
      { projection: { uid: 1, firstName: 1, middleName: 1, lastName: 1, email: 1 } },
    );
    if (!user) return reply.code(404).send({ error: "candidate_not_found" });

    const profile = await collections.olCandidateProfiles().findOne<{
      designation?: string; employer?: string; totalExperience?: number; currentLocation?: string;
    }>({ userId: oid }, { projection: { designation: 1, employer: 1, totalExperience: 1, currentLocation: 1 } });

    let parsed: Record<string, unknown> = {};
    let blobKey: string | null = null;
    let filename: string | null = null;
    let mime: string | null = null;

    // Fetch the résumé from OL's S3 by listing candidate_documents/<id>/resume/
    // (try the short uid first, then the _id hex).
    try {
      const found = await fetchOlResume([user.uid ?? "", String(user._id)]);
      if (found?.buf?.length) {
        filename = found.filename;
        mime = mimeForExt(filename);
        blobKey = (await blobStore.put(found.buf)).key;
        const { text } = await parseDocument(found.buf, mime, filename);
        if (text.trim().length >= 50) {
          const { parsed: p } = await extractResumeFields(text, req.log);
          parsed = p as unknown as Record<string, unknown>;
        }
      }
    } catch (err) {
      if (err instanceof ResumeExtractionError && err.code === "openai_not_configured") {
        return reply.code(503).send({ error: "openai_not_configured" });
      }
      req.log.warn({ err: (err as Error).message, userId }, "ol_resume_fetch_or_parse_failed");
    }

    return {
      userId: String(user._id),
      name: candidateName(user),
      email: (user.email as string) ?? null,
      currentTitle: (parsed.currentTitle as string) ?? profile?.designation ?? null,
      currentCompany: (parsed.currentCompany as string) ?? profile?.employer ?? null,
      totalExperienceYears: typeof profile?.totalExperience === "number" ? profile.totalExperience : null,
      currentLocation: (parsed.currentLocation as string) ?? profile?.currentLocation ?? null,
      parsed,
      blobKey,
      filename,
      mime,
    };
  });

  // Explicitly closed endpoints — anything that used to write a candidate
  // row. Returns 410 Gone so the old UI surfaces a precise error.
  app.post("/",         async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed", hint: "Use /api/calls with an inline candidate payload." }));
  app.get("/:id",       async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.patch("/:id",     async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.post("/:id/resume", async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
  app.get("/:id/resumes/:rid/file", async (_req, reply) => reply.code(410).send({ error: "candidate_persistence_removed" }));
}
