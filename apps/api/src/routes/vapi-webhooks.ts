// Vapi → J2W webhook receiver.
// Vapi POSTs call lifecycle events here (call-started, call-ended, transcript,
// function-call, status-update). We persist call metadata into the existing
// call_sessions / transcript_turns tables so the Conversations and Monitor
// pages surface Vapi calls alongside human-agent calls.
//
// Signature verification: Vapi sends HMAC-SHA256 of the raw body in the
// "x-vapi-signature" header using the secret we configured as `serverUrlSecret`.
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  callRoutingEvents,
  callSessions,
  db,
  transcriptTurns,
  voiceAgents,
} from "@j2w/db";
import type { RouteCallRequest, VapiWebhookEvent } from "@j2w/shared-types";
import { getAcousticSentimentQueue } from "@j2w/ingest-shared";
import { env } from "../env.js";
import { getProviderCredentials } from "../integrations/resolver.js";
import { withVapiContext } from "../vapi/context.js";
import { routeCall } from "./triage.js";

export async function vapiWebhookRoutes(app: FastifyInstance) {
  // We need the raw body for signature verification. Fastify parses JSON by
  // default, but we can re-stringify for signing as long as we use the same
  // canonical form Vapi uses. Vapi's signature is over the raw body string —
  // to do this right, register a raw-body parser for this route only.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const json = body.length ? JSON.parse(body as string) : {};
        (json as Record<string, unknown>).__raw = body;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post("/", async (req, reply) => {
    const body = req.body as (VapiWebhookEvent & { __raw?: string }) | undefined;
    if (!body) return reply.code(400).send({ error: "empty_body" });

    // Resolve which tenant this webhook is for. The deploy flow tags the
    // assistant's serverUrl with `?orgId=<orgId>` (see vapi/transform.ts), so
    // we trust that hint and look up the matching webhook secret. Falls back
    // to env.VAPI_WEBHOOK_SECRET when no orgId param is present (dev/legacy).
    const orgIdParam = (req.query as Record<string, string | undefined>)?.orgId;
    const vapiCreds = orgIdParam ? await getProviderCredentials(orgIdParam, "vapi") : null;
    const webhookSecret = vapiCreds?.webhookSecret ?? env.VAPI_WEBHOOK_SECRET;

    if (webhookSecret) {
      const sig = req.headers["x-vapi-signature"];
      const raw = body.__raw ?? "";
      if (!verifySignature(raw, typeof sig === "string" ? sig : "", webhookSecret)) {
        return reply.code(401).send({ error: "invalid_signature" });
      }
    }

    // Run the handler inside a Vapi context so any downstream PATCH /call/:id
    // (mid-call control from the triage warm-transfer path) uses this
    // tenant's API key.
    const runHandler = () => handleEvent(body, req);
    try {
      const result = vapiCreds
        ? await withVapiContext(
            {
              apiKey: vapiCreds.apiKey,
              publicKey: vapiCreds.publicKey,
              webhookSecret: vapiCreds.webhookSecret,
              orgId: orgIdParam,
            },
            runHandler,
          )
        : await runHandler();
      // function-call branches return a payload Vapi inlines as the tool
      // response. Other branches return undefined → ack with `{ok: true}`.
      return result ?? { ok: true };
    } catch (err) {
      app.log.error({ err }, "vapi webhook handler failed");
      return reply.code(500).send({ error: "handler_failed" });
    }
  });
}

