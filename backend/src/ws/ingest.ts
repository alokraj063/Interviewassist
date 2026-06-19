// Legacy desktop dual-channel ingest — disabled in the Mongo build.
// The recruiter wedge uses /ws/ingest-call (mixed-mono). Kept as a no-op
// registration so server wiring is unchanged.
import type { FastifyInstance } from "fastify";

export async function registerIngestWs(_app: FastifyInstance): Promise<void> {
  // no-op
}
