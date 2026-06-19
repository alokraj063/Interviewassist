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
import { env } from "../env.js";

export type TenantIntegrationProvider = "vapi" | "deepgram" | "sarvam" | "shunya" | "rekognition";
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

// Multi-tenant per-org credentials were dropped along with the rest of the
// org/clients machinery; this service now runs as a single shared tenant so
// every provider resolves from process env. The orgId argument is kept for
// call-site compatibility but ignored.
export async function getProviderCredentials<P extends TenantIntegrationProvider>(
  _orgId: string,
  provider: P,
): Promise<SecretFor<P> | null> {
  void decryptSecret;
  void _orgId;
  const fallback = envFallback(provider);
  if (fallback) return fallback as SecretFor<P>;
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

// `listTenantIntegrations` used to query the per-tenant `tenant_integrations`
// SQL table. With multi-tenant gone we just report what the env exposes — the
// platform UI that consumed this is also gone, but the export stays to avoid
// a breaking change for any background script that still imports it.
export async function listTenantIntegrations(_orgId: string): Promise<
  Array<{ provider: TenantIntegrationProvider; enabled: boolean; updatedAt: Date }>
> {
  void _orgId;
  return [];
}
