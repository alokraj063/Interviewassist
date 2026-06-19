import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { authenticateOl, type OlAuthUser } from "./auth/olAuth.js";
import { env } from "./env.js";
import { callsRoutes } from "./routes/calls.js";
import { assistRoutes } from "./routes/assist.js";
import { healthRoutes } from "./routes/health.js";
import { candidatesRoutes } from "./routes/candidates.js";
import { demandsRoutes } from "./routes/demands.js";
import { registerAgentWs } from "./ws/agent.js";
import { registerCustomTranscriberWs } from "./ws/custom-transcriber.js";
import { registerIngestWs } from "./ws/ingest.js";
import { registerIngestCallWs } from "./ws/ingest-call.js";
import { registerSessionWs } from "./ws/session.js";

// We don't sign our own JWTs anymore — the OL cookie carries the session.
// Kept as an unused type so other modules that import it still type-check
// during the migration; can be removed once nothing references it.
export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true, singleLine: true } }
          : undefined,
    },
    disableRequestLogging: env.NODE_ENV !== "development",
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie, { secret: env.JWT_SECRET });

  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "15m" },
  });

  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MB
      files: 20,
    },
  });

  await app.register(websocket, {
    options: {
      maxPayload: 65_536,
      perMessageDeflate: false,
    },
  });

  // Verify the OfferLetter (OL) cookie / Bearer token. No separate login is
  // run here — the same session that logged the user into OL is honoured
  // directly. `request.authUser` is populated with the OL actor; downstream
  // routes scope their queries by `authUser.uid` / `authUser.mongoId`.
  //
  // Transports supported:
  //   1. Cookie  authToken=<jwt>
  //   2. Header  Authorization: Bearer <jwt>
  //   3. Query   ?token=<jwt>  (for WebSockets that can't set headers)
  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    const ctx = await authenticateOl(request);
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });
    request.authUser = ctx;
  });

  // Permission system was tied to the old org/role mapping. With OL SSO, we
  // gate by `User.type` — but most routes are recruiter-personal anyway so
  // these helpers default to "logged-in OK". Routes that need a specific
  // role compare `authUser.role` themselves.
  app.decorate("requirePermission", function (_permission: string) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
    };
  });
  app.decorate("requirePlatformAdmin", async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.authUser) return reply.code(401).send({ error: "unauthorized" });
    if (request.authUser.role !== "UserAdmin") return reply.code(403).send({ error: "admin_required" });
  });

  await app.register(healthRoutes);
  await app.register(callsRoutes,      { prefix: "/api/calls" });
  await app.register(assistRoutes,     { prefix: "/api/assist" });
  await app.register(candidatesRoutes, { prefix: "/api/candidates" });
  await app.register(demandsRoutes,    { prefix: "/api/demands" });
  // Routes that were tied to the old multi-tenant model — clients /
  // prospects / users / teams / roles / org / platform / question-banks /
  // auth (login/signup) — are no longer registered. The OL app owns those
  // surfaces; we just reuse its session.

  await registerIngestWs(app);
  await registerIngestCallWs(app);
  await registerSessionWs(app);
  await registerAgentWs(app);
  await registerCustomTranscriberWs(app);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (permission: string) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    authUser?: OlAuthUser;
  }
}
