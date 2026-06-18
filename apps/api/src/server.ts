import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { loadAuthUser, type AuthUser } from "./auth/context.js";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { callsRoutes } from "./routes/calls.js";
import { assistRoutes } from "./routes/assist.js";
import { coachingRoutes } from "./routes/coaching.js";
import { clientPortalRoutes } from "./routes/client-portal.js";
import {
  assessmentsRoutes,
  publicAssessmentRoutes,
} from "./routes/assessments.js";
import {
  asyncVideoRoutes,
  publicAsyncVideoRoutes,
} from "./routes/async-video.js";
import { proctorRoutes } from "./routes/proctor.js";
import { recruitersRoutes } from "./routes/recruiters.js";
import { teamMonitorRoutes } from "./routes/team-monitor.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { rubricsRoutes } from "./routes/rubrics.js";
import { sourcingRoutes } from "./routes/sourcing.js";
import { messagingRoutes } from "./routes/messaging.js";
import { voiceAgentCampaignRoutes } from "./routes/voice-agent-campaigns.js";
import { healthRoutes } from "./routes/health.js";
import { kbRoutes } from "./routes/kb.js";
import { liveAssistRoutes } from "./routes/live-assist.js";
import { orgRoutes } from "./routes/org.js";
import { platformRoutes } from "./routes/platform.js";
import { qaRoutes } from "./routes/qa.js";
import { rolesRoutes } from "./routes/roles.js";
import { candidatesRoutes } from "./routes/candidates.js";
import { demandsRoutes } from "./routes/demands.js";
import { prospectsRoutes } from "./routes/prospects.js";
import { submissionsRoutes } from "./routes/submissions.js";
import { teamsRoutes } from "./routes/teams.js";
import { translationRoutes } from "./routes/translation.js";
import { usersRoutes } from "./routes/users.js";
import { triageRoutes } from "./routes/triage.js";
import { vapiWebhookRoutes } from "./routes/vapi-webhooks.js";
import { voiceAgentsRoutes } from "./routes/voice-agents.js";
import { questionBanksRoutes } from "./routes/question-banks.js";
import { adminOfferLetterSyncRoutes } from "./routes/admin/offer-letter-sync.js";
import { registerAgentWs } from "./ws/agent.js";
import { registerCustomTranscriberWs } from "./ws/custom-transcriber.js";
import { registerIngestWs } from "./ws/ingest.js";
import { registerIngestCallWs } from "./ws/ingest-call.js";
import { registerSessionWs } from "./ws/session.js";

// JWT access token payload. Short-lived (15m); refresh via cookie + /api/auth/refresh.
export interface JwtPayload {
  sub: string; // user id
  email: string;
  orgId: string;
  role:
    | "recruiter"
    | "delivery_lead"
    | "account_manager"
    | "business_head"
    | "qa_reviewer"
    | "admin"
    | "client_user"
    | "proctor";
  mfaVerified: boolean;
  /** True for super-admins who administrate tenants. Gated by `requirePlatformAdmin`. */
  isPlatformAdmin?: boolean;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
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

  // Verify JWT + hydrate req.authUser with membership + permissions.
  // Keeps req.user as the raw JWT payload (fastify-jwt convention).
  //
  // Supports two token transports:
  //   1. Authorization: Bearer <token>  (default for SPA fetches)
  //   2. ?token=<token> query param      (used by <audio>/<img> tags that
  //                                       can't set custom headers; the
  //                                       call recording endpoint relies
  //                                       on this)
  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      // If no Authorization header but a token query param exists, promote
      // it to the Authorization header so jwtVerify finds it.
      if (!request.headers.authorization) {
        const queryToken = (request.query as { token?: string } | undefined)?.token;
        if (queryToken) {
          request.headers.authorization = `Bearer ${queryToken}`;
        }
      }
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const payload = request.user as JwtPayload;
    const ctx = await loadAuthUser(payload.sub, payload.orgId);
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });
    request.authUser = ctx;
  });

  app.decorate("requirePermission", function (permission: string) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      const ctx = request.authUser;
      if (!ctx) return reply.code(401).send({ error: "unauthorized" });
      if (!ctx.permissions.includes(permission)) {
        return reply.code(403).send({ error: "forbidden", permission });
      }
    };
  });

  // Gate /api/platform/* routes. Distinct from `requirePermission` because
  // platform admins have no org-scoped permissions.
  app.decorate("requirePlatformAdmin", async function (request: FastifyRequest, reply: FastifyReply) {
    const ctx = request.authUser;
    if (!ctx) return reply.code(401).send({ error: "unauthorized" });
    if (!ctx.isPlatformAdmin) return reply.code(403).send({ error: "platform_admin_required" });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(kbRoutes, { prefix: "/api/kb" });
  await app.register(callsRoutes, { prefix: "/api/calls" });
  await app.register(assistRoutes, { prefix: "/api/assist" });
  await app.register(candidatesRoutes, { prefix: "/api/candidates" });
  await app.register(demandsRoutes, { prefix: "/api/demands" });
  await app.register(prospectsRoutes, { prefix: "/api/prospects" });
  await app.register(submissionsRoutes, { prefix: "/api/submissions" });
  await app.register(coachingRoutes, { prefix: "/api/coaching" });
  await app.register(clientPortalRoutes, { prefix: "/api/client-portal" });
  await app.register(assessmentsRoutes, { prefix: "/api/assessments" });
  await app.register(publicAssessmentRoutes, { prefix: "/api/public/assessments" });
  await app.register(asyncVideoRoutes, { prefix: "/api/async-video" });
  await app.register(publicAsyncVideoRoutes, { prefix: "/api/public/async-video" });
  await app.register(proctorRoutes, { prefix: "/api/proctor" });
  await app.register(recruitersRoutes, { prefix: "/api/recruiters" });
  await app.register(teamMonitorRoutes, { prefix: "/api/team-monitor" });
  await app.register(analyticsRoutes, { prefix: "/api/analytics" });
  await app.register(rubricsRoutes, { prefix: "/api/rubrics" });
  await app.register(sourcingRoutes, { prefix: "/api/sourcing" });
  await app.register(messagingRoutes, { prefix: "/api/messaging" });
  await app.register(voiceAgentCampaignRoutes, { prefix: "/api/voice-agent-campaigns" });
  await app.register(liveAssistRoutes, { prefix: "/api/live-assist" });
  await app.register(qaRoutes, { prefix: "/api/qa" });
  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(teamsRoutes, { prefix: "/api/teams" });
  await app.register(rolesRoutes, { prefix: "/api/roles" });
  await app.register(orgRoutes, { prefix: "/api/org" });
  await app.register(translationRoutes, { prefix: "/api/translation" });
  await app.register(voiceAgentsRoutes, { prefix: "/api/voice-agents" });
  await app.register(triageRoutes, { prefix: "/api/triage" });
  await app.register(vapiWebhookRoutes, { prefix: "/api/vapi/webhooks" });
  await app.register(platformRoutes, { prefix: "/api/platform" });
  await app.register(questionBanksRoutes, { prefix: "/api/question-banks" });
  await app.register(adminOfferLetterSyncRoutes, { prefix: "/api/admin/offer-letter-sync" });

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
    authUser?: AuthUser;
  }
}
