import { summarize, type BotFleetStats, type PassCriteria, type ProbeSample, type StepResult, type Summary, type SysSample } from '@bedperf/core'

/** Everything measured during one step's hold window. */
export interface MeasuredWindow {
  /** Probe samples whose window lies inside the hold. */
  probe: readonly ProbeSample[]
  /** OS samples received during the hold. */
  sys: readonly SysSample[]
  /** Fleet stats received during the hold. */
  bots: readonly BotFleetStats[]
  /**
   * Last fleet stats seen before the step began (before `scaleTo`). Failure counters are
   * cumulative, so the step's failures are `last - baseline`. When absent, the first stats
   * record of the window is the baseline.
   */
  botBaseline?: BotFleetStats
  /** Target player count of the step; when given, a fleet that spawned fewer bots fails. */
  players?: number
}

/** The part of `StepResult` that `evaluateStep` derives from a window. */
export type StepEvaluation = Omit<StepResult, 'repeat' | 'index' | 'players' | 'phase' | 'startT' | 'endT'>

/** Exact `failReasons` entry for a step measured while the load generator was saturated. */
export const LOADGEN_SATURATED_REASON = 'loadgen saturated'

/** pass: held the load; fail: did not; invalid: measured while the loadgen was saturated, so it says nothing about the server. */
export type StepOutcome = 'pass' | 'fail' | 'invalid'

export function stepOutcome (s: Pick<StepResult, 'pass' | 'loadgenSaturated'>): StepOutcome {
  if (s.loadgenSaturated) return 'invalid'
  return s.pass ? 'pass' : 'fail'
}

const fmt = (v: number, d = 2): string => Number.isFinite(v) ? v.toFixed(d) : String(v)

/**
 * Approximate a pooled sample from per-window quantile summaries.
 *
 * Each window contributes `n` points drawn from a piecewise-linear inverse CDF through its
 * known quantiles; `u = k / (n - 1)` matches the linear-interpolation percentile definition,
 * so a window's own p99 / max are reproduced. Below the median the window's p50 is used (or
 * its min when known); the low tail does not matter for the criteria.
 */
export function poolQuantiles (parts: ReadonlyArray<{ n: number, min?: number, p50: number, p95: number, p99: number, max: number }>): number[] {
  const out: number[] = []
  for (const p of parts) {
    const n = Math.round(p.n)
    if (!(n > 0) || ![p.p50, p.p95, p.p99, p.max].every(Number.isFinite)) continue
    const lo = p.min !== undefined && Number.isFinite(p.min) ? p.min : p.p50
    const anchors: Array<[number, number]> = [[0, lo], [0.5, p.p50], [0.95, p.p95], [0.99, p.p99], [1, p.max]]
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0.5 : k / (n - 1)
      let val = p.max
      for (let i = 1; i < anchors.length; i++) {
        const [u1, v1] = anchors[i]!
        if (u <= u1) {
          const [u0, v0] = anchors[i - 1]!
          val = u1 === u0 ? v1 : v0 + (v1 - v0) * (u - u0) / (u1 - u0)
          break
        }
      }
      out.push(val)
    }
  }
  return out
}

/** Pool several `Summary`s (e.g. per-interval RTT summaries) into one, approximately (see `poolQuantiles`). */
export function poolSummaries (parts: readonly Summary[]): Summary | undefined {
  const valid = parts.filter(s => s.n > 0 && Number.isFinite(s.mean))
  if (valid.length === 0) return undefined
  const pooled = summarize(poolQuantiles(valid))
  let n = 0
  let sum = 0
  for (const s of valid) { n += s.n; sum += s.mean * s.n }
  return {
    ...pooled,
    n,
    mean: sum / n,
    min: Math.min(...valid.map(s => s.min)),
    max: Math.max(...valid.map(s => s.max))
  }
}

function failureCount (s: BotFleetStats): number {
  return s.joinFailures + s.unexpectedDisconnects
}

function mean (xs: readonly number[]): number | undefined {
  const s = summarize(xs)
  return s.n > 0 ? s.mean : undefined
}

/**
 * Evaluate one step against the pass criteria. Pure.
 *
 * - avg TPS: mean of the windows' TPS.
 * - worst-window TPS: drop the worst `worstWindowDiscardPct` % of windows (floor), take the min of the rest.
 * - tick interval p99: over the pooled interval distribution reconstructed from the windows.
 * - main-thread util: mean of `mainThread.util`, only when `maxMainThreadUtil` is set.
 * - bot failures: delta of joinFailures + unexpectedDisconnects since the baseline.
 * - missing probe data, missing bot stats, or (when the criterion is set) missing main-thread data fail the step.
 * - a saturated loadgen yields `pass = false`, `loadgenSaturated = true` and `LOADGEN_SATURATED_REASON`
 *   first in `failReasons`; `stepOutcome()` maps that to 'invalid'.
 */
