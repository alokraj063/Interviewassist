import type { LanguageDetection, TranslationProvider as TranslationProviderId } from "@j2w/shared-types";
import {
  NotImplementedError,
  type DetectLanguageInput,
  type TranslateTextInput,
  type TranslateTextOutput,
  type TranslationProvider,
} from "./provider.js";

// Placeholder adapters for vendors we plan to support but haven't wired yet.
// They all throw NotImplementedError so the REST layer can return a clean
// 501 instead of a mysterious runtime crash. Drop in the real adapter and
// the factory picks it up automatically.
//
// When implementing a real adapter:
//   1. Add the vendor credential(s) to apps/api/src/env.ts.
//   2. Replace this placeholder with a class that implements TranslationProvider.
//   3. Register it in apps/api/src/translation/index.ts::getProvider.

function makeStub(id: TranslationProviderId): TranslationProvider {
  return {
    id,
    translateText(_input: TranslateTextInput): Promise<TranslateTextOutput> {
      throw new NotImplementedError(id, "translateText");
    },
    detectLanguage(_input: DetectLanguageInput): Promise<LanguageDetection> {
      throw new NotImplementedError(id, "detectLanguage");
    },
  };
}

export const GoogleTranslationProvider = makeStub("google");
export const DeepLTranslationProvider = makeStub("deepl");
export const AzureTranslationProvider = makeStub("azure");
export const SarvamTranslationProvider = makeStub("sarvam");
