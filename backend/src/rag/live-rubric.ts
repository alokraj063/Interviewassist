// Live rubric tick — disabled in the Mongo build.
//
// The live-rubric scoring was a Postgres-backed placeholder (the UI panel
// renders structure only). These are kept as no-ops so the transcript/STT
// pipeline that calls them keeps working without a relational rubric store.
import type { FastifyBaseLogger } from "fastify";

export function maybeRubricTick(_callId: string, _log: FastifyBaseLogger): void {
  // no-op
}

export function clearRubricTickState(_callId: string): void {
  // no-op
}
