import type { FastifyBaseLogger } from "fastify";
import { callTranslations, db } from "@j2w/db";
import type { Speaker, TranscriptTurn } from "@j2w/shared-types";
import { broadcastToCall } from "../ws/session.js";
import { getProvider, NotImplementedError } from "./index.js";
import { getCallConfig, loadGlossaryEntries, patchCallConfig } from "./state.js";

// Rolling-context per call: last 4 turns of source text help the provider keep
// pronouns, register, and domain terms consistent. Cleared on call end.
const callContext = new Map<string, string[]>();

function pushContext(callId: string, text: string): string[] {
  const existing = callContext.get(callId) ?? [];
  existing.push(text);
  while (existing.length > 4) existing.shift();
  callContext.set(callId, existing);
  return existing;
}

export function clearCallContext(callId: string): void {
  callContext.delete(callId);
}

interface TranslateTurnArgs {
  callId: string;
  turn: TranscriptTurn;
  log: FastifyBaseLogger;
}

// Called from every place that lands a final transcript turn (today:
// routes/calls.ts and deepgram/stream.ts). When translation is disabled for
// the call, this is a no-op; otherwise it translates, broadcasts the result,
// and persists a call_translations row.
export async function translateTurnIfEnabled({
  callId,
  turn,
  log,
}: TranslateTurnArgs): Promise<void> {
  const config = getCallConfig(callId);
  if (!config || config.mode === "off") return;

  // Inbound-only mode skips the recruiter half of the conversation.
  if (config.mode === "inbound" && turn.speaker === "recruiter") return;

  const isCustomer = turn.speaker === "candidate" || turn.speaker === "unknown";
  const sourceLang = resolveSourceLang(config, turn.speaker);
  const targetLang = resolveTargetLang(config, turn.speaker);

  // Auto-detect on the first customer utterance when sourceLang was left as
  // "auto". We emit language.detected so the UI strip updates the source pill.
  if (isCustomer && config.sourceLang === "auto" && !config.detectedSourceLang) {
    try {
      const provider = getProvider(config.provider);
      const detection = await provider.detectLanguage({ text: turn.text });
      patchCallConfig(callId, { detectedSourceLang: detection });
      broadcastToCall(callId, {
        type: "language.detected",
        callId,
        code: detection.code,
        confidence: detection.confidence,
        alternates: detection.alternates,
      });
    } catch (err) {
      log.warn({ err, callId }, "language detection failed; keeping default");
    }
  }

  const finalSourceLang = resolveSourceLang(getCallConfig(callId) ?? config, turn.speaker);

  // Signal "translating…" immediately so the UI can animate a partial while
  // the provider call is in flight. Provider latency can be hundreds of ms.
  broadcastToCall(callId, {
    type: "translation.partial",
    turnId: turn.id,
    speaker: turn.speaker,
    sourceLang: finalSourceLang,
    targetLang,
    text: "",
  });

  try {
    const provider = getProvider(config.provider);
    const glossary = await loadGlossaryEntries(config.glossaryId, finalSourceLang, targetLang);
    const context = pushContext(callId, turn.text);

    const result = await provider.translateText({
      text: turn.text,
      sourceLang: finalSourceLang,
      targetLang,
      glossary,
      latencyMode: config.latencyMode,
      context,
    });

    broadcastToCall(callId, {
      type: "translation.final",
      turnId: turn.id,
      speaker: turn.speaker,
      sourceLang: finalSourceLang,
      targetLang,
      text: result.text,
      confidence: result.confidence,
      latencyMs: result.latencyMs,
      provider: result.provider,
    });

    if (turn.id >= 0) {
      try {
        await db.insert(callTranslations).values({
          callId,
          turnId: turn.id,
          speaker: turn.speaker as Speaker,
          sourceLang: finalSourceLang,
          sourceText: turn.text,
          targetLang,
          targetText: result.text,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
          provider: result.provider,
        });
      } catch (err) {
        log.warn({ err, callId, turnId: turn.id }, "failed to persist call_translation row");
      }
    }
  } catch (err) {
    if (err instanceof NotImplementedError) {
      log.warn(
        { err: err.message, callId, provider: config.provider },
        "translation provider not implemented",
      );
      broadcastToCall(callId, {
        type: "error",
        message: `Translation provider "${config.provider}" is not wired yet — switch to mock or openai in Settings → Translation.`,
      });
    } else {
      log.error({ err, callId }, "translation failed");
      broadcastToCall(callId, {
        type: "error",
        message: "Translation failed — see server logs.",
      });
    }
  }
}

// Direction rules: a translation always goes from the speaker's language
// to "the other side". Candidate turns (and unknown / mixed mono) go
// `sourceLang → targetLang` (what the recruiter reads); recruiter turns
// go `targetLang → sourceLang` (what the candidate would hear in
// bidirectional mode).
function speakerIsCandidateSide(speaker: Speaker): boolean {
  return speaker === "candidate" || speaker === "unknown" || speaker === "mixed";
}

function resolveSourceLang(
  config: ReturnType<typeof getCallConfig> & object,
  speaker: Speaker,
): string {
  const base =
    config.detectedSourceLang?.code ??
    (config.sourceLang === "auto" ? "es-ES" : config.sourceLang);
  return speakerIsCandidateSide(speaker) ? base : config.targetLang;
}

function resolveTargetLang(
  config: ReturnType<typeof getCallConfig> & object,
  speaker: Speaker,
): string {
  const caller =
    config.detectedSourceLang?.code ??
    (config.sourceLang === "auto" ? "es-ES" : config.sourceLang);
  return speakerIsCandidateSide(speaker) ? config.targetLang : caller;
}
