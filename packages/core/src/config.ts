import type { ServerProperties } from './bds.ts'
import type { CpuSpec, PlacementPriority } from './placement.ts'
import type { ServerSpec } from './server.ts'

/** Thresholds a load step must meet to "pass" (i.e. the server holds 20 TPS at that load). */
export interface PassCriteria {
  /** Mean TPS over the measured window. Default 19.8. */
  minAvgTps: number
  /** Minimum over 1 s windows, after discarding the worst `worstWindowDiscardPct` %. Default 19.0. */
  minWorstWindowTps: number
  worstWindowDiscardPct: number
  /** p99 of tick intervals, ms. Default 80: BDS on Windows sleeps in ~15.6 ms timer quanta, so a healthy 20 TPS server alternates ~47/63 ms intervals. */
  maxTickIntervalP99Ms: number
  /** Optional: mean main-thread utilisation ceiling (0..1). Not enforced when undefined. */
  maxMainThreadUtil?: number
  /** Max allowed unexpected disconnects + join failures during the step. Default 0. */
  maxBotFailures: number
  /**
   * Tick-counter (`time query gametime`) TPS over the hold must be at least this. Undefined: same as
   * `minAvgTps`. Only checked when the counter produced a value.
   */
  minCounterTps?: number
  /**
   * Largest allowed difference between probe and tick-counter TPS over the same stretch, TPS.
   * A larger one makes the step invalid (`tps_sources_disagree`). Default 0.5.
   */
  maxProbeCounterTpsDivergence?: number
}

/**
 * How a step waits after scaling before it measures. `converge`: until the fleet stops loading new
 * chunks (new unique chunk columns per bot per second over the last `windowSec` ≤ `ratePerBot`, on
 * data at most `maxDataAgeSec` old), but at least `minSec` and at most `maxSec` (then `settleCapped`).
 * `fixed`: sleep `ramp.settleSec`.
 */
export interface SettleConfig {
  mode: 'converge' | 'fixed'
  minSec: number
  maxSec: number
  windowSec: number
  ratePerBot: number
  maxDataAgeSec: number
  /** Seconds between convergence checks. */
  evalSec: number
}

/** CPU placement of server, bots and harness (see @bedperf/placement). */
export interface PlacementConfig {
  /** false: no placement, no verification (and no placement gate). */
  enabled: boolean
  label?: string
  serverCpus: CpuSpec
  botCpus: CpuSpec
  /** `bot`: share the bot set. */
  harnessCpus: 'bot' | string | number[]
  priority: PlacementPriority
}

/** Environment gates: thresholds that make a run or a step invalid (not failed). */
export interface GatesConfig {
  /** Idle check length before each repeat, seconds. 0 disables the idle check. */
  idleSec: number
  /** Idle check limits, cores of foreign load (whole machine mean, 10 s peak, on the server CPU set). */
  idleForeignMean: number
  idleForeignPeak10s: number
  idleServerSetForeignMean: number
  /** Per hold window limits on foreign load, cores. */
  foreignMean: number
  foreignPeak10s: number
  serverSetForeignMean: number
  /** Longest stretch of a hold without a tick-counter reply, seconds. */
  gametimeMaxGapSec: number
  /** p99 tick-counter reply latency in a hold, seconds. */
  gametimeLatencyP99Sec: number
}

export interface SamplingConfig {
  /** Interval between `time query gametime` queries, seconds. */
  gametimeIntervalSec: number
}

export interface RampConfig {
  /** Players at the first step. */
  start: number
  /** Coarse increment between steps. */
  step: number
  /** Hard cap. */
  max: number
  /** Seconds to settle after scaling before measuring, in `settle.mode = 'fixed'`. */
  settleSec: number
  /**
   * Settle rule; the config parser fills it (default: `converge`, so `settleSec` matters only with
   * `settle.mode = 'fixed'`). Absent (a config built without the parser): fixed `settleSec`.
   */
  settle?: SettleConfig
  /** Seconds measured per step. */
  holdSec: number
  /** Bisect between last pass and first fail down to this resolution (players). 0 disables. */
  resolution: number
}

export interface BenchmarkConfig {
  name: string
  /**
   * BDS version: 'latest' | 'preview' | '1.26.63.1'. For a modded `server` flavor, 'latest'/'preview'
   * resolve to the flavor's pinned BDS (see `bdsVersionFor`).
   */
  bdsVersion: string
  /** Server implementation. Absent: vanilla BDS, native (see `DEFAULT_SERVER_SPEC`). */
  server?: ServerSpec
  /** bedboo protocol family for bots; derived from bdsVersion when omitted. */
  botVersion?: string
  serverProperties: ServerProperties
  world: {
    /** Use a saved world snapshot by id, or generate from seed. */
    snapshot?: string
    seed?: string
    levelType?: 'DEFAULT' | 'FLAT'
  }
  scenario: { module: string, params?: Record<string, unknown> }
  /** `connectRetries`: see `LoadGenOptions.connectRetries` (absent: 0). */
  loadgen: { botsPerWorker: number, joinIntervalMs: number, connectRetries?: number }
  ramp: RampConfig
  criteria: PassCriteria
  /** Independent repetitions of the whole search. */
  repeats: number
  /** Global warmup before the first step, seconds (server running, no bots). */
  warmupSec: number
  seed: number
  /** CPU placement. Filled by the config parser (default `auto`, enabled). */
  placement?: PlacementConfig
  /** Environment gates. Filled by the config parser. */
  gates?: GatesConfig
  sampling?: SamplingConfig
  /** Pause between repeats, seconds. Filled by the config parser (default 60). */
  cooldownSec?: number
}

export const DEFAULT_SETTLE: SettleConfig = {
  mode: 'converge',
  minSec: 20,
  maxSec: 300,
  windowSec: 60,
  ratePerBot: 0.1,
  maxDataAgeSec: 5,
  evalSec: 5
}

export const DEFAULT_PLACEMENT: PlacementConfig = {
  enabled: true,
  serverCpus: 'auto',
  botCpus: 'auto',
  harnessCpus: 'bot',
  priority: 'normal'
}

export const DEFAULT_GATES: GatesConfig = {
  idleSec: 15,
  idleForeignMean: 0.25,
  idleForeignPeak10s: 1.5,
  idleServerSetForeignMean: 0.25,
  foreignMean: 0.25,
  foreignPeak10s: 1.5,
  serverSetForeignMean: 0.25,
  gametimeMaxGapSec: 60,
  gametimeLatencyP99Sec: 30
}

export const DEFAULT_SAMPLING: SamplingConfig = { gametimeIntervalSec: 5 }

export const DEFAULT_COOLDOWN_SEC = 60

export const DEFAULT_TPS_DIVERGENCE = 0.5

export const DEFAULT_CRITERIA: PassCriteria = {
  minAvgTps: 19.8,
  minWorstWindowTps: 19.0,
  worstWindowDiscardPct: 1,
  maxTickIntervalP99Ms: 80,
  maxBotFailures: 0
}
