// Voice-agent CRUD + deploy + test-call + voices listing.
// Phase 1 ships CRUD; deploy/test-call/webhooks are wired in Phase 3.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_ORG_ID,
  callSessions,
  db,
  triageRoutingRules,
  voiceAgentDeployments,
  voiceAgents,
} from "@j2w/db";
import type {
  CreateVoiceAgentInput,
  UpdateVoiceAgentInput,
  VapiVoiceOption,
  VoiceAgent,
  VoiceAgentDeployment,
  VoiceAgentLanguage,
  VoiceAgentStatus,
} from "@j2w/shared-types";
import {
  VapiError,
  attachPhoneToAssistant,
  buyPhoneNumber,
  createAssistant,
  deleteAssistant,
  listVoices,
  updateAssistant,
} from "../vapi/client.js";
import { toVapiPayload } from "../vapi/transform.js";
import { syncAgentKbToVapi } from "../vapi/kbSync.js";
import { syncTriageSquad } from "../vapi/squads.js";
import { withVapiContext } from "../vapi/context.js";
import { getProviderCredentials } from "../integrations/resolver.js";

// ---- zod schemas ----

const createSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(["specialist", "triage"]).optional(),
  purpose: z.string().max(500).optional(),
  language: z
    .enum(["multi", "hi-IN", "en-IN", "en-US", "en-GB", "mr-IN", "ta-IN", "te-IN"])
    .optional(),
  systemPrompt: z.string().max(20_000).optional(),
  firstMessage: z.string().max(1000).optional(),
  template: z.enum(["billing", "scheduler", "support", "blank", "triage"]).optional(),
}) satisfies z.ZodType<CreateVoiceAgentInput>;

const toolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  parameters: z.record(z.unknown()),
  fulfillmentUrl: z.string().url().optional(),
});

const voiceConfigSchema = z
  .object({
    model: z.string().optional(),
    speed: z.number().min(0).max(4).optional(),
    stability: z.number().min(0).max(1).optional(),
    similarityBoost: z.number().min(0).max(1).optional(),
    fallbackPlan: z
      .object({
        voices: z.array(
          z.object({
            provider: z.string(),
            voiceId: z.string(),
            model: z.string().optional(),
            stability: z.number().min(0).max(1).optional(),
            similarityBoost: z.number().min(0).max(1).optional(),
          }),
        ),
      })
      .optional(),
  })
  .nullable();

const updateSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(["specialist", "triage"]),
    status: z.enum(["draft", "active", "paused", "archived"]),
    purpose: z.string().max(500),
    systemPrompt: z.string().max(20_000),
    firstMessage: z.string().max(1000),
    language: z.enum(["multi", "hi-IN", "en-IN", "en-US", "en-GB", "mr-IN", "ta-IN", "te-IN"]),
    transcriberProvider: z.string(),
    transcriberModel: z.string(),
    transcriberLanguage: z.string(),
    transcriberEndpointing: z.number().int().min(0).max(5000).nullable(),
    llmProvider: z.string(),
    llmModel: z.string(),
    llmTemperature: z.number().min(0).max(2),
    voiceProvider: z.string(),
    voiceId: z.string(),
    voiceConfig: voiceConfigSchema,
    voicemailMessage: z.string().max(2000).nullable(),
    endCallMessage: z.string().max(2000).nullable(),
    endCallPhrases: z.array(z.string().max(200)).max(40),
    clientMessages: z.array(z.string().max(100)).max(40),
    serverMessages: z.array(z.string().max(100)).max(40),
    artifactPlan: z.record(z.unknown()).nullable(),
    startSpeakingPlan: z.record(z.unknown()).nullable(),
    stopSpeakingPlan: z.record(z.unknown()).nullable(),
    compliancePlan: z
      .object({
        hipaaEnabled: z.boolean().optional(),
        pciEnabled: z.boolean().optional(),
      })
      .nullable(),
    tone: z.string().max(100),
    personality: z
      .object({
        warmth: z.number().min(0).max(100).optional(),
        conciseness: z.number().min(0).max(100).optional(),
        formality: z.number().min(0).max(100).optional(),
        patience: z.number().min(0).max(100).optional(),
        proactiveness: z.number().min(0).max(100).optional(),
      })
      .nullable(),
    tools: z.array(toolSchema),
    knowledgeSourceIds: z.array(z.string().uuid()),
    compliance: z
      .object({
        disclosures: z.array(z.string()).optional(),
        prohibited: z.array(z.string()).optional(),
        piiRedaction: z.boolean().optional(),
      })
      .nullable(),
    escalation: z
      .object({
        handoffPhone: z.string().optional(),
        rules: z.array(z.string()).optional(),
      })
      .nullable(),
    maxDurationSec: z.number().int().min(30).max(3600),
    routing: z
      .object({
        intentVocabulary: z.array(z.string().min(1).max(64)).max(40).optional(),
        defaultDestinationRef: z.string().max(200).optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
      })
      .nullable(),
  })
  .partial() satisfies z.ZodType<UpdateVoiceAgentInput>;

