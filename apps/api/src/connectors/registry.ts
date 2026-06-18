// Connector registry. Resolves a Connector for a given (orgId, providerKey)
// by checking tenant_integrations status and falling back to a per-key
// mock connector so the UI works without real API keys.
//
// Real provider modules (naukri, linkedin, whatsapp, exotel, greenhouse,
// workday) plug in here behind a per-key entry. For now everything routes
// to the mock provider.
import { createMockConnector, mockConnector } from "./mock.js";
import type { Connector } from "./types.js";

const KNOWN_KEYS = [
  "mock",
  "naukri",
  "linkedin",
  "whatsapp",
  "exotel",
  "greenhouse",
  "workday",
] as const;
export type ConnectorKey = (typeof KNOWN_KEYS)[number];

export const KNOWN_CONNECTOR_KEYS = KNOWN_KEYS;

const DISPLAY: Record<ConnectorKey, string> = {
  mock: "Mock pool",
  naukri: "Naukri",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  exotel: "Exotel",
  greenhouse: "Greenhouse",
  workday: "Workday",
};

// In-memory cache so each connector instance is reused across requests.
const cache = new Map<string, Connector>();

export async function getConnector(orgId: string, key: ConnectorKey): Promise<Connector> {
  const cacheKey = `${orgId}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  // TODO: when real providers are added, branch on key and check
  // tenant_integrations for credentials. For every unknown/unconfigured
  // key today, return a mock instance scoped to that key so deterministic
  // fake data still varies by source.
  if (key === "mock") {
    cache.set(cacheKey, mockConnector);
    return mockConnector;
  }
  const c = createMockConnector(key, DISPLAY[key]);
  cache.set(cacheKey, c);
  return c;
}

export function listKnownConnectors(): Array<{ key: ConnectorKey; displayName: string }> {
  return KNOWN_KEYS.map((k) => ({ key: k, displayName: DISPLAY[k] }));
}
