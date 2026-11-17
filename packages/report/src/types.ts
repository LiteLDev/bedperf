import type { AgentLinkEvent, AgentTelemetry, BenchmarkConfig, BotFleetStats, GametimeSample, InterferenceSample, ProbeSample, RunMeta, RunResult, StepResult, SysSample } from '@bedperf/core'

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
  /** `sys.interference` envelopes (machine-level foreign load); empty in older runs. */
  interference: Array<Timed<InterferenceSample>>
  /** `bds.gametime` envelopes (tick-counter replies); empty in older runs. */
  gametime: Array<Timed<GametimeSample>>
  /** `agent.telemetry` envelopes from remote bot agents (empty for local runs and older runs). */
  agentTelemetry: Array<Timed<AgentTelemetry>>
  /** `agent.link` envelopes: agent connected / lost / closed / link stats. */
  agentLink: Array<Timed<AgentLinkEvent>>
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
  /** result.json `invalidLimited`: the search stopped on invalid steps. */
  invalidLimited: boolean
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
  /** Step invalid: `invalidReasons` non-empty, or (older runs) loadgen saturation. */
  invalid: boolean
  /** Why the step is invalid (the orchestrator's `invalidReasons`, or loadgen saturation). */
  invalidReasons: string[]
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
  // Newer measurements; all optional, absent in older runs.
  /** Script-free TPS from the server tick counter over the hold window. */
  counterTps?: number
  /** Lowest ~5 s tick-counter TPS in the hold window. */
  counterTpsLow5?: number
  /** Longest stretch of the hold window without a tick-counter reply, ms. */
  gametimeMaxGapMs?: number
  /** Tick-counter reply latency p50, ms. */
  gametimeLatencyP50?: number
  /** Tick-thread CPU time per server tick, ms. */
  tickCpuMsPerTick?: number
  /** How the tick thread was identified. */
  tickThreadSource?: 'name' | 'busiest'
  /** Mean / peak-10 s foreign CPU load during the hold, cores. */
  foreignMean?: number
  foreignPeak10s?: number
  /** Mean foreign load on the server CPU set, cores. */
  serverSetForeignMean?: number
  /** Whether the server's CPU placement verified for this step. */
  placementVerified?: boolean
  /** Settle time actually used before the hold, s. */
  settleSec?: number
  /** The adaptive settle hit its cap instead of converging. */
  settleCapped?: boolean
  /** Some bots had not finished loading their view when the hold started. */
  viewsIncomplete?: boolean
  /** Median per-bot in-view chunk columns. */
  inViewMedian?: number
  /** Median per-bot time to 90 % of the in-view columns, ms. */
  viewT90MsP50?: number
  /** Chunk columns delivered to the fleet per second. */
  chunksPerSec?: number
  /** Distinct chunk columns received per bot. */
  uniqChunksPerBot?: number
}

/** Metrics that have a scaling curve. */
export const CURVE_METRICS = ['tps', 'util', 'cpu', 'rss', 'rssPerPlayer', 'rttP95', 'netTx', 'tickP99', 'counterTps', 'tickCpuMsPerTick', 'foreignMean', 'inViewMedian', 'viewT90', 'chunksPerSec'] as const
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
  /**
   * Tick-thread CPU ms per tick per additional player (slope of `tickCpuMsPerTick`), fitted on
   * passing steps when possible. A cross-machine capacity cost: unlike util it does not saturate.
   */
  tickCpuPerPlayer?: Fit
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
  /** Tick-counter TPS between consecutive `bds.gametime` replies (empty in older runs). */
  counterTps: Array<[number, number]>
  /** Foreign CPU load, cores, from `sys.interference` (empty in older runs). */
  foreign: Array<[number, number]>
  /** Foreign CPU load on the server CPU set, cores (empty without a server CPU set). */
  serverSetForeign: Array<[number, number]>
  /** Tick-thread CPU ms per tick from consecutive sys samples' `mainThread.cpuMs` and TPS. */
  tickCpu: Array<[number, number]>
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
  provenance: Provenance
  /** The server implementation that ran (absent in analyses made before analysis version 3). */
  server?: ServerView
  /** Where the bots ran and how their machines behaved (absent before analysis version 3). */
  topology?: TopologyView
  /** Threats to validity, most severe first. */
  threats: Threat[]
  /** True when nothing blocks publishing the headline (see `threats`). */
  publishable: boolean
  notes: string[]
}

/** One threat-to-validity / disclosure item. `bad` makes the run not publishable. */
export interface Threat {
  id: string
  level: 'bad' | 'warn' | 'info'
  text: string
}

/** Provenance and environment read defensively from meta.json (all optional). */
export interface Provenance {
  configSha256?: string
  machineFingerprint?: string
  machine?: { os?: string, cpuModel?: string, logical?: number, physical?: number, ramGiB?: number }
  harness?: { version?: string, git?: string, dirty?: boolean, node?: string }
  bdsZipSha256?: string
  probePackSha256?: string
  bedbooCommit?: string
  placement?: {
    profileSha256?: string
    kind?: string
    method?: string
    serverCpus?: string
    botCpus?: string
    priority?: string
    verified?: boolean
    checks: Array<{ id: string, level: string, summary: string }>
  }
  /** Gate thresholds, flattened to dotted keys. */
  gates: Array<[string, string]>
}

