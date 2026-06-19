// Per-tenant integration credential resolver.
//
// Lookup order:
//   1. tenant_integrations row for (orgId, provider) where enabled=true → decrypt.
//   2. Fall back to env vars (legacy single-tenant behavior). Keeps dev frictionless
//      and lets a deployment run as "house account" for tenants that haven't
//      configured their own keys.
//   3. null — caller must respond with a "provider_not_configured"-shaped error.
//
// Callers should treat the returned credentials as opaque — pass them straight
// into the upstream client. Plaintext must never appear in API responses or logs.
import { and, eq } from "drizzle-orm";
import { db, tenantIntegrations, type TenantIntegrationProvider } from "@j2w/db";
import { env } from "../env.js";
import {
  decryptSecret,
  type DeepgramSecret,
  type RekognitionSecret,
  type SarvamSecret,
  type ShunyaSecret,
  type TenantIntegrationSecret,
  type VapiSecret,
} from "./encryption.js";

type SecretFor<P extends TenantIntegrationProvider> = P extends "vapi"
  ? VapiSecret
  : P extends "deepgram"
    ? DeepgramSecret
    : P extends "sarvam"
      ? SarvamSecret
      : P extends "shunya"
        ? ShunyaSecret
        : P extends "rekognition"
          ? RekognitionSecret
          : never;

export async function getProviderCredentials<P extends TenantIntegrationProvider>(
  orgId: string,
  provider: P,
): Promise<SecretFor<P> | null> {
  // 1) Tenant-stored row.
  const [row] = await db
    .select({ ciphertext: tenantIntegrations.ciphertext, enabled: tenantIntegrations.enabled })
    .from(tenantIntegrations)
    .where(and(eq(tenantIntegrations.orgId, orgId), eq(tenantIntegrations.provider, provider)));
  if (row?.enabled) {
    const secret = decryptSecret<TenantIntegrationSecret>(row.ciphertext);
    if (secret.provider === provider) return secret as SecretFor<P>;
  }
  // 2) Env fallback.
  const fallback = envFallback(provider);
  if (fallback) return fallback as SecretFor<P>;
  // 3) Nothing configured.
  return null;
}

function envFallback(provider: TenantIntegrationProvider): TenantIntegrationSecret | null {
  switch (provider) {
    case "vapi":
      return env.VAPI_API_KEY
        ? {
            provider: "vapi",
            apiKey: env.VAPI_API_KEY,
            publicKey: env.VAPI_PUBLIC_KEY,
            webhookSecret: env.VAPI_WEBHOOK_SECRET,
          }
        : null;
    case "deepgram":
      return env.DEEPGRAM_API_KEY ? { provider: "deepgram", apiKey: env.DEEPGRAM_API_KEY } : null;
    case "sarvam":
      return env.SARVAM_API_SUBSCRIPTION_KEY
        ? { provider: "sarvam", apiSubscriptionKey: env.SARVAM_API_SUBSCRIPTION_KEY }
        : null;
    case "shunya":
      return env.SHUNYA_API_KEY ? { provider: "shunya", apiKey: env.SHUNYA_API_KEY } : null;
    case "rekognition":
      return env.AWS_REKOGNITION_ACCESS_KEY_ID && env.AWS_REKOGNITION_SECRET_ACCESS_KEY
        ? {
            provider: "rekognition",
            accessKeyId: env.AWS_REKOGNITION_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_REKOGNITION_SECRET_ACCESS_KEY,
            region: env.AWS_REKOGNITION_REGION,
          }
        : null;
  }
}

// Lists which providers a tenant has explicitly configured (regardless of
// whether they're enabled). Used by the platform/integrations UI; never returns
// plaintext.
export async function listTenantIntegrations(orgId: string): Promise<
  Array<{
    provider: TenantIntegrationProvider;
    enabled: boolean;
    updatedAt: Date;
  }>
> {
  const rows = await db
    .select({
      provider: tenantIntegrations.provider,
      enabled: tenantIntegrations.enabled,
      updatedAt: tenantIntegrations.updatedAt,
    })
    .from(tenantIntegrations)
    .where(eq(tenantIntegrations.orgId, orgId));
  return rows.map((r) => ({
    provider: r.provider as TenantIntegrationProvider,
    enabled: r.enabled,
    updatedAt: r.updatedAt,
  }));
}
