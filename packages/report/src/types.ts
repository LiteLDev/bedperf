import type { BenchmarkConfig, BotFleetStats, ProbeSample, RunMeta, RunResult, StepResult, SysSample } from '@bedperf/core'

/**
 * Payload of an `orch.step.start` / `orch.step.end` envelope.
 *
 * Core does not pin these shapes down, so the report reads only these fields and treats all of
 * them as optional. An `orch.step.end` payload may additionally be a full `StepResult`; when it is
 * and `steps.json` is missing (aborted run), the report falls back to those results.
 */
export interface StepMarkData {
  repeat?: number
  index?: number
  players?: number
  phase?: 'ramp' | 'bisect'
  pass?: boolean
  loadgenSaturated?: boolean
}

/** Envelope payload with its envelope timestamp attached. */
export interface Timed<T> { t: number, data: T }

export interface StepMark {
  t: number
  edge: 'start' | 'end'
  data: StepMarkData
}

/** Everything `loadRun` reads from a run directory. */
export interface RunData {
  dir: string
  config: BenchmarkConfig
  meta: RunMeta
  steps: StepResult[]
  /** Undefined when the run was aborted before writing `result.json`. */
  result?: RunResult
  probe: Array<Timed<ProbeSample>>
  sys: Array<Timed<SysSample>>
  bot: Array<Timed<BotFleetStats>>
  stepMarks: StepMark[]
  /** Envelope `t` of `orch.run.start` / `orch.run.end`, when present. */
  runStartT?: number
  runEndT?: number
  /** Envelopes of kinds the report does not use, counted by kind. */
  otherKinds: Record<string, number>
  /** samples.jsonl lines that were not valid envelopes. */
  badLines: number
  /** Data-quality problems found while loading (unparseable optional files, ...). */
  warnings: string[]
}

export interface Headline {
  maxPlayersMedian: number | undefined
  perRepeat: number[]
  min: number | undefined
  max: number | undefined
  /** max - min across repeats. */
  spread: number | undefined
  capped: boolean
  loadgenLimited: boolean
  /** 'result' when taken from result.json, 'steps' when recomputed from steps (aborted run). */
  source: 'result' | 'steps'
  aborted: boolean
  /** Repeats left out of a recomputed headline because their search did not finish. */
  incompleteRepeats: number[]
}

export interface StepRow {
  repeat: number
  index: number
  phase: 'ramp' | 'bisect'
  players: number
  pass: boolean
  /** Step invalidated by loadgen saturation. */
  invalid: boolean
  failReasons: string[]
  startT: number
  endT: number
  tpsMean?: number
  tpsMin?: number
  tickP99?: number
  over50: number
  over100: number
  utilMean?: number
  cpuMean?: number
  rssMean?: number
  rttP95?: number
  netRxBps?: number
  netTxBps?: number
  botFailures: number
}

/** Metrics that have a scaling curve. */
export const CURVE_METRICS = ['tps', 'util', 'cpu', 'rss', 'rssPerPlayer', 'rttP95', 'netTx', 'tickP99'] as const
export type CurveMetric = typeof CURVE_METRICS[number]

export interface CurvePoint {
  players: number
  values: Partial<Record<CurveMetric, number>>
}

export interface Curve {
  /** Repeat number, or undefined for the across-repeat mean. */
  repeat: number | undefined
  points: CurvePoint[]
}

export interface Fit {
  slope: number
  intercept: number
  r2: number
  n: number
}

export interface Derived {
  /** Bytes of RSS per additional player (slope). */
  memPerPlayer?: Fit
  /** Network tx / rx bytes per second per player (slope). */
  netTxPerPlayer?: Fit
  netRxPerPlayer?: Fit
  /** Main-thread utilisation per player (slope), fitted on passing steps when possible. */
  utilPerPlayer?: Fit
  /** Players at which the util fit reaches 1.0. */
  playersAtUtil1?: number
}

export interface StepBand {
  repeat: number
  index: number
  players: number
  t0: number
  t1: number
  status: 'pass' | 'fail' | 'invalid' | 'unknown'
}

export interface Timeline {
  /** Run time origin (epoch ms); series x values are seconds from this. */
  t0: number
  tps: Array<[number, number]>
  util: Array<[number, number]>
  players: Array<[number, number]>
  bands: StepBand[]
  /** Per-repeat time windows in seconds from t0, for small multiples. */
  repeats: Array<{ repeat: number, x0: number, x1: number }>
}

export interface Analysis {
  name: string
  runId: string
  config: RunData['config']
  meta: RunData['meta']
  headline: Headline
  steps: StepRow[]
  curves: Curve[]
  /** Across-repeat mean curve. */
  meanCurve: Curve
  derived: Derived
  timeline: Timeline
  notes: string[]
}
