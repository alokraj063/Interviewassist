// FreJun OAuth routes — kept OUT of routes/telephony.ts because the callback
// must NOT sit behind `app.authenticate`.
//
// FreJun redirects the browser here after the recruiter grants access. Relying
// on the OL cookie surviving that cross-site top-level navigation is fragile
// (SameSite policy, browser variation), so the signed `state` parameter is the
// authority instead: it carries the uid and is verified before anything is
// written.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import {
  buildAuthorizeUrl,
  consumePendingGrant,
  disconnect,
  exchangeCode,
  FrejunOAuthError,
  getAccessToken,
  isOAuthConfigured,
  rememberPendingGrant,
  signState,
  verifyState,
} from "../telephony/frejunOAuth.js";

/** Minimal self-closing page for the popup the frontend opens. */
function closingPage(ok: boolean, message: string): string {
  const payload = JSON.stringify({ source: "frejun-oauth", ok, message });
  return `<!doctype html><meta charset="utf-8"><title>FreJun</title>
<body style="font:14px system-ui;padding:2rem;text-align:center">
<p>${ok ? "✅ FreJun connected." : "❌ " + message}</p>
<p style="color:#666">You can close this window.</p>
<script>
  try { window.opener && window.opener.postMessage(${payload}, "*"); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 800 : 4000});
</script></body>`;
}

export async function telephonyOAuthRoutes(app: FastifyInstance) {
  // ── Start the grant ────────────────────────────────────────────────────
  // Authenticated: we need to know WHICH recruiter is connecting.
  app.get("/authorize", { preHandler: app.authenticate }, async (req, reply) => {
    if (!isOAuthConfigured()) {
      return reply.code(503).send({
        error: "frejun_oauth_not_configured",
        missing: [
          !env.FREJUN_OAUTH_CLIENT_ID && "FREJUN_OAUTH_CLIENT_ID",
          !env.FREJUN_OAUTH_CLIENT_SECRET && "FREJUN_OAUTH_CLIENT_SECRET",
          !env.FREJUN_OAUTH_REDIRECT_URI && "FREJUN_OAUTH_REDIRECT_URI",
        ].filter(Boolean),
      });
    }
    const ctx = req.authUser!;
    // FreJun drops `state` on the way back, so the callback matches on this
    // instead. `state` is still sent — harmless, and useful if they add it.
    await rememberPendingGrant(ctx.uid, ctx.email);
    const url = buildAuthorizeUrl(signState(ctx.uid, ctx.email));
    // `?json=true` lets the frontend open the popup itself instead of being
    // redirected — a redirect inside fetch() is useless to it.
    if ((req.query as { json?: string }).json === "true") return { authorizeUrl: url };
    return reply.redirect(url);
  });

  // ── FreJun redirects here ──────────────────────────────────────────────
  //
  // Registered on BOTH paths on purpose. FreJun's observed redirect is
  //   /api/telephony/oauth/?code=…&email=…&response_type=code
  // i.e. the bare prefix, not "/callback", and it does NOT echo `state`.
  // "/callback" stays registered so a corrected dashboard entry (or a future
  // FreJun change) also works without another deploy.
  const handleCallback = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as {
      code?: string;
      email?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    void reply.header("Content-Type", "text/html; charset=utf-8");

    if (q.error) {
      req.log.warn({ error: q.error, desc: q.error_description }, "frejun oauth denied");
      return reply.send(closingPage(false, q.error_description || q.error));
    }
    if (!q.code) return reply.send(closingPage(false, "Missing authorization code."));

    // Identify the recruiter: `state` when present (spec-correct), otherwise
    // the pending grant matched on the email FreJun hands back.
    let uid: string | null = null;
    let email: string | null = null;

    if (q.state) {
      const claims = verifyState(q.state);
      if (claims) {
        uid = claims.uid;
        email = claims.email;
      }
    }
    if (!uid && q.email) {
      const pending = await consumePendingGrant(q.email);
      if (pending) {
        uid = pending.olUid;
        email = q.email;
      }
    }
    if (!uid || !email) {
      req.log.warn({ email: q.email }, "frejun oauth callback with no matching pending grant");
      return reply.send(
        closingPage(false, "No matching authorization request. Please start again from the app."),
      );
    }

    try {
      await exchangeCode(q.code, uid, email);
      req.log.info({ uid, email }, "frejun oauth connected");
      return reply.send(closingPage(true, "Connected"));
    } catch (err) {
      if (err instanceof FrejunOAuthError) {
        req.log.warn({ status: err.status, body: err.body }, "frejun token exchange failed");
        return reply.send(closingPage(false, err.message || `Token exchange failed (${err.status}).`));
      }
      throw err;
    }
  };

  app.get("/", handleCallback);
  app.get("/callback", handleCallback);

  // ── The token the browser SDK logs in with ─────────────────────────────
  // 409 (not 401) so the UI can tell "you must connect FreJun" apart from
  // "your OfferLetter session expired".
  app.get("/token", { preHandler: app.authenticate }, async (req, reply) => {
    // NEVER cache. Access tokens are short-lived and refreshed server-side; a
    // cached GET response served a browser last night's expired token this
    // morning, which the SDK then rejected as "FreJun login failed".
    void reply.header("Cache-Control", "no-store, no-cache, must-revalidate").header("Pragma", "no-cache");
    if (!isOAuthConfigured()) return reply.code(503).send({ error: "frejun_oauth_not_configured" });
    const tok = await getAccessToken(req.authUser!.uid);
    if (!tok) return reply.code(409).send({ error: "frejun_not_connected" });
    return { accessToken: tok.accessToken, email: tok.email, expiresAt: tok.expiresAt };
  });

  // ── Connection status, for rendering a Connect/Disconnect button ───────
  app.get("/status", { preHandler: app.authenticate }, async (req) => {
    const tok = await getAccessToken(req.authUser!.uid);
    return {
      configured: isOAuthConfigured(),
      connected: Boolean(tok),
      email: tok?.email ?? null,
      expiresAt: tok?.expiresAt ?? null,
    };
  });

  app.delete("/token", { preHandler: app.authenticate }, async (req) => {
    await disconnect(req.authUser!.uid);
    return { ok: true };
  });
}
