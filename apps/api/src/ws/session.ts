import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { SessionClientMessage, SessionServerMessage } from "@j2w/shared-types";
import { getCallConfig } from "../translation/state.js";

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
  app.get("/ws/session", { websocket: true }, (socket: WebSocket, req) => {
    const url = new URL(req.url, "http://local");
    const callId = url.searchParams.get("callId");
    const token = url.searchParams.get("token") ?? extractBearer(req.headers.authorization);

    if (!callId) return socket.close(4400, "missing_callId");
    if (!token) return socket.close(4401, "missing_token");

    let user: { email: string };
    try {
      user = app.jwt.verify(token) as { email: string };
    } catch {
      return socket.close(4401, "invalid_token");
    }

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

    // Echo any active translation config so a reconnecting browser can
    // rebuild its UI (language pair, display mode, latency mode, etc.)
    // without re-enabling translation itself.
    const config = getCallConfig(callId);
    sock.send({ type: "translation.config", config });

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

function extractBearer(header?: string): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}
