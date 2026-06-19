// Super-admin (platform admin) routes. Gated by `requirePlatformAdmin`.
//
// What this exposes:
//   - GET    /orgs              — list every tenant
//   - POST   /orgs              — create a tenant + invite its first admin
//   - GET    /orgs/:id          — tenant detail (read-only): users, voice agents, KB
//   - PATCH  /orgs/:id          — rename, set/clear suspension
//   - GET    /orgs/:id/integrations — which providers are configured (no plaintext)
//   - PUT    /orgs/:id/integrations/:provider — set or rotate credentials
//   - DELETE /orgs/:id/integrations/:provider — remove credentials
//
// Read-only debug surface intentionally — no mutate-on-tenant endpoints. To
// take destructive action against a tenant's data, the platform admin still
// has to be invited as a member of that tenant.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  invitations,
  kbSources,
  memberships,
  organizations,
  tenantIntegrations,
  users,
  voiceAgents,
  type TenantIntegrationProvider,
} from "@j2w/db";
import { hashToken, randomToken } from "../auth/tokens.js";
import {
  seedRolePermissionsFromDefault,
  slugifyName,
  uniqueOrgSlug,
} from "../auth/orgs.js";
import { sendInvitationEmail } from "../email/send.js";
import { listTenantIntegrations } from "../integrations/resolver.js";
import {
  deleteTenantIntegration,
  setTenantIntegrationEnabled,
  upsertTenantIntegration,
} from "../integrations/store.js";
import type {
  DeepgramSecret,
  SarvamSecret,
  ShunyaSecret,
  TenantIntegrationSecret,
  VapiSecret,
} from "../integrations/encryption.js";

// ---------- schemas ----------

const PROVIDERS = ["vapi", "deepgram", "sarvam", "shunya"] as const;

const createOrgSchema = z.object({
  name: z.string().min(1).max(200),
  adminEmail: z.string().email().trim().toLowerCase(),
  adminName: z.string().min(1).max(200).optional(),
});

const patchOrgSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    suspended: z.boolean().optional(),
  })
  .strict();

const vapiSecretSchema = z.object({
  apiKey: z.string().min(8).max(500),
  publicKey: z.string().min(1).max(500).optional(),
  webhookSecret: z.string().min(8).max(500).optional(),
});
const deepgramSecretSchema = z.object({ apiKey: z.string().min(8).max(500) });
const sarvamSecretSchema = z.object({ apiSubscriptionKey: z.string().min(8).max(500) });
const shunyaSecretSchema = z.object({ apiKey: z.string().min(8).max(500) });

const integrationBodySchema = z.object({
  enabled: z.boolean().optional(),
  // Discriminated by URL param `:provider`. Only one of the field unions
  // applies; we validate against the right one inside the handler.
  vapi: vapiSecretSchema.optional(),
  deepgram: deepgramSecretSchema.optional(),
  sarvam: sarvamSecretSchema.optional(),
  shunya: shunyaSecretSchema.optional(),
});

// ---------- routes ----------

