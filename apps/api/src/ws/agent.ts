import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { callSessions, db } from "@j2w/db";
import { and, eq, inArray } from "drizzle-orm";
import { bus, type AgentEvent } from "../bus.js";
import type { JwtPayload } from "../server.js";

// Recruiter notification stream. One socket per logged-in desktop (or
// browser) instance. The server pushes:
//   - {type: "call_assigned", ...}  when a new call is routed to this recruiter
//   - {type: "call_ended", ...}     when any of the recruiter's active calls end
// On connect, the server replays at most one current assignment so a fresh
// client doesn't miss a call that was already routed.
export async function registerAgentWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/agent", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const token =
      url.searchParams.get("token") ??
      (req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null);
    if (!token) return socket.close(4401, "missing_token");

    let payload: JwtPayload;
    try {
      payload = app.jwt.verify(token) as JwtPayload;
    } catch {
      return socket.close(4401, "invalid_token");
    }

    const recruiterUserId = payload.sub;

    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const unsub = bus.subscribe((ev: AgentEvent) => {
      if (ev.type === "call_assigned" && ev.recruiterUserId === recruiterUserId) send(ev);
      else if (ev.type === "call_ended" && ev.recruiterUserId === recruiterUserId) send(ev);
      else if (ev.type === "triage_handoff_offered" && ev.recruiterUserId === recruiterUserId) send(ev);
      else if (ev.type === "triage_handoff_accepted" && ev.recruiterUserId === recruiterUserId) send(ev);
      else if (ev.type === "triage_handoff_failed" && ev.recruiterUserId === recruiterUserId) send(ev);
    });

    socket.on("close", () => unsub());
    socket.on("error", () => unsub());

    // Replay any current assignment.
    const [existing] = await db
      .select()
      .from(callSessions)
      .where(
        and(
          eq(callSessions.recruiterUserId, recruiterUserId),
          inArray(callSessions.status, ["assigned", "active"]),
        ),
      )
      .limit(1);
    if (existing && existing.orgId) {
      send({
        type: "call_assigned",
        callId: existing.id,
        recruiterUserId,
        orgId: existing.orgId,
        candidateRefOrPhone: existing.candidateRefOrPhone ?? null,
        origin: (existing.origin as "web" | "telephony" | "desktop" | "vapi" | "bridge" | null) ?? "web",
        assignedAt: (existing.assignedAt ?? existing.startedAt).toISOString(),
      });
    }
  });
}