export function evaluateStep (window: MeasuredWindow, criteria: PassCriteria): StepEvaluation {
  const reasons: string[] = []
  const probe = window.probe.filter(s => s.type === 'sample' && s.ticks >= 0 && s.windowMs > 0)

  const loadgenSaturated = window.bots.some(b => b.loadgen.saturated)
  if (loadgenSaturated) reasons.push(LOADGEN_SATURATED_REASON)

  // --- TPS & tick intervals (probe) ---
  const tpsValues = probe.map(s => s.tps)
  const tps = summarize(tpsValues)
  const intervalParts = probe.map(s => ({ n: s.ticks, p50: s.interval.p50, p95: s.interval.p95, p99: s.interval.p99, max: s.interval.max }))
  const pooled = summarize(poolQuantiles(intervalParts))
  let tickN = 0
  let tickSum = 0
  for (const s of probe) {
    if (s.ticks > 0 && Number.isFinite(s.interval.mean)) { tickN += s.ticks; tickSum += s.interval.mean * s.ticks }
  }
  const maxes = probe.flatMap(s => s.ticks > 0 && Number.isFinite(s.interval.max) ? [s.interval.max] : [])
  const tickIntervalMs: Summary = tickN > 0
    ? { ...pooled, n: tickN, mean: tickSum / tickN, max: maxes.length > 0 ? Math.max(...maxes) : pooled.max }
    : pooled
  let over50 = 0
  let over100 = 0
  for (const s of probe) { over50 += s.over50; over100 += s.over100 }

  if (tps.n === 0) {
    reasons.push('no probe data in window')
  } else {
    if (tps.mean < criteria.minAvgTps) reasons.push(`avg TPS ${fmt(tps.mean)} < ${criteria.minAvgTps}`)
    const sorted = tpsValues.filter(Number.isFinite).sort((a, b) => a - b)
    const discard = Math.min(Math.floor(sorted.length * criteria.worstWindowDiscardPct / 100), sorted.length - 1)
    const worst = sorted[discard]!
    if (worst < criteria.minWorstWindowTps) {
      reasons.push(`worst-window TPS ${fmt(worst)} < ${criteria.minWorstWindowTps} (after discarding ${discard} of ${sorted.length} windows)`)
    }
    if (!Number.isFinite(tickIntervalMs.p99)) reasons.push('no tick interval data in window')
    else if (tickIntervalMs.p99 > criteria.maxTickIntervalP99Ms) reasons.push(`tick interval p99 ${fmt(tickIntervalMs.p99, 1)} ms > ${criteria.maxTickIntervalP99Ms} ms`)
  }

  // --- OS ---
  const mtValues = window.sys.flatMap(s => s.mainThread === undefined ? [] : [s.mainThread.util])
  const mainThreadUtil = mtValues.length > 0 ? summarize(mtValues) : undefined
  if (criteria.maxMainThreadUtil !== undefined) {
    if (mainThreadUtil === undefined) reasons.push('no main-thread utilisation data in window')
    else if (mainThreadUtil.mean > criteria.maxMainThreadUtil) reasons.push(`main-thread util ${fmt(mainThreadUtil.mean, 3)} > ${criteria.maxMainThreadUtil}`)
  }
  const cpuPct = window.sys.length > 0 ? summarize(window.sys.map(s => s.cpuPct)) : undefined
  const rssBytes = window.sys.length > 0 ? summarize(window.sys.map(s => s.rssBytes)) : undefined
  const netRx = mean(window.sys.flatMap(s => s.net === undefined ? [] : [s.net.rxBytesPerSec]))
  const netTx = mean(window.sys.flatMap(s => s.net === undefined ? [] : [s.net.txBytesPerSec]))

  // --- bots ---
  let botFailures = 0
  const last = window.bots.at(-1)
  if (last === undefined) {
    reasons.push('no bot stats in window')
  } else {
    const base = window.botBaseline ?? window.bots[0]!
    botFailures = Math.max(0, failureCount(last) - failureCount(base))
    if (botFailures > criteria.maxBotFailures) reasons.push(`bot failures ${botFailures} > ${criteria.maxBotFailures}`)
    if (window.players !== undefined && last.spawned < window.players) reasons.push(`only ${last.spawned}/${window.players} bots spawned`)
  }
  const rttMs = poolSummaries(window.bots.flatMap(b => b.rttMs === undefined ? [] : [b.rttMs]))

  const res: StepEvaluation = {
    tps,
    tickIntervalMs,
    over50,
    over100,
    botFailures,
    loadgenSaturated,
    pass: reasons.length === 0,
    failReasons: reasons
  }
  if (mainThreadUtil !== undefined) res.mainThreadUtil = mainThreadUtil
  if (cpuPct !== undefined) res.cpuPct = cpuPct
  if (rssBytes !== undefined) res.rssBytes = rssBytes
  if (rttMs !== undefined) res.rttMs = rttMs
  if (netRx !== undefined) res.netRxBytesPerSec = netRx
  if (netTx !== undefined) res.netTxBytesPerSec = netTx
  return res
}
