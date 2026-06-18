// Seed for the Live Assist page when demoing the live-translation feature.
// Scenario: Spanish-speaking customer in Madrid with an HP Pavilion boot issue,
// agent speaks English only. Mirrors the dramatic arc of the Hinglish seed
// (frustration -> fix -> relief) so the sentiment curve still reads correctly.
import type { Citation } from "@j2w/shared-types";
import type { LiveAssistSeed } from "@/lib/liveAssistDemo";
import type { Suggestion } from "@/hooks/useLiveCall";
import type { TranslatedTurn } from "@/lib/translationConfig";
import type { DemoCustomer } from "@/lib/liveAssistDemo";

const DEMO_CALL_ID = "demo-hp-laptop-es";

export const demoTranslationCustomer: DemoCustomer = {
  name: "Carlos García",
  accountId: "ACC-91204",
  product: "HP Pavilion 15-eg2xxx",
  warranty: "Active · expires 2027-02-18",
  location: "Madrid, España",
  phone: "+34 6•• •• •• 42",
  email: "carlos.garcia@example.es",
  priorTickets: [
    { id: "INC-50118", subject: "Adaptador cargador no reconocido", date: "2026-01-22" },
    { id: "INC-51744", subject: "Pantalla parpadea al arrancar", date: "2026-03-04" },
  ],
  tags: ["Priority", "Spanish"],
};

export const demoTranslatedTurns: TranslatedTurn[] = [
  {
    id: 1,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Hola, mi portátil HP no se enciende. La luz de encendido se ilumina pero la pantalla se queda en negro.",
    isFinal: true,
    tsStartMs: 0,
    tsEndMs: 5600,
    sentiment: -0.55,
    translation: {
      sourceLang: "es-ES",
      targetLang: "en-US",
      text: "Hi, my HP laptop won't turn on. The power light comes on but the screen stays black.",
      isFinal: true,
      confidence: 0.94,
      latencyMs: 320,
    },
  },
  {
    id: 2,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "I'm really sorry to hear that, Carlos. I'll help you get this sorted. When was the last time it worked normally?",
    isFinal: true,
    tsStartMs: 5800,
    tsEndMs: 11400,
    sentiment: 0.15,
    translation: {
      sourceLang: "en-US",
      targetLang: "es-ES",
      text: "Lo siento mucho, Carlos. Voy a ayudarte a resolverlo. ¿Cuándo fue la última vez que funcionó con normalidad?",
      isFinal: true,
      confidence: 0.93,
      latencyMs: 280,
    },
  },
  {
    id: 3,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Anoche funcionaba perfectamente. Por la mañana me salió un aviso de actualización de la BIOS, y después ya no arranca.",
    isFinal: true,
    tsStartMs: 11800,
    tsEndMs: 18400,
    sentiment: -0.5,
    translation: {
      sourceLang: "es-ES",
      targetLang: "en-US",
      text: "It was working perfectly last night. This morning I got a BIOS update prompt, and after installing it the laptop won't boot.",
      isFinal: true,
      confidence: 0.91,
      latencyMs: 410,
    },
  },
  {
    id: 4,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "Got it. A hard reset after a BIOS update usually works. Your data will be safe — don't worry.",
    isFinal: true,
    tsStartMs: 18800,
    tsEndMs: 24600,
    sentiment: 0.3,
    translation: {
      sourceLang: "en-US",
      targetLang: "es-ES",
      text: "Entendido. Después de una actualización de BIOS, un reinicio forzado suele funcionar. Tus datos están a salvo, no te preocupes.",
      isFinal: true,
      confidence: 0.95,
      latencyMs: 260,
    },
  },
  {
    id: 5,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Vale, pero la batería no es extraíble. ¿Qué tengo que hacer exactamente? Lo necesito para trabajar.",
    isFinal: true,
    tsStartMs: 25000,
    tsEndMs: 30200,
    sentiment: -0.25,
    translation: {
      sourceLang: "es-ES",
      targetLang: "en-US",
      // Intentionally lower-confidence turn to trigger the "Review original"
      // warning — makes the demo feel honest about model fallibility.
      text: "Okay, but the battery isn't removable. What exactly do I need to do? I need it for work.",
      isFinal: true,
      confidence: 0.52,
      latencyMs: 540,
    },
  },
  {
    id: 6,
    callId: DEMO_CALL_ID,
    speaker: "recruiter",
    text: "Unplug the power adapter, then hold the power button down for 30 seconds. That drains the residual charge. Plug it back in and try to boot.",
    isFinal: true,
    tsStartMs: 30400,
    tsEndMs: 38800,
    sentiment: 0.2,
    translation: {
      sourceLang: "en-US",
      targetLang: "es-ES",
      text: "Desconecta el cargador y mantén pulsado el botón de encendido durante 30 segundos. Eso descarga la carga residual. Vuelve a conectarlo e intenta arrancar.",
      isFinal: true,
      confidence: 0.96,
      latencyMs: 240,
    },
  },
  {
    id: 7,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "Vale, lo intento. Espera un momento, por favor.",
    isFinal: true,
    tsStartMs: 39000,
    tsEndMs: 42000,
    sentiment: 0.05,
    translation: {
      sourceLang: "es-ES",
      targetLang: "en-US",
      text: "Okay, I'll try it. Hold on a moment, please.",
      isFinal: true,
      confidence: 0.97,
      latencyMs: 210,
    },
  },
  {
    id: 8,
    callId: DEMO_CALL_ID,
    speaker: "candidate",
    text: "¡Sí! Ya ha arrancado, puedo ver la pantalla. Muchísimas gracias. ¿Y si me vuelve a pasar en el futuro? Tengo garantía, ¿no?",
    isFinal: true,
    tsStartMs: 58400,
    tsEndMs: 65200,
    sentiment: 0.7,
    translation: {
      sourceLang: "es-ES",
      targetLang: "en-US",
      text: "Yes! It booted, I can see the screen. Thank you so much. What if it happens again? I'm still under warranty, right?",
      isFinal: true,
      confidence: 0.93,
      latencyMs: 300,
    },
  },
];