export async function platformRoutes(app: FastifyInstance) {
  const platformAuth = { preHandler: [app.authenticate, app.requirePlatformAdmin] };

  // ---- list tenants
  app.get("/orgs", platformAuth, async () => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        createdAt: organizations.createdAt,
        memberCount: sql<number>`(
          SELECT COUNT(*)::int FROM memberships
           WHERE memberships.org_id = organizations.id
             AND memberships.status = 'active'
        )`,
        kbSourceCount: sql<number>`(
          SELECT COUNT(*)::int FROM kb_sources WHERE kb_sources.org_id = organizations.id
        )`,
        voiceAgentCount: sql<number>`(
          SELECT COUNT(*)::int FROM voice_agents WHERE voice_agents.org_id = organizations.id
        )`,
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt));
    return { orgs: rows };
  });

  // ---- create tenant + invite first admin
  app.post("/orgs", platformAuth, async (req, reply) => {
    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const { name, adminEmail, adminName } = parsed.data;
    const platformActor = req.authUser!;

    // Block creating a duplicate org for an email that's already a member of
    // some tenant — single-membership-per-email is the design rule.
    const [existingUser] = await db.select().from(users).where(eq(users.email, adminEmail));
    if (existingUser) {
      const [member] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, existingUser.id));
      if (member) {
        return reply.code(409).send({ error: "email_already_in_a_tenant" });
      }
    }

    const slug = await uniqueOrgSlug(slugifyName(name));
    const [org] = await db
      .insert(organizations)
      .values({ name, slug })
      .returning({ id: organizations.id, name: organizations.name, slug: organizations.slug });

    await seedRolePermissionsFromDefault(org.id);

    // Issue an invitation rather than creating the user directly — they set
    // their own password at /accept-invite.
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(invitations).values({
      orgId: org.id,
      email: adminEmail,
      role: "admin",
      tokenHash: hashToken(token),
      invitedBy: platformActor.id,
      expiresAt,
    });

    try {
      await sendInvitationEmail(
        {
          to: adminEmail,
          inviterName: platformActor.name ?? "Platform admin",
          orgName: org.name,
          role: "admin",
          token,
        },
        req.log,
      );
    } catch (err) {
      req.log.error({ err }, "failed to send platform-provisioned invitation email");
    }

    return {
      org,
      invitation: { email: adminEmail, expiresAt, name: adminName ?? null },
    };
  });

  // ---- tenant detail (read-only)
  app.get("/orgs/:id", platformAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    if (!org) return reply.code(404).send({ error: "not_found" });

    const memberRows = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        status: memberships.status,
        joinedAt: memberships.joinedAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, id))
      .orderBy(memberships.joinedAt);

    const kbCount = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(kbSources)
      .where(eq(kbSources.orgId, id)))[0]?.n ?? 0;

    const agentCount = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(voiceAgents)
      .where(eq(voiceAgents.orgId, id)))[0]?.n ?? 0;

    return {
      org,
      members: memberRows,
      counts: { kbSources: kbCount, voiceAgents: agentCount },
    };
  });

  // ---- patch tenant (rename / suspend) — minimum-viable mutate
  app.patch("/orgs/:id", platformAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const updates: Record<string, unknown> = {};
    if (parsed.data.name) updates.name = parsed.data.name;
    if (Object.keys(updates).length > 0) {
      await db.update(organizations).set(updates).where(eq(organizations.id, id));
    }
    if (typeof parsed.data.suspended === "boolean") {
      // Suspending an org = suspending every active membership. Reversible.
      await db
        .update(memberships)
        .set({ status: parsed.data.suspended ? "suspended" : "active" })
        .where(
          and(
            eq(memberships.orgId, id),
            eq(memberships.status, parsed.data.suspended ? "active" : "suspended"),
          ),
        );
    }
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    return { org };
  });

  // ---- list a tenant's configured integrations
  app.get("/orgs/:id/integrations", platformAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));
    if (!org) return reply.code(404).send({ error: "not_found" });
    const rows = await listTenantIntegrations(id);
    return { integrations: rows };
  });

  // ---- upsert credentials for a provider
  app.put("/orgs/:id/integrations/:provider", platformAuth, async (req, reply) => {
    const { id, provider } = req.params as { id: string; provider: string };
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return reply.code(400).send({ error: "unsupported_provider" });
    }
    const parsed = integrationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.flatten() });
    }
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id));
    if (!org) return reply.code(404).send({ error: "not_found" });

    const secret = buildSecret(provider as TenantIntegrationProvider, parsed.data);
    if (!secret) {
      return reply.code(400).send({ error: "missing_credentials" });
    }
    await upsertTenantIntegration({
      orgId: id,
      provider: provider as TenantIntegrationProvider,
      secret,
      enabled: parsed.data.enabled ?? true,
      createdBy: req.authUser!.id,
    });
    return { ok: true };
  });

  // ---- enable/disable an integration without rotating its key
  app.patch("/orgs/:id/integrations/:provider", platformAuth, async (req, reply) => {
    const { id, provider } = req.params as { id: string; provider: string };
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return reply.code(400).send({ error: "unsupported_provider" });
    }
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload" });
    const ok = await setTenantIntegrationEnabled(id, provider as TenantIntegrationProvider, parsed.data.enabled);
    if (!ok) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // ---- delete an integration
  app.delete("/orgs/:id/integrations/:provider", platformAuth, async (req, reply) => {
    const { id, provider } = req.params as { id: string; provider: string };
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return reply.code(400).send({ error: "unsupported_provider" });
    }
    const ok = await deleteTenantIntegration(id, provider as TenantIntegrationProvider);
    if (!ok) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });
}

function buildSecret(
  provider: TenantIntegrationProvider,
  body: z.infer<typeof integrationBodySchema>,
): TenantIntegrationSecret | null {
  switch (provider) {
    case "vapi": {
      const v = body.vapi;
      if (!v) return null;
      return { provider: "vapi", apiKey: v.apiKey, publicKey: v.publicKey, webhookSecret: v.webhookSecret } satisfies VapiSecret;
    }
    case "deepgram": {
      const d = body.deepgram;
      if (!d) return null;
      return { provider: "deepgram", apiKey: d.apiKey } satisfies DeepgramSecret;
    }
    case "sarvam": {
      const s = body.sarvam;
      if (!s) return null;
      return { provider: "sarvam", apiSubscriptionKey: s.apiSubscriptionKey } satisfies SarvamSecret;
    }
    case "shunya": {
      const s = body.shunya;
      if (!s) return null;
      return { provider: "shunya", apiKey: s.apiKey } satisfies ShunyaSecret;
    }
    default:
      // rekognition (and any future provider) is configured via env fallback
      // only; not yet exposed through the platform-UI body schema.
      return null;
  }
}
