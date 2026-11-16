/** Summary statistics over a numeric sample. All fields are NaN for an empty input. */
export interface Summary {
  n: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

/**
 * Percentile with linear interpolation between closest ranks (numpy's default).
 * `sorted` must be ascending. `p` in [0, 100].
 */
export function percentileSorted (sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  if (n === 1) return sorted[0]!
  const rank = (Math.min(Math.max(p, 0), 100) / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const a = sorted[lo]!
  const b = sorted[hi]!
  return a + (b - a) * (rank - lo)
}

export function percentile (values: readonly number[], p: number): number {
  return percentileSorted([...values].sort((a, b) => a - b), p)
}

export function summarize (values: readonly number[]): Summary {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (s.length === 0) {
    return { n: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN }
  }
  let sum = 0
  for (const v of s) sum += v
  return {
    n: s.length,
    min: s[0]!,
    max: s[s.length - 1]!,
    mean: sum / s.length,
    p50: percentileSorted(s, 50),
    p95: percentileSorted(s, 95),
    p99: percentileSorted(s, 99)
  }
}
