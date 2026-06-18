// Deterministic RNG + helpers shared across all demo seed phases. Mulberry32
// matches the legacy seed.ts pattern so behaviour stays familiar; everything
// here is pure so re-running yields identical content.

export type Rng = () => number;

export function rngSeeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(arr: readonly T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function pickN<T>(arr: readonly T[], n: number, rng: Rng): T[] {
  if (n >= arr.length) return [...arr];
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

export function intBetween(min: number, max: number, rng: Rng): number {
  return Math.floor(min + rng() * (max - min + 1));
}

export function floatBetween(min: number, max: number, rng: Rng): number {
  return min + rng() * (max - min);
}

const DAY_MS = 86400_000;

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}

export function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * DAY_MS);
}

export function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Stable UUID derived from a string seed via a tiny deterministic hash. We
// don't need cryptographic strength — only that the same input always
// produces the same v4-shaped UUID so re-seeds wipe and re-insert the same
// rows. Mirrors the seedMockCalls pattern.
export function stableUuid(seed: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xdeadbeef >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
  }
  // Fan out to 16 bytes by stepping the two halves through more rounds.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 11), 0xc2b2ae3d) >>> 0;
    bytes[i] = ((i & 1 ? h2 : h1) >>> ((i & 3) * 8)) & 0xff;
  }
  // RFC 4122 v4 / variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
