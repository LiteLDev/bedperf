/**
 * Script-free tick rate from the server's tick counter (`time query gametime`), a cross-check
 * for the Script API probe TPS.
 *
 * The host asks for the counter every few seconds. Each reply is a `GametimeSample`: when the
 * command was written (`sentAt`), when the reply line was read (`t`) and the counter value. A
 * rate over a window `[t0, t1]` uses the first reply `a` and the last reply `b` received inside
 * the window: `(g_b - g_a) / (t_b - t_a)`. Reply times jitter, so short windows can read above
 * 20; values are never clamped.
 *
 * All times are host epoch milliseconds; rates are ticks per second.
 */
import { summarize } from './stats.ts'

/** One `time query gametime` round trip. */
export interface GametimeReading {
  /** Counter value from `Gametime is <n>`. */
  gametime: number
  /** Host epoch ms right before the command bytes were written. */
  sentAt: number
  /** Host epoch ms when the reply line was read. */
  recvAt: number
}

/** One sampled reply, as recorded in the `bds.gametime` envelope. */
export interface GametimeSample {
  /** Receive time (host epoch ms); the time the counter value is attributed to. */
  t: number
  /** Host epoch ms right before the command bytes were written. */
  sentAt: number
  gametime: number
  /** `t - sentAt`. */
  latencyMs: number
}

function byTime (samples: readonly GametimeSample[]): GametimeSample[] {
  return [...samples].sort((a, b) => a.t - b.t || a.sentAt - b.sentAt)
}

/** Replies received inside `[t0, t1]`, in receive order. */
function inside (samples: readonly GametimeSample[], t0: number, t1: number): GametimeSample[] {
  return byTime(samples).filter(s => s.t >= t0 && s.t <= t1)
}

/**
 * Ticks per second over `[t0, t1]` from the first and last reply inside it. Undefined when the
 * window is empty, has fewer than two replies, or the replies span less than `minCoverage`
 * (default 0.9) of the window.
 */
export function counterTps (samples: readonly GametimeSample[], t0: number, t1: number, minCoverage = 0.9): number | undefined {
  if (!(t1 > t0)) return undefined
  const pts = inside(samples, t0, t1)
  if (pts.length < 2) return undefined
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const span = b.t - a.t
  if (span <= 0 || span < minCoverage * (t1 - t0)) return undefined
  return (b.gametime - a.gametime) / (span / 1000)
}

/**
 * Lowest rate over any stretch of consecutive replies spanning at least `minSpanSec` seconds.
 * For each reply `i`, `j` is the first later reply with `t_j - t_i >= minSpanSec`. 4.5 s gives
 * the "lowest 5 s" value with a 5 s sampling interval (the half second absorbs reply jitter).
 * Undefined when no such stretch exists.
 */
export function lowTps (samples: readonly GametimeSample[], minSpanSec = 4.5): number | undefined {
  const pts = byTime(samples)
  const minSpan = minSpanSec * 1000
  let best: number | undefined
  let j = 0
  for (let i = 0; i < pts.length; i++) {
    j = Math.max(j, i + 1)
    while (j < pts.length && pts[j]!.t - pts[i]!.t < minSpan) j++
    if (j >= pts.length) break
    const span = pts[j]!.t - pts[i]!.t
    if (span <= 0) continue
    const rate = (pts[j]!.gametime - pts[i]!.gametime) / (span / 1000)
    if (best === undefined || rate < best) best = rate
  }
  return best
}

/** Longest stretch (ms) of `[t0, t1]` without a reply, counting from `t0` and up to `t1`. */
export function maxGap (samples: readonly GametimeSample[], t0: number, t1: number): number {
  if (!(t1 > t0)) return 0
  const times = [t0, ...inside(samples, t0, t1).map(s => s.t), t1]
  let max = 0
  for (let i = 1; i < times.length; i++) max = Math.max(max, times[i]! - times[i - 1]!)
  return max
}

/** Reply latency (`t - sentAt`, ms) distribution. Fields are NaN when there are no samples. */
export function latencySummary (samples: readonly GametimeSample[]): { n: number, p50: number, p99: number, max: number } {
  const s = summarize(samples.map(x => x.latencyMs))
  return { n: s.n, p50: s.p50, p99: s.p99, max: s.max }
}

/** True when the counter never decreases between consecutive replies (in receive order). */
export function monotonic (samples: readonly GametimeSample[]): boolean {
  const pts = byTime(samples)
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.gametime < pts[i - 1]!.gametime) return false
  }
  return true
}
