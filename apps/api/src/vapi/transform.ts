// Map between our VoiceAgent DB shape and Vapi's assistant payload shape.
// Isolates Vapi's schema from ours so a future provider swap is localized.
import type { VoiceAgent } from "@j2w/shared-types";
import { env } from "../env.js";
import { currentVapiContext } from "./context.js";

export interface VapiVoicePayload {
  provider: string;
  voiceId: string;
  model?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  fallbackPlan?: {
    voices: Array<{
      provider: string;
      voiceId: string;
      model?: string;
      stability?: number;
      similarityBoost?: number;
    }>;
  };
}

export interface VapiTranscriberPayload {
  provider: string;
  model: string;
  language: string;
  endpointing?: number;
}

export interface VapiAssistantPayload {
  name: string;
  firstMessage: string;
  voicemailMessage?: string;
  endCallMessage?: string;
  endCallPhrases?: string[];
  model: {
    provider: string;
    model: string;
    temperature: number;
    messages: Array<{ role: "system"; content: string }>;
    tools?: Array<Record<string, unknown>>;
    toolIds?: string[];
  };
  voice: VapiVoicePayload;
  transcriber: VapiTranscriberPayload;
  maxDurationSeconds: number;
  clientMessages?: string[];
  serverMessages?: string[];
  artifactPlan?: Record<string, unknown>;
  startSpeakingPlan?: Record<string, unknown>;
  stopSpeakingPlan?: Record<string, unknown>;
  compliancePlan?: { hipaaEnabled?: boolean; pciEnabled?: boolean };
  serverUrl?: string;
  serverUrlSecret?: string;
  metadata?: Record<string, unknown>;
}

export interface TransformOptions {
  // Vapi tool ids (query tools for KB sources) to attach to model.toolIds.
  // Populated by the deploy flow after syncing KB sources to Vapi.
  extraToolIds?: string[];
  // Slug names of the `knowledgeBases` entries on the auto-generated KB tool.
  // When there are 2+, we append a short directive to the system prompt so
  // the LLM knows which routing keys to pass to `knowledge_query`.
  kbSlugs?: string[];
}

/**
 * Build the Vapi payload from our stored agent + server-side context
 * (disclosures, escalation rules) we want injected into the prompt.
 */
export function toVapiPayload(
  agent: VoiceAgent,
  opts: TransformOptions = {},
): VapiAssistantPayload {
  const systemPrompt = buildSystemPrompt(agent, opts.kbSlugs ?? []);
  const firstMessage = buildFirstMessage(agent);

  const voice: VapiVoicePayload = {
    provider: agent.voiceProvider,
    voiceId: agent.voiceId,
  };
  if (agent.voiceConfig) {
    const vc = agent.voiceConfig;
    if (vc.model !== undefined) voice.model = vc.model;
    if (vc.speed !== undefined) voice.speed = vc.speed;
    if (vc.stability !== undefined) voice.stability = vc.stability;
    if (vc.similarityBoost !== undefined) voice.similarityBoost = vc.similarityBoost;
    if (vc.fallbackPlan) voice.fallbackPlan = vc.fallbackPlan;
  }

  const transcriber: VapiTranscriberPayload = {
    provider: agent.transcriberProvider,
    model: agent.transcriberModel,
    language: agent.transcriberLanguage,
  };
  if (agent.transcriberEndpointing != null) {
    transcriber.endpointing = agent.transcriberEndpointing;
  }

  const toolIds: string[] = opts.extraToolIds?.slice() ?? [];

  // Compose the inline tools array: user-defined tools first, then any
  // platform-injected ones (currently just `routeCall` for triage agents).
  const inlineTools: Array<Record<string, unknown>> = agent.tools.length
    ? agent.tools.map(toVapiTool)
    : [];
  if (agent.kind === "triage") {
    inlineTools.push(buildRouteCallTool());
  }

  const payload: VapiAssistantPayload = {
    name: agent.name,
    firstMessage,
    model: {
      provider: agent.llmProvider,
      model: agent.llmModel,
      temperature: agent.llmTemperature,
      messages: [{ role: "system", content: systemPrompt }],
      tools: inlineTools.length ? inlineTools : undefined,
      toolIds: toolIds.length ? toolIds : undefined,
    },
    voice,
    transcriber,
    maxDurationSeconds: agent.maxDurationSec,
    endCallPhrases: agent.endCallPhrases.length
      ? agent.endCallPhrases
      : ["goodbye", "bye", "end call", "alvida", "dhanyavaad"],
    metadata: {
      j2wAgentId: agent.id,
      j2wOrgId: agent.orgId,
    },
  };

  if (agent.voicemailMessage) payload.voicemailMessage = agent.voicemailMessage;
  if (agent.endCallMessage) payload.endCallMessage = agent.endCallMessage;
  if (agent.clientMessages.length) payload.clientMessages = agent.clientMessages;
  if (agent.serverMessages.length) payload.serverMessages = agent.serverMessages;
  if (agent.artifactPlan) payload.artifactPlan = agent.artifactPlan;
  if (agent.startSpeakingPlan) payload.startSpeakingPlan = agent.startSpeakingPlan;
  if (agent.stopSpeakingPlan) payload.stopSpeakingPlan = agent.stopSpeakingPlan;
  if (agent.compliancePlan) payload.compliancePlan = agent.compliancePlan;

  // Webhook + secret — Vapi posts call events here. Tag the URL with `orgId`
  // so the inbound handler knows which tenant's secret to verify against
  // without having to look up the assistant first.
  const ctx = currentVapiContext();
  const base = `${env.API_PUBLIC_URL.replace(/\/$/, "")}/api/vapi/webhooks`;
  const webhook = ctx?.orgId ? `${base}?orgId=${encodeURIComponent(ctx.orgId)}` : base;
  payload.serverUrl = webhook;
  const webhookSecret = ctx?.webhookSecret ?? env.VAPI_WEBHOOK_SECRET;
  if (webhookSecret) {
    payload.serverUrlSecret = webhookSecret;
  }

  return payload;
}

