import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  TRANSLATION_SETTINGS_KEY,
  TRANSLATION_STORAGE_KEY,
  type SupportedLanguage,
  type TranslationDisplayMode,
  type TranslationMode,
  type TranslationSettings,
} from "@/lib/translationConfig";

export interface TranslationUIState {
  mode: TranslationMode;
  sourceLang: SupportedLanguage | "auto";
  targetLang: SupportedLanguage;
  displayMode: TranslationDisplayMode;
  showOutboundMeter: boolean;
}

const DEFAULT_STATE: TranslationUIState = {
  mode: "off",
  sourceLang: "auto",
  targetLang: "en-US",
  displayMode: "dual",
  showOutboundMeter: true,
};

function loadState(): TranslationUIState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(TRANSLATION_STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<TranslationUIState>) };
  } catch {
    return DEFAULT_STATE;
  }
}

function persistState(state: TranslationUIState) {
  try {
    window.localStorage.setItem(TRANSLATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — non-fatal
  }
}

export interface UseTranslationState extends TranslationUIState {
  isActive: boolean;
  enable: (overrides?: Partial<TranslationUIState>) => void;
  disable: () => void;
  toggle: () => void;
  setSourceLang: (lang: SupportedLanguage | "auto") => void;
  setTargetLang: (lang: SupportedLanguage) => void;
  setDisplayMode: (mode: TranslationDisplayMode) => void;
  setMode: (mode: TranslationMode) => void;
  swapLanguages: () => void;
}

export function useTranslationState(): UseTranslationState {
  const [state, setState] = useState<TranslationUIState>(() => loadState());

  useEffect(() => {
    persistState(state);
  }, [state]);

  const enable = useCallback((overrides?: Partial<TranslationUIState>) => {
    setState((prev) => ({
      ...prev,
      mode: overrides?.mode ?? (prev.mode === "off" ? "bidirectional" : prev.mode),
      ...overrides,
    }));
  }, []);

  const disable = useCallback(() => {
    setState((prev) => ({ ...prev, mode: "off" }));
  }, []);

  const toggle = useCallback(() => {
    setState((prev) => ({ ...prev, mode: prev.mode === "off" ? "bidirectional" : "off" }));
  }, []);

  const setSourceLang = useCallback((lang: SupportedLanguage | "auto") => {
    setState((prev) => ({ ...prev, sourceLang: lang }));
  }, []);

  const setTargetLang = useCallback((lang: SupportedLanguage) => {
    setState((prev) => ({ ...prev, targetLang: lang }));
  }, []);

  const setDisplayMode = useCallback((mode: TranslationDisplayMode) => {
    setState((prev) => ({ ...prev, displayMode: mode }));
  }, []);

  const setMode = useCallback((mode: TranslationMode) => {
    setState((prev) => ({ ...prev, mode }));
  }, []);

  const swapLanguages = useCallback(() => {
    setState((prev) => {
      if (prev.sourceLang === "auto") return prev;
      return {
        ...prev,
        sourceLang: prev.targetLang,
        targetLang: prev.sourceLang,
      };
    });
  }, []);

  return {
    ...state,
    isActive: state.mode !== "off",
    enable,
    disable,
    toggle,
    setSourceLang,
    setTargetLang,
    setDisplayMode,
    setMode,
    swapLanguages,
  };
}

function loadSettings(): TranslationSettings {
  if (typeof window === "undefined") return DEFAULT_TRANSLATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(TRANSLATION_SETTINGS_KEY);
    if (!raw) return DEFAULT_TRANSLATION_SETTINGS;
    return { ...DEFAULT_TRANSLATION_SETTINGS, ...(JSON.parse(raw) as Partial<TranslationSettings>) };
  } catch {
    return DEFAULT_TRANSLATION_SETTINGS;
  }
}

export function useTranslationSettings(): [
  TranslationSettings,
  (patch: Partial<TranslationSettings>) => void,
  () => void,
] {
  const [settings, setSettings] = useState<TranslationSettings>(() => loadSettings());

  const update = useCallback((patch: Partial<TranslationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_TRANSLATION_SETTINGS);
    try {
      window.localStorage.removeItem(TRANSLATION_SETTINGS_KEY);
    } catch {
      // ignore
    }
  }, []);

  return [settings, update, reset];
}
