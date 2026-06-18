// Frontend mock-ID → backend UUID bridge.
//
// The frontend's seeded mock CONVERSATIONS uses string IDs like "CV-10000".
// The backend's call_sessions.id is a UUID. To let PR2's qa_reviews FK
// writes work against mock data without ripping out the 260-row dataset,
// we deterministically map the mock IDs to UUIDs using a fixed namespace
// and the numeric tail of the mock ID.
//
// The same derivation is duplicated in apps/web/src/lib/mockCallIds.ts —
// keep these in lockstep.

const NAMESPACE = "f7e9c8a0-0001-4c12-8abc-"; // fixed 24 hex chars (24 chars with dashes counted)

export function mockIdToUuid(mockId: string): string {
  const m = mockId.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) : 0;
  const hex = n.toString(16).padStart(12, "0");
  return `${NAMESPACE}${hex}`;
}
