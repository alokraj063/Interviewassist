import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type {
  TranslationConfig,
  WorkspaceTranslationSettings,
} from "@j2w/shared-types";
import {
  DEFAULT_TRANSLATION_SETTINGS,
  TRANSLATION_SETTINGS_KEY,
  type TranslationSettings,
} from "@/lib/translationConfig";

// Bridges the Phase 1 local-only `TranslationSettings` shape to the Phase 2
// backend `WorkspaceTranslationSettings` shape. The web app continues to
// write localStorage as a cache (so Settings renders instantly) but the
// server is now the source of truth on refresh.
//
// Reconciliation rules:
//   - On mount: fetch /api/translation/settings. If it succeeds, it wins
//     and we replace localStorage. If it fails (offline / not signed in),
//     fall back to whatever localStorage has.
//   - On save: PUT /api/translation/settings; on success update local cache.
//     On failure, keep the local change so the form doesn't "jump back" —
//     the user can retry save.

function toServerShape(s: TranslationSettings): Partial<WorkspaceTranslationSettings> {
  return {
    provider: s.provider,
    model: s.model,
    defaultSourceLang: s.defaultSourceLang,
    defaultTargetLang: s.defaultTargetLang,
    latencyMode: s.latencyMode,
    preserveTone: s.preserveTone,
    voiceCloning: s.voiceCloning,
    confidenceThreshold: s.confidenceThreshold,
    lowConfidenceAction: s.lowConfidenceAction,
    glossaryId: s.glossaryId,
    redactPII: s.redactPII,
    profanityFilter: s.profanityFilter,
    customPhrases: s.customPhrases,
  };
}

function fromServerShape(s: WorkspaceTranslationSettings): TranslationSettings {
  return {
    provider: s.provider as TranslationSettings["provider"],
    model: s.model,
    defaultSourceLang: s.defaultSourceLang as TranslationSettings["defaultSourceLang"],
    defaultTargetLang: s.defaultTargetLang as TranslationSettings["defaultTargetLang"],
    // autoDetect is a UI-only mirror of defaultSourceLang === "auto" — server
    // doesn't track a separate bool. We keep the local flag so the Switch
    // survives round-trips cleanly.
    autoDetect: s.defaultSourceLang === "auto",
    latencyMode: s.latencyMode,
    preserveTone: s.preserveTone,
    voiceCloning: s.voiceCloning,
    confidenceThreshold: s.confidenceThreshold,
    lowConfidenceAction: s.lowConfidenceAction,
    glossaryId: s.glossaryId,
    redactPII: s.redactPII,
    profanityFilter: s.profanityFilter,
    customPhrases: s.customPhrases,
  };
}

export interface UseTranslationApi {
  settings: TranslationSettings;
  /** Optimistic local patch (no network call). */
  updateLocal: (patch: Partial<TranslationSettings>) => void;
  /** Persist the current settings to the server. Resolves false on failure. */
  save: () => Promise<boolean>;
  /** Reset to the bundled defaults (local only — call save() to sync). */
  reset: () => void;
  loading: boolean;
  saving: boolean;
  /** "api" if the server round-trip succeeded, "local" if we're offline. */
  source: "api" | "local";
  /** Last save error surfaced for UI toasts. */
  error: string | null;
}

function readCache(): TranslationSettings {
  try {
    const raw = window.localStorage.getItem(TRANSLATION_SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_TRANSLATION_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_TRANSLATION_SETTINGS;
}

function writeCache(s: TranslationSettings): void {
  try {
    window.localStorage.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function useTranslationApi(): UseTranslationApi {
  const [settings, setSettings] = useState<TranslationSettings>(() => readCache());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState<"api" | "local">("local");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ settings: WorkspaceTranslationSettings }>(
          "/api/translation/settings",
        );
        if (cancelled) return;
        const next = fromServerShape(res.settings);
        setSettings(next);
        writeCache(next);
        setSource("api");
      } catch {
        if (!cancelled) setSource("local");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateLocal = useCallback((patch: Partial<TranslationSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // Keep autoDetect in sync with defaultSourceLang so the Switch and
      // the Select never disagree.
      if (patch.defaultSourceLang != null) {
        next.autoDetect = patch.defaultSourceLang === "auto";
      } else if (patch.autoDetect === true) {
        next.defaultSourceLang = "auto";
      } else if (patch.autoDetect === false && prev.defaultSourceLang === "auto") {
        next.defaultSourceLang = "en-US";
      }
      writeCache(next);
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch<{ settings: WorkspaceTranslationSettings }>(
        "/api/translation/settings",
        { method: "PUT", json: toServerShape(settings) },
      );
      const next = fromServerShape(res.settings);
      setSettings(next);
      writeCache(next);
      setSource("api");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      setError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const reset = useCallback(() => {
    setSettings(DEFAULT_TRANSLATION_SETTINGS);
    writeCache(DEFAULT_TRANSLATION_SETTINGS);
  }, []);

  return { settings, updateLocal, save, reset, loading, saving, source, error };
}

// Thin wrapper for enabling/disabling translation on a specific call.
// Used by the LiveAssist page when the user toggles the Globe button or
// changes language pairs during an active call.
export async function enableCallTranslation(
  callId: string,
  body: {
    mode?: "inbound" | "bidirectional";
    sourceLang: string;
    targetLang: string;
    provider?: TranslationConfig["provider"];
    latencyMode?: TranslationConfig["latencyMode"];
    glossaryId?: string | null;
  },
): Promise<TranslationConfig> {
  const res = await apiFetch<{ config: TranslationConfig }>(
    `/api/calls/${callId}/translation/enable`,
    { method: "POST", json: body },
  );
  return res.config;
}

export async function disableCallTranslation(callId: string): Promise<void> {
  await apiFetch(`/api/calls/${callId}/translation/disable`, { method: "POST" });
}

export async function patchCallTranslation(
  callId: string,
  patch: Partial<{
    mode: "off" | "inbound" | "bidirectional";
    sourceLang: string;
    targetLang: string;
    latencyMode: TranslationConfig["latencyMode"];
    glossaryId: string | null;
  }>,
): Promise<TranslationConfig | null> {
  const res = await apiFetch<{ config: TranslationConfig | null }>(
    `/api/calls/${callId}/translation`,
    { method: "PATCH", json: patch },
  );
  return res.config;
}
