// Deterministic per-bot RNG: mulberry32 seeded by a hash of (run seed, bot index).

/** mulberry32 PRNG. Returns floats in [0, 1). */
export function mulberry32 (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 32-bit mix of (seed, index) so neighbouring indices get unrelated streams. */
export function botSeed (seed: number, index: number): number {
  let h = (Math.trunc(seed) ^ Math.imul(index + 1, 0x9E3779B9)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B)
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35)
  return (h ^ (h >>> 16)) >>> 0
}

export function botRandom (seed: number, index: number): () => number {
  return mulberry32(botSeed(seed, index))
}

/**
 * Whether bot `index` belongs to an evenly spread sample of `ratio` of all bots (bot 0 is always in when
 * ratio > 0; ratio >= 1 selects every bot).
 */
export function isSampled (index: number, ratio: number): boolean {
  if (!(ratio > 0)) return false
  if (ratio >= 1) return true
  return Math.floor(index * ratio) !== Math.floor((index - 1) * ratio)
}
