// Per-request Vapi credential context. Threaded through the call stack via
// AsyncLocalStorage so we don't have to pipe an apiKey/publicKey/webhookSecret
// triple through every Vapi function in every layer.
//
// Use:
//   const creds = await getProviderCredentials(orgId, "vapi");
//   if (!creds) return reply.code(503).send({ error: "vapi_not_configured" });
//   return withVapiContext(creds, async () => {
//     // any vapi/client.ts call here uses creds.apiKey
//   });
//
// Outside `withVapiContext` the client falls back to env vars — preserves the
// original single-tenant behavior for jobs / scripts that aren't request-bound.
import { AsyncLocalStorage } from "node:async_hooks";

export interface VapiContext {
  apiKey: string;
  publicKey?: string;
  webhookSecret?: string;
  orgId?: string;
}

const storage = new AsyncLocalStorage<VapiContext>();

export function withVapiContext<T>(ctx: VapiContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentVapiContext(): VapiContext | undefined {
  return storage.getStore();
}
