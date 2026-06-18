// Shared keyset (seek) pagination helpers. A cursor encodes the last row's
// (timestamp, id) tuple as base64url(JSON) so pages are stable and disjoint
// even when rows are inserted concurrently. Matches the inline pattern in
// routes/question-banks.ts; extracted so coaching (and future pages) reuse it.

export type KeyCursor = { ts: string; id: string };

export function encodeCursor(c: KeyCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s?: string | null): KeyCursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (obj && typeof obj.ts === "string" && typeof obj.id === "string") {
      return { ts: obj.ts, id: obj.id };
    }
  } catch {
    /* ignore malformed cursor → treated as first page */
  }
  return null;
}
