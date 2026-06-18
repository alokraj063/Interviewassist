import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  TRANSCRIPTION_SETTINGS_KEY,
  firstModelFor,
  type TranscriptionSettings,
} from "@/lib/transcriptionConfig";

// Mirrors the shape of useTranslationSettings so the Settings page and the
// CallBar quick-switcher can share a single persisted source of truth.

function load(): TranscriptionSettings {
  if (typeof window === "undefined") return DEFAULT_TRANSCRIPTION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(TRANSCRIPTION_SETTINGS_KEY);
    if (!raw) return DEFAULT_TRANSCRIPTION_SETTINGS;
    return {
      ...DEFAULT_TRANSCRIPTION_SETTINGS,
      ...(JSON.parse(raw) as Partial<TranscriptionSettings>),
    };
  } catch {
    return DEFAULT_TRANSCRIPTION_SETTINGS;
  }
}

function persist(settings: TranscriptionSettings) {
  try {
    window.localStorage.setItem(TRANSCRIPTION_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable — non-fatal
  }
}

export function useTranscriptionSettings(): [
  TranscriptionSettings,
  (patch: Partial<TranscriptionSettings>) => void,
  () => void,
] {
  const [settings, setSettings] = useState<TranscriptionSettings>(() => load());

  // Cross-tab sync so switching the provider in Settings updates the CallBar
  // badge without a full refresh.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== TRANSCRIPTION_SETTINGS_KEY) return;
      setSettings(load());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<TranscriptionSettings>) => {
    setSettings((prev) => {
      const next: TranscriptionSettings = { ...prev, ...patch };
      // Switching providers invalidates the previously selected model; fall
      // back to the new provider's default when the caller didn't set one.
      if (patch.provider && patch.provider !== prev.provider && !patch.model) {
        next.model = firstModelFor(patch.provider);
      }
      persist(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_TRANSCRIPTION_SETTINGS);
    try {
      window.localStorage.removeItem(TRANSCRIPTION_SETTINGS_KEY);
    } catch {
      // ignore
    }
  }, []);

  return [settings, update, reset];
}

/**
 * Read-only snapshot used by places that need the current provider without
 * subscribing to updates (e.g. the call-start handler). Falls back to the
 * default if localStorage is unavailable.
 */
export function readTranscriptionSettings(): TranscriptionSettings {
  return load();
}
