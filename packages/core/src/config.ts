import type { ServerProperties } from './bds.ts'

/** Thresholds a load step must meet to "pass" (i.e. the server holds 20 TPS at that load). */
export interface PassCriteria {
  /** Mean TPS over the measured window. Default 19.8. */
  minAvgTps: number
  /** Minimum over 1 s windows, after discarding the worst `worstWindowDiscardPct` %. Default 19.0. */
  minWorstWindowTps: number
  worstWindowDiscardPct: number
  /** p99 of tick intervals, ms. Default 60. */
  maxTickIntervalP99Ms: number
  /** Optional: mean main-thread utilisation ceiling (0..1). Not enforced when undefined. */
  maxMainThreadUtil?: number
  /** Max allowed unexpected disconnects + join failures during the step. Default 0. */
  maxBotFailures: number
}

export interface RampConfig {
  /** Players at the first step. */
  start: number
  /** Coarse increment between steps. */
  step: number
  /** Hard cap. */
  max: number
  /** Seconds to settle after scaling before measuring. */
  settleSec: number
  /** Seconds measured per step. */
  holdSec: number
  /** Bisect between last pass and first fail down to this resolution (players). 0 disables. */
  resolution: number
}

export interface BenchmarkConfig {
  name: string
  /** BDS version: 'latest' | 'preview' | '1.26.63.1'. */
  bdsVersion: string
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
  loadgen: { botsPerWorker: number, joinIntervalMs: number }
  ramp: RampConfig
  criteria: PassCriteria
  /** Independent repetitions of the whole search. */
  repeats: number
  /** Global warmup before the first step, seconds. */
  warmupSec: number
  seed: number
}

export const DEFAULT_CRITERIA: PassCriteria = {
  minAvgTps: 19.8,
  minWorstWindowTps: 19.0,
  worstWindowDiscardPct: 1,
  maxTickIntervalP99Ms: 60,
  maxBotFailures: 0
}
