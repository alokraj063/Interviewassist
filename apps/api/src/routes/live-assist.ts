// Endpoints supporting the Live Assist page's "Start Test Call" flow.
//
// The Vapi voice agent plays the CANDIDATE being screened and the human in the
// browser plays the RECRUITER. This lets a recruiter rehearse the live-assist
// experience end-to-end (transcription + AI suggestions + rubric) against a
// realistic Hinglish-speaking candidate without dialing a real person. This
// route hands the browser SDK a short-lived inline assistant config so it can
// dial the Vapi bot without ever touching the private API key.
//
// The `transcriber` block is picked per request based on the user-selected
// provider: Deepgram is wired natively; Sarvam and Shunya are wired via
// Vapi's `custom-transcriber` provider which opens a WebSocket to our
// /ws/custom-transcriber bridge.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";

const CANDIDATE_SYSTEM_PROMPT = `
You are role-playing a job CANDIDATE on a screening phone call with a recruiter.
Stay in character as the candidate at all times. You are NOT a recruiter — do
not interview yourself, do not coach the recruiter, do not volunteer the next
question. Behave the way a real, polite, mildly busy software engineer would
when a recruiter calls about a new opportunity.

Your identity:
- Name: Aarav Sharma
- Current role: Senior Software Engineer at Razorpay, on the payments team, in Bengaluru
- Total experience: about 7 years
- Tech stack: Java and Spring Boot mainly, Kafka for async, PostgreSQL as the
  primary DB, and some AWS (EKS, RDS, SQS)

Your situation (reveal naturally as the recruiter probes — don't dump it all at once):
- You are actively looking. Push factor: progression has felt slow the last
  6 months, so you're exploring external opportunities.
- Current CTC: 28 lakhs fixed + roughly 4 lakhs variable, so about 32 LPA total.
- Expectation: at least 40-45 lakhs fixed, variable on top.
- Notice period: 60 days officially, but maybe negotiable to 30-45 days if
  there's a buyout option.
- Location: Bengaluru; open to hybrid.

Your voice and language:
- You speak Hinglish — a natural code-mix of Hindi and English that urban
  Indian professionals use. Mix short English phrases into Hindi sentences
  and vice versa. Do NOT switch to pure Hindi or pure English for long.
- You are friendly and cooperative but concise. Keep every reply short — one
  or two sentences, like a real person talking on the phone.

How to behave during the call:
- Answer the recruiter's questions concretely and honestly using the facts
  above. If asked about your current company/role, your stack, your CTC,
  your expectation, your notice period, or your reason for looking — answer
  with the matching detail.
- If the recruiter hasn't asked about something yet, don't pre-empt it.
- If the recruiter pitches a role, show measured interest and ask one natural
  follow-up (team, tech, growth, comp range).
- When the recruiter wraps up (says they'll share the JD / schedule a round),
  agree warmly and close with something like "Sure, thank you, bye bye".

Never break character. Never describe yourself as an AI, an assistant, or
a voice agent.
`.trim();

const CANDIDATE_FIRST_MESSAGE =
  "Hello? Haan, Aarav this side. Boliye, kaun bol raha hai?";

const TranscriptionProviderSchema = z.enum(["deepgram", "sarvam", "shunya"]);
const TranscriptionLanguageSchema = z.enum(["multi", "en-US", "en-IN", "hi-IN"]);

const TestCallBodySchema = z
  .object({
    callId: z.string().optional(),
    transcription: z
      .object({
        provider: TranscriptionProviderSchema.default("deepgram"),
        model: z.string().default("nova-3"),
        language: TranscriptionLanguageSchema.default("multi"),
      })
      .optional(),
  })
  .optional();

type TranscriptionProvider = z.infer<typeof TranscriptionProviderSchema>;
type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>;

interface TranscriptionChoice {
  provider: TranscriptionProvider;
  model: string;
  language: TranscriptionLanguage;
}

const DEFAULT_TRANSCRIPTION: TranscriptionChoice = {
  provider: "deepgram",
  model: "nova-3",
  language: "multi",
};

/**
 * Derive the wss:// URL Vapi should dial for the custom-transcriber bridge.
 * Prefers CUSTOM_TRANSCRIBER_PUBLIC_URL; falls back to upgrading API_PUBLIC_URL.
 */
