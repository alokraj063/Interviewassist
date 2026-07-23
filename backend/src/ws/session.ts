import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionClientMessage, SessionServerMessage } from "@j2w/shared-types";
import { authenticateOl } from "../auth/olAuth.js";
import { collections } from "../mongo.js";

// Registry of connected browser sessions, keyed by callId. The ingest +
// Deepgram pipeline (Phase 5) will look up this registry to push events.
const sessions = new Map<string, Set<SessionSocket>>();

interface SessionSocket {
  callId: string;
  userEmail: string;
  send: (msg: SessionServerMessage) => void;
  close: () => void;
}

export function broadcastToCall(callId: string, msg: SessionServerMessage): void {
  const set = sessions.get(callId);
  if (!set) return;
  for (const sock of set) sock.send(msg);
}

export function hasSessionListeners(callId: string): boolean {
  return (sessions.get(callId)?.size ?? 0) > 0;
}

export async function registerSessionWs(app: FastifyInstance): Promise<void> {
  app.get("/ws/session", { websocket: true }, async (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");

    if (!callId) return socket.close(4400, "missing_callId");

    // OL SSO — the browser's WS handshake carries `authToken` automatically.
    const user = await authenticateOl(req as FastifyRequest);
    if (!user) return socket.close(4401, "missing_or_invalid_token");

    const sock: SessionSocket = {
      callId,
      userEmail: user.email,
      send: (msg) => socket.send(JSON.stringify(msg)),
      close: () => socket.close(),
    };

    const set = sessions.get(callId) ?? new Set<SessionSocket>();
    set.add(sock);
    sessions.set(callId, set);

    sock.send({ type: "hello", callId, ts: Date.now() });

    // Replay the call's CURRENT telephony state to this freshly-connected
    // socket.
    //
    // Lifecycle events are broadcast exactly once, to whoever is listening at
    // that instant. `call.answered` typically fires a second or two after the
    // call is created — often before the browser's socket has finished
    // connecting — and a client that missed it would sit on "Ringing…"
    // forever with no way to recover. Replaying on connect makes the state
    // pull-safe as well as push-safe, so a page refresh mid-call also heals.
    void (async () => {
      try {
        const row = await collections.interviews().findOne<{
          telephony?: {
            status?: string;
            direction?: "outbound" | "inbound";
            answerTime?: Date | null;
            endTime?: Date | null;
          };
        }>({ id: callId }, { projection: { _id: 0, telephony: 1 } });
        const t = row?.telephony;
        if (!t?.status) return;

        sock.send({
          type: "call.status",
          callId,
          status: t.status as never,
          direction: t.direction ?? "outbound",
          ts: Date.now(),
        });
        if (t.answerTime) {
          sock.send({ type: "call.answered", callId, ts: new Date(t.answerTime).getTime() });
        }
        if (t.endTime) {
          sock.send({ type: "call.ended", callId, ts: new Date(t.endTime).getTime() });
        }
      } catch {
        // A replay failure must never stop the socket serving live events.
      }
    })();

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as SessionClientMessage;
        if (msg.type === "ping") sock.send({ type: "hello", callId, ts: Date.now() });
      } catch {
        // ignore malformed client frames
      }
    });

    socket.on("close", () => {
      set.delete(sock);
      if (set.size === 0) sessions.delete(callId);
    });
  });
}

