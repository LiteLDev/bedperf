import type { PlacementCheck, PlacementKind, PlacementMode, PlacementPriority } from './placement.ts'
import type { Summary } from './stats.ts'
import type { ServerArtifact, ServerBuildInfo } from './server.ts'
import type { TopologyMeta } from './topology.ts'

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
  /** `benchConfigSha256`: the config without its `server` section (same benchmark, any server). */
  benchConfigSha256?: string
  /** The server implementation that ran (absent for old runs: vanilla BDS). */
  server?: ServerBuildInfo
  /** Where the bots ran (absent for old runs: local). */
  topology?: TopologyMeta
  machine?: MachineInfo
  harness?: HarnessInfo
  artifacts?: RunArtifacts
  /** How bots reach the server. `loopback`: bots connect to a loopback address (no real network). */
  network?: { loopback: boolean }
  /** CPU placement of the run (absent when placement was disabled or for old runs). */
  placement?: RunPlacementMeta
  /** Resolved environment gates and validity thresholds the run used. */
  gates?: Record<string, unknown>
  /** Version of the analysis that produced derived numbers; set by the report, not the recorder. */
  analysisVersion?: string
  /**
   * Every file in the run dir at `close()` ('/'-separated relative path), except meta.json itself and
   * report.html.
   */
  files?: Record<string, FileDigest>
}

/** meta.json `placement`. */
export interface RunPlacementMeta {
  /** sha256 of the canonical placement profile (see @bedperf/placement `profileSha256`). */
  profileSha256?: string
  label?: string
  kind: PlacementKind
  /** What the plan placed on the server machine (absent for old runs: `local`). */
  mode?: PlacementMode
  /** How the server set was applied: `preexec` (Linux taskset), `post-spawn` (Windows). */
  method: string
  serverCpus: number[]
  botCpus: number[]
  harnessCpus: number[]
  priority: PlacementPriority
  /** Every server verification of the run passed (false as soon as one failed). */
  verified: boolean
  /** Number of server verifications done. */
  verifications?: number
  checks: PlacementCheck[]
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
  /** Server build inputs (loader, mods, launcher, wine), see `ServerBuildInfo.artifacts`. */
  server?: ServerArtifact[]
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
  /**
   * Why the measurement says nothing about the server (`<code>` or `<code>: <detail>`), e.g. `loadgen saturated`,
   * `placement_mismatch`, `interference: ...`, `tps_sources_disagree: ...`. The step is invalid when non-empty.
   */
  invalidReasons?: string[]
  /** Tick-counter (`time query gametime`) TPS over the hold. */
  counterTps?: number
  /** Lowest tick-counter TPS over any ~5 s stretch of the hold. */
  counterTpsLow5?: number
  /** Longest stretch of the hold without a tick-counter reply, ms. */
  gametimeMaxGapMs?: number
  /** Tick-counter reply latency over the hold, ms. */
  gametimeLatencyMs?: Summary
  /** Tick-thread CPU time per executed tick, ms (a lower bound on tick cost, not MSPT). */
  tickCpuMsPerTick?: number
  /** How the tick thread was identified (`name` / `busiest`), from the OS samples. */
  tickThreadSource?: string
  /** Foreign (not server / bots / harness) CPU load during the hold, cores. */
  interference?: { foreignMean: number, foreignPeak10s: number, serverSetForeignMean?: number }
  /** Server placement verified at hold start and end. */
  placementVerified?: boolean
  /** Seconds actually spent settling before the hold. */
  settleSec?: number
  /** Settle stopped at `maxSec` without converging. */
  settleCapped?: boolean
  /** At settle end, fewer than 95% of the bots had at least half the median in-view chunk count. */
  viewsIncomplete?: boolean
  /** Median per-bot in-view chunk columns at hold end. */
  inViewMedian?: number
  /** Median per-bot view-load (90%) latency at hold end, ms. */
  viewT90MsP50?: number
  /** Fleet chunk columns received per second, mean over the hold. */
  chunksPerSec?: number
  /** Distinct chunk columns per spawned bot at hold end. */
  uniqChunksPerBot?: number
}

/** How a repeat ended. `ok`: it measured; `server_failed`: the server crashed or could not take the first step (a result, never rerun); `invalid`: the environment or harness made it meaningless (rerun once). */
export type RepeatStatus = 'ok' | 'invalid' | 'server_failed'

export interface RepeatSummary {
  index: number
  status: RepeatStatus
  statusReasons: string[]
  maxPlayers: number
  /** Index of the invalid repeat this one reran. */
  rerunOf?: number
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
  /** Set when a repeat's search stopped because a load level was invalid twice in a row (any reason). */
  invalidLimited?: boolean
  /** Every repeat, by index (reruns included). `maxPlayers` above is indexed the same way. */
  repeats?: RepeatSummary[]
  /** Repeats with status `ok`; `maxPlayersMedian` is their median. */
  kOk?: number
  /** Repeats run (reruns included). */
  n?: number
}
