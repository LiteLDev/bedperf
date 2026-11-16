import type { Fit } from './types.ts'

/** Returns `v` when it is a finite number, else undefined. */
export function num (v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function mean (xs: readonly number[]): number | undefined {
  const f = xs.filter(Number.isFinite)
  if (f.length === 0) return undefined
  let s = 0
  for (const x of f) s += x
  return s / f.length
}

export function median (xs: readonly number[]): number | undefined {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return undefined
  const m = n >> 1
  return n % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Ordinary least-squares fit of y on x. Needs at least two distinct x values. */
export function linreg (pts: ReadonlyArray<readonly [number, number]>): Fit | undefined {
  const p = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  const n = p.length
  if (n < 2) return undefined
  let sx = 0
  let sy = 0
  for (const [x, y] of p) { sx += x; sy += y }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of p) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  if (sxx === 0) return undefined
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2, n }
}

/**
 * Linear interpolation of y at x over points sorted by x. Returns undefined outside the
 * range of the points (no extrapolation).
 */
export function interp (pts: ReadonlyArray<readonly [number, number]>, x: number): number | undefined {
  const p = pts.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  if (p.length === 0) return undefined
  for (let i = 0; i < p.length; i++) {
    const [xi, yi] = p[i]!
    if (xi === x) return yi
    if (xi > x) {
      if (i === 0) return undefined
      const [xa, ya] = p[i - 1]!
      return ya + (yi - ya) * (x - xa) / (xi - xa)
    }
  }
  return undefined
}

/** "Nice" axis ticks covering [min, max]. */
export function niceTicks (min: number, max: number, target = 5): { min: number, max: number, step: number, ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1 }
  if (max < min) [min, max] = [max, min]
  // A range that is zero (or vanishing next to the magnitude) gets padded, so the step stays
  // representable at that magnitude.
  if (max - min <= Math.max(Math.abs(min), Math.abs(max)) * 1e-9) {
    const pad = min === 0 && max === 0 ? 1 : Math.max(Math.abs(min), Math.abs(max)) * 0.1
    min -= pad
    max += pad
  }
  const raw = (max - min) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const lo = Math.floor(min / step + 1e-9) * step
  const hi = Math.ceil(max / step - 1e-9) * step
  const count = Math.min(1000, Math.round((hi - lo) / step))
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) ticks.push(Number((lo + i * step).toPrecision(12)))
  return { min: lo, max: hi, step, ticks }
}

/** Downsamples [x, y] points into at most `buckets` buckets, reducing y with `reduce`. */
export function downsample (
  pts: ReadonlyArray<[number, number]>,
  buckets: number,
  reduce: 'mean' | 'min' | 'max' = 'mean'
): Array<[number, number]> {
  if (pts.length <= buckets) return pts.slice()
  const x0 = pts[0]![0]
  const x1 = pts[pts.length - 1]![0]
  const w = (x1 - x0) / buckets || 1
  const out: Array<[number, number]> = []
  let cur = -1
  let xs = 0
  let acc = 0
  let n = 0
  const flush = (): void => {
    if (n > 0) out.push([xs / n, reduce === 'mean' ? acc / n : acc])
  }
  for (const [x, y] of pts) {
    const b = Math.min(buckets - 1, Math.floor((x - x0) / w))
    if (b !== cur) {
      flush()
      cur = b
      xs = 0
      n = 0
      acc = reduce === 'min' ? Infinity : reduce === 'max' ? -Infinity : 0
    }
    xs += x
    n++
    acc = reduce === 'min' ? Math.min(acc, y) : reduce === 'max' ? Math.max(acc, y) : acc + y
  }
  flush()
  return out
}

/**
 * Binomial coefficient C(n, k), exact for the small n used here (repeat counts). Returns 0 when
 * k is outside [0, n] and NaN for non-integer or negative n.
 */
export function binomial (n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0) return Number.NaN
  if (k < 0 || k > n) return 0
  const kk = Math.min(k, n - k)
  let c = 1
  // c stays C(n - kk + i, i), an integer, after every step.
  for (let i = 1; i <= kk; i++) c = (c * (n - kk + i)) / i
  return Math.round(c)
}

/**
 * Chance that m values of one group and n of another come out completely separated in one given
 * direction (every value of one above every value of the other) when there is no real
 * difference, i.e. every ordering is equally likely: 1 / C(m + n, m). 3 vs 3 gives 1/20,
 * 5 vs 5 gives 1/252.
 */
export function separationChance (m: number, n: number): number {
  return 1 / binomial(m + n, m)
}

/**
 * Mann-Whitney U of `b` against `a`: the number of (a, b) pairs with b > a, ties counting 1/2.
 * U = m * n means every b is above every a; U = 0 means every b is below every a.
 */
export function mannWhitneyU (a: readonly number[], b: readonly number[]): number {
  let u = 0
  for (const y of b) {
    for (const x of a) u += y > x ? 1 : y === x ? 0.5 : 0
  }
  return u
}

/** Average ranks (1-based) of `xs`, ties sharing the mean of the ranks they span. */
export function ranks (xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0])
  const out = new Array<number>(xs.length)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[order[k]![1]] = r
    i = j + 1
  }
  return out
}

/**
 * Complete-separation test of group `b` against group `a`: 'higher' when every b is strictly
 * above every a, 'lower' when every b is strictly below every a, else 'overlap'. Non-finite
 * values are ignored; an empty group gives 'overlap'.
 */
export function dominance (a: readonly number[], b: readonly number[]): 'higher' | 'lower' | 'overlap' {
  const fa = a.filter(Number.isFinite)
  const fb = b.filter(Number.isFinite)
  if (fa.length === 0 || fb.length === 0) return 'overlap'
  // Equivalent to Mann-Whitney U = m * n (higher) or U = 0 (lower).
  if (Math.min(...fb) > Math.max(...fa)) return 'higher'
  if (Math.max(...fb) < Math.min(...fa)) return 'lower'
  return 'overlap'
}
