// Pure aggregation of worker interval reports into fleet stats (kept separate from the controller for tests).
import { summarize, type BotFleetStats } from '@bedperf/core'
import type { WorkerStats } from './protocol.ts'

export interface SaturationThresholds {
  /** Worker event-loop delay p99 above this marks the fleet saturated, ms. Default 50. */
  eventLoopP99Ms: number
  /** Worker event-loop thread CPU above this (% of one core) marks the fleet saturated. Default 85. */
  cpuPct: number
}

export const DEFAULT_SATURATION: SaturationThresholds = { eventLoopP99Ms: 50, cpuPct: 85 }

/** BotFleetStats plus loadgen sizing extras (a superset of the core contract). */
export interface FleetStats extends BotFleetStats {
  loadgen: BotFleetStats['loadgen'] & {
    /** Bots alive in workers (joining or spawned), per the latest reports. */
    bots: number
    /** Max over workers of whole-process CPU (event loop + GC/helper threads), % of one core. */
    maxWorkerProcessCpuPct: number
    /** Sum over workers of whole-process CPU, % of one core: the load the fleet puts on its host. */
    totalCpuPct: number
    /** Sum over workers of resident set size, bytes. */
    rssBytes: number
    /** Live workers whose last report is older than the staleness limit (counted as saturated). */
    staleWorkers: number
  }
}

export interface LiveWorker {
  /** Latest report of this worker, if any. */
  latest?: WorkerStats
  /** Time since the latest report (or since the worker was started if none), ms. */
  sinceMs: number
}

export interface AggregateInput {
  t: number
  target: number
  connected: number
  spawned: number
  joinFailures: number
  unexpectedDisconnects: number
  /** Wall time since the previous aggregate, ms. */
  elapsedMs: number
  /** All worker reports received since the previous aggregate. */
  reports: readonly WorkerStats[]
  /** One entry per live worker. */
  workers: readonly LiveWorker[]
  thresholds: SaturationThresholds
  /** A live worker silent for longer than this is considered stuck (saturated), ms. */
  staleMs: number
}

export function aggregateStats (a: AggregateInput): FleetStats {
  const join: number[] = []
  const rtt: number[] = []
  let corrections = 0
  let rx = 0
  for (const r of a.reports) {
    for (const v of r.joinLatencyMs) join.push(v)
    for (const v of r.rttMs) rtt.push(v)
    corrections += r.corrections
    rx += r.rxBytes
  }
  let lag = 0
  let maxCpu = 0
  let maxProcCpu = 0
  let totalCpu = 0
  let rss = 0
  let bots = 0
  let stale = 0
  for (const w of a.workers) {
    if (w.sinceMs > a.staleMs) stale++
    const l = w.latest
    if (!l) continue
    lag = Math.max(lag, l.eventLoopP99Ms)
    maxCpu = Math.max(maxCpu, l.mainThreadCpuPct)
    maxProcCpu = Math.max(maxProcCpu, l.cpuPct)
    totalCpu += l.cpuPct
    rss += l.rssBytes
    bots += l.bots
  }
  const sec = a.elapsedMs / 1000
  const stats: FleetStats = {
    t: a.t,
    target: a.target,
    connected: a.connected,
    spawned: a.spawned,
    joinFailures: a.joinFailures,
    unexpectedDisconnects: a.unexpectedDisconnects,
    loadgen: {
      workers: a.workers.length,
      eventLoopLagP99Ms: lag,
      maxWorkerCpuPct: maxCpu,
      saturated: lag > a.thresholds.eventLoopP99Ms || maxCpu > a.thresholds.cpuPct || stale > 0,
      bots,
      maxWorkerProcessCpuPct: maxProcCpu,
      totalCpuPct: totalCpu,
      rssBytes: rss,
      staleWorkers: stale
    }
  }
  if (join.length > 0) stats.joinLatencyMs = summarize(join)
  if (rtt.length > 0) stats.rttMs = summarize(rtt)
  if (a.reports.length > 0 && sec > 0) {
    stats.correctionsPerSec = corrections / sec
    stats.rxBytesPerSec = rx / sec
  }
  return stats
}
