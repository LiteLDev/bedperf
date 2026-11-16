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
