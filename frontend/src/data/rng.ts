// Seeded RNG for stable sample data across reloads
let seed = 1337;
export function rng() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
export function resetRng(s = 1337) { seed = s; }
export function pick<T>(arr: T[]): T { return arr[Math.floor(rng() * arr.length)]; }
export function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}
export function rand(min: number, max: number) { return min + rng() * (max - min); }
export function randInt(min: number, max: number) { return Math.floor(rand(min, max + 1)); }
export function chance(p: number) { return rng() < p; }