export const demoTranslationSentimentSeries: Array<{ t: number; v: number }> = (() => {
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < 18; i++) {
    const phase = i / 17;
    const dip = 54 - 30 * Math.exp(-((phase - 0.24) ** 2) / 0.035);
    const recover = phase > 0.55 ? (phase - 0.55) * 58 : 0;
    const v = Math.round(Math.max(20, Math.min(86, dip + recover)));
    out.push({ t: i, v });
  }
  return out;
})();

export const demoTranslationCitations: Citation[] = [
  {
    chunkId: 910001,
    sourceId: "src-hp-kb",
    sourceName: "HP Support KB",
    documentId: "doc-bios-reset",
    documentTitle: "HP Notebook BIOS recovery / reset",
    snippet:
      "Disconnect AC adapter, press and hold the Power button for 30 seconds to drain residual charge, then reconnect and boot.",
    score: 0.92,
  },
  {
    chunkId: 910002,
    sourceId: "src-j2w-warranty-eu",
    sourceName: "J2W Warranty (EU)",
    documentId: "doc-eu-warranty",
    documentTitle: "EU consumer warranty — hardware replacement triggers",
    snippet:
      "EU consumer law guarantees 2-year warranty. Replacement qualifies if the same root cause is logged twice within 30 days.",
    score: 0.76,
  },
];

export const demoTranslationSuggestions: Suggestion[] = [
  {
    requestId: "demo-sug-es-1",
    triggerTurnId: 3,
    text:
      "Walk Carlos through the HP hard-reset: unplug AC, hold Power for 30 seconds, reconnect and boot. Reassure him no data is lost.",
    payload: {
      suggestion:
        "Walk Carlos through the HP hard-reset: unplug AC, hold Power for 30 seconds, reconnect and boot. Reassure him no data is lost.",
      sentiment: -0.4,
      topics: ["BIOS update", "Boot failure", "HP Pavilion"],
      complianceFlags: [],
      citations: [demoTranslationCitations[0]],
      confidence: 0.84,
    },
    latencyMs: 1180,
    done: true,
  },
];

export const demoTranslationTopics: Array<{ name: string; confidence: number }> = [
  { name: "BIOS update", confidence: 0.89 },
  { name: "Boot failure", confidence: 0.82 },
  { name: "HP Pavilion 15", confidence: 0.75 },
  { name: "EU warranty", confidence: 0.48 },
];

export const demoTranslationCompliance: Array<{
  id: string;
  label: string;
  ok: boolean;
  ts?: number;
}> = [
  { id: "disclosure", label: "Recording disclosure", ok: true, ts: 2_800 },
  { id: "identity", label: "Identity verified", ok: true, ts: 9_100 },
  { id: "language_consent", label: "Translation consent", ok: true, ts: 4_600 },
  { id: "fees", label: "Fee disclosure", ok: false },
];

export const demoTranslationElapsed = Math.floor(
  demoTranslatedTurns[demoTranslatedTurns.length - 1].tsEndMs / 1000,
);

// Extra scripted turns played after the user clicks "Start Test Call" on the
// Spanish scenario, so the demo still feels live-wired when they press play.
export interface ScriptedTranslationStep {
  delayMs: number;
  speaker: "candidate" | "recruiter";
  partial: string;
  partialTranslation: string;
  final: string;
  finalTranslation: string;
  confidence: number;
}

export const demoTranslationScript: ScriptedTranslationStep[] = [
  {
    delayMs: 2400,
    speaker: "candidate",
    partial: "Perfecto, todo funciona de nuevo",
    partialTranslation: "Great, everything works again",
    final: "Perfecto, todo funciona de nuevo. ¿Podemos actualizar mi cuenta con este incidente?",
    finalTranslation: "Great, everything works again. Can we update my account with this incident?",
    confidence: 0.94,
  },
  {
    delayMs: 6200,
    speaker: "recruiter",
    partial: "Of course, I'll log it",
    partialTranslation: "Por supuesto, lo registraré",
    final: "Of course, I'll log the incident and link it to your warranty case so it's on record.",
    finalTranslation: "Por supuesto, registraré el incidente y lo vincularé a tu caso de garantía para que quede constancia.",
    confidence: 0.96,
  },
  {
    delayMs: 11800,
    speaker: "candidate",
    partial: "Muchas gracias",
    partialTranslation: "Thank you very much",
    final: "Muchas gracias por tu ayuda. Un servicio excelente, de verdad.",
    finalTranslation: "Thank you very much for your help. Truly excellent service.",
    confidence: 0.95,
  },
];

export interface LiveAssistTranslationSeed extends LiveAssistSeed {
  turns: TranslatedTurn[];
  translation: {
    sourceLang: "es-ES";
    targetLang: "en-US";
    script: ScriptedTranslationStep[];
  };
}

export const liveAssistTranslationSeed: LiveAssistTranslationSeed = {
  turns: demoTranslatedTurns,
  sentimentSeries: demoTranslationSentimentSeries,
  sentiment: demoTranslationSentimentSeries[demoTranslationSentimentSeries.length - 1].v,
  topics: demoTranslationTopics,
  compliance: demoTranslationCompliance,
  suggestions: demoTranslationSuggestions,
  citations: demoTranslationCitations,
  elapsed: demoTranslationElapsed,
  translation: {
    sourceLang: "es-ES",
    targetLang: "en-US",
    script: demoTranslationScript,
  },
};
