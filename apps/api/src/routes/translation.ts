import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  db,
  translationGlossaries,
  translationGlossaryEntries,
} from "@j2w/db";
import { getProvider, NotImplementedError } from "../translation/index.js";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  getWorkspaceSettings,
  saveWorkspaceSettings,
} from "../translation/state.js";

// Workspace-level translation config + glossary CRUD. Call-scoped endpoints
// (enable, disable, PATCH) live in routes/calls.ts alongside the existing
// call lifecycle handlers so they share the same call-ownership check.

const PROVIDER_IDS = ["mock", "openai", "google", "deepl", "azure", "sarvam"] as const;
const LATENCY_MODES = ["realtime", "balanced", "accurate"] as const;
const LOW_CONF_ACTIONS = ["show-warning", "insert-original", "drop"] as const;

const settingsPatchSchema = z.object({
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().min(1).max(80).optional(),
  defaultSourceLang: z.string().min(2).max(16).optional(),
  defaultTargetLang: z.string().min(2).max(16).optional(),
  latencyMode: z.enum(LATENCY_MODES).optional(),
  preserveTone: z.boolean().optional(),
  voiceCloning: z.boolean().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  lowConfidenceAction: z.enum(LOW_CONF_ACTIONS).optional(),
  glossaryId: z.string().uuid().nullable().optional(),
  redactPII: z.boolean().optional(),
  profanityFilter: z.boolean().optional(),
  customPhrases: z.string().max(10_000).optional(),
});

export async function translationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // ---------- Workspace settings ----------
  app.get("/settings", async (req) => {
    const ctx = req.authUser!;
    const settings = await getWorkspaceSettings(ctx.orgId);
    return { settings, defaults: DEFAULT_WORKSPACE_SETTINGS };
  });

  app.put("/settings", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = settingsPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.format() });
    }
    const settings = await saveWorkspaceSettings(ctx.orgId, parsed.data);
    return { settings };
  });

  // ---------- Glossaries ----------
  app.get("/glossaries", async (req) => {
    const ctx = req.authUser!;
    const glossaries = await db
      .select()
      .from(translationGlossaries)
      .where(eq(translationGlossaries.orgId, ctx.orgId));
    const entries = glossaries.length
      ? await db
          .select()
          .from(translationGlossaryEntries)
          .where(
            // Scope by glossary ids we just fetched.
            // Small N; OR-in-array is fine here.
            eq(translationGlossaryEntries.glossaryId, glossaries[0].id),
          )
      : [];
    // If there are multiple glossaries, fan out the entry fetch — simple
    // fan-out rather than a single IN() to avoid a drizzle helper dance
    // over what is always a small list.
    const allEntries =
      glossaries.length > 1
        ? (
            await Promise.all(
              glossaries.map((g) =>
                db
                  .select()
                  .from(translationGlossaryEntries)
                  .where(eq(translationGlossaryEntries.glossaryId, g.id)),
              ),
            )
          ).flat()
        : entries;
    return {
      glossaries: glossaries.map((g) => ({
        id: g.id,
        orgId: g.orgId,
        name: g.name,
        description: g.description,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        entries: allEntries.filter((e) => e.glossaryId === g.id).map(serializeEntry),
      })),
    };
  });

  const createGlossarySchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    entries: z
      .array(
        z.object({
          sourceText: z.string().min(1).max(500),
          targetText: z.string().min(1).max(500),
          sourceLang: z.string().min(2).max(16).nullable().optional(),
          targetLang: z.string().min(2).max(16).nullable().optional(),
        }),
      )
      .max(1000)
      .optional(),
  });
  app.post("/glossaries", async (req, reply) => {
    const ctx = req.authUser!;
    const parsed = createGlossarySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.error.format() });
    }
    const id = randomUUID();
    await db.insert(translationGlossaries).values({
      id,
      orgId: ctx.orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    });
    if (parsed.data.entries?.length) {
      await db.insert(translationGlossaryEntries).values(
        parsed.data.entries.map((e) => ({
          id: randomUUID(),
          glossaryId: id,
          sourceText: e.sourceText,
          targetText: e.targetText,
          sourceLang: e.sourceLang ?? null,
          targetLang: e.targetLang ?? null,
        })),
      );
    }
    return reply.code(201).send({ id });
  });

  const patchGlossarySchema = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
  });
  app.patch("/glossaries/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const parsed = patchGlossarySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const result = await db
      .update(translationGlossaries)
      .set({
        ...(parsed.data.name != null ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(translationGlossaries.id, id),
          eq(translationGlossaries.orgId, ctx.orgId),
        ),
      )
      .returning({ id: translationGlossaries.id });
    if (result.length === 0) return reply.code(404).send({ error: "glossary_not_found" });
    return { ok: true };
  });

  app.delete("/glossaries/:id", async (req, reply) => {
    const ctx = req.authUser!;
    const { id } = req.params as { id: string };
    const result = await db
      .delete(translationGlossaries)
      .where(
        and(
          eq(translationGlossaries.id, id),
          eq(translationGlossaries.orgId, ctx.orgId),
        ),
      )
      .returning({ id: translationGlossaries.id });
    if (result.length === 0) return reply.code(404).send({ error: "glossary_not_found" });
    return { ok: true };
  });

  // ---------- Language detection (text-only, Phase 2) ----------
  const detectSchema = z.object({
    text: z.string().min(1).max(2000),
    provider: z.enum(PROVIDER_IDS).optional(),
  });
  app.post("/detect-language", async (req, reply) => {
    const parsed = detectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });

    const ctx = req.authUser!;
    const providerId =
      parsed.data.provider ?? (await getWorkspaceSettings(ctx.orgId)).provider;
    try {
      const provider = getProvider(providerId);
      const detection = await provider.detectLanguage({ text: parsed.data.text });
      return { detection, provider: providerId };
    } catch (err) {
      if (err instanceof NotImplementedError) {
        return reply.code(501).send({ error: "provider_not_implemented", provider: providerId });
      }
      req.log.error({ err }, "language detection failed");
      return reply.code(500).send({ error: "detect_failed" });
    }
  });
}

function serializeEntry(e: typeof translationGlossaryEntries.$inferSelect) {
  return {
    id: e.id,
    glossaryId: e.glossaryId,
    sourceText: e.sourceText,
    targetText: e.targetText,
    sourceLang: e.sourceLang,
    targetLang: e.targetLang,
  };
}
