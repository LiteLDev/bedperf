// Pure aggregation of worker interval reports into fleet stats (kept separate from the controller for tests).
import { summarize, type AgentFleetSlice, type BotFleetStats } from '@bedperf/core'
import type { WorkerStats } from './protocol.ts'
import type { BotViewSample } from './view.ts'

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
    /** Sum over workers of whole-process CPU, cores (= totalCpuPct / 100). */
    totalCores: number
    /** client_cache_blob_status replies sent by forceFullChunks bots in the interval. */
    blobMissReplies: number
  }
  /**
   * Some bot saw a chunk packet using the client blob cache (`cache_enabled` or blob hashes). False means every
   * chunk arrived with its full payload. Absent when no worker reported it.
   */
  chunkCacheSeen?: boolean
}

/** Nearest-rank quantile of a non-empty ascending sample: the ceil(q·n)-th smallest value. */
export function nearestRank (sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1))]!
}

/** Median of a sample with right-censored values (censored sort after every observed one); null if unknown. */
export function censoredMedian (values: ReadonlyArray<{ v: number, censored: boolean }>): number | null {
  if (values.length === 0) return null
  const o = [...values].sort((a, b) => (Number(a.censored) - Number(b.censored)) || (a.v - b.v))
  const n = o.length
  const mid = n % 2 ? [o[(n - 1) / 2]!] : [o[n / 2 - 1]!, o[n / 2]!]
  if (mid.some(m => m.censored)) return null
  return mid.reduce((a, m) => a + m.v, 0) / mid.length
}

/** View-load fields of BotFleetStats from per-bot samples. */
export function aggregateView (samples: readonly BotViewSample[]): Pick<FleetStats, 'uniqChunks' | 'inView' | 'viewT90Ms' | 'viewTNMs'> {
  if (samples.length === 0) return {}
  const out: Pick<FleetStats, 'uniqChunks' | 'inView' | 'viewT90Ms' | 'viewTNMs'> = {}
  out.uniqChunks = samples.reduce((a, v) => a + v.uniq, 0)
  const iv = summarize(samples.map(v => v.inView))
  out.inView = {
    min: iv.min,
    median: iv.p50,
    max: iv.max,
    halfMedianFrac: samples.filter(v => v.inView >= 0.5 * iv.p50).length / samples.length
  }
  const t90 = samples.flatMap(v => v.t90Ms !== undefined ? [v.t90Ms] : []).sort((a, b) => a - b)
  if (t90.length > 0) out.viewT90Ms = { p50: nearestRank(t90, 0.5), p90: nearestRank(t90, 0.9), max: t90[t90.length - 1]!, n: t90.length }
  out.viewTNMs = {
    medianCensored: censoredMedian(samples.map(v => ({ v: v.tNMs, censored: v.tNCensored }))),
    censored: samples.filter(v => v.tNCensored).length,
    n: samples.length
  }
  return out
}

export interface LiveWorker {
  /** Latest report of this worker, if any. */
  latest?: WorkerStats
  /** Time since the latest report (or since the worker was started if none), ms. */
  sinceMs: number
  /** Remote agent running this worker, if any. */
  agent?: string
}

export interface AggregateInput {
  t: number
  target: number
  connected: number
  spawned: number
  joinFailures: number
  unexpectedDisconnects: number
  connectRetries?: number
  /** Wall time since the previous aggregate, ms. */
  elapsedMs: number
  /** All worker reports received since the previous aggregate. */
  reports: readonly WorkerStats[]
  /** One entry per live worker. */
  workers: readonly LiveWorker[]
  thresholds: SaturationThresholds
  /** A live worker silent for longer than this is considered stuck (saturated), ms. */
  staleMs: number
  /** agent name -> reasons its machine reported itself saturated (non-empty arrays only). */
  externalSaturation?: Readonly<Record<string, readonly string[]>>
}

