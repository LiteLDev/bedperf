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
  /** Load generator self-check: if saturated, results of this interval are not trustworthy. */
  loadgen: {
    workers: number
    /** Max over workers of event-loop delay p99, ms. */
    eventLoopLagP99Ms: number
    /** Max over workers of CPU usage, % of one core. */
    maxWorkerCpuPct: number
    saturated: boolean
  }
}
