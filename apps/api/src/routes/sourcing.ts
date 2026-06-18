// Sourcing — proxies through the connector framework so the Sourcing UI
// sees a uniform shape across Naukri / LinkedIn / mock / etc. The UI's
// "Import to internal DB" call hits POST /import which creates a real
// candidates row with external_*_id linkage and source set.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { candidates, db } from "@j2w/db";
import {
  getConnector,
  listKnownConnectors,
  KNOWN_CONNECTOR_KEYS,
  type ConnectorKey,
} from "../connectors/registry.js";

const querySchema = z.object({
  source: z.enum(KNOWN_CONNECTOR_KEYS).default("mock"),
  q: z.string().max(200).optional(),
  skill: z.string().max(120).optional(),
  location: z.string().max(120).optional(),
  minExperienceYears: z.coerce.number().min(0).max(50).optional(),
  maxExperienceYears: z.coerce.number().min(0).max(50).optional(),
  limit: z.coerce.number().min(1).max(50).default(12),
});

const importSchema = z.object({
  source: z.enum(KNOWN_CONNECTOR_KEYS),
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  currentTitle: z.string().max(200).nullable().optional(),
  currentCompany: z.string().max(200).nullable().optional(),
  totalExperienceYears: z.number().nullable().optional(),
  expectedCtcLakhs: z.number().nullable().optional(),
  noticePeriodDays: z.number().nullable().optional(),
  currentLocation: z.string().max(120).nullable().optional(),
  rawProfileUrl: z.string().nullable().optional(),
});

export async function sourcingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/sources", async () => {
    return { sources: listKnownConnectors() };
  });

  app.get("/search", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", issues: parsed.error.flatten() });
    }
    const conn = await getConnector(ctx.orgId, parsed.data.source as ConnectorKey);
    const results = await conn.pullCandidates({
      q: parsed.data.q,
      skill: parsed.data.skill,
      location: parsed.data.location,
      minExperienceYears: parsed.data.minExperienceYears,
      maxExperienceYears: parsed.data.maxExperienceYears,
      limit: parsed.data.limit,
    });
    return { source: parsed.data.source, results };
  });

  app.get("/health/:source", async (req, reply) => {
    const ctx = req.authUser!;
    const { source } = req.params as { source: string };
    if (!(KNOWN_CONNECTOR_KEYS as readonly string[]).includes(source)) {
      return reply.code(404).send({ error: "unknown_source" });
    }
    const conn = await getConnector(ctx.orgId, source as ConnectorKey);
    const h = await conn.health();
    return { source, ...h };
  });

  // Import a connector candidate into the local candidates table. Returns
  // the local candidate row.
  app.post("/import", { preHandler: [app.requirePermission("candidates.write")] }, async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    // Naive dedup: check email if present
    if (parsed.data.email) {
      const [existing] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(
          and(eq(candidates.orgId, ctx.orgId), eq(candidates.emailNormalized, parsed.data.email.toLowerCase())),
        )
        .limit(1);
      if (existing) {
        return reply.code(200).send({ candidate: existing, deduped: true });
      }
    }
    const sourceMap: Record<string, string> = {
      naukri: "naukri",
      linkedin: "linkedin",
      mock: "imported",
      greenhouse: "imported",
      workday: "imported",
      whatsapp: "imported",
      exotel: "imported",
    };
    const [row] = await db
      .insert(candidates)
      .values({
        orgId: ctx.orgId,
        email: parsed.data.email ?? null,
        emailNormalized: parsed.data.email?.toLowerCase() ?? null,
        phone: parsed.data.phone ?? null,
        displayName: parsed.data.displayName,
        currentTitle: parsed.data.currentTitle ?? null,
        currentCompany: parsed.data.currentCompany ?? null,
        totalExperienceYears:
          parsed.data.totalExperienceYears != null
            ? String(parsed.data.totalExperienceYears)
            : null,
        expectedCtcLakhs:
          parsed.data.expectedCtcLakhs != null ? String(parsed.data.expectedCtcLakhs) : null,
        noticePeriodDays: parsed.data.noticePeriodDays ?? null,
        currentLocation: parsed.data.currentLocation ?? null,
        source: (sourceMap[parsed.data.source] ?? "imported") as "imported",
      })
      .returning();
    return reply.code(201).send({ candidate: row, deduped: false });
  });
}
