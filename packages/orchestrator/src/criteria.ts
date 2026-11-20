import {
  counterTps, DEFAULT_GATES, DEFAULT_TPS_DIVERGENCE, latencySummary, lowTps, maxGap, monotonic, summarize,
  type AgentLinkEvent, type AgentTelemetry, type BotFleetStats, type GametimeSample, type GatesConfig, type InterferenceSample, type PassCriteria,
  type ProbeSample, type StepResult, type Summary, type SysSample
} from '@bedperf/core'
import { checkInterference, mainThreadCpuSeries, summarizeInterference, tickCpuMsPerTick, type TickPoint } from '@bedperf/sysmon'

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
  /** Hold start / end, host epoch ms. Needed by the tick-counter, interference and tick-CPU metrics. */
  t0?: number
  t1?: number
  /**
   * Tick-counter replies received up to the end of the hold (those received inside `[t0, t1]` are used).
   * The gametime gates apply only when `gametimeIntervalMs` is set (the sampler ran).
   */
  gametime?: readonly GametimeSample[]
  /** Interval of the tick-counter sampler, ms; set when it ran for this step. */
  gametimeIntervalMs?: number
  /** Interference samples covering the hold; when given (even empty) the interference gate applies. */
  interference?: readonly InterferenceSample[]
  /** OS samples around the hold (not trimmed), for tick-thread CPU per tick. Default: `sys`. */
  tickSys?: readonly SysSample[]
  /** Probe samples around the hold (not trimmed by the start mark), to interpolate the probe tick counter. Default: `probe`. */
  probeAround?: readonly ProbeSample[]
  /** Invalid reasons established outside the window data (e.g. `placement_mismatch`), listed after loadgen saturation. */
  extraInvalid?: readonly string[]
  /**
   * Remote agents whose control link was lost between the step start and the hold end (`agent.link` `lost`
   * events): their bots are gone, so the step is invalid.
   */
  agentsLost?: readonly AgentLinkEvent[]
  /**
   * Telemetry of the remote agents whose interval lies inside the hold, with its receive time. Foreign load on
   * an agent machine over the interference gates makes the step invalid.
   */
  agentTelemetry?: ReadonlyArray<{ t: number, data: AgentTelemetry }>
}

/** Thresholds `evaluateStep` takes besides the pass criteria. */
export interface EvaluateOptions {
  gates?: Partial<GatesConfig>
}

/** The part of `StepResult` that `evaluateStep` derives from a window. */
export type StepEvaluation = Omit<StepResult, 'repeat' | 'index' | 'players' | 'phase' | 'startT' | 'endT'>

/** Exact `failReasons` entry for a step measured while the load generator was saturated. */
export const LOADGEN_SATURATED_REASON = 'loadgen saturated'

/** pass: held the load; fail: did not; invalid: the measurement says nothing about the server (see `invalidReasons`). */
export type StepOutcome = 'pass' | 'fail' | 'invalid'

export function stepOutcome (s: Pick<StepResult, 'pass' | 'loadgenSaturated' | 'invalidReasons'>): StepOutcome {
  if (s.loadgenSaturated || (s.invalidReasons !== undefined && s.invalidReasons.length > 0)) return 'invalid'
  return s.pass ? 'pass' : 'fail'
}

/** Invalid-reason codes (an entry is `<code>` or `<code>: <detail>`). */
export const InvalidCodes = {
  placementMismatch: 'placement_mismatch',
  interference: 'interference',
  tpsSourcesDisagree: 'tps_sources_disagree',
  gametimeMissing: 'gametime_missing',
  gametimeGap: 'gametime_gap',
  gametimeLatency: 'gametime_latency',
  gametimeNonMonotonic: 'gametime_non_monotonic',
  /** A remote bot agent's control link was lost (its bots went with it). */
  agentLost: 'agent_lost',
  /** Foreign load on a remote agent's machine over the interference gates. */
  agentInterference: 'agent_interference',
  /** Agents reconnected between repeats are other machines than the run recorded. */
  agentTopologyChanged: 'agent_topology_changed'
} as const

/** Probe tick counter at `t`, linearly interpolated between the samples around it (no extrapolation). */
function probeTickAt (sorted: readonly ProbeSample[], t: number): number | undefined {
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (a.t <= t && t <= b.t) {
      if (b.tick < a.tick) return undefined
      return b.t === a.t ? a.tick : a.tick + (b.tick - a.tick) * (t - a.t) / (b.t - a.t)
    }
  }
  return undefined
}

/**
 * Share of the hold the first-to-last tick-counter replies must span for `counterTps`: two
 * sampling intervals of slack, clamped to [0.5, 0.9].
 */
