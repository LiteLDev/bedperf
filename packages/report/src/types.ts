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

/**
 * Outcome class of one repeat.
 * - `ok`: the search finished and its result counts toward the headline.
 * - `server_failed`: the server crashed, was stopped by a watchdog or could not hold the load in a
 *   way that ended the repeat. This is a result about the server: shown, never silently dropped,
 *   but kept out of the median.
 * - `invalid`: the repeat says something about the harness or the machine, not the server (it
 *   never ended, the search did not finish, the orchestrator flagged it). Kept out of the median.
 */
export type RepeatStatus = 'ok' | 'invalid' | 'server_failed'
export const REPEAT_STATUSES: readonly RepeatStatus[] = ['ok', 'server_failed', 'invalid']

/** An `orch.repeat.end` envelope, read defensively. */
export interface RepeatEnd {
  t: number
  repeat: number
  /** False when the payload's `outcome` was null or missing (the repeat threw). */
  hasOutcome: boolean
  /** `outcome.status` when it is one of the known statuses. */
  status?: RepeatStatus
  statusReasons: string[]
  maxPlayers?: number
  capped?: boolean
  loadgenLimited?: boolean
  /** `outcome.aborted`: why the repeat ended early (server exited, ...). */
  aborted?: string
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
  /** Repeat numbers from `orch.repeat.start` envelopes, in file order. */
  repeatStarts: number[]
  /** `orch.repeat.end` envelopes, one per repeat (the last one wins). */
  repeatEnds: RepeatEnd[]
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

/** One repeat's place in the headline. */
export interface RepeatInfo {
  repeat: number
  status: RepeatStatus
  /** Why the repeat is not `ok` (or notes on an ok one); empty when there is nothing to say. */
  reasons: string[]
  /** Highest passing player count of this repeat, when known. */
  maxPlayers: number | undefined
}

export interface Headline {
  /** Median of `perRepeat`, i.e. over the `ok` repeats only. */
  maxPlayersMedian: number | undefined
  /** Max players of the `ok` repeats, in repeat order. */
  perRepeat: number[]
  /** Every repeat with its status, including the ones left out of the median. */
  repeats: RepeatInfo[]
  /** Number of `ok` repeats. */
  kOk: number
  /** Number of repeats in total. */
  n: number
  statusCounts: Record<RepeatStatus, number>
  /** min / max of `perRepeat` (ok repeats). */
  min: number | undefined
  max: number | undefined
  /** max - min across ok repeats. */
  spread: number | undefined
  capped: boolean
  loadgenLimited: boolean
  /** 'result' when taken from result.json, 'steps' when recomputed from steps (aborted run). */
  source: 'result' | 'steps'
  aborted: boolean
  /** Repeats left out of the headline as `invalid` because they never ended or their search did not finish. */
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
  /** ANALYSIS_VERSION of the code that produced this analysis. */
  analysisVersion: number
  name: string
  runId: string
  config: RunData['config']
  meta: RunData['meta']
  headline: Headline
  steps: StepRow[]
  /** One curve per repeat (every repeat, whatever its status). */
  curves: Curve[]
  /**
   * Across-repeat mean curve, over the `ok` repeats' steps (over all steps when no repeat is ok).
   */
  meanCurve: Curve
  /** Fits over the same steps as `meanCurve`. */
  derived: Derived
  /** Fits per `ok` repeat, for per-repeat comparison of slopes. */
  repeatDerived: Array<{ repeat: number, derived: Derived }>
  /** Repeat numbers whose status is `ok`, ascending. */
  okRepeats: number[]
  timeline: Timeline
  notes: string[]
}

/**
 * Fields read from meta.json that must match for two runs to be compared. Core may not declare
 * all of them yet, so they are read defensively; a run without a field cannot be verified on it.
 */
export const COMPARABILITY_FIELDS: Array<{ key: string, label: string, paths: ReadonlyArray<readonly string[]> }> = [
  { key: 'configSha256', label: 'config hash', paths: [['configSha256']] },
  { key: 'machineFingerprint', label: 'machine fingerprint', paths: [['machine', 'fingerprint'], ['machineFingerprint']] },
  { key: 'bdsVersion', label: 'BDS version', paths: [['bdsVersion']] },
  { key: 'bdsBuildSha256', label: 'BDS build hash', paths: [['artifacts', 'bdsZipSha256'], ['bdsBuildSha256'], ['artifacts', 'bdsBuildSha256'], ['artifacts', 'bds', 'sha256']] },
  { key: 'analysisVersion', label: 'analysis version', paths: [['analysisVersion']] },
  { key: 'placementProfileSha256', label: 'placement profile hash', paths: [['placement', 'profileSha256']] },
  { key: 'botVersion', label: 'bot version', paths: [['botVersion']] }
]