function buildSystemPrompt(agent: VoiceAgent, kbSlugs: string[]): string {
  const sections: string[] = [];

  if (agent.systemPrompt.trim()) {
    sections.push(agent.systemPrompt.trim());
  }

  if (agent.kind === "triage") {
    const vocab = agent.routing?.intentVocabulary ?? [];
    const vocabHint = vocab.length
      ? `Possible intents: ${vocab.map((v) => `"${v}"`).join(", ")}.`
      : "Pick a short kebab-case intent like \"billing\", \"technical\", \"sales\".";
    sections.push(
      [
        "You are an AI triage agent. Greet the caller, hold a short conversation",
        "(2–4 turns) to understand why they called, then call the `routeCall`",
        `tool with your classification. ${vocabHint}`,
        "After calling routeCall, briefly tell the caller what's happening next",
        "(\"I'll connect you to our billing team — one moment.\") and stop talking.",
      ].join(" "),
    );
  }

  // Hinglish-first directive. If the primary language is "multi" we explicitly
  // instruct the model to code-mix — generic multilingual models otherwise
  // tend to pick a single language and stick with it.
  if (agent.language === "multi") {
    sections.push(
      "Language: You speak Hinglish (Hindi + English code-mixing). " +
        "Match the caller's register: if they speak English, reply in English; " +
        "if they use Hindi or Hinglish, reply in Hinglish. Use Devanagari or " +
        "Roman script for Hindi words naturally as appropriate for speech.",
    );
  } else if (agent.language.startsWith("hi")) {
    sections.push("Language: Respond in Hindi. You may mix English loanwords naturally.");
  }

  if (agent.tone) {
    sections.push(`Tone: ${agent.tone}.`);
  }

  if (agent.personality) {
    const p = agent.personality;
    const dims = Object.entries({
      warmth: p.warmth,
      conciseness: p.conciseness,
      formality: p.formality,
      patience: p.patience,
      proactiveness: p.proactiveness,
    })
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([k, v]) => `${k}=${v}`);
    if (dims.length) {
      sections.push(`Personality (0-100): ${dims.join(", ")}.`);
    }
  }

  if (agent.compliance?.disclosures?.length) {
    sections.push(
      `Required disclosures (weave naturally into conversation):\n- ${agent.compliance.disclosures.join("\n- ")}`,
    );
  }

  if (agent.compliance?.prohibited?.length) {
    sections.push(
      `Never say or imply:\n- ${agent.compliance.prohibited.join("\n- ")}`,
    );
  }

  if (agent.escalation?.rules?.length) {
    const handoff = agent.escalation.handoffPhone
      ? ` Transfer the call to ${agent.escalation.handoffPhone} using the transferCall tool.`
      : " Offer to schedule a human callback.";
    sections.push(
      `Escalation rules — if ANY apply, stop and escalate:\n- ${agent.escalation.rules.join("\n- ")}\n${handoff}`,
    );
  }

  // When the agent has 2+ KB sources wired up, tell the LLM which routing keys
  // the `knowledge_query` tool accepts — reinforces what's in the tool's
  // `knowledge_base` enum parameter.
  if (kbSlugs.length >= 2) {
    sections.push(
      `Knowledge retrieval: Call the \`knowledge_query\` tool before answering factual questions. ` +
        `Choose the \`knowledge_base\` argument from: ${kbSlugs.map((s) => `\`${s}\``).join(", ")}. ` +
        `Pick the one that best matches the caller's question, then pass a concise \`query\`.`,
    );
  } else if (kbSlugs.length === 1) {
    sections.push(
      `Knowledge retrieval: Call the \`knowledge_query\` tool before answering factual questions — it searches the \`${kbSlugs[0]}\` knowledge base.`,
    );
  }

  return sections.join("\n\n");
}

function buildFirstMessage(agent: VoiceAgent): string {
  const disclosures = agent.compliance?.disclosures ?? [];
  if (!disclosures.length) return agent.firstMessage;
  // Prepend disclosures as a single sentence; the model can rephrase naturally.
  return `${disclosures.join(" ")} ${agent.firstMessage}`.trim();
}

function toVapiTool(tool: VoiceAgent["tools"][number]): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    ...(tool.fulfillmentUrl ? { server: { url: tool.fulfillmentUrl } } : {}),
  };
}

// Auto-injected on triage agents — Vapi will call this when the assistant
// completes its classification. The fulfillment URL is the same webhook the
// rest of Vapi posts to (`/api/vapi/webhooks`); we route it via the
// function-call branch in vapi-webhooks.ts since that handler already has
// HMAC signature verification.
function buildRouteCallTool(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "routeCall",
      description:
        "Route this call based on detected intent. Call ONCE per call, after enough information has been gathered.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Short kebab-case intent (e.g. 'billing', 'technical', 'cancellation').",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Your confidence in the classification, 0–1.",
          },
          sentiment: {
            type: "number",
            minimum: -1,
            maximum: 1,
            description: "Caller sentiment, -1 (angry) to 1 (happy).",
          },
          language: { type: "string", description: "BCP-47 detected caller language." },
          entities: {
            type: "object",
            description: "Extracted facts: { accountId?, productSku?, errorCode?, ... }.",
            additionalProperties: { type: "string" },
          },
          reason: {
            type: "string",
            description: "One sentence on why this routing decision.",
          },
        },
        required: ["intent", "confidence"],
      },
    },
  };
}
