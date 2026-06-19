import { eq } from "drizzle-orm";
import {
  callTranslations,
  db,
  translationGlossaries,
  translationGlossaryEntries,
  workspaceTranslationSettings,
} from "@j2w/db";
import type {
  TranslationConfig,
  TranslationProvider as TranslationProviderId,
  WorkspaceTranslationSettings,
} from "@j2w/shared-types";

// Per-call runtime config for live translation. Held in memory (not the DB)
// because it changes often during a call and recreating it after a restart
// is cheap (the browser will POST /enable again when re-connecting).
const activeConfigs = new Map<string, TranslationConfig>();

export function getCallConfig(callId: string): TranslationConfig | null {
  return activeConfigs.get(callId) ?? null;
}

export function setCallConfig(config: TranslationConfig): void {
  activeConfigs.set(config.callId, config);
}

export function patchCallConfig(
  callId: string,
  patch: Partial<TranslationConfig>,
): TranslationConfig | null {
  const existing = activeConfigs.get(callId);
  if (!existing) return null;
  const next = { ...existing, ...patch, callId };
  activeConfigs.set(callId, next);
  return next;
}

export function clearCallConfig(callId: string): void {
  activeConfigs.delete(callId);
}

// ---------- Workspace settings ----------

export const DEFAULT_WORKSPACE_SETTINGS: Omit<WorkspaceTranslationSettings, "orgId" | "updatedAt"> = {
  provider: "mock",
  model: "mock-v1",
  defaultSourceLang: "auto",
  defaultTargetLang: "en-US",
  latencyMode: "balanced",
  preserveTone: true,
  voiceCloning: false,
  confidenceThreshold: 0.6,
  lowConfidenceAction: "show-warning",
  glossaryId: null,
  redactPII: false,
  profanityFilter: false,
  customPhrases: "",
};

export async function getWorkspaceSettings(
  orgId: string,
): Promise<WorkspaceTranslationSettings> {
  const [row] = await db
    .select()
    .from(workspaceTranslationSettings)
    .where(eq(workspaceTranslationSettings.orgId, orgId));
  if (!row) {
    return {
      orgId,
      updatedAt: new Date(0).toISOString(),
      ...DEFAULT_WORKSPACE_SETTINGS,
    };
  }
  return {
    orgId: row.orgId,
    provider: row.provider as TranslationProviderId,
    model: row.model,
    defaultSourceLang: row.defaultSourceLang,
    defaultTargetLang: row.defaultTargetLang,
    latencyMode: row.latencyMode,
    preserveTone: row.preserveTone,
    voiceCloning: row.voiceCloning,
    confidenceThreshold: row.confidenceThreshold,
    lowConfidenceAction: row.lowConfidenceAction,
    glossaryId: row.glossaryId,
    redactPII: row.redactPII,
    profanityFilter: row.profanityFilter,
    customPhrases: row.customPhrases,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveWorkspaceSettings(
  orgId: string,
  patch: Partial<Omit<WorkspaceTranslationSettings, "orgId" | "updatedAt">>,
): Promise<WorkspaceTranslationSettings> {
  const existing = await db
    .select()
    .from(workspaceTranslationSettings)
    .where(eq(workspaceTranslationSettings.orgId, orgId));

  const values = {
    orgId,
    provider: patch.provider ?? existing[0]?.provider ?? DEFAULT_WORKSPACE_SETTINGS.provider,
    model: patch.model ?? existing[0]?.model ?? DEFAULT_WORKSPACE_SETTINGS.model,
    defaultSourceLang:
      patch.defaultSourceLang ?? existing[0]?.defaultSourceLang ?? DEFAULT_WORKSPACE_SETTINGS.defaultSourceLang,
    defaultTargetLang:
      patch.defaultTargetLang ?? existing[0]?.defaultTargetLang ?? DEFAULT_WORKSPACE_SETTINGS.defaultTargetLang,
    latencyMode:
      patch.latencyMode ?? existing[0]?.latencyMode ?? DEFAULT_WORKSPACE_SETTINGS.latencyMode,
    preserveTone:
      patch.preserveTone ?? existing[0]?.preserveTone ?? DEFAULT_WORKSPACE_SETTINGS.preserveTone,
    voiceCloning:
      patch.voiceCloning ?? existing[0]?.voiceCloning ?? DEFAULT_WORKSPACE_SETTINGS.voiceCloning,
    confidenceThreshold:
      patch.confidenceThreshold ?? existing[0]?.confidenceThreshold ?? DEFAULT_WORKSPACE_SETTINGS.confidenceThreshold,
    lowConfidenceAction:
      patch.lowConfidenceAction ?? existing[0]?.lowConfidenceAction ?? DEFAULT_WORKSPACE_SETTINGS.lowConfidenceAction,
    glossaryId: patch.glossaryId !== undefined ? patch.glossaryId : existing[0]?.glossaryId ?? null,
    redactPII: patch.redactPII ?? existing[0]?.redactPII ?? DEFAULT_WORKSPACE_SETTINGS.redactPII,
    profanityFilter:
      patch.profanityFilter ?? existing[0]?.profanityFilter ?? DEFAULT_WORKSPACE_SETTINGS.profanityFilter,
    customPhrases:
      patch.customPhrases ?? existing[0]?.customPhrases ?? DEFAULT_WORKSPACE_SETTINGS.customPhrases,
    updatedAt: new Date(),
  };

  if (existing.length === 0) {
    await db.insert(workspaceTranslationSettings).values(values);
  } else {
    await db
      .update(workspaceTranslationSettings)
      .set(values)
      .where(eq(workspaceTranslationSettings.orgId, orgId));
  }

  return getWorkspaceSettings(orgId);
}

// ---------- Glossaries ----------

export async function loadGlossaryEntries(
  glossaryId: string | null,
  sourceLang: string,
  targetLang: string,
): Promise<Array<{ source: string; target: string }>> {
  if (!glossaryId) return [];
  const rows = await db
    .select({
      sourceText: translationGlossaryEntries.sourceText,
      targetText: translationGlossaryEntries.targetText,
      sourceLang: translationGlossaryEntries.sourceLang,
      targetLang: translationGlossaryEntries.targetLang,
    })
    .from(translationGlossaryEntries)
    .where(eq(translationGlossaryEntries.glossaryId, glossaryId));
  // Keep direction-scoped entries only when they match; universal entries
  // (both lang columns NULL) always pass through.
  return rows
    .filter(
      (r) =>
        (!r.sourceLang && !r.targetLang) ||
        (r.sourceLang === sourceLang && r.targetLang === targetLang),
    )
    .map((r) => ({ source: r.sourceText, target: r.targetText }));
}

export async function listGlossaries(orgId: string) {
  const rows = await db
    .select()
    .from(translationGlossaries)
    .where(eq(translationGlossaries.orgId, orgId));
  return rows;
}

export { translationGlossaries, translationGlossaryEntries, callTranslations };
