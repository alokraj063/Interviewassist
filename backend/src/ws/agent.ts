// Supervisor/agent WebSocket — disabled in the Mongo build (not used by the
// interview feature). Kept as a no-op registration so server wiring is unchanged.
import type { FastifyInstance } from "fastify";

export async function registerAgentWs(_app: FastifyInstance): Promise<void> {
  // no-op
}