export function counterCoverage (holdMs: number, intervalMs: number): number {
  if (!(holdMs > 0)) return 0.9
  return Math.min(0.9, Math.max(0.5, 1 - 2 * intervalMs / holdMs))
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
 *   first in `failReasons` and in `invalidReasons`; `stepOutcome()` maps that to 'invalid'.
 * - validity gates (`invalidReasons`, any entry makes the step invalid): interference over the gates,
 *   tick-counter replies missing / gap / latency / non-monotonic, probe vs counter TPS divergence, and
 *   `extraInvalid` (placement). Tick counter TPS below `minCounterTps` (default `minAvgTps`) fails the step.
 */
export function evaluateStep (window: MeasuredWindow, criteria: PassCriteria, opts: EvaluateOptions = {}): StepEvaluation {
  const reasons: string[] = []
  const invalid: string[] = []
  const gates: GatesConfig = { ...DEFAULT_GATES, ...opts.gates }
  const probe = window.probe.filter(s => s.type === 'sample' && s.ticks >= 0 && s.windowMs > 0)

  // Saturated load generator reports in the hold: any (default), or more than gates.loadgenSaturatedMaxFraction.
  const satCount = window.bots.filter(b => b.loadgen.saturated).length
  const satMax = gates.loadgenSaturatedMaxFraction
  const loadgenSaturated = satMax === undefined || window.bots.length === 0
    ? satCount > 0
    : satCount / window.bots.length > satMax
  if (loadgenSaturated) {
    reasons.push(LOADGEN_SATURATED_REASON)
    invalid.push(LOADGEN_SATURATED_REASON)
  }
  if (window.extraInvalid !== undefined) invalid.push(...window.extraInvalid)

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
    // Bots that never joined count against maxBotFailures as well (default 0: any shortfall fails the step).
    if (window.players !== undefined && window.players - last.spawned > criteria.maxBotFailures) reasons.push(`only ${last.spawned}/${window.players} bots spawned`)
  }
  const rttMs = poolSummaries(window.bots.flatMap(b => b.rttMs === undefined ? [] : [b.rttMs]))

  const extra: Partial<StepEvaluation> = {}
  const { t0, t1 } = window
  const hold = t0 !== undefined && t1 !== undefined && t1 > t0 ? { t0, t1 } : undefined

  // --- interference ---
  if (window.interference !== undefined) {
    const sum = summarizeInterference([...window.interference])
    if (sum.samples > 0) {
      const i: NonNullable<StepResult['interference']> = { foreignMean: sum.foreignMean, foreignPeak10s: sum.foreignPeak10s }
      if (sum.serverSetForeignMean !== undefined) i.serverSetForeignMean = sum.serverSetForeignMean
      extra.interference = i
    }
    const chk = checkInterference(sum, { foreignMean: gates.foreignMean, foreignPeak10s: gates.foreignPeak10s, serverSetForeignMean: gates.serverSetForeignMean })
    if (!chk.ok) invalid.push(`${InvalidCodes.interference}: ${chk.reasons.join('; ')}`)
  }

  // --- remote agents ---
  const lostNames = new Map<string, string | undefined>()
  for (const e of window.agentsLost ?? []) if (e.event === 'lost' && !lostNames.has(e.agent)) lostNames.set(e.agent, e.reason)
  for (const [name, why] of lostNames) invalid.push(`${InvalidCodes.agentLost}: ${name}${why !== undefined ? ` (${why})` : ''}`)
  const byAgent = new Map<string, InterferenceSample[]>()
  for (const { t, data } of window.agentTelemetry ?? []) {
    // only `t` and `foreignCores` feed the summary
    const s = { t, intervalMs: data.intervalMs, foreignCores: data.foreignCores } as InterferenceSample
    byAgent.set(data.agent, [...(byAgent.get(data.agent) ?? []), s])
  }
  for (const [name, xs] of byAgent) {
    const chk = checkInterference(summarizeInterference(xs), { foreignMean: gates.foreignMean, foreignPeak10s: gates.foreignPeak10s })
    if (!chk.ok) invalid.push(`${InvalidCodes.agentInterference}: ${name} ${chk.reasons.join('; ')}`)
  }

  // --- tick counter (time query gametime) ---
  const inside = hold !== undefined && window.gametime !== undefined
    ? window.gametime.filter(g => g.t >= hold.t0 && g.t <= hold.t1).sort((a, b) => a.t - b.t || a.sentAt - b.sentAt)
    : []
  if (hold !== undefined && inside.length > 0) {
    const ct = counterTps(inside, hold.t0, hold.t1, counterCoverage(hold.t1 - hold.t0, window.gametimeIntervalMs ?? 5000))
    if (ct !== undefined) extra.counterTps = ct
    const low = lowTps(inside, 4.5)
    if (low !== undefined) extra.counterTpsLow5 = low
    extra.gametimeMaxGapMs = maxGap(inside, hold.t0, hold.t1)
    extra.gametimeLatencyMs = summarize(inside.map(g => g.latencyMs))
  }
  if (hold !== undefined && window.gametimeIntervalMs !== undefined) {
    if (inside.length < 2) invalid.push(`${InvalidCodes.gametimeMissing}: ${inside.length} tick-counter replies in the hold`)
    else {
      const gap = maxGap(inside, hold.t0, hold.t1)
      if (gap > gates.gametimeMaxGapSec * 1000) invalid.push(`${InvalidCodes.gametimeGap}: no reply for ${fmt(gap / 1000, 1)} s > ${gates.gametimeMaxGapSec} s`)
      const lat = latencySummary(inside)
      if (lat.p99 > gates.gametimeLatencyP99Sec * 1000) invalid.push(`${InvalidCodes.gametimeLatency}: reply latency p99 ${fmt(lat.p99 / 1000, 1)} s > ${gates.gametimeLatencyP99Sec} s`)
      if (!monotonic(inside)) invalid.push(InvalidCodes.gametimeNonMonotonic)
    }
  }
  if (extra.counterTps !== undefined && tps.n > 0) {
    const minCounter = criteria.minCounterTps ?? criteria.minAvgTps
    if (extra.counterTps < minCounter) reasons.push(`counter TPS ${fmt(extra.counterTps)} < ${minCounter}`)
  }
  // Cross-check over exactly the reply span: counter rate vs the probe tick counter interpolated at both ends.
  if (inside.length >= 2) {
    const a = inside[0]!
    const b = inside[inside.length - 1]!
    const around = [...(window.probeAround ?? probe)].filter(s => s.type === 'sample').sort((x, y) => x.t - y.t)
    const pa = probeTickAt(around, a.t)
    const pb = probeTickAt(around, b.t)
    if (b.t > a.t && pa !== undefined && pb !== undefined) {
      const counterRate = (b.gametime - a.gametime) / ((b.t - a.t) / 1000)
      const probeRate = (pb - pa) / ((b.t - a.t) / 1000)
      const limit = criteria.maxProbeCounterTpsDivergence ?? DEFAULT_TPS_DIVERGENCE
      if (Math.abs(counterRate - probeRate) > limit) {
        invalid.push(`${InvalidCodes.tpsSourcesDisagree}: probe ${fmt(probeRate)} vs counter ${fmt(counterRate)} TPS (> ${limit})`)
      }
    }
  }

  // --- tick-thread CPU per tick ---
  if (hold !== undefined) {
    const cpu = mainThreadCpuSeries([...(window.tickSys ?? window.sys)].sort((x, y) => x.t - y.t))
    if (cpu.length >= 2) {
      const ticks: TickPoint[] = inside.length >= 2
        ? inside.map(g => ({ t: g.t, tick: g.gametime }))
        : probe.map(s => ({ t: s.t, tick: s.tick }))
      const w0 = Math.max(hold.t0, cpu[0]!.t)
      const w1 = Math.min(hold.t1, cpu[cpu.length - 1]!.t)
      const v = w1 > w0 ? tickCpuMsPerTick(cpu, ticks, w0, w1) : undefined
      if (v !== undefined) extra.tickCpuMsPerTick = v
    }
  }
  const src = [...window.sys].reverse().find(s => s.mainThread?.source !== undefined)?.mainThread?.source
  if (src !== undefined) extra.tickThreadSource = src

  // --- view load ---
  if (last !== undefined) {
    if (last.inView !== undefined) extra.inViewMedian = last.inView.median
    if (last.viewT90Ms !== undefined) extra.viewT90MsP50 = last.viewT90Ms.p50
    if (last.uniqChunks !== undefined && last.spawned > 0) extra.uniqChunksPerBot = last.uniqChunks / last.spawned
  }
  const cps = mean(window.bots.flatMap(b => b.chunksPerSec === undefined ? [] : [b.chunksPerSec]))
  if (cps !== undefined) extra.chunksPerSec = cps

  const res: StepEvaluation = {
    tps,
    tickIntervalMs,
    over50,
    over100,
    botFailures,
    loadgenSaturated,
    pass: reasons.length === 0 && invalid.length === 0,
    failReasons: reasons,
    invalidReasons: invalid,
    ...extra
  }
  if (mainThreadUtil !== undefined) res.mainThreadUtil = mainThreadUtil
  if (cpuPct !== undefined) res.cpuPct = cpuPct
  if (rssBytes !== undefined) res.rssBytes = rssBytes
  if (rttMs !== undefined) res.rttMs = rttMs
  if (netRx !== undefined) res.netRxBytesPerSec = netRx
  if (netTx !== undefined) res.netTxBytesPerSec = netTx
  return res
}
