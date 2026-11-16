/** One thread in a raw reading. `cpuMs` is cumulative (user + kernel) since thread start. */
export interface RawThread {
  tid: number
  name?: string
  cpuMs: number
}

export interface NetCounter {
  /** Interface name (Linux) or id (Windows). */
  name: string
  rxBytes: number
  txBytes: number
}

/**
 * One raw, cumulative reading of the target process, as produced by a platform backend.
 * Rates are computed later from the delta between two readings (see `computeSample`).
 */
export interface RawReading {
  /** Reading time, epoch ms. */
  t: number
  /** Cumulative process CPU (user + kernel), ms. */
  procCpuMs: number
  rssBytes: number
  privateBytes?: number
  handles?: number
  threadCount?: number
  /** Cumulative per-thread CPU. Omitted if the backend could not read threads. */
  threads?: RawThread[]
  /**
   * Cumulative byte counters per network interface (loopback excluded). Kept per interface so
   * an interface appearing between readings does not count its lifetime bytes as one delta.
   */
  net?: NetCounter[]
  /** Cumulative whole-machine CPU times, ms (from `os.cpus()`), summed over all cores. */
  sysCpu?: { busyMs: number, totalMs: number }
}

/** What a backend returns for one read: a reading, or a signal that the target is gone. */
export type BackendResult = { kind: 'reading', raw: RawReading } | { kind: 'exited' }

export interface Backend {
  read (): Promise<BackendResult>
  close (): Promise<void>
  /** Sampler's own cost, when measurable (Windows helper process). */
  helper? (): { pid?: number, cpuMs?: number }
}
