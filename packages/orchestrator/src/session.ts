// A/B sessions: several configs measured in one session, their repeats interleaved so slow drift of
// the machine (thermals, background load) hits every config alike. One run dir per config plus a
// session.json linking them.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BenchmarkConfig } from '@bedperf/core'
import { BenchmarkRun, consoleLogger, ExitCodes, exitCodeOf, initialIdleGate, type BenchmarkOutcome, type EngineDeps, type RunOptions } from './engine.ts'

/** `sequential`: all repeats of config 0, then config 1, ...; `rotate`: block k runs repeat k of every config, starting at config k mod n; `seeded`: block order shuffled with a seeded RNG. */
export type RepeatOrder = { kind: 'sequential' } | { kind: 'rotate' } | { kind: 'seeded', seed: number }

export function parseOrder (s: string): RepeatOrder {
  if (s === 'sequential' || s === 'rotate') return { kind: s }
  const m = /^seeded:(-?\d+)$/.exec(s)
  if (m !== null) return { kind: 'seeded', seed: Number(m[1]) }
  throw new Error(`unknown order '${s}' (expected rotate, sequential or seeded:<N>)`)
}

export function formatOrder (o: RepeatOrder): string {
  return o.kind === 'seeded' ? `seeded:${o.seed}` : o.kind
}

function mulberry32 (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ScheduleItem {
  /** Index into the session's configs. */
  config: number
  /** Repeat slot of that config. */
  slot: number
  /** Block (slot number for block orders). */
  block: number
}

/** The order in which (config, slot) pairs run. Pure. `repeats[i]` = repeat slots of config i. */
export function sessionSchedule (repeats: readonly number[], order: RepeatOrder): ScheduleItem[] {
  const out: ScheduleItem[] = []
  const n = repeats.length
  if (order.kind === 'sequential') {
    for (let c = 0; c < n; c++) for (let k = 0; k < repeats[c]!; k++) out.push({ config: c, slot: k, block: k })
    return out
  }
  const rng = order.kind === 'seeded' ? mulberry32(order.seed) : undefined
  const blocks = Math.max(0, ...repeats)
  for (let k = 0; k < blocks; k++) {
    let cs = Array.from({ length: n }, (_, j) => order.kind === 'rotate' ? (k + j) % n : j)
    if (rng !== undefined) {
      for (let i = cs.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[cs[i], cs[j]] = [cs[j]!, cs[i]!]
      }
    }
    cs = cs.filter(c => k < repeats[c]!)
    for (const c of cs) out.push({ config: c, slot: k, block: k })
  }
  return out
}

export interface SessionEntry {
  config: BenchmarkConfig
  /** Engine deps of this config; `runsDir` should be the session dir. */
  deps: EngineDeps
  opts?: RunOptions
}

export interface SessionOutcome {
  sessionId: string
  dir: string
  runs: BenchmarkOutcome[]
  /** Worst exit code over the runs (see `ExitCodes`). */
  exitCode: number
}

export interface SessionOptions {
  sessionId: string
  /** Directory session.json is written to (usually also every entry's `runsDir`). */
  dir: string
  order: RepeatOrder
  signal?: AbortSignal
  now?: () => number
}

/**
 * Run several configs as one session. The idle gate runs once before any run dir is created (busy:
 * `EnvGateError`); then each scheduled (config, slot) runs `BenchmarkRun.runSlot`, with cooldown and
 * the idle gate between consecutive repeats whichever config they belong to.
 */
export async function runSession (entries: readonly SessionEntry[], sopts: SessionOptions): Promise<SessionOutcome> {
  if (entries.length === 0) throw new Error('a session needs at least one config')
  const now = sopts.now ?? Date.now
  const log = entries[0]!.deps.logger ?? consoleLogger
  await initialIdleGate(entries[0]!.config, entries[0]!.deps)
  await mkdir(sopts.dir, { recursive: true })
  const startedAt = new Date(now()).toISOString()
  const runs: BenchmarkRun[] = []
  const schedule = sessionSchedule(entries.map(e => e.config.repeats), sopts.order)
  const done: Array<ScheduleItem & { repeats: Array<{ index: number, status: string }> }> = []
  const writeSession = async (extra: Record<string, unknown>): Promise<void> => {
    const body = {
      sessionId: sopts.sessionId,
      order: formatOrder(sopts.order),
      startedAt,
      configs: runs.map((r, i) => ({ name: entries[i]!.config.name, runId: r.runId, dir: path.relative(sopts.dir, r.dir).split(path.sep).join('/'), configSha256: r.rec.meta.configSha256 })),
      schedule: done.map(d => ({ config: entries[d.config]!.config.name, runId: runs[d.config]!.runId, slot: d.slot, block: d.block, repeats: d.repeats })),
      ...extra
    }
    await writeFile(path.join(sopts.dir, 'session.json'), JSON.stringify(body, null, 2) + '\n')
  }
  try {
    for (const e of entries) runs.push(await BenchmarkRun.open(e.config, e.deps, { ...e.opts, ...(sopts.signal !== undefined ? { signal: sopts.signal } : {}) }))
    await writeSession({})
    let first = true
    for (const item of schedule) {
      sopts.signal?.throwIfAborted()
      log.info(`session ${sopts.sessionId}: block ${item.block}, ${entries[item.config]!.config.name} repeat slot ${item.slot}`)
      const outs = await runs[item.config]!.runSlot(item.slot, first)
      first = false
      done.push({ ...item, repeats: outs.map(o => ({ index: o.repeat, status: o.status })) })
      await writeSession({})
    }
  } catch (err) {
    for (const r of runs) await r.fail(err)
    await writeSession({ finishedAt: new Date(now()).toISOString(), error: String((err as Error)?.message ?? err) }).catch(() => {})
    throw err
  }
  const outcomes: BenchmarkOutcome[] = []
  for (const r of runs) outcomes.push(await r.finish())
  const codes = outcomes.map(o => exitCodeOf(o.result))
  const exitCode = codes.every(c => c === ExitCodes.ok)
    ? ExitCodes.ok
    : codes.includes(ExitCodes.invalid) ? ExitCodes.invalid : ExitCodes.serverFailed
  await writeSession({ finishedAt: new Date(now()).toISOString(), exitCode, results: outcomes.map(o => ({ runId: o.runId, maxPlayersMedian: o.result.maxPlayersMedian, kOk: o.result.kOk, n: o.result.n })) })
  return { sessionId: sopts.sessionId, dir: sopts.dir, runs: outcomes, exitCode }
}
