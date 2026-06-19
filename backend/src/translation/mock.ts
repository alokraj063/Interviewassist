import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageDetection } from "@j2w/shared-types";
import type {
  DetectLanguageInput,
  TranslateTextInput,
  TranslateTextOutput,
  TranslationProvider,
} from "./provider.js";

// Deterministic mock provider — the default for dev so nothing blows up when
// OPENAI_API_KEY is missing. Behaviour:
//
//   1. If the source text matches a canned fixture (by exact or prefix match),
//      return the pre-translated string at the fixture's recorded confidence.
//   2. Otherwise, mirror the source wrapped in [target-lang] brackets so you
//      can still see WS + persistence working end-to-end without a network
//      call. The confidence is pseudo-random but deterministic per input so
//      the same source always returns the same confidence (stable for tests).
//
// Fixtures live at apps/api/fixtures/translation/*.json so UI demos match the
// Phase 1 seed exactly. A fresh fixture file drops in without code changes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../fixtures/translation");

interface FixtureEntry {
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  confidence: number;
  latencyMs?: number;
}

interface FixtureFile {
  scenario: string;
  entries: FixtureEntry[];
}

let fixtureCache: FixtureEntry[] | null = null;

async function loadFixtures(): Promise<FixtureEntry[]> {
  if (fixtureCache) return fixtureCache;
  try {
    const files = await readFile(path.join(FIXTURES_DIR, "carlos-garcia.json"), "utf8");
    const parsed = JSON.parse(files) as FixtureFile;
    fixtureCache = parsed.entries ?? [];
  } catch {
    fixtureCache = [];
  }
  return fixtureCache;
}

function deterministicConfidence(text: string): number {
  // Simple djb2-style hash → [0.72, 0.96] — always plausible, never below the
  // default workspace confidence threshold so the UI doesn't flag mock output
  // as low-confidence. One deliberate exception lives in the fixture file.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return 0.72 + ((h % 2400) / 10_000);
}

function simulatedLatency(mode: TranslateTextInput["latencyMode"]): number {
  // Same ballpark as the frontend demo script so flipping latency modes feels
  // tangibly different in the UI.
  if (mode === "realtime") return 180 + Math.floor(Math.random() * 80);
  if (mode === "accurate") return 620 + Math.floor(Math.random() * 180);
  return 320 + Math.floor(Math.random() * 120);
}

function detectFromText(text: string): LanguageDetection {
  // Pure-ASCII heuristic: Spanish/French/etc. dial-words. Good enough to fake
  // language detection in dev without loading a model.
  const lower = text.toLowerCase();
  const CUES: Array<{ code: string; cues: RegExp }> = [
    { code: "es-ES", cues: /\b(hola|gracias|por favor|pero|está|también|muchas|ayuda)\b/ },
    { code: "fr-FR", cues: /\b(bonjour|merci|s'il vous plaît|pardon|aide|maintenant)\b/ },
    { code: "de-DE", cues: /\b(hallo|danke|bitte|hilfe|jetzt|nicht|funktioniert)\b/ },
    { code: "pt-BR", cues: /\b(olá|obrigado|obrigada|por favor|ajuda|não)\b/ },
    { code: "hi-IN", cues: /[ऀ-ॿ]/ },
    { code: "zh-CN", cues: /[一-鿿]/ },
    { code: "ja-JP", cues: /[぀-ヿ]/ },
    { code: "ar-SA", cues: /[؀-ۿ]/ },
  ];
  for (const { code, cues } of CUES) {
    if (cues.test(lower)) return { code, confidence: 0.88 };
  }
  return { code: "en-US", confidence: 0.9 };
}

export class MockTranslationProvider implements TranslationProvider {
  readonly id = "mock" as const;

  async translateText(input: TranslateTextInput): Promise<TranslateTextOutput> {
    const fixtures = await loadFixtures();
    const match = fixtures.find(
      (f) =>
        f.sourceLang === input.sourceLang &&
        f.targetLang === input.targetLang &&
        normalise(f.sourceText) === normalise(input.text),
    );

    const latencyMs = simulatedLatency(input.latencyMode);
    // Simulate the actual wait — lets the UI's "translating…" state be visible
    // and exercises the downstream latency-sensitive code paths for real.
    await new Promise((r) => setTimeout(r, latencyMs));

    if (match) {
      return {
        text: applyGlossary(match.targetText, input.glossary),
        confidence: match.confidence,
        latencyMs,
        provider: "mock",
      };
    }

    // Fallback: return the source text framed in brackets so the UI still
    // renders something human-readable instead of mojibake.
    const echoed = `[${input.targetLang}] ${input.text}`;
    return {
      text: applyGlossary(echoed, input.glossary),
      confidence: deterministicConfidence(input.text),
      latencyMs,
      provider: "mock",
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<LanguageDetection> {
    if (!input.text) return { code: "en-US", confidence: 0.5 };
    return detectFromText(input.text);
  }
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function applyGlossary(
  text: string,
  glossary?: Array<{ source: string; target: string }>,
): string {
  if (!glossary || glossary.length === 0) return text;
  let out = text;
  for (const { source, target } of glossary) {
    if (!source || !target) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(source)}\\b`, "gi");
    out = out.replace(pattern, target);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
