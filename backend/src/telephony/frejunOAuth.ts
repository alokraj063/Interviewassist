// FreJun OAuth 2.0 — authorization-code flow, per recruiter.
//
// Why this exists at all: the browser Softphone SDK authenticates with a
// Bearer ACCESS TOKEN plus the user's FreJun email. The Api-Key that works for
// the REST endpoints is rejected by it (verified: /integrations/webhooks/
// returns 401 "Given token is not valid" for an Api-Key).
//
// And FreJun uses the authorization-CODE flow, not client-credentials — so
// there is no single machine token. Each recruiter grants access once, and we
// keep their access/refresh pair keyed by their OfferLetter uid.
//
// Endpoints were confirmed by probing: POST /api/v1/oauth/token/ responds 403
// to an empty body while every other candidate path 404s.
//
// SECURITY NOTE: tokens are stored as plaintext in `ia_frejun_tokens`. That
// matches the current posture of this service (INTEGRATIONS_KEK is unset and
// the Mongo URI is a literal default in env.ts), but it is NOT good enough for
// production — set INTEGRATIONS_KEK and wrap these through
// integrations/encryption.ts before this ships.
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { col } from "../mongo.js";
import { env } from "../env.js";

export interface FrejunTokenDoc {
  olUid: string;
  frejunEmail: string;
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry, so a restart doesn't lose the countdown. */
  expiresAt: Date | null;
  scope: string | null;
  updatedAt: Date;
}

export class FrejunOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `FreJun OAuth error ${status}`);
    this.name = "FrejunOAuthError";
  }
}

const tokens = () => col("ia_frejun_tokens");

export function isOAuthConfigured(): boolean {
  return Boolean(
    env.FREJUN_OAUTH_CLIENT_ID && env.FREJUN_OAUTH_CLIENT_SECRET && env.FREJUN_OAUTH_REDIRECT_URI,
  );
}

// ─── state ───────────────────────────────────────────────────────────────────
// The `state` parameter is a short-lived signed JWT rather than a random
// nonce in a session store: it survives an API restart, needs no extra
// collection, and carries the uid so the callback doesn't have to depend on
// the OL cookie surviving a cross-site redirect.

interface StateClaims {
  uid: string;
  email: string;
  nonce: string;
}

export function signState(uid: string, email: string): string {
  return jwt.sign({ uid, email, nonce: randomUUID() } satisfies StateClaims, env.JWT_SECRET, {
    expiresIn: "10m",
  });
}

export function verifyState(state: string): StateClaims | null {
  try {
    return jwt.verify(state, env.JWT_SECRET) as StateClaims;
  } catch {
    return null;
  }
}

// ─── pending grants ──────────────────────────────────────────────────────────
//
// Observed 2026-07-22: FreJun does NOT echo `state` back. Its redirect is
//   /api/telephony/oauth/?code=<code>&email=<user>&response_type=code
// so `state` cannot be the CSRF defence or the identity carrier.
//
// Instead, /authorize records a short-lived pending grant keyed by the email
// we are about to send the user off with. The callback only proceeds if a
// matching pending row exists, which both identifies the recruiter and stops a
// forged callback from binding tokens to an arbitrary account.

export interface PendingGrant {
  email: string;
  olUid: string;
  createdAt: Date;
}

const pending = () => col("ia_frejun_oauth_pending");

export async function rememberPendingGrant(uid: string, email: string): Promise<void> {
  await pending().updateOne(
    { email: email.toLowerCase() },
    { $set: { email: email.toLowerCase(), olUid: uid, createdAt: new Date() } },
    { upsert: true },
  );
}

export async function consumePendingGrant(email: string): Promise<PendingGrant | null> {
  return pending().findOneAndDelete({ email: email.toLowerCase() }) as Promise<PendingGrant | null>;
}

export function buildAuthorizeUrl(state: string): string {
  const u = new URL(env.FREJUN_OAUTH_AUTHORIZE_URL);
  u.searchParams.set("client_id", env.FREJUN_OAUTH_CLIENT_ID ?? "");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", env.FREJUN_OAUTH_REDIRECT_URI ?? "");
  u.searchParams.set("state", state);
  return u.toString();
}

// ─── token endpoint ──────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * FreJun's token endpoint requires HTTP **Basic** client authentication.
 * Established by probing it with a dummy code (2026-07-22):
 *
 *   client_id/client_secret in the body  -> 403 {"message":"Access forbidden."}
 *   Authorization: Basic <id:secret>     -> 400 {"message":"Invalid code"}
 *
 * The 400 is the tell: client auth was accepted and only the (deliberately
 * fake) code was rejected. None of this is in their docs — do not "simplify"
 * the credentials back into the body.
 *
 * A body-credential retry remains for the case where FreJun later relaxes it,
 * and it only fires on 401/403, i.e. specifically a client-auth rejection.
 */