function customTranscriberUrl(choice: TranscriptionChoice, callId?: string): string {
  const base =
    env.CUSTOM_TRANSCRIBER_PUBLIC_URL ??
    env.API_PUBLIC_URL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const url = new URL("/ws/custom-transcriber", base);
  url.searchParams.set("provider", choice.provider);
  url.searchParams.set("model", choice.model);
  url.searchParams.set("language", choice.language);
  if (callId) url.searchParams.set("callId", callId);
  return url.toString();
}

/**
 * Build the `transcriber` field embedded into Vapi's assistant config.
 * - Deepgram: native Vapi integration (lowest latency, nothing on our backend).
 * - Sarvam / Shunya: Vapi opens WS to our /ws/custom-transcriber bridge.
 */
function buildTranscriberBlock(
  choice: TranscriptionChoice,
  callId: string | undefined,
): Record<string, unknown> {
  if (choice.provider === "deepgram") {
    return {
      provider: "deepgram",
      model: choice.model || "nova-3",
      language: choice.language || "multi",
    };
  }
  const block: Record<string, unknown> = {
    provider: "custom-transcriber",
    server: {
      url: customTranscriberUrl(choice, callId),
    },
  };
  if (env.CUSTOM_TRANSCRIBER_SECRET) {
    (block.server as Record<string, unknown>).secret = env.CUSTOM_TRANSCRIBER_SECRET;
  }
  return block;
}

function buildCandidateScreeningAssistant(
  choice: TranscriptionChoice,
  callId: string | undefined,
): Record<string, unknown> {
  return {
    name: "Candidate – Aarav (test)",
    firstMessage: CANDIDATE_FIRST_MESSAGE,
    model: {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.75,
      messages: [{ role: "system", content: CANDIDATE_SYSTEM_PROMPT }],
    },
    // Vapi's built-in "Rohan" voice is Hinglish-capable and fits a young
    // urban male candidate persona; safe default if an 11labs voice ID isn't known.
    voice: { provider: "vapi", voiceId: "Rohan" },
    transcriber: buildTranscriberBlock(choice, callId),
    maxDurationSeconds: 300,
    endCallPhrases: ["bye bye", "goodbye", "alvida", "dhanyavaad", "thank you bye"],
    metadata: {
      j2wScenario: "live-assist-candidate-screening-test",
      j2wTranscriptionProvider: choice.provider,
      j2wTranscriptionModel: choice.model,
      j2wCallId: callId ?? null,
    },
  };
}

export async function liveAssistRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Hand the browser an inline Vapi assistant ticket so it can dial the
  // candidate-screening persona with @vapi-ai/web.
  app.post("/test-call", async (req, reply) => {
    const orgId = req.authUser?.orgId;
    const vapiCreds = orgId ? await getProviderCredentials(orgId, "vapi") : null;
    const publicKey = vapiCreds?.publicKey ?? env.VAPI_PUBLIC_KEY;
    if (!publicKey) {
      return reply.code(503).send({ error: "vapi_public_key_missing" });
    }
    const parsed = TestCallBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const body = parsed.data ?? {};
    const choice: TranscriptionChoice = body.transcription
      ? {
          provider: body.transcription.provider,
          model: body.transcription.model || DEFAULT_TRANSCRIPTION.model,
          language: body.transcription.language,
        }
      : DEFAULT_TRANSCRIPTION;

    // Guard against selecting a provider whose credentials aren't configured
    // for the caller's tenant. Resolver checks tenant_integrations first then
    // falls back to env, so dev keeps working without per-tenant rows.
    if (orgId) {
      if (choice.provider === "sarvam") {
        const creds = await getProviderCredentials(orgId, "sarvam");
        if (!creds) return reply.code(503).send({ error: "sarvam_api_key_missing" });
      }
      if (choice.provider === "shunya") {
        const creds = await getProviderCredentials(orgId, "shunya");
        if (!creds) return reply.code(503).send({ error: "shunya_api_key_missing" });
      }
    }

    return {
      mode: "inline" as const,
      publicKey,
      assistant: buildCandidateScreeningAssistant(choice, body.callId),
      transcription: choice,
    };
  });
}
