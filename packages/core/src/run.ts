import type { Summary } from './stats.ts'

/** Files inside `runs/<runId>/`. */
export const RUN_FILES = {
  config: 'config.json',
  meta: 'meta.json',
  samples: 'samples.jsonl',
  steps: 'steps.json',
  result: 'result.json',
  bdsLog: 'bds.log',
  report: 'report.html'
} as const

export interface RunMeta {
  runId: string
  startedAt: string
  finishedAt?: string
  bdsVersion: string
  botVersion: string
  host: {
    os: string
    arch: string
    cpuModel: string
    cpuCount: number
    totalMemBytes: number
    hostname?: string
  }
  bedperfVersion: string
  bedbooCommit?: string
  /** Loadgen on the same machine as BDS? */
  colocated: boolean
}

/** Aggregates for one held load level. */
export interface StepResult {
  repeat: number
  index: number
  players: number
  /** Phase of the search that produced this step. */
  phase: 'ramp' | 'bisect'
  startT: number
  endT: number
  tps: Summary
  tickIntervalMs: Summary
  over50: number
  over100: number
  mainThreadUtil?: Summary
  cpuPct?: Summary
  rssBytes?: Summary
  rttMs?: Summary
  netRxBytesPerSec?: number
  netTxBytesPerSec?: number
  botFailures: number
  loadgenSaturated: boolean
  pass: boolean
  /** Human-readable reasons for failure, one per violated criterion. */
  failReasons: string[]
}

export interface RunResult {
  runId: string
  /** BenchmarkConfig.name */
  config: string
  /** Max players that passed, per repeat. */
  maxPlayers: number[]
  /** Median across repeats. */
  maxPlayersMedian: number
  /** Set when a repeat hit ramp.max without failing (true capacity is higher). */
  capped: boolean
  /** Set when any step was invalidated by loadgen saturation. */
  loadgenLimited: boolean
}