/** meta.json `server`, read defensively. Old runs (no `server`) are vanilla BDS, native. */
export interface ServerView {
  /** False for older runs that do not record `server` (vanilla BDS assumed). */
  recorded: boolean
  /** `serverLabel(spec)`, e.g. `levilamina+levioptimize (wine)`. */
  label: string
  flavor: string
  mods: string[]
  runtime: string
  /** Component versions: BDS first, then loader and mods. */
  versions: Array<[string, string]>
  binaryPlatform?: string
  exeName?: string
  artifacts: Array<{ name: string, version?: string, sha256?: string }>
  specSha256?: string
  buildSha256?: string
  allocator?: string
  /** Effective loader config written into the instance. */
  loaderConfig?: unknown
  /**
   * Loader config keys that differ from the loader's upstream defaults, as dotted paths with their
   * values: bedperf's benchmark-neutral defaults (`neutral`) and the config's own overrides (`user`).
   */
  loaderOverrides: Array<{ path: string, value: string, source: 'neutral' | 'user' }>
  notes: string[]
}

/** One agent's link stats. */
export interface AgentLinkView {
  rttMedianMs: number
  rttMinMs: number
  rttMaxMs: number
  n: number
  clockOffsetMs?: number
}

/** One remote agent of a run. */
export interface AgentView {
  name: string
  addressId?: string
  fingerprint?: string
  cpuModel?: string
  logical?: number
  physical?: number
  ramGiB?: number
  os?: string
  cpus?: number
  weight?: number
  maxBots?: number
  link?: AgentLinkView
  placementVerified?: boolean
  botCpus?: string
  /** Telemetry samples, saturated samples and the reasons the agent gave, tallied. */
  samples: number
  saturatedSamples: number
  saturatedReasons: string[]
  /** `agent.link` `lost` events of this agent. */
  lost: number
}

/** Per-agent telemetry series; x in seconds from `Timeline.t0`. */
export interface AgentSeries {
  agent: string
  busy: Array<[number, number]>
  bot: Array<[number, number]>
  foreign: Array<[number, number]>
  /** Merged intervals in which the agent reported itself saturated, [x0, x1] seconds. */
  saturated: Array<[number, number]>
}

/** One `agent.link` event, x in seconds from `Timeline.t0`. */
export interface AgentLinkMark {
  x: number
  agent: string
  event: string
  reason?: string
}

/** Per-step per-agent load from `bot.stats` `loadgen.agents` during the hold window. */
export interface AgentStepRow {
  repeat: number
  index: number
  players: number
  agents: Array<{ agent: string, bots: number, maxTotalCores?: number, maxLagP99Ms?: number, saturated: boolean }>
}

/** meta.json `topology` plus the agent envelopes. Old runs (no `topology`) are local. */
export interface TopologyView {
  mode: 'local' | 'remote'
  /** False for runs that do not record `topology`. */
  recorded: boolean
  sha256?: string
  botTargetHost?: string
  agents: AgentView[]
  series: AgentSeries[]
  links: AgentLinkMark[]
  steps: AgentStepRow[]
}

/**
 * Fields read from meta.json that must match for two runs to be compared. Core may not declare
 * all of them yet, so they are read defensively; a run without a field cannot be verified on it.
 */
export interface ComparabilityField {
  key: string
  label: string
  paths: ReadonlyArray<readonly string[]>
  /**
   * Part of the server implementation: in an implementation comparison (runs on different
   * servers) a difference is expected and does not refuse the comparison.
   */
  server?: boolean
  /**
   * Must match in an implementation comparison: a value recorded by one run only refuses it too
   * (a value recorded by neither is "cannot verify").
   */
  required?: boolean
}

/**
 * - `configSha256`: `benchConfigSha256` (the config without its `server` section) when both runs
 *   record it, else `configSha256` (older runs).
 * - `server`: server label and spec hash; a difference makes the comparison an implementation
 *   comparison. Old runs without `server` are vanilla BDS.
 * - `loaderConfig`: sha256 of the effective loader config (`none` without one); not part of the
 *   spec hash, so a same-server comparison with different loader settings is refused.
 * - `topology`: `topology.sha256`, `local` when the run has no topology or a local one.
 */
export const COMPARABILITY_FIELDS: ComparabilityField[] = [
  { key: 'configSha256', label: 'benchmark config hash', paths: [['benchConfigSha256'], ['configSha256']], required: true },
  { key: 'server', label: 'server', paths: [['server', 'specSha256']], server: true },
  { key: 'serverBuildSha256', label: 'server build hash', paths: [['server', 'buildSha256']], server: true },
  { key: 'loaderConfig', label: 'loader config hash', paths: [['server', 'loaderConfig']], server: true },
  { key: 'topology', label: 'topology', paths: [['topology', 'sha256']], required: true },
  { key: 'machineFingerprint', label: 'machine fingerprint', paths: [['machine', 'fingerprint'], ['machineFingerprint']], required: true },
  { key: 'bdsVersion', label: 'BDS version', paths: [['bdsVersion']], required: true },
  { key: 'bdsBuildSha256', label: 'BDS build hash', paths: [['artifacts', 'bdsZipSha256'], ['bdsBuildSha256'], ['artifacts', 'bdsBuildSha256'], ['artifacts', 'bds', 'sha256']], server: true },
  { key: 'analysisVersion', label: 'analysis version', paths: [['analysisVersion']] },
  { key: 'placementProfileSha256', label: 'placement profile hash', paths: [['placement', 'profileSha256']], required: true },
  { key: 'botVersion', label: 'bot version', paths: [['botVersion']] }
]
