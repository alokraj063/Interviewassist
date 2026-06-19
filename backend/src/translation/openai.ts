import OpenAI from "openai";
import type { LanguageDetection } from "@j2w/shared-types";
import { env } from "../env.js";
import type {
  DetectLanguageInput,
  TranslateTextInput,
  TranslateTextOutput,
  TranslationProvider,
} from "./provider.js";

// OpenAI-backed translation. We piggy-back on the existing OPENAI_API_KEY
// rather than introducing a vendor-specific dependency. Confidence is
// approximated from model temperature + response length (OpenAI doesn't
// expose a translation-quality score directly).

const MODEL_BY_LATENCY: Record<NonNullable<TranslateTextInput["latencyMode"]>, string> = {
  realtime: "gpt-4o-mini",
  balanced: env.OPENAI_MODEL_FALLBACK,
  accurate: env.OPENAI_MODEL,
};

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (client) return client;
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not configured — cannot use provider=openai for translation",
    );
  }
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

export class OpenAITranslationProvider implements TranslationProvider {
  readonly id = "openai" as const;

  async translateText(input: TranslateTextInput): Promise<TranslateTextOutput> {
    const model = MODEL_BY_LATENCY[input.latencyMode ?? "balanced"];
    const started = Date.now();

    // Glossary is prepended as "Preserve these translations" hints. OpenAI
    // respects explicit instructions well; no need for constrained decoding.
    const glossaryBlock = (input.glossary ?? [])
      .filter((g) => g.source && g.target)
      .map((g) => `- "${g.source}" → "${g.target}"`)
      .join("\n");

    const contextBlock = (input.context ?? []).slice(-4).join("\n");

    const system =
      `You are a professional live-call interpreter. Translate the user message from ` +
      `${input.sourceLang} to ${input.targetLang}. Preserve tone, formality, and any ` +
      `proper nouns. Output ONLY the translation — no preface, no commentary, no quotes.` +
      (glossaryBlock ? `\n\nPreserve these translations:\n${glossaryBlock}` : "") +
      (contextBlock ? `\n\nPrior turns for context:\n${contextBlock}` : "");

    const res = await openai().chat.completions.create({
      model,
      temperature: input.latencyMode === "accurate" ? 0.2 : 0.4,
      max_tokens: Math.max(64, Math.min(1024, input.text.length * 4)),
      messages: [
        { role: "system", content: system },
        { role: "user", content: input.text },
      ],
    });

    const translated = res.choices[0]?.message?.content?.trim() ?? "";
    const latencyMs = Date.now() - started;

    // Heuristic confidence: longer translations that closely match the source
    // length get higher scores; empty or tiny responses get demoted. Not a
    // substitute for a real quality model, but good enough for the UI warning.
    const confidence = scoreTranslation(input.text, translated);

    return { text: translated, confidence, latencyMs, provider: "openai" };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<LanguageDetection> {
    if (!input.text) return { code: "en-US", confidence: 0.5 };
    const sample = input.text.slice(0, 400);
    const res = await openai().chat.completions.create({
      model: env.OPENAI_MODEL_FALLBACK,
      temperature: 0,
      max_tokens: 16,
      messages: [
        {
          role: "system",
          content:
            "Identify the BCP-47 language tag of the following text (e.g. en-US, es-ES, fr-FR, hi-IN). Reply with ONLY the tag, nothing else.",
        },
        { role: "user", content: sample },
      ],
    });
    const code = res.choices[0]?.message?.content?.trim() ?? "en-US";
    const normalised = /^[a-z]{2}(-[A-Z]{2})?$/.test(code) ? code : "en-US";
    return { code: normalised, confidence: 0.85 };
  }
}

function scoreTranslation(source: string, target: string): number {
  if (!target) return 0.2;
  if (target.length < 2) return 0.3;
  const ratio = Math.min(target.length, source.length) / Math.max(target.length, source.length);
  // Penalise translations that are wildly shorter/longer than the source;
  // cap into [0.55, 0.94] so real confidence deltas still matter.
  return Math.max(0.55, Math.min(0.94, 0.6 + ratio * 0.3));
}
