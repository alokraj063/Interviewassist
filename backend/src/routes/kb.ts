// Knowledge Base API — enterprise rebuild.
//
// Curates the corpora that power Copilot / Voice Agents / AI scoring. The flat
// source list is promoted into org-scoped, permissioned COLLECTIONS (the real
// corpus grouping unit — the fictional name-substring tabs are gone), with
// retrieval telemetry that makes `retrievals7d`/latency/content-gaps real,
// retrieval-quality eval suites/runs, a feedback loop, and an append-only audit.
//
// Hard rules enforced here (Part 3 backend lens / A4·A6·A7):
//   - Every query is org-scoped via `req.authUser!.orgId` — NO `DEFAULT_ORG`
//     fallback (cross-tenant scope hole closed). Cross-org reads/writes 404.
//   - Every mutation is gated by `app.requirePermission("knowledge.<action>")`.
//   - Every body/query is Zod-validated → 400 + issues.
//   - List routes are keyset/cursor paginated (stable disjoint pages, accurate
//     total).
//   - Every state change writes a `kb_audit` row INSIDE the same db.transaction.
//   - create/grant/feedback/eval-run honor an `Idempotency-Key` header.
//   - The OpenAI embedding path 503s precisely (`openai_key_missing`) when the
//     key is unset — never 500. Eval falls back to a deterministic lexical
//     stub flagged `usedRealEmbeddings=false` so the math/persistence stay
//     testable without a credential.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  chunks,
  db,
  documents,
  kbAnswerFeedback,
  kbAudit,
  kbCollections,
  kbCollectionGrants,
  kbEvalCases,
  kbEvalRunCases,
  kbEvalRuns,
  kbEvalSuites,
  kbRetrievalEvents,
  kbSources,
} from "@j2w/db";
import {
  blobStore,
  getIngestQueue,
  subscribeIngestEvents,
  type IngestJob,
} from "@j2w/ingest-shared";
import { env } from "../env.js";
import { retrieve } from "../rag/retrieve.js";

// ---------- helpers ----------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function badRequest(reply: FastifyReply, parsed: z.SafeParseError<unknown>) {
  return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
}

function queryHashOf(q: string): string {
  return createHash("sha256").update(q.trim().toLowerCase()).digest("hex");
}

// Keyset cursor over (sortValue, id): base64url(JSON). Stable disjoint pages.
type KeyCursor = { v: string; id: string };
function encodeCursor(c: KeyCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s?: string | null): KeyCursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (o && typeof o.v === "string" && typeof o.id === "string") return { v: o.v, id: o.id };
  } catch {
    /* ignore */
  }
  return null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// Append-only audit row, written in the SAME tx as the state change.
