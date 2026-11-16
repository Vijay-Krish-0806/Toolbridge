/**
 * Seeded pseudo-random number generator (mulberry32).
 * The same seed always produces the same sequence, which makes the seed data repeatable.
 * Not suitable for anything security-related.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy (Fisher-Yates). The input is not changed. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[int(0, items.length - 1)] as (typeof items)[number];
    },
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i);
        const a = copy[i] as (typeof copy)[number];
        copy[i] = copy[j] as (typeof copy)[number];
        copy[j] = a;
      }
      return copy;
    },
  };
}
