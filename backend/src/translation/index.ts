import type { TranslationProvider as TranslationProviderId } from "@j2w/shared-types";
import { env } from "../env.js";
import { MockTranslationProvider } from "./mock.js";
import { OpenAITranslationProvider } from "./openai.js";
import {
  AzureTranslationProvider,
  DeepLTranslationProvider,
  GoogleTranslationProvider,
  SarvamTranslationProvider,
} from "./stubs.js";
import type { TranslationProvider } from "./provider.js";

// Factory: resolve a concrete adapter from its id. Real adapters are
// singletons (they hold HTTP clients); the mock is light enough to rebuild.
const openaiSingleton = new OpenAITranslationProvider();
const mockSingleton = new MockTranslationProvider();

export function getProvider(id: TranslationProviderId): TranslationProvider {
  switch (id) {
    case "mock":
      return mockSingleton;
    case "openai":
      // Fall back to the mock if OPENAI_API_KEY isn't set, so local dev
      // without a key still produces something the UI can render.
      return env.OPENAI_API_KEY ? openaiSingleton : mockSingleton;
    case "google":
      return GoogleTranslationProvider;
    case "deepl":
      return DeepLTranslationProvider;
    case "azure":
      return AzureTranslationProvider;
    case "sarvam":
      return SarvamTranslationProvider;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unknown translation provider: ${exhaustive}`);
    }
  }
}

export { NotImplementedError } from "./provider.js";
export type {
  TranslateTextInput,
  TranslateTextOutput,
  DetectLanguageInput,
  TranslationProvider,
} from "./provider.js";