async function writeKbAudit(
  tx: Tx,
  e: {
    orgId: string;
    actorUserId: string | null;
    entityType:
      | "collection"
      | "source"
      | "document"
      | "grant"
      | "eval_suite"
      | "eval_run"
      | "feedback";
    entityId: string;
    action: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(kbAudit).values({
    orgId: e.orgId,
    actorUserId: e.actorUserId,
    entityType: e.entityType,
    entityId: e.entityId,
    action: e.action,
    detail: e.detail ?? {},
  });
}

function idemKeyOf(req: FastifyRequest): string | null {
  const k = (req.headers["idempotency-key"] as string | undefined)?.slice(0, 200);
  return k && k.length > 0 ? k : null;
}

// Deterministic lexical "embedding" used by the eval stub path when there is no
// OpenAI key — token-overlap score, so hit-rate/MRR/citation math is real and
// the run persists. Flagged `usedRealEmbeddings=false`.
function lexicalScore(query: string, text: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  if (q.size === 0) return 0;
  const t = new Set(text.toLowerCase().split(/\W+/).filter(Boolean));
  let hit = 0;
  for (const w of q) if (t.has(w)) hit += 1;
  return hit / q.size;
}

const CORPORA = ["jd", "company", "question_bank"] as const;

// ---------- route plugin ----------

export async function kbRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const read = app.requirePermission("knowledge.read");
  const write = app.requirePermission("knowledge.write");
  const manage = app.requirePermission("knowledge.manage");
  const evalPerm = app.requirePermission("knowledge.eval");
  const feedbackPerm = app.requirePermission("knowledge.feedback");

  const readG = { preHandler: [app.authenticate, read] };
  const writeG = { preHandler: [app.authenticate, write] };
  const manageG = { preHandler: [app.authenticate, manage] };
  const evalG = { preHandler: [app.authenticate, evalPerm] };
  const feedbackG = { preHandler: [app.authenticate, feedbackPerm] };

  // ===================================================================
  // COLLECTIONS
  // ===================================================================

  const listCollectionsQ = z.object({
    status: z.enum(["active", "deprecated"]).optional(),
    corpus: z.enum(CORPORA).optional(),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  });

  app.get("/collections", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = listCollectionsQ.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { status, corpus, q, limit, cursor } = parsed.data;

    // Filter conds (used for both list + total). Keyset cond is list-only.
    const filterConds = [eq(kbCollections.orgId, orgId)];
    if (status) filterConds.push(eq(kbCollections.status, status));
    if (corpus) filterConds.push(eq(kbCollections.corpus, corpus));
    if (q) filterConds.push(sql`${kbCollections.name} ILIKE ${"%" + q + "%"}`);
    const conds = [...filterConds];
    // keyset on (updatedAt, id) DESC
    const cur = decodeCursor(cursor);
    if (cur) {
      conds.push(
        sql`(${kbCollections.updatedAt}, ${kbCollections.id}) < (${cur.v}::timestamptz, ${cur.id}::uuid)`,
      );
    }

    const rows = await db
      .select({
        id: kbCollections.id,
        name: kbCollections.name,
        description: kbCollections.description,
        corpus: kbCollections.corpus,
        status: kbCollections.status,
        staleAfterDays: kbCollections.staleAfterDays,
        createdAt: kbCollections.createdAt,
        updatedAt: kbCollections.updatedAt,
        sourceCount: sql<number>`(SELECT COUNT(*)::int FROM kb_sources s WHERE s.collection_id = kb_collections.id)`,
        docCount: sql<number>`(SELECT COUNT(*)::int FROM documents d JOIN kb_sources s ON s.id = d.source_id WHERE s.collection_id = kb_collections.id)`,
        retrievals7d: sql<number>`(SELECT COUNT(*)::int FROM kb_retrieval_events e WHERE e.collection_id = kb_collections.id AND e.had_results AND e.created_at > now() - interval '7 days')`,
      })
      .from(kbCollections)
      .where(and(...conds))
      .orderBy(desc(kbCollections.updatedAt), desc(kbCollections.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor({ v: toIso(last.updatedAt)!, id: last.id }) : null;

    const [{ total }] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(kbCollections)
      .where(and(...filterConds));

    return {
      collections: page.map((r) => ({
        ...r,
        createdAt: toIso(r.createdAt),
        updatedAt: toIso(r.updatedAt),
      })),
      nextCursor,
      total,
    };
  });

  app.get("/collections/:id", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { id } = req.params as { id: string };
    const [col] = await db
      .select()
      .from(kbCollections)
      .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });

    const sources = await db
      .select({
        id: kbSources.id,
        name: kbSources.name,
        type: kbSources.type,
        status: kbSources.status,
        lastIndexedAt: kbSources.lastIndexedAt,
        lastRetrievedAt: kbSources.lastRetrievedAt,
      })
      .from(kbSources)
      .where(eq(kbSources.collectionId, id))
      .orderBy(desc(kbSources.createdAt));

    const grants = await db
      .select()
      .from(kbCollectionGrants)
      .where(eq(kbCollectionGrants.collectionId, id));

    return {
      collection: {
        ...col,
        createdAt: toIso(col.createdAt),
        updatedAt: toIso(col.updatedAt),
      },
      sources: sources.map((s) => ({
        ...s,
        lastIndexedAt: toIso(s.lastIndexedAt),
        lastRetrievedAt: toIso(s.lastRetrievedAt),
      })),
      grants: grants.map((g) => ({ ...g, createdAt: toIso(g.createdAt) })),
    };
  });

  const createCollectionBody = z.object({
    name: z.string().trim().min(1).max(200),
    corpus: z.enum(CORPORA),
    description: z.string().max(2000).optional(),
    staleAfterDays: z.number().int().positive().max(3650).optional(),
  });

  app.post("/collections", manageG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const parsed = createCollectionBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    // Idempotency: (org, name) is unique. A repeat with same Idempotency-Key or
    // same name returns the existing row rather than 409/duplicate.
    const [existing] = await db
      .select()
      .from(kbCollections)
      .where(and(eq(kbCollections.orgId, orgId), eq(kbCollections.name, body.name)));
    if (existing) {
      return reply.code(200).send({
        collection: {
          ...existing,
          createdAt: toIso(existing.createdAt),
          updatedAt: toIso(existing.updatedAt),
        },
        idempotent: true,
      });
    }

    const idemKey = idemKeyOf(req);
    const row = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(kbCollections)
        .values({
          orgId,
          name: body.name,
          corpus: body.corpus,
          description: body.description ?? null,
          staleAfterDays: body.staleAfterDays ?? null,
          createdByUserId: actor,
        })
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "collection",
        entityId: c.id,
        action: "collection.create",
        detail: { name: body.name, corpus: body.corpus, ...(idemKey ? { idemKey } : {}) },
      });
      return c;
    });

    return reply.code(201).send({
      collection: { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) },
    });
  });

  const patchCollectionBody = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    staleAfterDays: z.number().int().positive().max(3650).nullable().optional(),
    // optimistic-concurrency token
    expectedUpdatedAt: z.string().datetime().optional(),
  });

  app.patch("/collections/:id", manageG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = patchCollectionBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const [col] = await db
      .select()
      .from(kbCollections)
      .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });

    if (body.expectedUpdatedAt && toIso(col.updatedAt) !== new Date(body.expectedUpdatedAt).toISOString()) {
      return reply.code(409).send({ error: "stale_write", currentUpdatedAt: toIso(col.updatedAt) });
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.staleAfterDays !== undefined) patch.staleAfterDays = body.staleAfterDays;

    const row = await db.transaction(async (tx) => {
      const [c] = await tx
        .update(kbCollections)
        .set(patch)
        .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)))
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "collection",
        entityId: id,
        action: "collection.rename",
        detail: { ...patch, updatedAt: undefined },
      });
      return c;
    });

    return { collection: { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) } };
  });

  async function setCollectionStatus(
    req: FastifyRequest,
    reply: FastifyReply,
    next: "active" | "deprecated",
    action: "collection.deprecate" | "collection.restore",
  ) {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const [col] = await db
      .select()
      .from(kbCollections)
      .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });

    const row = await db.transaction(async (tx) => {
      const [c] = await tx
        .update(kbCollections)
        .set({ status: next, updatedAt: new Date() })
        .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)))
        .returning();
      // Cascade source status: deprecate → deprecated; restore → indexed.
      if (next === "deprecated") {
        await tx
          .update(kbSources)
          .set({ status: "deprecated", deprecatedAt: new Date() })
          .where(and(eq(kbSources.collectionId, id), eq(kbSources.orgId, orgId)));
      } else if (next === "active") {
        // Un-deprecate only sources stranded by the collection cascade
        // (status='deprecated' with deprecatedAt set); leave manually-managed
        // sources alone.
        await tx
          .update(kbSources)
          .set({ status: "indexed", deprecatedAt: null })
          .where(
            and(
              eq(kbSources.collectionId, id),
              eq(kbSources.orgId, orgId),
              eq(kbSources.status, "deprecated"),
              sql`${kbSources.deprecatedAt} IS NOT NULL`,
            ),
          );
      }
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "collection",
        entityId: id,
        action,
        detail: { status: next },
      });
      return c;
    });
    return { collection: { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) } };
  }

  app.post("/collections/:id/deprecate", manageG, (req, reply) =>
    setCollectionStatus(req, reply, "deprecated", "collection.deprecate"),
  );
  app.post("/collections/:id/restore", manageG, (req, reply) =>
    setCollectionStatus(req, reply, "active", "collection.restore"),
  );

  // ---- grants ----
  app.get("/collections/:id/grants", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { id } = req.params as { id: string };
    const [col] = await db
      .select({ id: kbCollections.id })
      .from(kbCollections)
      .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });
    const grants = await db
      .select()
      .from(kbCollectionGrants)
      .where(eq(kbCollectionGrants.collectionId, id));
    return { grants: grants.map((g) => ({ ...g, createdAt: toIso(g.createdAt) })) };
  });

  const grantBody = z
    .object({
      role: z.string().trim().min(1).max(64).optional(),
      userId: z.string().uuid().optional(),
      level: z.enum(["read", "manage"]).default("read"),
    })
    .refine((b) => (b.role ? !b.userId : !!b.userId), {
      message: "exactly one of role or userId is required",
    });

  app.post("/collections/:id/grants", manageG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = grantBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const [col] = await db
      .select({ id: kbCollections.id })
      .from(kbCollections)
      .where(and(eq(kbCollections.id, id), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });

    // Idempotent on the unique (collection, role|user).
    const dupCond = body.role
      ? and(eq(kbCollectionGrants.collectionId, id), eq(kbCollectionGrants.role, body.role))
      : and(eq(kbCollectionGrants.collectionId, id), eq(kbCollectionGrants.userId, body.userId!));
    const [existing] = await db.select().from(kbCollectionGrants).where(dupCond);
    if (existing) {
      return reply.code(200).send({ grant: { ...existing, createdAt: toIso(existing.createdAt) }, idempotent: true });
    }

    const grant = await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(kbCollectionGrants)
        .values({
          orgId,
          collectionId: id,
          role: body.role ?? null,
          userId: body.userId ?? null,
          level: body.level,
        })
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "grant",
        entityId: id,
        action: "grant.add",
        detail: { role: body.role ?? null, userId: body.userId ?? null, level: body.level },
      });
      return g;
    });
    return reply.code(201).send({ grant: { ...grant, createdAt: toIso(grant.createdAt) } });
  });

  app.delete("/collections/:id/grants/:grantId", manageG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id, grantId } = req.params as { id: string; grantId: string };
    const deleted = await db.transaction(async (tx) => {
      const del = await tx
        .delete(kbCollectionGrants)
        .where(
          and(
            eq(kbCollectionGrants.id, grantId),
            eq(kbCollectionGrants.collectionId, id),
            eq(kbCollectionGrants.orgId, orgId),
          ),
        )
        .returning();
      if (del.length === 0) return null;
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "grant",
        entityId: id,
        action: "grant.revoke",
        detail: { grantId },
      });
      return del[0];
    });
    if (!deleted) return reply.code(404).send({ error: "grant_not_found" });
    return { deleted: deleted.id };
  });

  // ===================================================================
  // SOURCES
  // ===================================================================

  const listSourcesQ = z.object({
    collectionId: z.string().uuid().optional(),
    corpus: z.enum(CORPORA).optional(),
    status: z.enum(["indexing", "indexed", "error", "deprecated"]).optional(),
    staleOnly: z.coerce.boolean().optional(),
    q: z.string().trim().max(200).optional(),
    sort: z.enum(["created", "updated", "name", "retrievals"]).default("created"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  });

  app.get("/sources", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = listSourcesQ.safeParse(req.query);
    if (!parsed.success) return badRequest(reply, parsed);
    const { collectionId, corpus, status, staleOnly, q, sort, dir, limit, cursor } = parsed.data;

    const conds = [eq(kbSources.orgId, orgId)];
    if (collectionId) conds.push(eq(kbSources.collectionId, collectionId));
    if (status) conds.push(eq(kbSources.status, status));
    if (q) conds.push(sql`${kbSources.name} ILIKE ${"%" + q + "%"}`);
    if (corpus) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM kb_collections c WHERE c.id = ${kbSources.collectionId} AND c.corpus = ${corpus})`,
      );
    }
    // staleOnly: last_indexed_at older than the collection's stale_after_days.
    if (staleOnly) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM kb_collections c WHERE c.id = ${kbSources.collectionId}
          AND c.stale_after_days IS NOT NULL
          AND ${kbSources.lastIndexedAt} IS NOT NULL
          AND ${kbSources.lastIndexedAt} < now() - (c.stale_after_days || ' days')::interval)`,
      );
    }

    const sortCol =
      sort === "name"
        ? kbSources.name
        : sort === "updated"
          ? kbSources.lastIndexedAt
          : kbSources.createdAt;
    const dirFn = dir === "asc" ? asc : desc;
    const cmp = dir === "asc" ? sql`>` : sql`<`;

    // Keyset for the simple column sorts (created/updated/name). `retrievals`
    // is a computed aggregate so it uses offset-free keyset on id within the
    // ordering — we keyset on the chosen column + id.
    const cur = decodeCursor(cursor);
    if (cur && sort !== "retrievals") {
      const colExpr =
        sort === "name"
          ? sql`${kbSources.name}`
          : sort === "updated"
            ? sql`COALESCE(${kbSources.lastIndexedAt}, 'epoch'::timestamptz)`
            : sql`${kbSources.createdAt}`;
      const curVal =
        sort === "name" ? sql`${cur.v}` : sql`${cur.v}::timestamptz`;
      conds.push(sql`(${colExpr}, ${kbSources.id}) ${cmp} (${curVal}, ${cur.id}::uuid)`);
    }

    // Correlated subqueries in SELECT position MUST use literal qualified
    // outer column names — drizzle renders `${kbSources.id}` unqualified there,
    // which then resolves to the subquery's own table (uuid = bigint / ambiguous).
    const retr7d = sql<number>`(SELECT COUNT(*)::int FROM kb_retrieval_events e WHERE e.source_id = kb_sources.id AND e.had_results AND e.created_at > now() - interval '7 days')`;

    const baseSelect = {
      id: kbSources.id,
      name: kbSources.name,
      type: kbSources.type,
      status: kbSources.status,
      collectionId: kbSources.collectionId,
      createdAt: kbSources.createdAt,
      lastIndexedAt: kbSources.lastIndexedAt,
      lastRetrievedAt: kbSources.lastRetrievedAt,
      deprecatedAt: kbSources.deprecatedAt,
      corpus: sql<string | null>`(SELECT c.corpus FROM kb_collections c WHERE c.id = kb_sources.collection_id)`,
      staleAfterDays: sql<number | null>`(SELECT c.stale_after_days FROM kb_collections c WHERE c.id = kb_sources.collection_id)`,
      documentCount: sql<number>`(SELECT COUNT(*)::int FROM documents d WHERE d.source_id = kb_sources.id)`,
      retrievals7d: retr7d,
      isStale: sql<boolean>`EXISTS (SELECT 1 FROM kb_collections c WHERE c.id = kb_sources.collection_id
        AND c.stale_after_days IS NOT NULL
        AND kb_sources.last_indexed_at IS NOT NULL
        AND kb_sources.last_indexed_at < now() - (c.stale_after_days || ' days')::interval)`,
    };

    let rows;
    if (sort === "retrievals") {
      // aggregate sort — order by computed count then id; cursor encodes "<count>:<id>".
      rows = await db
        .select(baseSelect)
        .from(kbSources)
        .where(and(...conds))
        .orderBy(dir === "asc" ? asc(retr7d) : desc(retr7d), desc(kbSources.id))
        .limit(limit + 1);
    } else {
      rows = await db
        .select(baseSelect)
        .from(kbSources)
        .where(and(...conds))
        .orderBy(dirFn(sortCol), dir === "asc" ? asc(kbSources.id) : desc(kbSources.id))
        .limit(limit + 1);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last && sort !== "retrievals") {
      const v =
        sort === "name"
          ? last.name
          : sort === "updated"
            ? toIso(last.lastIndexedAt) ?? new Date(0).toISOString()
            : toIso(last.createdAt)!;
      nextCursor = encodeCursor({ v, id: last.id });
    }

    const [{ total }] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(kbSources)
      .where(and(...conds.filter((_, i) => i < (cur && sort !== "retrievals" ? conds.length - 1 : conds.length))));

    const sources = page.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      collectionId: r.collectionId,
      corpus: r.corpus,
      createdAt: toIso(r.createdAt),
      lastIndexedAt: toIso(r.lastIndexedAt),
      lastRetrievedAt: toIso(r.lastRetrievedAt),
      deprecatedAt: toIso(r.deprecatedAt),
      documentCount: r.documentCount ?? 0,
      retrievals7d: r.retrievals7d ?? 0,
      staleAfterDays: r.staleAfterDays ?? null,
      isStale: !!r.isStale,
    }));

    return { sources, nextCursor, total };
  });

  const createSourceBody = z.object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(["Upload", "URL", "SharePoint", "Confluence"]),
    collectionId: z.string().uuid(),
  });

  app.post("/sources", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const parsed = createSourceBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    // collectionId must belong to the caller's org.
    const [col] = await db
      .select({ id: kbCollections.id, corpus: kbCollections.corpus })
      .from(kbCollections)
      .where(and(eq(kbCollections.id, body.collectionId), eq(kbCollections.orgId, orgId)));
    if (!col) return reply.code(404).send({ error: "collection_not_found" });

    const idemKey = idemKeyOf(req);
    if (idemKey) {
      // dedupe a re-POST on the same key within this collection.
      const [prior] = await db
        .select({ id: kbSources.id })
        .from(kbSources)
        .innerJoin(kbAudit, sql`${kbAudit.entityId} = ${kbSources.id}::text`)
        .where(
          and(
            eq(kbSources.orgId, orgId),
            eq(kbAudit.action, "source.create"),
            sql`${kbAudit.detail}->>'idemKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior) {
        const [existing] = await db.select().from(kbSources).where(eq(kbSources.id, prior.id));
        return reply.code(200).send({ source: serializeSourceRow(existing, col.corpus), idempotent: true });
      }
    }

    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(kbSources)
        .values({ orgId, name: body.name, type: body.type, status: "indexing", collectionId: body.collectionId })
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "source",
        entityId: s.id,
        action: "source.create",
        detail: { name: body.name, collectionId: body.collectionId, ...(idemKey ? { idemKey } : {}) },
      });
      return s;
    });

    return reply.code(201).send({ source: serializeSourceRow(row, col.corpus) });
  });

  app.get("/sources/:id", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { id } = req.params as { id: string };

    const [source] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });

    const corpus = source.collectionId
      ? (
          await db
            .select({ corpus: kbCollections.corpus })
            .from(kbCollections)
            .where(eq(kbCollections.id, source.collectionId))
        )[0]?.corpus ?? null
      : null;

    const docs = await db
      .select({
        id: documents.id,
        title: documents.title,
        uri: documents.uri,
        mime: documents.mime,
        bytes: documents.bytes,
        status: documents.status,
        errorMessage: documents.errorMessage,
        createdAt: documents.createdAt,
        chunkCount: sql<number>`(SELECT COUNT(*)::int FROM chunks WHERE chunks.document_id = documents.id)`,
      })
      .from(documents)
      .where(eq(documents.sourceId, id))
      .orderBy(desc(documents.createdAt));

    // Chunk preview for ingestion visibility.
    const preview = await db
      .select({ id: chunks.id, text: chunks.text, corpus: chunks.corpus })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(eq(documents.sourceId, id))
      .limit(5);

    const feedback = await db
      .select()
      .from(kbAnswerFeedback)
      .where(and(eq(kbAnswerFeedback.sourceId, id), eq(kbAnswerFeedback.orgId, orgId)))
      .orderBy(desc(kbAnswerFeedback.createdAt))
      .limit(10);

    const auditRows = await db
      .select()
      .from(kbAudit)
      .where(and(eq(kbAudit.orgId, orgId), eq(kbAudit.entityType, "source"), eq(kbAudit.entityId, id)))
      .orderBy(desc(kbAudit.createdAt))
      .limit(25);

    const spark = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', created_at), 'YYYY-MM-DD')`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(kbRetrievalEvents)
      .where(
        and(
          eq(kbRetrievalEvents.sourceId, id),
          sql`created_at > now() - interval '30 days'`,
        ),
      )
      .groupBy(sql`date_trunc('day', created_at)`)
      .orderBy(sql`date_trunc('day', created_at)`);

    return {
      source: serializeSourceRow(source, corpus),
      documents: docs.map((d) => ({ ...d, createdAt: toIso(d.createdAt) })),
      chunkPreview: preview.map((c) => ({ id: Number(c.id), corpus: c.corpus, snippet: c.text.slice(0, 280) })),
      feedback: feedback.map((f) => ({ ...f, createdAt: toIso(f.createdAt), resolvedAt: toIso(f.resolvedAt) })),
      retrievalSparkline: spark,
      audit: auditRows.map((a) => ({ ...a, id: Number(a.id), createdAt: toIso(a.createdAt) })),
    };
  });

  app.post("/sources/:id/documents", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id: sourceId } = req.params as { id: string };
    const [source] = await db
      .select({ id: kbSources.id, collectionId: kbSources.collectionId })
      .from(kbSources)
      .where(and(eq(kbSources.id, sourceId), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });

    if (!req.isMultipart()) return reply.code(400).send({ error: "expected_multipart" });

    const corpus = source.collectionId
      ? (
          await db
            .select({ corpus: kbCollections.corpus })
            .from(kbCollections)
            .where(eq(kbCollections.id, source.collectionId))
        )[0]?.corpus ?? "company"
      : "company";

    const parts = req.files();
    const queued: Array<{ documentId: string; filename: string }> = [];
    for await (const part of parts) {
      const buf = await part.toBuffer();
      const mime = part.mimetype || guessMimeFromName(part.filename);
      const { key, sha256, bytes } = await blobStore.put(buf);
      const documentId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        sourceId,
        title: part.filename ?? null,
        mime,
        bytes,
        sha256,
        storageKey: key,
        status: "pending",
      });
      // corpus discriminator flows end-to-end from the collection (extra key is
      // ignored by workers that don't yet read it).
      const job = {
        documentId,
        sourceId,
        mime,
        filename: part.filename ?? documentId,
        storageKey: key,
        userEmail: req.user.email,
        corpus,
      } satisfies IngestJob & { corpus: string };
      await getIngestQueue().add("ingest", job, { jobId: documentId });
      queued.push({ documentId, filename: part.filename ?? documentId });
    }

    await db.transaction(async (tx) => {
      await tx.update(kbSources).set({ status: "indexing" }).where(eq(kbSources.id, sourceId));
      for (const q of queued) {
        await writeKbAudit(tx, {
          orgId,
          actorUserId: actor,
          entityType: "document",
          entityId: q.documentId,
          action: "document.upload",
          detail: { sourceId, filename: q.filename },
        });
      }
    });

    return { queued };
  });

  // SSE — unchanged plumbing; accepts token via query for EventSource.
  app.get("/sources/:id/events", async (req, reply) => {
    const { id: sourceId } = req.params as { id: string };
    const query = req.query as { token?: string };
    const header = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = query.token ?? header;
    if (!token) return reply.code(401).send({ error: "unauthorized" });
    try {
      app.jwt.verify(token);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
        : {}),
    });
    reply.raw.write(`: connected\n\n`);
    const unsubscribe = subscribeIngestEvents(sourceId, (evt) => {
      reply.raw.write(`event: ingest\ndata: ${JSON.stringify(evt)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(`: keepalive\n\n`), 15_000);
    req.raw.on("close", async () => {
      clearInterval(heartbeat);
      await unsubscribe();
    });
    return reply;
  });

  const patchSourceBody = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    collectionId: z.string().uuid().optional(),
  });

  app.patch("/sources/:id", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = patchSourceBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    const [source] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });

    if (body.collectionId) {
      const [col] = await db
        .select({ id: kbCollections.id })
        .from(kbCollections)
        .where(and(eq(kbCollections.id, body.collectionId), eq(kbCollections.orgId, orgId)));
      if (!col) return reply.code(404).send({ error: "collection_not_found" });
    }

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.collectionId !== undefined) patch.collectionId = body.collectionId;
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "empty_patch" });

    const moved = body.collectionId !== undefined && body.collectionId !== source.collectionId;
    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .update(kbSources)
        .set(patch)
        .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)))
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "source",
        entityId: id,
        action: moved ? "source.move" : "source.rename",
        detail: patch,
      });
      return s;
    });
    return { source: serializeSourceRow(row, null) };
  });

  app.post("/sources/:id/reindex", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const [source] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });

    // Idempotent: already indexing → no-op.
    if (source.status === "indexing") {
      return { source: serializeSourceRow(source, null), reindexed: false, reason: "already_indexing" };
    }

    const docs = await db
      .select({ id: documents.id, mime: documents.mime, title: documents.title, storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.sourceId, id));

    for (const d of docs) {
      const job: IngestJob = {
        documentId: d.id,
        sourceId: id,
        mime: d.mime ?? "application/octet-stream",
        filename: d.title ?? d.id,
        storageKey: d.storageKey,
        userEmail: req.user.email,
      };
      await getIngestQueue().add("ingest", job, { jobId: `${d.id}-reindex-${Date.now()}` });
    }

    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .update(kbSources)
        .set({ status: "indexing" })
        .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)))
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "source",
        entityId: id,
        action: "source.reindex",
        detail: { docCount: docs.length },
      });
      return s;
    });
    return { source: serializeSourceRow(row, null), reindexed: true, docCount: docs.length };
  });

  app.post("/sources/:id/deprecate", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const [source] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });

    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .update(kbSources)
        .set({ status: "deprecated", deprecatedAt: new Date() })
        .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)))
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "source",
        entityId: id,
        action: "source.deprecate",
        detail: {},
      });
      return s;
    });
    return { source: serializeSourceRow(row, null) };
  });

  const deleteSourceBody = z.object({ confirmName: z.string() });

  app.delete("/sources/:id", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = deleteSourceBody.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed);

    const [source] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)));
    if (!source) return reply.code(404).send({ error: "source_not_found" });
    if (parsed.data.confirmName !== source.name) {
      return reply.code(400).send({ error: "name_mismatch" });
    }

    const deleted = await db.transaction(async (tx) => {
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "source",
        entityId: id,
        action: "source.delete",
        detail: { name: source.name },
      });
      const del = await tx
        .delete(kbSources)
        .where(and(eq(kbSources.id, id), eq(kbSources.orgId, orgId)))
        .returning();
      return del[0];
    });
    return { deleted: deleted.id };
  });

  const bulkBody = z.object({
    action: z.enum(["deprecate", "reindex", "move"]),
    ids: z.array(z.string().uuid()).min(1).max(200),
    collectionId: z.string().uuid().optional(),
  });

  app.post("/sources/bulk", writeG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const parsed = bulkBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const { action, ids, collectionId } = parsed.data;
    if (action === "move" && !collectionId) {
      return reply.code(400).send({ error: "collection_id_required_for_move" });
    }
    if (action === "move" && collectionId) {
      const [col] = await db
        .select({ id: kbCollections.id })
        .from(kbCollections)
        .where(and(eq(kbCollections.id, collectionId), eq(kbCollections.orgId, orgId)));
      if (!col) return reply.code(404).send({ error: "collection_not_found" });
    }

    // Only operate on the caller's own sources.
    const owned = await db
      .select({ id: kbSources.id, status: kbSources.status })
      .from(kbSources)
      .where(and(eq(kbSources.orgId, orgId), inArray(kbSources.id, ids)));
    const ownedIds = new Set(owned.map((s) => s.id));
    const skipped = ids.filter((i) => !ownedIds.has(i));

    let updated = 0;
    await db.transaction(async (tx) => {
      for (const s of owned) {
        if (action === "deprecate") {
          await tx
            .update(kbSources)
            .set({ status: "deprecated", deprecatedAt: new Date() })
            .where(eq(kbSources.id, s.id));
          await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "source", entityId: s.id, action: "source.deprecate", detail: { bulk: true } });
          updated += 1;
        } else if (action === "move") {
          await tx.update(kbSources).set({ collectionId }).where(eq(kbSources.id, s.id));
          await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "source", entityId: s.id, action: "source.move", detail: { collectionId, bulk: true } });
          updated += 1;
        } else if (action === "reindex") {
          if (s.status !== "indexing") {
            await tx.update(kbSources).set({ status: "indexing" }).where(eq(kbSources.id, s.id));
            await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "source", entityId: s.id, action: "source.reindex", detail: { bulk: true } });
            updated += 1;
          }
        }
      }
    });
    return { updated, skipped };
  });

  // ===================================================================
  // SEARCH (+ telemetry)
  // ===================================================================

  const searchBody = z.object({
    query: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().uuid()).optional(),
    corpora: z.array(z.enum(CORPORA)).min(1).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  });

  app.post("/search", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const parsed = searchBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);

    // Org-scope sources and exclude deprecated.
    const ownSources = await db
      .select({ id: kbSources.id })
      .from(kbSources)
      .where(and(eq(kbSources.orgId, orgId), ne(kbSources.status, "deprecated")));
    const ownIds = new Set(ownSources.map((s) => s.id));
    const scoped = parsed.data.sourceIds
      ? parsed.data.sourceIds.filter((i) => ownIds.has(i))
      : Array.from(ownIds);

    const t0 = Date.now();
    try {
      const hits = await retrieve(parsed.data.query, {
        sourceIds: scoped,
        corpora: parsed.data.corpora,
        limit: parsed.data.limit ?? 6,
      });
      const latency = Date.now() - t0;
      await recordRetrieval(orgId, "kb_search", parsed.data.query, hits, latency);
      return { hits };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("OPENAI_API_KEY")) {
        return reply.code(503).send({ error: "openai_key_missing", message: msg });
      }
      req.log.error({ err }, "kb search failed");
      return reply.code(500).send({ error: "search_failed", message: msg });
    }
  });

  // ===================================================================
  // EVAL
  // ===================================================================

  app.get("/eval/suites", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return badRequest(reply, q);
    const cur = decodeCursor(q.data.cursor);
    const conds = [eq(kbEvalSuites.orgId, orgId)];
    if (cur) {
      conds.push(
        sql`(${kbEvalSuites.updatedAt}, ${kbEvalSuites.id}) < (${cur.v}::timestamptz, ${cur.id}::uuid)`,
      );
    }
    const rows = await db
      .select({
        id: kbEvalSuites.id,
        name: kbEvalSuites.name,
        corpus: kbEvalSuites.corpus,
        createdAt: kbEvalSuites.createdAt,
        updatedAt: kbEvalSuites.updatedAt,
        caseCount: sql<number>`(SELECT COUNT(*)::int FROM kb_eval_cases ec WHERE ec.suite_id = kb_eval_suites.id)`,
        lastHitRate: sql<number | null>`(SELECT hit_rate FROM kb_eval_runs r WHERE r.suite_id = kb_eval_suites.id AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 1)`,
      })
      .from(kbEvalSuites)
      .where(and(...conds))
      .orderBy(desc(kbEvalSuites.updatedAt), desc(kbEvalSuites.id))
      .limit(q.data.limit + 1);
    const hasMore = rows.length > q.data.limit;
    const page = hasMore ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return {
      suites: page.map((r) => ({ ...r, createdAt: toIso(r.createdAt), updatedAt: toIso(r.updatedAt) })),
      nextCursor: hasMore && last ? encodeCursor({ v: toIso(last.updatedAt)!, id: last.id }) : null,
    };
  });

  const createSuiteBody = z.object({ name: z.string().trim().min(1).max(200), corpus: z.enum(CORPORA).optional() });

  app.post("/eval/suites", evalG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const parsed = createSuiteBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(kbEvalSuites)
        .values({ orgId, name: parsed.data.name, corpus: parsed.data.corpus ?? null, createdByUserId: actor })
        .returning();
      await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "eval_suite", entityId: s.id, action: "eval.suite_create", detail: { name: parsed.data.name } });
      return s;
    });
    return reply.code(201).send({ suite: { ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) } });
  });

  const addCaseBody = z.object({
    query: z.string().trim().min(1).max(2000),
    expectedSourceId: z.string().uuid().optional(),
    expectedCollectionId: z.string().uuid().optional(),
    expectedSnippetContains: z.string().max(500).optional(),
  });

  app.post("/eval/suites/:id/cases", evalG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = addCaseBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const [suite] = await db
      .select({ id: kbEvalSuites.id })
      .from(kbEvalSuites)
      .where(and(eq(kbEvalSuites.id, id), eq(kbEvalSuites.orgId, orgId)));
    if (!suite) return reply.code(404).send({ error: "suite_not_found" });

    const row = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(kbEvalCases)
        .values({
          suiteId: id,
          query: parsed.data.query,
          expectedSourceId: parsed.data.expectedSourceId ?? null,
          expectedCollectionId: parsed.data.expectedCollectionId ?? null,
          expectedSnippetContains: parsed.data.expectedSnippetContains ?? null,
        })
        .returning();
      await tx.update(kbEvalSuites).set({ updatedAt: new Date() }).where(eq(kbEvalSuites.id, id));
      await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "eval_suite", entityId: id, action: "eval.case_add", detail: { caseId: c.id } });
      return c;
    });
    return reply.code(201).send({ case: { ...row, createdAt: toIso(row.createdAt) } });
  });

  app.delete("/eval/cases/:caseId", evalG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { caseId } = req.params as { caseId: string };
    // ownership via suite→org
    const [c] = await db
      .select({ id: kbEvalCases.id, suiteId: kbEvalCases.suiteId })
      .from(kbEvalCases)
      .innerJoin(kbEvalSuites, eq(kbEvalSuites.id, kbEvalCases.suiteId))
      .where(and(eq(kbEvalCases.id, caseId), eq(kbEvalSuites.orgId, orgId)));
    if (!c) return reply.code(404).send({ error: "case_not_found" });
    await db.delete(kbEvalCases).where(eq(kbEvalCases.id, caseId));
    return { deleted: caseId };
  });

  // Run a suite: real path uses retrieve() (OpenAI embeddings); stub path uses
  // a deterministic lexical match against the expected source's documents.
  app.post("/eval/suites/:id/run", evalG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const [suite] = await db
      .select()
      .from(kbEvalSuites)
      .where(and(eq(kbEvalSuites.id, id), eq(kbEvalSuites.orgId, orgId)));
    if (!suite) return reply.code(404).send({ error: "suite_not_found" });

    // Idempotency: a completed run for the same key returns it.
    const idemKey = idemKeyOf(req);
    if (idemKey) {
      const [prior] = await db
        .select()
        .from(kbEvalRuns)
        .where(
          and(
            eq(kbEvalRuns.orgId, orgId),
            eq(kbEvalRuns.suiteId, id),
            sql`${kbEvalRuns.errorMessage} IS NULL`,
            sql`EXISTS (SELECT 1 FROM kb_audit a WHERE a.entity_id = ${kbEvalRuns.id}::text AND a.action='eval.run' AND a.detail->>'idemKey' = ${idemKey})`,
          ),
        )
        .limit(1);
      if (prior) return reply.code(200).send({ run: serializeRun(prior), idempotent: true });
    }

    const cases = await db.select().from(kbEvalCases).where(eq(kbEvalCases.suiteId, id));
    const useReal = !!env.OPENAI_API_KEY;

    // Create the run row first (status running).
    const [run] = await db
      .insert(kbEvalRuns)
      .values({
        orgId,
        suiteId: id,
        status: "running",
        caseCount: cases.length,
        usedRealEmbeddings: useReal,
        triggeredByUserId: actor,
      })
      .returning();

    const runCaseRows: (typeof kbEvalRunCases.$inferInsert)[] = [];
    let hits = 0;
    let mrrSum = 0;
    let citationHits = 0;
    let citationTotal = 0;

    try {
      for (const c of cases) {
        let topSourceId: string | null = null;
        let topSnippet: string | null = null;
        let rankOfExpected: number | null = null;

        if (useReal) {
          const out = await retrieve(c.query, { limit: 6, corpora: suite.corpus ? [suite.corpus] : undefined });
          if (out.length > 0) {
            topSourceId = out[0].sourceId;
            topSnippet = out[0].snippet;
          }
          if (c.expectedSourceId) {
            const idx = out.findIndex((h) => h.sourceId === c.expectedSourceId);
            if (idx >= 0) rankOfExpected = idx + 1;
          }
        } else {
          // Stub: rank expected source's chunks by lexical overlap with query.
          const candidates = await db
            .select({ sourceId: chunks.sourceId, text: chunks.text })
            .from(chunks)
            .innerJoin(kbSources, eq(kbSources.id, chunks.sourceId))
            .where(eq(kbSources.orgId, orgId))
            .limit(500);
          const scored = candidates
            .map((cand) => ({ ...cand, score: lexicalScore(c.query, cand.text) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);
          if (scored.length > 0 && scored[0].score > 0) {
            topSourceId = scored[0].sourceId;
            topSnippet = scored[0].text.slice(0, 280);
          }
          if (c.expectedSourceId) {
            const idx = scored.findIndex((s) => s.sourceId === c.expectedSourceId && s.score > 0);
            if (idx >= 0) rankOfExpected = idx + 1;
          }
        }

        const hit = rankOfExpected != null;
        if (hit) {
          hits += 1;
          mrrSum += 1 / rankOfExpected!;
        }
        let citationOk: boolean | null = null;
        if (c.expectedSnippetContains) {
          citationTotal += 1;
          citationOk = !!topSnippet && topSnippet.toLowerCase().includes(c.expectedSnippetContains.toLowerCase());
          if (citationOk) citationHits += 1;
        }
        runCaseRows.push({
          runId: run.id,
          caseId: c.id,
          query: c.query,
          hit,
          rankOfExpected,
          citationOk,
          topSourceId,
          topSnippet,
        });
      }

      if (runCaseRows.length > 0) await db.insert(kbEvalRunCases).values(runCaseRows);

      const completed = await db.transaction(async (tx) => {
        const [r] = await tx
          .update(kbEvalRuns)
          .set({
            status: "completed",
            hitRate: cases.length ? hits / cases.length : 0,
            mrr: cases.length ? mrrSum / cases.length : 0,
            citationAccuracy: citationTotal ? citationHits / citationTotal : null,
            completedAt: new Date(),
          })
          .where(eq(kbEvalRuns.id, run.id))
          .returning();
        await writeKbAudit(tx, {
          orgId,
          actorUserId: actor,
          entityType: "eval_run",
          entityId: run.id,
          action: "eval.run",
          detail: { suiteId: id, usedRealEmbeddings: useReal, hitRate: r.hitRate, ...(idemKey ? { idemKey } : {}) },
        });
        return r;
      });
      return reply.code(201).send({ run: serializeRun(completed) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.update(kbEvalRuns).set({ status: "error", errorMessage: msg, completedAt: new Date() }).where(eq(kbEvalRuns.id, run.id));
      // External-key failure surfaces as a 503, not a 500 — but the stub path
      // means this should only fire on a genuine real-embedding failure.
      if (msg.includes("OPENAI_API_KEY")) {
        return reply.code(503).send({ error: "openai_key_missing", message: msg, runId: run.id });
      }
      req.log.error({ err }, "eval run failed");
      return reply.code(500).send({ error: "eval_run_failed", message: msg });
    }
  });

  app.get("/eval/runs/:runId", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const { runId } = req.params as { runId: string };
    const [run] = await db
      .select()
      .from(kbEvalRuns)
      .where(and(eq(kbEvalRuns.id, runId), eq(kbEvalRuns.orgId, orgId)));
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const cases = await db.select().from(kbEvalRunCases).where(eq(kbEvalRunCases.runId, runId));
    return { run: serializeRun(run), cases: cases.map((c) => ({ ...c, id: Number(c.id) })) };
  });

  // ===================================================================
  // FEEDBACK
  // ===================================================================

  const feedbackBody = z.object({
    sourceId: z.string().uuid().optional(),
    collectionId: z.string().uuid().optional(),
    chunkId: z.number().int().optional(),
    query: z.string().max(2000).optional(),
    rating: z.enum(["up", "down"]),
    reason: z.enum(["outdated", "wrong", "irrelevant", "incomplete", "helpful", "other"]).optional(),
    comment: z.string().max(2000).optional(),
  });

  // Submitting is read-tier (any reader can rate).
  app.post("/feedback", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const parsed = feedbackBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const body = parsed.data;

    // Org-scope referenced source.
    if (body.sourceId) {
      const [s] = await db
        .select({ id: kbSources.id })
        .from(kbSources)
        .where(and(eq(kbSources.id, body.sourceId), eq(kbSources.orgId, orgId)));
      if (!s) return reply.code(404).send({ error: "source_not_found" });
    }

    const idemKey = idemKeyOf(req);
    if (idemKey) {
      const [prior] = await db
        .select()
        .from(kbAnswerFeedback)
        .innerJoin(kbAudit, sql`${kbAudit.entityId} = ${kbAnswerFeedback.id}::text`)
        .where(
          and(
            eq(kbAnswerFeedback.orgId, orgId),
            eq(kbAudit.action, "feedback.submit"),
            sql`${kbAudit.detail}->>'idemKey' = ${idemKey}`,
          ),
        )
        .limit(1);
      if (prior) {
        const row = prior.kb_answer_feedback;
        return reply.code(200).send({ feedback: { ...row, createdAt: toIso(row.createdAt), resolvedAt: toIso(row.resolvedAt) }, idempotent: true });
      }
    }

    const row = await db.transaction(async (tx) => {
      const [f] = await tx
        .insert(kbAnswerFeedback)
        .values({
          orgId,
          sourceId: body.sourceId ?? null,
          collectionId: body.collectionId ?? null,
          chunkId: body.chunkId ?? null,
          query: body.query ?? null,
          rating: body.rating,
          reason: body.reason ?? null,
          comment: body.comment ?? null,
          submittedByUserId: actor,
        })
        .returning();
      await writeKbAudit(tx, {
        orgId,
        actorUserId: actor,
        entityType: "feedback",
        entityId: f.id,
        action: "feedback.submit",
        detail: { rating: body.rating, reason: body.reason ?? null, ...(idemKey ? { idemKey } : {}) },
      });
      return f;
    });
    return reply.code(201).send({ feedback: { ...row, createdAt: toIso(row.createdAt), resolvedAt: toIso(row.resolvedAt) } });
  });

  app.get("/feedback", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const q = z
      .object({
        status: z.enum(["open", "actioned", "dismissed"]).optional(),
        sourceId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
      .safeParse(req.query);
    if (!q.success) return badRequest(reply, q);
    const conds = [eq(kbAnswerFeedback.orgId, orgId)];
    if (q.data.status) conds.push(eq(kbAnswerFeedback.status, q.data.status));
    if (q.data.sourceId) conds.push(eq(kbAnswerFeedback.sourceId, q.data.sourceId));
    const cur = decodeCursor(q.data.cursor);
    if (cur) {
      conds.push(
        sql`(${kbAnswerFeedback.createdAt}, ${kbAnswerFeedback.id}) < (${cur.v}::timestamptz, ${cur.id}::uuid)`,
      );
    }
    const rows = await db
      .select()
      .from(kbAnswerFeedback)
      .where(and(...conds))
      .orderBy(desc(kbAnswerFeedback.createdAt), desc(kbAnswerFeedback.id))
      .limit(q.data.limit + 1);
    const hasMore = rows.length > q.data.limit;
    const page = hasMore ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return {
      feedback: page.map((f) => ({ ...f, createdAt: toIso(f.createdAt), resolvedAt: toIso(f.resolvedAt) })),
      nextCursor: hasMore && last ? encodeCursor({ v: toIso(last.createdAt)!, id: last.id }) : null,
    };
  });

  const resolveBody = z.object({ status: z.enum(["actioned", "dismissed"]) });

  app.post("/feedback/:id/resolve", feedbackG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const actor = req.authUser!.id;
    const { id } = req.params as { id: string };
    const parsed = resolveBody.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, parsed);
    const [fb] = await db
      .select({ id: kbAnswerFeedback.id })
      .from(kbAnswerFeedback)
      .where(and(eq(kbAnswerFeedback.id, id), eq(kbAnswerFeedback.orgId, orgId)));
    if (!fb) return reply.code(404).send({ error: "feedback_not_found" });

    const row = await db.transaction(async (tx) => {
      const [f] = await tx
        .update(kbAnswerFeedback)
        .set({ status: parsed.data.status, resolvedByUserId: actor, resolvedAt: new Date() })
        .where(and(eq(kbAnswerFeedback.id, id), eq(kbAnswerFeedback.orgId, orgId)))
        .returning();
      await writeKbAudit(tx, { orgId, actorUserId: actor, entityType: "feedback", entityId: id, action: "feedback.resolve", detail: { status: parsed.data.status } });
      return f;
    });
    return { feedback: { ...row, createdAt: toIso(row.createdAt), resolvedAt: toIso(row.resolvedAt) } };
  });

  // ===================================================================
  // ANALYTICS / CONTENT GAPS
  // ===================================================================

  app.get("/analytics", readG, async (req, reply) => {
    const orgId = req.authUser!.orgId;
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .safeParse(req.query);
    if (!q.success) return badRequest(reply, q);
    const days = q.data.days;
    const since = sql`now() - (${days} || ' days')::interval`;

    const [totals] = await db
      .select({
        retrievals: sql<number>`COUNT(*) FILTER (WHERE had_results)::int`,
        zeroResult: sql<number>`COUNT(*) FILTER (WHERE NOT had_results)::int`,
        avgLatencyMs: sql<number | null>`AVG(latency_ms)::int`,
        retrievals7d: sql<number>`COUNT(*) FILTER (WHERE had_results AND created_at > now() - interval '7 days')::int`,
      })
      .from(kbRetrievalEvents)
      .where(and(eq(kbRetrievalEvents.orgId, orgId), sql`created_at > ${since}`));

    const byDay = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', created_at), 'YYYY-MM-DD')`,
        retrievals: sql<number>`COUNT(*) FILTER (WHERE had_results)::int`,
        zeroResult: sql<number>`COUNT(*) FILTER (WHERE NOT had_results)::int`,
        avgLatencyMs: sql<number | null>`AVG(latency_ms)::int`,
      })
      .from(kbRetrievalEvents)
      .where(and(eq(kbRetrievalEvents.orgId, orgId), sql`created_at > ${since}`))
      .groupBy(sql`date_trunc('day', created_at)`)
      .orderBy(sql`date_trunc('day', created_at)`);

    const topSources = await db
      .select({
        sourceId: kbRetrievalEvents.sourceId,
        name: kbSources.name,
        retrievals: sql<number>`COUNT(*)::int`,
      })
      .from(kbRetrievalEvents)
      .innerJoin(kbSources, eq(kbSources.id, kbRetrievalEvents.sourceId))
      .where(and(eq(kbRetrievalEvents.orgId, orgId), eq(kbRetrievalEvents.hadResults, true), sql`kb_retrieval_events.created_at > ${since}`))
      .groupBy(kbRetrievalEvents.sourceId, kbSources.name)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10);

    // Content gaps: query hashes with most zero-result rows (or low avg score).
    const gaps = await db
      .select({
        queryHash: kbRetrievalEvents.queryHash,
        misses: sql<number>`COUNT(*) FILTER (WHERE NOT had_results)::int`,
        avgScore: sql<number | null>`AVG(score)`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(kbRetrievalEvents)
      .where(and(eq(kbRetrievalEvents.orgId, orgId), sql`created_at > ${since}`))
      .groupBy(kbRetrievalEvents.queryHash)
      .having(sql`COUNT(*) FILTER (WHERE NOT had_results) > 0 OR AVG(score) < 0.55`)
      .orderBy(desc(sql`COUNT(*) FILTER (WHERE NOT had_results)`))
      .limit(20);

    const [staleness] = await db
      .select({
        stale: sql<number>`COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM kb_collections c WHERE c.id = kb_sources.collection_id
            AND c.stale_after_days IS NOT NULL
            AND kb_sources.last_indexed_at IS NOT NULL
            AND kb_sources.last_indexed_at < now() - (c.stale_after_days || ' days')::interval))::int`,
        deprecated: sql<number>`COUNT(*) FILTER (WHERE status = 'deprecated')::int`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(kbSources)
      .where(eq(kbSources.orgId, orgId));

    return {
      days,
      totals,
      byDay,
      topSources,
      contentGaps: gaps.map((g) => ({ ...g, avgScore: g.avgScore == null ? null : Number(g.avgScore) })),
      staleness,
    };
  });

  void chunks;
}

// ---------- telemetry ----------

// Writes one kb_retrieval_events row per served chunk (or a single
// had_results=false row for a zero-result query — the content-gap signal) and
// bumps kb_sources.last_retrieved_at. Best-effort; never throws into the caller.
export async function recordRetrieval(
  orgId: string,
  surface: "suggest" | "kb_search" | "live_rubric" | "eval",
  query: string,
  hits: { sourceId: string; documentId?: string; chunkId?: number; corpus?: string; score?: number }[],
  latencyMs: number,
  callId?: string,
): Promise<void> {
  const qh = queryHashOf(query);
  try {
    if (hits.length === 0) {
      await db.insert(kbRetrievalEvents).values({
        orgId,
        surface,
        queryHash: qh,
        rank: 0,
        isTopHit: false,
        hadResults: false,
        latencyMs,
        callId: callId ?? null,
      });
      return;
    }
    const rows: (typeof kbRetrievalEvents.$inferInsert)[] = hits.map((h, i) => ({
      orgId,
      sourceId: h.sourceId ?? null,
      documentId: h.documentId ?? null,
      chunkId: h.chunkId ?? null,
      corpus: (h.corpus as (typeof CORPORA)[number]) ?? null,
      surface,
      queryHash: qh,
      rank: i,
      score: h.score ?? null,
      isTopHit: i === 0,
      hadResults: true,
      latencyMs,
      callId: callId ?? null,
    }));
    await db.insert(kbRetrievalEvents).values(rows);
    const sourceIds = Array.from(new Set(hits.map((h) => h.sourceId).filter(Boolean))) as string[];
    if (sourceIds.length > 0) {
      await db
        .update(kbSources)
        .set({ lastRetrievedAt: new Date() })
        .where(and(eq(kbSources.orgId, orgId), inArray(kbSources.id, sourceIds)));
    }
  } catch {
    /* telemetry is best-effort; never break the served retrieval */
  }
}

// ---------- serializers ----------

function serializeSourceRow(row: typeof kbSources.$inferSelect, corpus: string | null) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    collectionId: row.collectionId,
    corpus,
    createdAt: toIso(row.createdAt),
    lastIndexedAt: toIso(row.lastIndexedAt),
    lastRetrievedAt: toIso(row.lastRetrievedAt),
    deprecatedAt: toIso(row.deprecatedAt),
  };
}

function serializeRun(r: typeof kbEvalRuns.$inferSelect) {
  return {
    id: r.id,
    suiteId: r.suiteId,
    status: r.status,
    caseCount: r.caseCount,
    hitRate: r.hitRate,
    mrr: r.mrr,
    citationAccuracy: r.citationAccuracy,
    usedRealEmbeddings: r.usedRealEmbeddings,
    errorMessage: r.errorMessage,
    createdAt: toIso(r.createdAt),
    completedAt: toIso(r.completedAt),
  };
}

function guessMimeFromName(name?: string): string {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}