// ---- prompt templates ----

const TEMPLATES: Record<NonNullable<CreateVoiceAgentInput["template"]>, { systemPrompt: string; firstMessage: string; purpose: string }> = {
  billing: {
    purpose: "Handle billing inquiries, payment disputes, and invoice questions.",
    firstMessage:
      "Namaste! Main J2W ki billing assistant hoon. Aapki billing query mein main kaise help kar sakti hoon?",
    systemPrompt:
      "You are a billing assistant for Joules to Watts. Help callers with invoice questions, payment status, refund requests, and billing disputes. Verify identity before discussing account details. If the caller is upset, empathize before explaining policy.",
  },
  scheduler: {
    purpose: "Book, reschedule, and confirm appointments.",
    firstMessage:
      "Hello! Main appointment scheduling mein aapki help karne ke liye hoon. Kya aap koi slot book karna chahte hain?",
    systemPrompt:
      "You are an appointment scheduler for Joules to Watts. Collect caller name, preferred date/time, and service type. Confirm details before booking. Propose 2-3 alternatives if the requested slot is unavailable.",
  },
  support: {
    purpose: "General customer support — inquiries, issue triage, basic troubleshooting.",
    firstMessage:
      "Hi! Main J2W customer support se baat kar rahi hoon. Aapki kya problem hai, please bataiye.",
    systemPrompt:
      "You are a customer support agent for Joules to Watts. Listen carefully, ask clarifying questions, and try to resolve issues in one call. Escalate to a human if the issue involves account changes or refunds over ₹5000.",
  },
  blank: {
    purpose: "",
    firstMessage: "Hello! How can I help you today?",
    systemPrompt: "",
  },
  triage: {
    purpose: "Front-door AI triage — classify caller intent and route to the right destination.",
    firstMessage:
      "Namaste! Aap J2W ko call kar rahe hain. Main aapki call ko sahi team tak pahunchaane mein madad karungi. Bataiye, aaj kaisi madad chahiye?",
    systemPrompt:
      "You are a triage agent for Joules to Watts. Greet the caller warmly, hold a short conversation (2–4 turns) to understand the reason for their call, then call the routeCall tool with your classification. Be concise — the goal is to route quickly, not to resolve.",
  },
};

// ---- helpers ----

