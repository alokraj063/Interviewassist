import IORedis from "ioredis";
import type { KBIngestEvent } from "@j2w/shared-types";

// Pub/sub channel for ingestion progress updates. The API subscribes and
// fans out to connected SSE clients per sourceId.

const CHANNEL_PREFIX = "kb.ingest";

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return url;
}

export function channelForSource(sourceId: string): string {
  return `${CHANNEL_PREFIX}:${sourceId}`;
}

let _pub: IORedis | null = null;
function publisher(): IORedis {
  if (!_pub) _pub = new IORedis(redisUrl());
  return _pub;
}

export async function publishIngestEvent(evt: KBIngestEvent): Promise<void> {
  await publisher().publish(channelForSource(evt.sourceId), JSON.stringify(evt));
}

export function subscribeIngestEvents(
  sourceId: string,
  handler: (evt: KBIngestEvent) => void,
): () => Promise<void> {
  const sub = new IORedis(redisUrl());
  const channel = channelForSource(sourceId);
  void sub.subscribe(channel);
  sub.on("message", (_c, raw) => {
    try {
      handler(JSON.parse(raw) as KBIngestEvent);
    } catch {
      // ignore malformed events
    }
  });
  return async () => {
    await sub.unsubscribe(channel);
    await sub.quit();
  };
}
