// Single global subscription to /ws/agent for the signed-in user. Server
// pushes user-scoped events here (call_assigned, triage_handoff_offered,
// etc.). Mount the listener once at the AppShell level via useAgentEvents.

import { useEffect, useRef } from "react";
import type { Classification, TriageHandoffMode } from "@j2w/shared-types";
import { getStoredToken, getWsBase, subscribeTokenChange } from "@/lib/api";

export type AgentEvent =
  | {
      type: "call_assigned";
      callId: string;
      agentUserId: string;
      orgId: string;
      customerRef: string | null;
      origin: string;
      assignedAt: string;
    }
  | { type: "call_ended"; callId: string; agentUserId: string | null }
  | {
      type: "triage_handoff_offered";
      callId: string;
      agentUserId: string;
      orgId: string;
      triageAgentId: string;
      triageFlowName: string;
      classification: Classification;
      summary: string;
      handoffMode: TriageHandoffMode;
      expiresAt: string;
    }
  | { type: "triage_handoff_accepted"; callId: string; agentUserId: string; ts: number }
  | {
      type: "triage_handoff_failed";
      callId: string;
      agentUserId: string | null;
      reason: string;
      ts: number;
    };

type Listener = (ev: AgentEvent) => void;

const listeners = new Set<Listener>();

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect(token: string) {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  const url = `${getWsBase()}/ws/agent?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);
  socket.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as AgentEvent;
      for (const l of listeners) l(ev);
    } catch {
      // ignore malformed frames
    }
  };
  socket.onclose = () => {
    socket = null;
    // Reconnect with backoff if we still have a token. The token-change
    // subscriber re-triggers connect when the user signs in again.
    const t = getStoredToken();
    if (!t) return;
    reconnectTimer = setTimeout(() => connect(t), 5000);
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

// Auto-connect/reconnect whenever the access token changes. Token change is
// the right signal — when the user signs out the token clears and we tear
// down; when they sign in we open a fresh socket.
let bootstrapped = false;
function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  const t = getStoredToken();
  if (t) connect(t);
  subscribeTokenChange((token) => {
    if (!token) {
      disconnect();
    } else {
      disconnect();
      connect(token);
    }
  });
}

export function useAgentEvents(handler: Listener): void {
  // Stable handler ref so consumers can pass an inline callback without
  // disrupting the subscription on every render.
  const ref = useRef<Listener>(handler);
  ref.current = handler;

  useEffect(() => {
    bootstrap();
    const wrapped: Listener = (ev) => ref.current(ev);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}
