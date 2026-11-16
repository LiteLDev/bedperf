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
    /** Written by old runs only; new runs leave it out (see `Scrubber`). */
    hostname?: string
  }
  bedperfVersion: string
  bedbooCommit?: string
  /** Loadgen on the same machine as BDS? */
  colocated: boolean
  /** sha256Json of config.json's content (as written, after scrubbing). */
  configSha256?: string
  machine?: MachineInfo
  harness?: HarnessInfo
  artifacts?: RunArtifacts
  /** Version of the analysis that produced derived numbers; set by the report, not the recorder. */
  analysisVersion?: string
  /**
   * Every file in the run dir at `close()` ('/'-separated relative path), except meta.json itself and
   * report.html.
   */
  files?: Record<string, FileDigest>
}

/** Hardware identity (see `machineInfo` in provenance.ts). */
export interface MachineInfo {
  /** 16 hex digits: sha256Json({osFamily, cpuModel, logical, physical, ramGiB rounded}). No user or host name. */
  fingerprint: string
  os: string
  cpuModel: string
  logical: number
  /** Physical cores, when they could be counted. */
  physical?: number
  /** Total RAM, GiB, one decimal. */
  ramGiB: number
}

/** The bedperf build that produced a run. */
export interface HarnessInfo {
  version: string
  /** `git rev-parse HEAD` of the bedperf checkout, when git is available. */
  git?: string
  /** Tracked files under packages/ or scripts/ differ from `git`. */
  dirty?: boolean
  /** `process.version`. */
  node: string
}

/** Content hashes of the inputs a run depended on. */
export interface RunArtifacts {
  /** sha256 of the downloaded BDS zip (from the bds-install cache sidecar). */
  bdsZipSha256?: string
  /** `hashTree` of the probe behavior pack directory. */
  probePackSha256?: string
  bedbooCommit?: string
}

export interface FileDigest {
  sha256: string
  bytes: number
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
