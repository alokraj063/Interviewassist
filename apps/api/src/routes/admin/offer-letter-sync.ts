// Admin → Offer Letter Sync.
//
// Read-only surface that exposes the existing sync state to admins:
//   GET /status      — connection probe via olHealthCheck()
//   GET /heartbeats  — rows from offer_letter_sync_heartbeats for this org
//   GET /mappings    — recent demands + candidates with their external_offer_letter_*_id
//   POST /demands    — enqueue a demand-sync job for this org
//   POST /funnel     — enqueue a funnel-poll job for this org
//
// All endpoints require role=admin and are scoped to req.authUser.orgId.
// Reads do NOT change sync behaviour; the manual-trigger endpoints reuse
// the existing BullMQ queues that the worker already consumes.

import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  candidates,
  db,
  demands,
  offerLetterSyncHeartbeats,
} from "@j2w/db";
import {
  getOfferLetterDemandSyncQueue,
  getOfferLetterFunnelPollQueue,
} from "@j2w/ingest-shared";
import { isOfferLetterConfigured, olHealthCheck } from "@j2w/offer-letter-db";

export async function adminOfferLetterSyncRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Block everyone except admins.
  app.addHook("preHandler", async (req, reply) => {
    if (req.authUser?.role !== "admin") {
      return reply.code(403).send({ error: "admin_required" });
    }
  });

  // GET /status
  app.get("/status", async () => {
    const configured = isOfferLetterConfigured();
    if (!configured) {
      return {
        configured: false,
        reason: "OFFER_LETTER_MYSQL_HOST/USER/PASSWORD not set in API .env",
      };
    }
    let latencyMs: number | null = null;
    let reason: string | undefined;
    try {
      latencyMs = await olHealthCheck();
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    return {
      configured: true,
      host: process.env.OFFER_LETTER_MYSQL_HOST,
      port: Number(process.env.OFFER_LETTER_MYSQL_PORT ?? 3306),
      database: process.env.OFFER_LETTER_MYSQL_DATABASE ?? "offerletter",
      user: process.env.OFFER_LETTER_MYSQL_USER,
      latencyMs,
      lastSuccessfulQuery: latencyMs != null ? new Date().toISOString() : undefined,
      reason,
    };
  });

  // GET /heartbeats — last run per queue for this org.
  app.get("/heartbeats", async (req) => {
    const orgId = req.authUser!.orgId;
    const rows = await db
      .select()
      .from(offerLetterSyncHeartbeats)
      .where(eq(offerLetterSyncHeartbeats.orgId, orgId))
      .orderBy(desc(offerLetterSyncHeartbeats.lastRunAt));
    return {
      heartbeats: rows.map((r) => ({
        id: r.id,
        queueName: r.queueName,
        lastRunAt: r.lastRunAt.toISOString(),
        rowsUpserted: r.rowsUpserted,
        durationMs: r.durationMs,
        lastError: r.lastError,
      })),
    };
  });

  // GET /mappings — top 10 demands + 10 candidates with their external IDs.
  app.get("/mappings", async (req) => {
    const orgId = req.authUser!.orgId;

    const demandRows = await db
      .select({
        id: demands.id,
        title: demands.title,
        externalId: demands.externalOfferLetterDemandId,
        updatedAt: demands.updatedAt,
      })
      .from(demands)
      .where(eq(demands.orgId, orgId))
      .orderBy(desc(demands.updatedAt))
      .limit(10);

    const candidateRows = await db
      .select({
        id: candidates.id,
        firstName: candidates.firstName,
        lastName: candidates.lastName,
        email: candidates.email,
        externalId: candidates.externalOfferLetterUserId,
        updatedAt: candidates.updatedAt,
      })
      .from(candidates)
      .where(eq(candidates.orgId, orgId))
      .orderBy(desc(candidates.updatedAt))
      .limit(10);

    return {
      demands: demandRows.map((d) => ({
        id: d.id,
        label: d.title,
        externalId: d.externalId,
        updatedAt: d.updatedAt.toISOString(),
      })),
      candidates: candidateRows.map((c) => ({
        id: c.id,
        label: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
        externalId: c.externalId,
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  });

  // POST /demands — enqueue a manual demand sync for this org.
  app.post("/demands", async (req, reply) => {
    if (!isOfferLetterConfigured()) {
      return reply.code(503).send({ error: "offer_letter_not_configured" });
    }
    const orgId = req.authUser!.orgId;
    await getOfferLetterDemandSyncQueue().add(
      "manual-trigger",
      { orgId },
      { jobId: `manual-demand-sync-${orgId}-${Date.now()}` },
    );
    return reply.code(202).send({ enqueued: true });
  });

  // POST /funnel — enqueue a manual funnel poll for this org.
  app.post("/funnel", async (req, reply) => {
    if (!isOfferLetterConfigured()) {
      return reply.code(503).send({ error: "offer_letter_not_configured" });
    }
    const orgId = req.authUser!.orgId;
    await getOfferLetterFunnelPollQueue().add(
      "manual-trigger",
      { orgId },
      { jobId: `manual-funnel-poll-${orgId}-${Date.now()}` },
    );
    return reply.code(202).send({ enqueued: true });
  });
}
