// Resolve an OfferLetter recruiter → a FreJun `agent_id`.
//
// Live-account finding (2026-07-22): FreJun's call log exposes the user as
// `recruiter` = an email on @joulestowatts.com — the SAME domain OfferLetter
// uses. So email is the natural join key and no mapping table is needed for
// the common case.
//
// What is NOT yet verified: whether `call-to-voip`'s `agent_id` parameter
// accepts that email or wants an opaque numeric/hash id. FreJun exposes no
// working user-listing endpoint (`/integrations/users/` 500s), so the first
// real outbound call is what settles it. Until then the resolver is layered
// so we can pin or override without touching call sites:
//
//   1. FREJUN_DEFAULT_AGENT_ID   — pin every call to one agent (first-run testing)
//   2. ia_frejun_agents          — explicit per-user override, written by ops
//   3. the recruiter's email     — the expected steady state
//
// If FreJun rejects the email form, populate `ia_frejun_agents` and nothing
// else changes.
import { col } from "../mongo.js";
import { env } from "../env.js";
import type { OlAuthUser } from "../auth/olAuth.js";

export interface FrejunAgentDoc {
  olUid: string;
  frejunAgentId: string;
  email?: string | null;
  updatedAt: Date;
}

export class AgentNotMappedError extends Error {
  constructor(readonly olUid: string) {
    super(`No FreJun agent_id could be resolved for OL user ${olUid}`);
    this.name = "AgentNotMappedError";
  }
}

/**
 * Some users live on "joulestowatts.co" rather than ".com". This LOOKS like a
 * typo but is not: verified 2026-07-22 that e.g. shweta.dubey@joulestowatts.co
 * is spelled identically in OfferLetter and in FreJun, so the email join still
 * works and needs no mapping row.
 *
 * Never "correct" a .co address to .com — that would break the very users it
 * appears to fix.
 */
export function isCoDomain(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith("@joulestowatts.co");
}

export async function resolveFrejunAgentId(user: OlAuthUser): Promise<string> {
  if (env.FREJUN_DEFAULT_AGENT_ID) return env.FREJUN_DEFAULT_AGENT_ID;

  // Typed at findOne (not at col) to match how the rest of the codebase reads
  // collections — interfaces don't satisfy the driver's `Document` constraint.
  const mapped = await col("ia_frejun_agents").findOne<FrejunAgentDoc>({ olUid: user.uid });
  if (mapped?.frejunAgentId) return mapped.frejunAgentId;

  if (user.email) return user.email;

  throw new AgentNotMappedError(user.uid);
}
