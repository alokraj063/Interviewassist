// Frontend mock-ID → backend UUID bridge. Must match the derivation in
// apps/api/src/dev/mockCallIds.ts exactly.

const NAMESPACE = "f7e9c8a0-0001-4c12-8abc-";

export function mockIdToUuid(mockId: string): string {
  const m = mockId.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) : 0;
  const hex = n.toString(16).padStart(12, "0");
  return `${NAMESPACE}${hex}`;
}
