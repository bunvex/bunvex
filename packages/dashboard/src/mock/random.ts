// A small seeded PRNG (mulberry32), so the mock's data — and every test and screenshot built on it — is the
// same on every run for the same seed.

export type Random = {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** A Convex-style document id: 32 characters of lowercase base32. */
  id(): string;
};

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function createRandom(seed: number): Random {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
    id: () => Array.from({ length: 32 }, () => ID_ALPHABET[int(0, 31)]).join(""),
  };
}
