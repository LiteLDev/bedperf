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
