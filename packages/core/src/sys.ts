/** OS-level sample of one process (the BDS server), nominally once per second. */
export interface SysSample {
  pid: number
  /** Sample time, epoch ms. */
  t: number
  /** Interval this sample's rates cover, ms. */
  intervalMs: number
  /** Whole-process CPU usage over the interval, in % of ONE core (can exceed 100). */
  cpuPct: number
  /**
   * The server main (tick) thread. Selected by thread name when possible (BDS names it
   * `MC_SERVER`; `source: 'name'`), otherwise the busiest thread over a sliding window
   * (`source: 'busiest'`). `util` = cpuPct / 100: fraction of wall time the main thread was
   * on-CPU. This is the no-mod proxy for MSPT / 50 ms headroom.
   */
  mainThread?: {
    tid: number
    name?: string
    cpuPct: number
    util: number
    /** How the thread was identified. Absent in producers that predate tick-thread naming. */
    source?: 'name' | 'busiest'
    /**
     * Cumulative CPU time (user + kernel) of this thread since it started, ms, read at `t`.
     * Only comparable between samples with the same `tid`.
     */
    cpuMs?: number
  }
  /** Top-N threads by CPU over the interval. */
  threads?: Array<{ tid: number, name?: string, cpuPct: number }>
  threadCount?: number
  /** Resident set / working set, bytes. */
  rssBytes: number
  /** Private / committed bytes where available. */
  privateBytes?: number
  handles?: number
  /** Network byte rates. Per-process when available, otherwise whole-system (see `scope`). */
  net?: { rxBytesPerSec: number, txBytesPerSec: number, scope: 'process' | 'system' }
  /** Whole-machine CPU busy %, 0..100, useful to detect host saturation. */
  systemCpuPct?: number
}

/** Something that samples periodically until stopped. */
export interface Sampler<T> {
  start (onSample: (s: T) => void): Promise<void>
  stop (): Promise<void>
}

/** The harness's own process trees, in assignment order: a pid belongs to the first group that reaches it. */
export type ProcessGroupName = 'server' | 'bots' | 'harness'

/** A process outside the own groups and the CPU it used over a scan interval. */
export interface ForeignProcess {
  pid: number
  name: string
  /** Mean CPU over the scan interval, in cores. */
  cores: number
}

/**
 * Machine-level interference sample, nominally once per second: how much CPU the rest of the
 * machine took while we measured. All "cores" values are CPU-seconds per second. Values are NOT
 * clamped: counter granularity can push foreign load slightly below zero, and clamping would
 * bias the mean upwards.
 */
export interface InterferenceSample {
  /** Sample time, epoch ms. */
  t: number
  /** Interval this sample covers, ms. */
  intervalMs: number
  /** Busy fraction of each logical CPU over the interval (index = CPU number). */
  cpuBusy: number[]
  /** Σ cpuBusy, cores. */
  busyCores: number
  /** CPU of each own group (root + all descendants), cores. */
  groups: Record<ProcessGroupName, number>
  /** busyCores − Σ groups: load from anything that is not ours. */
  foreignCores: number
  /** Σ busy over the server CPU set − server group; only when a server CPU set is configured. */
  serverSetForeignCores?: number
  /** Top foreign processes since the previous process-table scan (about every 10 s), busiest first. */
  top?: ForeignProcess[]
  /** Length of the interval `top` covers, ms. */
  topIntervalMs?: number
}

/** Interference over a window of `InterferenceSample`s. */
export interface InterferenceSummary {
  samples: number
  /** Mean foreign load, cores. */
  foreignMean: number
  /** Highest mean foreign load over 10 consecutive samples (the whole window if shorter), cores. */
  foreignPeak10s: number
  /** Mean foreign load on the server CPU set, cores; absent without a server CPU set. */
  serverSetForeignMean?: number
}

/** Upper limits for `InterferenceSummary`, in cores. */
export interface InterferenceThresholds {
  foreignMean: number
  foreignPeak10s: number
  serverSetForeignMean: number
}

export interface InterferenceCheck {
  ok: boolean
  /** Human-readable reasons for failure; empty when ok. */
  reasons: string[]
}