function verifySignature(raw: string, sig: string, secret: string): boolean {
  if (!sig) return false;
  const mac = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleEvent(evt: VapiWebhookEvent, req: FastifyRequest): Promise<unknown> {
  switch (evt.type) {
    case "call-started":
      await onCallStarted(evt);
      return;
    case "call-ended":
      await onCallEnded(evt);
      return;
    case "transcript":
      await onTranscript(evt);
      return;
    case "status-update":
      // noop for now — the Monitor page will subscribe to these later via /ws/session bridge.
      return;
    case "function-call":
      return await onFunctionCall(evt, req);
  }
}

async function onFunctionCall(
  evt: Extract<VapiWebhookEvent, { type: "function-call" }>,
  req: FastifyRequest,
): Promise<unknown> {
  const fn = evt.functionCall;
  if (!fn || fn.name !== "routeCall") {
    // Other tools fulfill via their own server.url; Vapi only forwards
    // here for tools without a separate server URL (or as a fallback).
    return;
  }
  const payload: RouteCallRequest = {
    callId: evt.call.id,
    intent: String(fn.parameters.intent ?? ""),
    confidence: Number(fn.parameters.confidence ?? 0),
    sentiment:
      fn.parameters.sentiment != null ? Number(fn.parameters.sentiment) : undefined,
    language:
      typeof fn.parameters.language === "string"
        ? fn.parameters.language
        : undefined,
    entities:
      fn.parameters.entities && typeof fn.parameters.entities === "object"
        ? (fn.parameters.entities as Record<string, string>)
        : undefined,
    reason:
      typeof fn.parameters.reason === "string" ? fn.parameters.reason : undefined,
  };
  try {
    const decision = await routeCall(req, payload, req.log);
    // Vapi inlines this object as the tool's result message — the assistant
    // can then read `result.instructions` and speak it.
    return { result: decision };
  } catch (err) {
    req.log.error({ err, callId: payload.callId }, "routeCall fulfillment failed");
    return {
      result: {
        error: err instanceof Error ? err.message : "route_failed",
      },
    };
  }
}

async function onCallStarted(evt: Extract<VapiWebhookEvent, { type: "call-started" }>) {
  // Find the local voice_agent by Vapi assistant id so we can link the call.
  const [agent] = await db
    .select({
      id: voiceAgents.id,
      orgId: voiceAgents.orgId,
      kind: voiceAgents.kind,
      name: voiceAgents.name,
    })
    .from(voiceAgents)
    .where(eq(voiceAgents.vapiAssistantId, evt.call.assistantId));

  await db
    .insert(callSessions)
    .values({
      id: evt.call.id,
      orgId: agent?.orgId ?? null,
      voiceAgentId: agent?.id ?? null,
      origin: "vapi",
      status: "active",
      startedAt: evt.call.startedAt ? new Date(evt.call.startedAt) : new Date(),
    })
    .onConflictDoNothing();

  // Triage flows record their entry event up-front so the live dashboard
  // surfaces the call within seconds of pickup.
  if (agent?.kind === "triage") {
    await db
      .insert(callRoutingEvents)
      .values({
        callId: evt.call.id,
        orgId: agent.orgId,
        seq: 0,
        kind: "triage_started",
        fromRef: { type: "voice_agent", id: agent.id, label: agent.name },
      })
      .onConflictDoNothing?.();
  }
}

async function onCallEnded(evt: Extract<VapiWebhookEvent, { type: "call-ended" }>) {
  const recordingUrl = evt.recordingUrl ?? null;
  await db
    .update(callSessions)
    .set({
      status: "ended",
      endedAt: evt.call.endedAt ? new Date(evt.call.endedAt) : new Date(),
      recordingUrl,
      // Vapi doesn't tell us duration/mime directly; leave null and let the
      // worker probe the file with ffprobe if needed.
      summary: evt.summary
        ? { overview: evt.summary, resolution: evt.call.endedReason ?? "", nextSteps: [] }
        : undefined,
    })
    .where(eq(callSessions.id, evt.call.id));

  // Fire the Phase 2 acoustic-sentiment worker if we have a recording.
  // Soft-fail: Redis down shouldn't break the webhook.
  if (recordingUrl) {
    try {
      await getAcousticSentimentQueue().add(
        `acoustic:${evt.call.id}`,
        { callId: evt.call.id, recordingUrl },
        { jobId: `acoustic:${evt.call.id}` }, // idempotent per-call
      );
    } catch {
      // swallow — the job can be requeued later via a recompute endpoint
    }
  }
}

async function onTranscript(evt: Extract<VapiWebhookEvent, { type: "transcript" }>) {
  // Only persist finals to avoid churn. Partials go over the WS bridge later.
  // For autonomous voice screener calls (Vapi-driven), `assistant` is the AI
  // recruiter screener and `user` is the candidate.
  if (evt.transcriptType && evt.transcriptType !== "final") return;
  await db.insert(transcriptTurns).values({
    callId: evt.call.id,
    speaker: evt.role === "assistant" ? "recruiter" : "candidate",
    text: evt.transcript,
    isFinal: true,
    tsStartMs: 0,
    tsEndMs: 0,
    sentiment: null,
  });
}
