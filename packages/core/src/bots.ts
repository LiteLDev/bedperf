import type { Summary } from './stats.ts'

/** Aggregate state + metrics of the bot fleet, emitted periodically by the load generator. */
export interface BotFleetStats {
  t: number
  /** Number of bots the fleet is trying to keep online. */
  target: number
  /** Bots with an open connection (connect seen, not ended). */
  connected: number
  /** Bots that received `spawn` and are running their scenario. */
  spawned: number
  /** Cumulative failures to join (error/timeout before spawn). */
  joinFailures: number
  /** Cumulative disconnects after spawn that the fleet did not request (kick/error/end). */
  unexpectedDisconnects: number
  /** connect → spawn latency of joins completed in this interval, ms. */
  joinLatencyMs?: Summary
  /**
   * Round trip of a tick-bound request (command or scriptevent ping) in this interval, ms.
   * Grows when the server tick is late — client-perceived lag.
   */
  rttMs?: Summary
  /** Server movement corrections per second across the fleet (physics desync indicator). */
  correctionsPerSec?: number
  /** Bytes received from the server by all bots per second, when measurable. */
  rxBytesPerSec?: number
  /** Chunk columns loaded by all bots per second in this interval (re-loads included). */
  chunksPerSec?: number
  /** Sum over live bots of the distinct chunk columns each has ever received. */
  uniqChunks?: number
  /**
   * Per-bot count of loaded chunk columns within (server view radius + 1) chunks of the bot's current chunk,
   * over spawned bots at the end of the interval.
   */
  inView?: { min: number, median: number, max: number }
  /**
   * Per-bot view-load latency, ms: from the bot's view origin (its latest server teleport after spawn, else
   * start_game) to the arrival of its ceil(0.9·U)-th in-view column, U = its current in-view count (columns
   * already loaded at the origin count as 0). Nearest-rank percentiles over spawned bots with U > 0.
   */
  viewT90Ms?: { p50: number, p90: number, max: number, n: number }
  /**
   * Per-bot time from the view origin to the 80th in-view column, ms. Bots that have fewer are right-censored at
   * the time observed so far; `medianCensored` is null when the median falls on a censored value.
   */
  viewTNMs?: { medianCensored: number | null, censored: number, n: number }
  /** Packets received by the whole fleet in this interval, by packet name. */
  packets?: Record<string, number>
  /** Load generator self-check: if saturated, results of this interval are not trustworthy. */
  loadgen: {
    workers: number
    /** Max over workers of event-loop delay p99, ms. */
    eventLoopLagP99Ms: number
    /** Max over workers of CPU usage, % of one core. */
    maxWorkerCpuPct: number
    saturated: boolean
    /** Sum over workers of whole-process CPU, in cores (load the fleet puts on its host). */
    totalCores?: number
  }
}
