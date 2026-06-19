// Upsert / disable / delete operations for tenant_integrations rows.
// Encryption happens here so route code never touches plaintext beyond the
// HTTP request body.
import { and, eq } from "drizzle-orm";
import { db, tenantIntegrations, type TenantIntegrationProvider } from "@j2w/db";
import { encryptSecret, type TenantIntegrationSecret } from "./encryption.js";

export async function upsertTenantIntegration(args: {
  orgId: string;
  provider: TenantIntegrationProvider;
  secret: TenantIntegrationSecret;
  enabled?: boolean;
  createdBy?: string | null;
}): Promise<void> {
  if (args.secret.provider !== args.provider) {
    throw new Error(`secret provider ${args.secret.provider} does not match ${args.provider}`);
  }
  const ciphertext = encryptSecret(args.secret);
  await db
    .insert(tenantIntegrations)
    .values({
      orgId: args.orgId,
      provider: args.provider,
      ciphertext,
      enabled: args.enabled ?? true,
      createdBy: args.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [tenantIntegrations.orgId, tenantIntegrations.provider],
      set: {
        ciphertext,
        enabled: args.enabled ?? true,
        updatedAt: new Date(),
      },
    });
}

export async function setTenantIntegrationEnabled(
  orgId: string,
  provider: TenantIntegrationProvider,
  enabled: boolean,
): Promise<boolean> {
  const result = await db
    .update(tenantIntegrations)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(tenantIntegrations.orgId, orgId), eq(tenantIntegrations.provider, provider)))
    .returning({ id: tenantIntegrations.id });
  return result.length > 0;
}

export async function deleteTenantIntegration(
  orgId: string,
  provider: TenantIntegrationProvider,
): Promise<boolean> {
  const result = await db
    .delete(tenantIntegrations)
    .where(and(eq(tenantIntegrations.orgId, orgId), eq(tenantIntegrations.provider, provider)))
    .returning({ id: tenantIntegrations.id });
  return result.length > 0;
}
