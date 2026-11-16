// @bedperf/probe-addon: host side of the L1 Script API probe (pack lives in ../pack).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { percentile, summarize, type ProbeRecord, type ProbeSample, type Summary } from '@bedperf/core'

/** Header UUID of the probe behavior pack (pack/manifest.json). */
export const PROBE_PACK_UUID = 'bf8271af-694e-4bc1-9d98-f105c75b58dd'
export const PROBE_PACK_VERSION: readonly [number, number, number] = [1, 0, 0]
/** Folder name under `behavior_packs/` (same scheme as testkit's installBehaviorPack). */
export const PROBE_PACK_FOLDER = `bedperf_${PROBE_PACK_UUID.slice(0, 8)}`

/** Absolute path of the behavior pack directory (contains manifest.json). */
export function packDir (): string {
  return fileURLToPath(new URL('../pack', import.meta.url))
}

/**
 * Install the probe into a BDS instance and enable it on `levelName`. Idempotent. Replaces files
 * instead of writing into them, so hard links into the pristine BDS cache are never written through.
 * Works before the world exists.
 */
export function installProbe (instanceDir: string, levelName: string): void {
  const dest = join(instanceDir, 'behavior_packs', PROBE_PACK_FOLDER)
  rmSync(dest, { recursive: true, force: true })
  cpSync(packDir(), dest, { recursive: true })

  const worldDir = join(instanceDir, 'worlds', levelName)
  mkdirSync(worldDir, { recursive: true })
  const listFile = join(worldDir, 'world_behavior_packs.json')
  let list: unknown[] = []
  if (existsSync(listFile)) {
    const parsed = JSON.parse(readFileSync(listFile, 'utf8').replace(/^\uFEFF/, '')) as unknown
    if (!Array.isArray(parsed)) throw new Error(`${listFile} is not a JSON array`)
    list = parsed.filter(e => (e as { pack_id?: unknown } | null)?.pack_id !== PROBE_PACK_UUID)
  }
  list.push({ pack_id: PROBE_PACK_UUID, version: [...PROBE_PACK_VERSION] })
  rmSync(listFile, { force: true }) // never write through a link
  writeFileSync(listFile, JSON.stringify(list, null, 2))
}

export interface ProbeSummaryOptions {
  /** Only include samples whose end time `t` is >= this (ms epoch). */
  fromT?: number
  /** Only include samples whose end time `t` is <= this (ms epoch). */
  toT?: number
}

export interface ProbeSummary {
  /** Number of sample windows aggregated. */
  windows: number
  /** Sum of window durations (ms). */
  durationMs: number
  /** Total ticks observed. */
  ticks: number
  /** Time-weighted TPS: ticks / total duration. NaN with no windows. */
  tps: number
  /** Distribution of per-window TPS. */
  windowTps: Summary
  /** 1st percentile of window TPS (≈ "min after discarding the worst 1 % of windows"). */
  windowTpsP1: number
  /** Mean tick interval over all windows (ms): durationMs / ticks. */
  intervalMean: number
  /** Largest single tick interval seen (ms). */
  intervalMax: number
  /** Distribution of per-window p95 / p99 tick intervals (exact global percentiles are not recoverable). */
  windowIntervalP95: Summary
  windowIntervalP99: Summary
  over50: number
  over100: number
  /** over50 / ticks. */
  over50Rate: number
  players: Summary
  /** Distribution of entity totals over the windows that carried an entity sample. */
  entities: Summary
}

/** Aggregate probe samples (non-sample records are ignored) over an optional time range. */
export function summarizeProbe (records: readonly ProbeRecord[], opts: ProbeSummaryOptions = {}): ProbeSummary {
  const { fromT = -Infinity, toT = Infinity } = opts
  const samples = records.filter((r): r is ProbeSample => r.type === 'sample' && r.t >= fromT && r.t <= toT)
  let durationMs = 0
  let ticks = 0
  let intervalMax = Number.NaN
  let over50 = 0
  let over100 = 0
  const tps: number[] = []
  for (const s of samples) {
    durationMs += s.windowMs
    ticks += s.ticks
    if (!(s.interval.max <= intervalMax)) intervalMax = s.interval.max
    over50 += s.over50
    over100 += s.over100
    tps.push(s.tps)
  }
  return {
    windows: samples.length,
    durationMs,
    ticks,
    tps: durationMs > 0 ? ticks / (durationMs / 1000) : Number.NaN,
    windowTps: summarize(tps),
    windowTpsP1: percentile(tps, 1),
    intervalMean: ticks > 0 ? durationMs / ticks : Number.NaN,
    intervalMax,
    windowIntervalP95: summarize(samples.map(s => s.interval.p95)),
    windowIntervalP99: summarize(samples.map(s => s.interval.p99)),
    over50,
    over100,
    over50Rate: ticks > 0 ? over50 / ticks : Number.NaN,
    players: summarize(samples.map(s => s.players)),
    entities: summarize(samples.flatMap(s => s.entities ? [s.entities.total] : []))
  }
}