function rowToVoiceAgent(row: typeof voiceAgents.$inferSelect): VoiceAgent {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: (row.kind as VoiceAgent["kind"]) ?? "specialist",
    status: row.status as VoiceAgentStatus,
    purpose: row.purpose,
    systemPrompt: row.systemPrompt,
    firstMessage: row.firstMessage,
    language: row.language as VoiceAgentLanguage,
    transcriberProvider: row.transcriberProvider,
    transcriberModel: row.transcriberModel,
    transcriberLanguage: row.transcriberLanguage,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    llmTemperature: row.llmTemperature,
    voiceProvider: row.voiceProvider,
    voiceId: row.voiceId,
    voiceConfig: row.voiceConfig ?? null,
    transcriberEndpointing: row.transcriberEndpointing ?? null,
    voicemailMessage: row.voicemailMessage ?? null,
    endCallMessage: row.endCallMessage ?? null,
    endCallPhrases: (row.endCallPhrases ?? []) as string[],
    clientMessages: (row.clientMessages ?? []) as string[],
    serverMessages: (row.serverMessages ?? []) as string[],
    artifactPlan: row.artifactPlan ?? null,
    startSpeakingPlan: row.startSpeakingPlan ?? null,
    stopSpeakingPlan: row.stopSpeakingPlan ?? null,
    compliancePlan: row.compliancePlan ?? null,
    tone: row.tone,
    personality: row.personality ?? null,
    tools: (row.tools ?? []) as VoiceAgent["tools"],
    knowledgeSourceIds: (row.knowledgeSourceIds ?? []) as string[],
    compliance: row.compliance ?? null,
    escalation: row.escalation ?? null,
    maxDurationSec: row.maxDurationSec,
    vapiAssistantId: row.vapiAssistantId,
    vapiPhoneId: row.vapiPhoneId,
    vapiKbToolId: row.vapiKbToolId,
    vapiSquadId: row.vapiSquadId ?? null,
    phoneNumber: row.phoneNumber,
    lastDeployedAt: row.lastDeployedAt ? row.lastDeployedAt.toISOString() : null,
    routing: row.routing ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getAgentById(orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(voiceAgents)
    .where(and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, orgId)));
  return row ?? null;
}

// ---- routes ----