async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(
    `${env.FREJUN_OAUTH_CLIENT_ID ?? ""}:${env.FREJUN_OAUTH_CLIENT_SECRET ?? ""}`,
  ).toString("base64");

  const attempt = async (clientAuth: "basic" | "body") => {
    const body =
      clientAuth === "basic"
        ? params
        : {
            ...params,
            client_id: env.FREJUN_OAUTH_CLIENT_ID ?? "",
            client_secret: env.FREJUN_OAUTH_CLIENT_SECRET ?? "",
          };
    const res = await fetch(env.FREJUN_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...(clientAuth === "basic" ? { Authorization: `Basic ${basic}` } : {}),
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep the raw text so the error is still readable */
    }
    return { res, body: parsed };
  };

  let { res, body } = await attempt("basic");
  if (res.status === 401 || res.status === 403) ({ res, body } = await attempt("body"));

  if (!res.ok) {
    // Surface FreJun's own wording — "Invalid code" vs "Access forbidden"
    // point at completely different problems.
    const msg = (body as { message?: string } | null)?.message;
    throw new FrejunOAuthError(res.status, body, msg ? `FreJun: ${msg}` : undefined);
  }
  const parsed = body as TokenResponse;
  if (!parsed?.access_token) throw new FrejunOAuthError(502, body, "no access_token in response");
  return parsed;
}

async function persist(uid: string, email: string, t: TokenResponse): Promise<FrejunTokenDoc> {
  const doc: FrejunTokenDoc = {
    olUid: uid,
    frejunEmail: email,
    accessToken: t.access_token as string,
    refreshToken: t.refresh_token ?? null,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
    scope: t.scope ?? null,
    updatedAt: new Date(),
  };
  await tokens().updateOne({ olUid: uid }, { $set: doc }, { upsert: true });
  return doc;
}

/** Exchange the authorization code for tokens and store them for this user. */
export async function exchangeCode(code: string, uid: string, email: string): Promise<FrejunTokenDoc> {
  const t = await postToken({
    grant_type: "authorization_code",
    code,
    client_id: env.FREJUN_OAUTH_CLIENT_ID ?? "",
    client_secret: env.FREJUN_OAUTH_CLIENT_SECRET ?? "",
    redirect_uri: env.FREJUN_OAUTH_REDIRECT_URI ?? "",
  });
  return persist(uid, email, t);
}

/** Refresh a near-expired token, preserving the refresh token if none is returned. */
async function refresh(doc: FrejunTokenDoc): Promise<FrejunTokenDoc> {
  if (!doc.refreshToken) throw new FrejunOAuthError(400, null, "no refresh_token stored");
  const t = await postToken({
    grant_type: "refresh_token",
    refresh_token: doc.refreshToken,
    client_id: env.FREJUN_OAUTH_CLIENT_ID ?? "",
    client_secret: env.FREJUN_OAUTH_CLIENT_SECRET ?? "",
  });
  if (!t.refresh_token) t.refresh_token = doc.refreshToken;
  return persist(doc.olUid, doc.frejunEmail, t);
}

/** Renew this far ahead of expiry so a token can't die mid-call. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * A usable access token for this recruiter, or null when they have never
 * granted access (the caller should send them through /oauth/authorize).
 */
export async function getAccessToken(
  uid: string,
): Promise<{ accessToken: string; email: string; expiresAt: Date | null } | null> {
  const doc = await tokens().findOne<FrejunTokenDoc>({ olUid: uid });
  if (!doc) return null;

  const expiring = doc.expiresAt && doc.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!expiring) {
    return { accessToken: doc.accessToken, email: doc.frejunEmail, expiresAt: doc.expiresAt };
  }
  try {
    const next = await refresh(doc);
    return { accessToken: next.accessToken, email: next.frejunEmail, expiresAt: next.expiresAt };
  } catch {
    // Refresh failed (revoked / expired grant, or a transient network blip).
    const stillValid = !doc.expiresAt || doc.expiresAt.getTime() > Date.now();
    if (stillValid) {
      // The current access token hasn't actually expired yet (or we can't tell) —
      // keep using it and retry the refresh on the next call.
      return { accessToken: doc.accessToken, email: doc.frejunEmail, expiresAt: doc.expiresAt };
    }
    // The access token IS expired and it can't be refreshed → the connection is
    // dead. Drop it so /status reports `connected: false` and /token returns 409,
    // which flips the UI to "Connect FreJun" and forces a fresh grant — instead
    // of showing a green "connected" chip while every call silently fails on an
    // expired token.
    await tokens().deleteOne({ olUid: uid }).catch(() => {});
    return null;
  }
}

export async function disconnect(uid: string): Promise<void> {
  await tokens().deleteOne({ olUid: uid });
}
