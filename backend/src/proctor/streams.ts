// Live webcam/screen feed stream-token minting for the proctor cockpit.
//
// Real-first with snapshot-mode fallback:
//   - When PROCTOR_STREAM_PROVIDER='livekit' + LIVEKIT_API_KEY/_SECRET/_URL are
//     set, mintViewerToken() issues a viewer (subscribe-only) access token the
//     cockpit hands to the LiveKit client SDK to consume the candidate's
//     published webcam/screen tracks.
//   - When PROCTOR_STREAM_PROVIDER='livekit' but keys are unset, the caller
//     returns 503 {error:"stream_provider_missing"} (never 500).
//   - When PROCTOR_STREAM_PROVIDER='none' (default), there is no live feed; the
//     cockpit renders snapshot stills (evidence_blob_key) and shows a "Live feed
//     unavailable" banner. getStreamMode() returns 'snapshot'.
//
// The real LiveKit token mint is wired but BLOCKED-on-credential.
import { createHmac } from "node:crypto";
import { env } from "../env.js";

export type StreamMode = "live" | "snapshot";

export class StreamProviderMissing extends Error {
  constructor() {
    super("stream_provider_missing");
    this.name = "StreamProviderMissing";
  }
}

export function getStreamMode(): StreamMode {
  if (env.PROCTOR_STREAM_PROVIDER === "livekit" && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    return "live";
  }
  return "snapshot";
}

export interface ViewerToken {
  provider: "livekit";
  url: string;
  token: string;
  room: string;
}

/**
 * Mint a subscribe-only LiveKit access token for a proctor session room.
 * Throws StreamProviderMissing when 'livekit' is selected but keys are unset.
 */
export function mintViewerToken(sessionId: string, viewerIdentity: string): ViewerToken {
  if (
    env.PROCTOR_STREAM_PROVIDER !== "livekit" ||
    !env.LIVEKIT_API_KEY ||
    !env.LIVEKIT_API_SECRET ||
    !env.LIVEKIT_URL
  ) {
    throw new StreamProviderMissing();
  }
  const room = `proctor-${sessionId}`;
  // Minimal LiveKit-compatible JWT (HS256) granting subscribe-only on the room.
  // The official server SDK (livekit-server-sdk) produces the same claim shape;
  // we hand-roll the JWT to avoid adding the dependency before keys exist.
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: env.LIVEKIT_API_KEY,
      sub: viewerIdentity,
      nbf: now,
      exp: now + 60 * 15,
      video: { room, roomJoin: true, canSubscribe: true, canPublish: false },
    }),
  );
  const sig = createHmac("sha256", env.LIVEKIT_API_SECRET).update(`${header}.${payload}`).digest("base64url");
  return { provider: "livekit", url: env.LIVEKIT_URL, token: `${header}.${payload}.${sig}`, room };
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