export async function voiceAgentsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };

  // VOICES — cached list from Vapi's voice catalog. Defined before /:id so
  // the static path wins the route match.
  let voicesCache: { at: number; voices: VapiVoiceOption[] } | null = null;
  app.get("/voices", auth, async (req, reply) => {
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const creds = await getProviderCredentials(orgId, "vapi");
    if (!creds) return reply.code(503).send({ error: "vapi_not_configured" });
    const now = Date.now();
    if (voicesCache && now - voicesCache.at < 60 * 60 * 1000) {
      return { voices: voicesCache.voices };
    }
    try {
      const raw = await withVapiContext(
        { apiKey: creds.apiKey, publicKey: creds.publicKey, webhookSecret: creds.webhookSecret, orgId },
        () => listVoices(),
      );
      const voices: VapiVoiceOption[] = raw.map((v) => ({
        provider: v.provider,
        voiceId: v.voiceId,
        name: v.name ?? v.voiceId,
        language: v.language,
        gender:
          v.gender === "male" || v.gender === "female" || v.gender === "neutral" ? v.gender : undefined,
        accent: v.accent,
        previewUrl: v.previewUrl,
      }));
      voicesCache = { at: now, voices };
      return { voices };
    } catch (err) {
      app.log.error({ err }, "vapi voices fetch failed");
      return reply.code(502).send({ error: "vapi_voices_failed" });
    }
  });

  // LIST
  app.get("/", auth, async (req) => {
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const rows = await db
      .select()
      .from(voiceAgents)
      .where(eq(voiceAgents.orgId, orgId))
      .orderBy(desc(voiceAgents.createdAt));
    return { agents: rows.map(rowToVoiceAgent) };
  });

  // CREATE
  app.post("/", auth, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const kind: VoiceAgent["kind"] =
      parsed.data.kind ?? (parsed.data.template === "triage" ? "triage" : "specialist");
    const templateKey = (parsed.data.template ?? (kind === "triage" ? "triage" : "blank")) as keyof typeof TEMPLATES;
    const tmpl = TEMPLATES[templateKey] ?? TEMPLATES.blank;

    const [row] = await db
      .insert(voiceAgents)
      .values({
        orgId,
        name: parsed.data.name,
        kind,
        status: "draft",
        purpose: parsed.data.purpose ?? tmpl.purpose,
        systemPrompt: parsed.data.systemPrompt ?? tmpl.systemPrompt,
        firstMessage: parsed.data.firstMessage ?? tmpl.firstMessage,
        language: parsed.data.language ?? "multi",
        // Seed a sensible default vocabulary for triage agents so the editor
        // has something to render the first time it loads.
        routing:
          kind === "triage"
            ? {
                intentVocabulary: ["billing", "technical", "sales", "cancellation", "other"],
                confidenceThreshold: 0.6,
              }
            : null,
        createdByUserId: req.authUser?.id ?? null,
      })
      .returning();

    return { agent: rowToVoiceAgent(row) };
  });

  // READ
  app.get("/:id", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const row = await getAgentById(orgId, id);
    if (!row) return reply.code(404).send({ error: "not_found" });

    const deployments = await db
      .select({
        id: voiceAgentDeployments.id,
        agentId: voiceAgentDeployments.agentId,
        deployedAt: voiceAgentDeployments.deployedAt,
        status: voiceAgentDeployments.status,
        errorMessage: voiceAgentDeployments.errorMessage,
      })
      .from(voiceAgentDeployments)
      .where(eq(voiceAgentDeployments.agentId, id))
      .orderBy(desc(voiceAgentDeployments.deployedAt))
      .limit(20);

    const deploymentList: VoiceAgentDeployment[] = deployments.map((d) => ({
      id: d.id,
      agentId: d.agentId,
      deployedAt: d.deployedAt.toISOString(),
      status: d.status as "success" | "failed",
      errorMessage: d.errorMessage,
    }));

    return { agent: rowToVoiceAgent(row), deployments: deploymentList };
  });

  // UPDATE
  app.patch("/:id", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const [row] = await db
      .update(voiceAgents)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, orgId)))
      .returning();

    return { agent: rowToVoiceAgent(row) };
  });

  // DELETE (soft-archive if deployed, hard-delete if draft)
  app.delete("/:id", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    // If deployed to Vapi, detach + delete the assistant there first.
    if (existing.vapiAssistantId) {
      const creds = await getProviderCredentials(orgId, "vapi");
      if (creds) {
        try {
          await withVapiContext(
            { apiKey: creds.apiKey, publicKey: creds.publicKey, webhookSecret: creds.webhookSecret, orgId },
            () => deleteAssistant(existing.vapiAssistantId!),
          );
        } catch (err) {
          req.log.warn({ err, agentId: id }, "vapi delete assistant failed; continuing with local delete");
        }
      }
    }

    await db.delete(voiceAgents).where(and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, orgId)));
    return { deleted: id };
  });

  // DEPLOY — push config to Vapi, (optionally) buy+attach a phone number.
  app.post("/:id/deploy", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const creds = await getProviderCredentials(orgId, "vapi");
    if (!creds) {
      return reply.code(503).send({ error: "vapi_not_configured", message: "Vapi credentials missing" });
    }

    const agent = rowToVoiceAgent(existing);
    if (!agent.voiceId) {
      return reply.code(400).send({ error: "voice_required", message: "Pick a voice before deploying." });
    }
    return withVapiContext(
      { apiKey: creds.apiKey, publicKey: creds.publicKey, webhookSecret: creds.webhookSecret, orgId },
      () => deployImpl(),
    );

    async function deployImpl() {

    // Push selected KB sources to Vapi first — all selected sources collapse
    // into a single `knowledge_query` query tool (one `knowledgeBases` entry
    // per source). Failures are logged but non-fatal; the assistant deploy
    // continues without KB rather than blocking the whole flow.
    let kbToolId: string | null = agent.vapiKbToolId;
    let kbSlugs: string[] = [];
    try {
      const synced = await syncAgentKbToVapi(agent.knowledgeSourceIds, agent.vapiKbToolId);
      kbToolId = synced.toolId;
      kbSlugs = synced.knowledgeBaseSlugs;
    } catch (err) {
      req.log.warn({ err, agentId: id }, "kb sync to vapi failed; deploying without KB");
    }

    // Deploy body: `buyPhone` + `areaCode` are opt-in. Without them we only
    // upsert the assistant config and attach any existing phone we already have.
    const deployBody = (req.body ?? {}) as { buyPhone?: boolean; areaCode?: string };
    const wantsNewPhone = !!deployBody.buyPhone;

    const extraToolIds = kbToolId ? [kbToolId] : [];
    const payload = toVapiPayload(agent, { extraToolIds, kbSlugs });

    const payloadForVapi = payload as unknown as Record<string, unknown>;
    try {
      let assistantId = existing.vapiAssistantId;
      if (assistantId) {
        await updateAssistant(assistantId, payloadForVapi);
      } else {
        const created = await createAssistant(payloadForVapi);
        assistantId = created.id;
      }

      let phoneId = existing.vapiPhoneId;
      let phoneNumber = existing.phoneNumber;
      let phoneWarning: string | null = null;

      if (!phoneId && wantsNewPhone) {
        const areaCode = (deployBody.areaCode ?? "").trim();
        // Area code is optional for Vapi's own numbers; if supplied, must be
        // 3+ digits and numeric (this becomes `numberDesiredAreaCode`).
        if (areaCode && !/^\d{3,}$/.test(areaCode)) {
          return reply.code(400).send({
            error: "invalid_area_code",
            message: "areaCode must be a 3+ digit numeric string, or omitted to let Vapi pick.",
          });
        }
        try {
          const phone = await buyPhoneNumber(areaCode ? { areaCode } : {});
          phoneId = phone.id;
          phoneNumber = phone.number ?? null;
        } catch (err) {
          // Don't fail the whole deploy just because phone purchase broke —
          // the assistant is already good. Log the detail so ops can diagnose.
          phoneWarning =
            err instanceof VapiError
              ? `${err.message}: ${typeof err.body === "string" ? err.body : JSON.stringify(err.body)}`
              : err instanceof Error
                ? err.message
                : "unknown";
          req.log.warn({ err }, "vapi phone-number buy failed (non-fatal)");
        }
      }

      if (phoneId) {
        try {
          await attachPhoneToAssistant(phoneId, assistantId);
        } catch (err) {
          phoneWarning =
            (phoneWarning ? phoneWarning + "; " : "") +
            (err instanceof VapiError ? err.message : err instanceof Error ? err.message : "unknown");
          req.log.warn({ err }, "vapi phone attach failed (non-fatal)");
        }
      }

      // For triage agents: rebuild the Vapi squad now that we have an
      // assistantId (every voice_agent destination becomes a squad member).
      let nextSquadId = existing.vapiSquadId;
      if (existing.kind === "triage") {
        try {
          const ruleRows = await db
            .select()
            .from(triageRoutingRules)
            .where(eq(triageRoutingRules.triageAgentId, id))
            .orderBy(triageRoutingRules.priority);
          const sync = await syncTriageSquad(
            { id, name: agent.name, vapiAssistantId: assistantId, vapiSquadId: existing.vapiSquadId },
            ruleRows.map((r) => ({
              id: r.id,
              flowId: r.triageAgentId,
              priority: r.priority,
              intent: r.intent,
              conditions: r.conditions ?? undefined,
              destinationType: r.destinationType as never,
              destinationRef: r.destinationRef,
              destinationLabel: r.destinationLabel,
              handoffMode: r.handoffMode as never,
              enabled: r.enabled,
              uiPosition: r.uiPosition ?? { x: 0, y: 0 },
            })),
          );
          if (sync) nextSquadId = sync.squadId;
        } catch (err) {
          req.log.warn({ err, agentId: id }, "vapi squad sync failed during deploy (non-fatal)");
        }
      }

      const [row] = await db
        .update(voiceAgents)
        .set({
          vapiAssistantId: assistantId,
          vapiPhoneId: phoneId,
          vapiKbToolId: kbToolId,
          vapiSquadId: nextSquadId,
          phoneNumber: phoneNumber ?? null,
          status: "active",
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(voiceAgents.id, id), eq(voiceAgents.orgId, orgId)))
        .returning();

      await db.insert(voiceAgentDeployments).values({
        agentId: id,
        deployedByUserId: req.authUser?.id ?? null,
        vapiConfigSnapshot: payload as unknown as Record<string, unknown>,
        status: "success",
        errorMessage: phoneWarning,
      });

      return { agent: rowToVoiceAgent(row), phoneWarning };
    } catch (err) {
      const baseMessage =
        err instanceof VapiError ? err.message : err instanceof Error ? err.message : "unknown";
      const detail =
        err instanceof VapiError
          ? typeof err.body === "string"
            ? err.body
            : JSON.stringify(err.body)
          : null;
      const message = detail ? `${baseMessage} — ${detail}` : baseMessage;
      await db.insert(voiceAgentDeployments).values({
        agentId: id,
        deployedByUserId: req.authUser?.id ?? null,
        vapiConfigSnapshot: payload as unknown as Record<string, unknown>,
        status: "failed",
        errorMessage: message,
      });
      req.log.error({ err }, "vapi deploy failed");
      return reply.code(502).send({ error: "vapi_deploy_failed", message });
    }
    }
  });

  // TEST CALL — return public key + assistantId so the browser SDK can dial.
  app.post("/:id/test-call", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const creds = await getProviderCredentials(orgId, "vapi");
    if (!creds?.publicKey) {
      return reply.code(503).send({ error: "vapi_public_key_missing" });
    }

    // If the agent has never been deployed, create a one-shot assistant on the
    // fly by sending the inline config — Vapi's web SDK accepts that. The
    // payload's webhook URL/secret come from the Vapi context.
    if (!existing.vapiAssistantId) {
      const assistant = await withVapiContext(
        { apiKey: creds.apiKey, publicKey: creds.publicKey, webhookSecret: creds.webhookSecret, orgId },
        async () => toVapiPayload(rowToVoiceAgent(existing)),
      );
      return {
        mode: "inline" as const,
        publicKey: creds.publicKey,
        assistant,
      };
    }

    return {
      mode: "assistantId" as const,
      publicKey: creds.publicKey,
      assistantId: existing.vapiAssistantId,
    };
  });

  // CALLS — recent calls handled by this agent, sourced from call_sessions.
  app.get("/:id/calls", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));

    const rows = await db
      .select({
        id: callSessions.id,
        startedAt: callSessions.startedAt,
        endedAt: callSessions.endedAt,
        status: callSessions.status,
        candidateRefOrPhone: callSessions.candidateRefOrPhone,
        summary: callSessions.summary,
      })
      .from(callSessions)
      .where(eq(callSessions.voiceAgentId, id))
      .orderBy(desc(callSessions.startedAt))
      .limit(limit);

    const calls = rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      durationSec: r.endedAt ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
      status: r.status,
      candidateRefOrPhone: r.candidateRefOrPhone,
      summary: r.summary,
    }));
    return { calls };
  });

  // STATS — daily rollup for the last N days, for the Overview chart.
  app.get("/:id/stats", auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.authUser?.orgId ?? DEFAULT_ORG_ID;
    const existing = await getAgentById(orgId, id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const q = req.query as { days?: string };
    const days = Math.min(90, Math.max(1, Number(q.days ?? 14)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Daily bucket: count calls, resolved%, avg duration.
    const rows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${callSessions.startedAt}), 'YYYY-MM-DD')`,
        calls: sql<number>`count(*)::int`,
        ended: sql<number>`count(*) filter (where ${callSessions.endedAt} is not null)::int`,
        avgDuration: sql<number>`coalesce(avg(extract(epoch from (${callSessions.endedAt} - ${callSessions.startedAt})))::int, 0)`,
      })
      .from(callSessions)
      .where(
        and(eq(callSessions.voiceAgentId, id), gte(callSessions.startedAt, since)),
      )
      .groupBy(sql`date_trunc('day', ${callSessions.startedAt})`)
      .orderBy(sql`date_trunc('day', ${callSessions.startedAt})`);

    // Fill in missing days so the chart always has `days` points.
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series: Array<{ day: string; calls: number; ended: number; avgDuration: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const row = byDay.get(key);
      series.push({
        day: key,
        calls: row?.calls ?? 0,
        ended: row?.ended ?? 0,
        avgDuration: row?.avgDuration ?? 0,
      });
    }

    const totalCalls = series.reduce((s, r) => s + r.calls, 0);
    const totalEnded = series.reduce((s, r) => s + r.ended, 0);

    return {
      days,
      series,
      totals: {
        calls: totalCalls,
        ended: totalEnded,
        resolutionRate: totalCalls ? Math.round((totalEnded / totalCalls) * 100) : 0,
      },
    };
  });
}