/** Per-agent slices; empty when no worker runs on an agent and no agent reported saturation. */
export function aggregateAgents (a: Pick<AggregateInput, 'workers' | 'thresholds' | 'staleMs' | 'externalSaturation'>): AgentFleetSlice[] {
  const by = new Map<string, AgentFleetSlice>()
  const slice = (agent: string): AgentFleetSlice => {
    let s = by.get(agent)
    if (!s) {
      s = { agent, workers: 0, bots: 0, totalCores: 0, eventLoopLagP99Ms: 0, maxWorkerCpuPct: 0, saturated: false }
      by.set(agent, s)
    }
    return s
  }
  for (const w of a.workers) {
    if (w.agent === undefined) continue
    const s = slice(w.agent)
    s.workers++
    if (w.sinceMs > a.staleMs) s.saturated = true
    const l = w.latest
    if (!l) continue
    s.bots += l.bots
    s.totalCores += l.cpuPct / 100
    s.eventLoopLagP99Ms = Math.max(s.eventLoopLagP99Ms, l.eventLoopP99Ms)
    s.maxWorkerCpuPct = Math.max(s.maxWorkerCpuPct, l.mainThreadCpuPct)
  }
  for (const [agent, reasons] of Object.entries(a.externalSaturation ?? {})) {
    if (reasons.length > 0) slice(agent).saturated = true
  }
  for (const s of by.values()) {
    if (s.eventLoopLagP99Ms > a.thresholds.eventLoopP99Ms || s.maxWorkerCpuPct > a.thresholds.cpuPct) s.saturated = true
  }
  return [...by.values()].sort((x, y) => x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0)
}

export function aggregateStats (a: AggregateInput): FleetStats {
  const join: number[] = []
  const rtt: number[] = []
  let corrections = 0
  let rx = 0
  let chunkLoads = 0
  let blobMiss = 0
  let packets: Record<string, number> | undefined
  for (const r of a.reports) {
    chunkLoads += r.chunkLoads ?? 0
    blobMiss += r.blobMissReplies ?? 0
    if (r.packets) {
      packets ??= {}
      for (const [k, v] of Object.entries(r.packets)) packets[k] = (packets[k] ?? 0) + v
    }
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
  const view: BotViewSample[] = []
  let cacheSeen: boolean | undefined
  for (const w of a.workers) {
    const isStale = w.sinceMs > a.staleMs
    if (isStale) stale++
    const l = w.latest
    if (!l) continue
    lag = Math.max(lag, l.eventLoopP99Ms)
    maxCpu = Math.max(maxCpu, l.mainThreadCpuPct)
    maxProcCpu = Math.max(maxProcCpu, l.cpuPct)
    totalCpu += l.cpuPct
    rss += l.rssBytes
    bots += l.bots
    // a stale worker's bot snapshot may describe bots that are gone
    if (l.view && !isStale) for (const v of l.view) view.push(v)
    if (l.chunkCacheSeen !== undefined) cacheSeen = (cacheSeen ?? false) || l.chunkCacheSeen
  }
  const sec = a.elapsedMs / 1000
  const agents = aggregateAgents(a)
  const externallySaturated = Object.values(a.externalSaturation ?? {}).some(r => r.length > 0)
  const stats: FleetStats = {
    t: a.t,
    target: a.target,
    connected: a.connected,
    spawned: a.spawned,
    joinFailures: a.joinFailures,
    unexpectedDisconnects: a.unexpectedDisconnects,
    ...(a.connectRetries !== undefined ? { connectRetries: a.connectRetries } : {}),
    loadgen: {
      workers: a.workers.length,
      eventLoopLagP99Ms: lag,
      maxWorkerCpuPct: maxCpu,
      saturated: lag > a.thresholds.eventLoopP99Ms || maxCpu > a.thresholds.cpuPct || stale > 0 || externallySaturated,
      bots,
      maxWorkerProcessCpuPct: maxProcCpu,
      totalCpuPct: totalCpu,
      rssBytes: rss,
      staleWorkers: stale,
      totalCores: totalCpu / 100,
      blobMissReplies: blobMiss,
      ...(agents.length > 0 ? { agents } : {})
    },
    ...aggregateView(view)
  }
  if (cacheSeen !== undefined) stats.chunkCacheSeen = cacheSeen
  if (packets) stats.packets = packets
  if (join.length > 0) stats.joinLatencyMs = summarize(join)
  if (rtt.length > 0) stats.rttMs = summarize(rtt)
  if (a.reports.length > 0 && sec > 0) {
    stats.correctionsPerSec = corrections / sec
    stats.rxBytesPerSec = rx / sec
    if (a.reports.some(r => r.chunkLoads !== undefined)) stats.chunksPerSec = chunkLoads / sec
  }
  return stats
}
