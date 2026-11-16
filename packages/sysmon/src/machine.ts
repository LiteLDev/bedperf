import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import type {
  ForeignProcess, InterferenceCheck, InterferenceSample, InterferenceSummary, InterferenceThresholds,
  ProcessGroupName, Sampler
} from '@bedperf/core'
import { createPlatformProcTable, type ProcEntry, type ProcTable } from './proctable.ts'

/** Own groups in assignment order: a pid belongs to the first group that reaches it. */
export const GROUPS: readonly ProcessGroupName[] = ['server', 'bots', 'harness']

/** Cumulative busy and total time of one logical CPU, in any unit (only ratios are used). */
export interface CpuTimes { busy: number, total: number }

/** Reads cumulative times of every logical CPU, indexed by CPU number. */
export type CpuTimesReader = () => CpuTimes[]

// ---------------------------------------------------------------------------------------------
// Per-CPU busy
// ---------------------------------------------------------------------------------------------

/**
 * Per-CPU times from `/proc/stat` (`cpuN user nice system idle iowait irq softirq steal ...`).
 * busy = total − idle − iowait, so steal counts as busy (the CPU was not ours to use); guest
 * time is already inside user/nice. Offline CPUs, missing from the file, read as {0, 0}.
 */
export function parseProcStatCpus (text: string): CpuTimes[] {
  const out: CpuTimes[] = []
  for (const line of text.split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const f = m[2]!.trim().split(/\s+/).slice(0, 8).map(Number)
    if (f.length < 4 || f.some(v => !Number.isFinite(v))) continue
    const total = f.reduce((a, b) => a + b, 0)
    out[Number(m[1])] = { busy: total - f[3]! - (f[4] ?? 0), total }
  }
  for (let i = 0; i < out.length; i++) out[i] ??= { busy: 0, total: 0 }
  return out
}

/**
 * Per-CPU times from `os.cpus()`. Windows: busy = user + sys, because libuv's `sys` is kernel
 * time minus idle and already contains interrupt and DPC time (`irq` is a subset of it).
 * Elsewhere: user + nice + sys + irq.
 */
export function cpuTimesFromOs (list = cpus(), platform: NodeJS.Platform = process.platform): CpuTimes[] {
  return list.map(c => {
    const { user, nice, sys, idle, irq } = c.times
    const busy = platform === 'win32' ? user + nice + sys : user + nice + sys + irq
    return { busy, total: busy + idle }
  })
}

/** Platform default: `/proc/stat` on Linux (for iowait/steal), `os.cpus()` elsewhere. */
export function readCpuTimes (): CpuTimes[] {
  if (process.platform === 'linux') {
    try {
      const t = parseProcStatCpus(readFileSync('/proc/stat', 'utf8'))
      if (t.length) return t
    } catch {}
  }
  return cpuTimesFromOs()
}

/** Busy fraction of each CPU between two readings. Not clamped. */
export function busyFractions (prev: CpuTimes[], cur: CpuTimes[]): number[] {
  const n = Math.min(prev.length, cur.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const span = cur[i]!.total - prev[i]!.total
    out.push(span > 0 ? (cur[i]!.busy - prev[i]!.busy) / span : 0)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Own groups
// ---------------------------------------------------------------------------------------------

export type GroupRoots = Partial<Record<ProcessGroupName, number[]>>

/**
 * Assign every process reachable from a group's roots to that group, groups in `GROUPS` order;
 * a pid belongs to the first group that reaches it, and a walk never enters another group's
 * root. A child is only linked to its parent when it started no earlier than the parent, so a
 * reused parent pid does not adopt older orphans. Roots are members even if absent from `table`.
 */
export function assignGroups (table: ProcEntry[], roots: GroupRoots): Map<number, ProcessGroupName> {
  const byPid = new Map<number, ProcEntry>()
  for (const e of table) byPid.set(e.pid, e)
  const children = new Map<number, number[]>()
  for (const e of table) {
    if (e.pid === e.ppid) continue
    const parent = byPid.get(e.ppid)
    if (parent && parent.start && e.start && e.start < parent.start) continue
    let list = children.get(e.ppid)
    if (!list) children.set(e.ppid, list = [])
    list.push(e.pid)
  }
  const allRoots = new Set<number>()
  for (const g of GROUPS) for (const p of roots[g] ?? []) allRoots.add(p)
  const out = new Map<number, ProcessGroupName>()
  for (const g of GROUPS) {
    const own = new Set(roots[g] ?? [])
    const stack = [...own].filter(p => !out.has(p))
    for (const p of stack) out.set(p, g)
    while (stack.length) {
      const pid = stack.pop()!
      for (const c of children.get(pid) ?? []) {
        if (out.has(c) || (allRoots.has(c) && !own.has(c))) continue
        out.set(c, g)
        stack.push(c)
      }
    }
  }
  return out
}

const key = (e: ProcEntry): string => `${e.pid}:${e.start}`

/**
 * Processes that used at least `minCores` between two scans, busiest first (ties by pid). A
 * process missing from `before` started in between, so all of its CPU counts.
 */
export function topForeign (
  before: Map<string, ProcEntry>, after: ProcEntry[], own: ReadonlySet<number>, seconds: number, n = 10, minCores = 0.01
): ForeignProcess[] {
  if (!(seconds > 0)) return []
  const rows: ForeignProcess[] = []
  for (const e of after) {
    if (e.pid === 0 || own.has(e.pid)) continue
    const cores = (e.cpuMs - (before.get(key(e))?.cpuMs ?? 0)) / 1000 / seconds
    if (cores >= minCores) rows.push({ pid: e.pid, name: e.name, cores: Math.round(cores * 1000) / 1000 })
  }
  rows.sort((a, b) => b.cores - a.cores || a.pid - b.pid)
  return rows.slice(0, n)
}

// ---------------------------------------------------------------------------------------------
// Window summary and gates
// ---------------------------------------------------------------------------------------------

export const DEFAULT_INTERFERENCE_THRESHOLDS: InterferenceThresholds = {
  foreignMean: 0.25,
  foreignPeak10s: 1.5,
  serverSetForeignMean: 0.25
}

const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN

/** Highest mean over any `k` consecutive values (the mean of all of them when there are fewer). */
export function peakMean (xs: number[], k: number): number {
  if (!xs.length) return Number.NaN
  const w = Math.max(1, Math.min(k, xs.length))
  let sum = 0
  for (let i = 0; i < w; i++) sum += xs[i]!
  let best = sum
  for (let i = w; i < xs.length; i++) {
    sum += xs[i]! - xs[i - w]!
    if (sum > best) best = sum
  }
  return best / w
}

/** Summarise a window of samples (pure). `peakSamples` = samples per peak window (default 10, i.e. 10 s at 1 Hz). */
export function summarizeInterference (samples: InterferenceSample[], peakSamples = 10): InterferenceSummary {
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  const foreign = sorted.map(s => s.foreignCores)
  const out: InterferenceSummary = {
    samples: sorted.length,
    foreignMean: mean(foreign),
    foreignPeak10s: peakMean(foreign, peakSamples)
  }
  const set = sorted.map(s => s.serverSetForeignCores).filter((v): v is number => typeof v === 'number')
  if (set.length) out.serverSetForeignMean = mean(set)
  return out
}

const f2 = (v: number): string => v.toFixed(2)

/** Compare a summary against limits (defaults: `DEFAULT_INTERFERENCE_THRESHOLDS`). */
export function checkInterference (summary: InterferenceSummary, thresholds: Partial<InterferenceThresholds> = {}): InterferenceCheck {
  const lim = { ...DEFAULT_INTERFERENCE_THRESHOLDS, ...thresholds }
  const reasons: string[] = []
  if (summary.samples === 0) reasons.push('no interference samples')
  else {
    if (!(summary.foreignMean <= lim.foreignMean)) reasons.push(`foreign load ${f2(summary.foreignMean)} cores > ${lim.foreignMean}`)
    if (!(summary.foreignPeak10s <= lim.foreignPeak10s)) reasons.push(`foreign 10 s peak ${f2(summary.foreignPeak10s)} cores > ${lim.foreignPeak10s}`)
    if (summary.serverSetForeignMean !== undefined && !(summary.serverSetForeignMean <= lim.serverSetForeignMean)) {
      reasons.push(`foreign load on server CPUs ${f2(summary.serverSetForeignMean)} cores > ${lim.serverSetForeignMean}`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

// ---------------------------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------------------------

export interface MachineSamplerOptions {
  /** Default 1000. */
  intervalMs?: number
  /** Full process-table scan (new group members, top foreign) every this many ms (default 10 000). */
  topIntervalMs?: number
  /** Default 10. */
  topN?: number
  /** Default 0.01 cores. */
  topMinCores?: number
  /** Logical CPUs reserved for the server; enables `serverSetForeignCores`. */
  serverCpus?: number[]
  /** Initial group roots. `harness` defaults to `[process.pid]`. */
  groups?: GroupRoots
  /** Consecutive failed ticks tolerated before giving up (default 3). */
  maxConsecutiveErrors?: number
  /** Called once if sampling gives up after persistent errors (not for `stop()`). */
  onEnd?: (reason: 'error', err: Error) => void
  /** Overrides for tests. */
  cpuTimes?: CpuTimesReader
  procTable?: ProcTable
  /** Monotonic ms (default `performance.now`). */
  now?: () => number
  /** Epoch ms (default `Date.now`). */
  clock?: () => number
}

export interface MachineSampler extends Sampler<InterferenceSample> {
  /** Replace a group's roots (their descendants follow); membership is rescanned at the next sample. */
  setGroup (group: ProcessGroupName, pids: number[]): void
  /** Rescan the process table at the next sample. */
  refresh (): void
  /** Scan now and return the top foreign processes since the previous scan. Needs a started sampler. */
  top (): Promise<ForeignProcess[]>
}

/** Machine-wide interference sampler. Single-use, like `createProcessSampler`. */
export function createMachineSampler (opts: MachineSamplerOptions = {}): MachineSampler {
  const intervalMs = opts.intervalMs ?? 1000
  const topIntervalMs = opts.topIntervalMs ?? 10_000
  const topN = opts.topN ?? 10
  const topMin = opts.topMinCores ?? 0.01
  const maxErrors = Math.max(1, opts.maxConsecutiveErrors ?? 3)
  const serverCpus = opts.serverCpus ? [...new Set(opts.serverCpus)].sort((a, b) => a - b) : undefined
  const readCpus = opts.cpuTimes ?? readCpuTimes
  const now = opts.now ?? (() => performance.now())
  const clock = opts.clock ?? Date.now
  const roots: Record<ProcessGroupName, number[]> = { server: [], bots: [], harness: [process.pid] }
  for (const g of GROUPS) if (opts.groups?.[g]) roots[g] = [...opts.groups[g]!]

  let table: ProcTable | undefined
  let started = false
  let running = false
  let timer: NodeJS.Timeout | undefined
  let wake: (() => void) | undefined
  let loopP: Promise<void> | undefined
  let chain: Promise<unknown> = Promise.resolve()

  // State, only touched inside `exclusive`.
  let members = new Map<number, ProcessGroupName>()
  let needScan = true
  let lastScanAt = Number.NaN
  let foreignPrev: Map<string, ProcEntry> | undefined
  let prevCpus: CpuTimes[] | undefined
  let prevOwn = new Map<string, number>()
  let prevT = 0

  function exclusive<T> (fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  /** Full scan: refresh membership; returns top foreign since the previous scan, if any. */
  async function scan (): Promise<{ top: ForeignProcess[], seconds: number } | undefined> {
    // Cleared before the await so a setGroup()/refresh() during the scan triggers another one.
    needScan = false
    const entries = await table!.scan()
    const t = now()
    members = assignGroups(entries, roots)
    const own = new Set(members.keys())
    let result: { top: ForeignProcess[], seconds: number } | undefined
    if (foreignPrev) {
      const seconds = (t - lastScanAt) / 1000
      result = { top: topForeign(foreignPrev, entries, own, seconds, topN, topMin), seconds }
    }
    // Keep every process (own ones too): one that leaves a group must not look newly started.
    foreignPrev = new Map(entries.map(e => [key(e), e]))
    lastScanAt = t
    return result
  }

  async function tick (): Promise<InterferenceSample | undefined> {
    try {
      return await tickInner()
    } catch (err) {
      // Re-baseline: the failed tick may have left half-updated deltas.
      prevCpus = undefined
      prevOwn = new Map()
      throw err
    }
  }

  async function tickInner (): Promise<InterferenceSample | undefined> {
    let topRes: { top: ForeignProcess[], seconds: number } | undefined
    if (needScan || !(now() - lastScanAt < topIntervalMs)) {
      const scheduled = !needScan || foreignPrev === undefined
      const r = await scan()
      // A rescan forced by setGroup/refresh may cover only a short interval: report top only on schedule.
      if (r && (scheduled || r.seconds * 1000 >= topIntervalMs / 2)) topRes = r
    }
    const pids = [...members.keys()]
    // Own CPU first, then the per-CPU counters right after the reply, so both cover the same
    // interval up to the reply's transfer latency rather than the whole helper round trip.
    const entries = await table!.read(pids)
    const busyNow = readCpus()
    const t = now()
    const cur = new Map<string, number>()
    const groups: Record<ProcessGroupName, number> = { server: 0, bots: 0, harness: 0 }
    const spanMs = t - prevT
    for (const e of entries) {
      const g = members.get(e.pid)
      if (!g) continue
      const k = key(e)
      cur.set(k, e.cpuMs)
      const before = prevOwn.get(k)
      // A pid seen for the first time only sets its baseline.
      if (before !== undefined && prevCpus && spanMs > 0) groups[g] += (e.cpuMs - before) / spanMs
    }
    const first = prevCpus === undefined
    const busy = first ? [] : busyFractions(prevCpus!, busyNow)
    prevCpus = busyNow
    prevOwn = cur
    prevT = t
    if (first || !(spanMs > 0)) return undefined
    const busyCores = busy.reduce((a, b) => a + b, 0)
    const s: InterferenceSample = {
      t: clock(),
      intervalMs: Math.round(spanMs),
      cpuBusy: busy.map(b => Math.round(b * 10_000) / 10_000),
      busyCores,
      groups,
      foreignCores: busyCores - groups.server - groups.bots - groups.harness
    }
    if (serverCpus) s.serverSetForeignCores = serverCpus.reduce((a, c) => a + (busy[c] ?? 0), 0) - groups.server
    if (topRes) { s.top = topRes.top; s.topIntervalMs = Math.round(topRes.seconds * 1000) }
    return s
  }

  async function loop (onSample: (s: InterferenceSample) => void): Promise<void> {
    let next = now()
    let errors = 0
    let endErr: Error | undefined
    while (running) {
      try {
        const s = await exclusive(tick)
        errors = 0
        if (s && running) {
          try { onSample(s) } catch (err) { queueMicrotask(() => { throw err }) }
        }
      } catch (err) {
        if (!running) break
        if (++errors >= maxErrors) { endErr = err as Error; break }
      }
      next += intervalMs
      const n = now()
      if (next < n) next = n
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, next - n) })
    }
    const wasRunning = running
    running = false
    try { await table?.close() } catch {}
    if (endErr && wasRunning && opts.onEnd) {
      try { opts.onEnd('error', endErr) } catch (err) { queueMicrotask(() => { throw err }) }
    }
  }

  return {
    async start (onSample) {
      if (started) throw new Error('machine sampler already started (samplers are single-use)')
      started = true
      if (serverCpus) {
        const n = readCpus().length
        const bad = serverCpus.filter(c => !Number.isInteger(c) || c < 0 || c >= n)
        if (bad.length) throw new Error(`serverCpus ${bad.join(',')} out of range: this machine has CPUs 0..${n - 1}`)
      }
      table = opts.procTable ?? createPlatformProcTable()
      running = true
      loopP = loop(onSample)
    },
    async stop () {
      if (!running) { await loopP; return }
      running = false
      if (timer) clearTimeout(timer)
      wake?.()
      try { await table?.close() } catch {}
      await loopP
    },
    setGroup (group, pids) {
      if (!GROUPS.includes(group)) throw new Error(`unknown group ${String(group)}; use one of ${GROUPS.join(', ')}`)
      roots[group] = [...pids]
      needScan = true
    },
    refresh () { needScan = true },
    top () {
      if (!running) return Promise.reject(new Error('machine sampler is not running'))
      return exclusive(async () => (await scan())?.top ?? [])
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Idle gate
// ---------------------------------------------------------------------------------------------

export interface IdleCheckOptions extends Pick<MachineSamplerOptions, 'intervalMs' | 'cpuTimes' | 'procTable' | 'now' | 'clock' | 'topN' | 'topMinCores'> {
  /** Default 15. */
  durationSec?: number
  serverCpus?: number[]
  thresholds?: Partial<InterferenceThresholds>
  /** Harness root (default `process.pid`); everything outside its tree counts as foreign. */
  harnessRoot?: number
}

export interface IdleCheckResult extends InterferenceCheck {
  /** Floored at 0 (unlike run windows) so a quiet machine reads as 0, not slightly negative. */
  summary: InterferenceSummary
  /** Busiest foreign processes over the whole check. */
  top: ForeignProcess[]
  samples: InterferenceSample[]
}

/**
 * Measure foreign load on a quiet machine (no server, no bots) for `durationSec` and gate it.
 * With no server running, foreign load on the server set is simply the busy time of those CPUs.
 */
export async function idleCheck (opts: IdleCheckOptions = {}): Promise<IdleCheckResult> {
  const durationSec = opts.durationSec ?? 15
  const intervalMs = opts.intervalMs ?? 1000
  const steps = Math.max(1, Math.round(durationSec * 1000 / intervalMs))
  const o: MachineSamplerOptions = {
    intervalMs,
    topIntervalMs: Number.POSITIVE_INFINITY,
    // process.pid stays in the harness group so the sampler's own helper is never foreign.
    groups: { harness: [...new Set([opts.harnessRoot ?? process.pid, process.pid])] }
  }
  if (opts.serverCpus) o.serverCpus = opts.serverCpus
  if (opts.cpuTimes) o.cpuTimes = opts.cpuTimes
  if (opts.procTable) o.procTable = opts.procTable
  if (opts.now) o.now = opts.now
  if (opts.clock) o.clock = opts.clock
  if (opts.topN !== undefined) o.topN = opts.topN
  if (opts.topMinCores !== undefined) o.topMinCores = opts.topMinCores
  const samples: InterferenceSample[] = []
  let failed: Error | undefined
  let done!: () => void
  const finished = new Promise<void>(resolve => { done = resolve })
  o.onEnd = (_r, err) => { failed = err; done() }
  const sampler = createMachineSampler(o)
  let top: ForeignProcess[] = []
  await sampler.start(s => { samples.push(s); if (samples.length >= steps) done() })
  const guard = setTimeout(done, durationSec * 2000 + 30_000)
  try {
    await finished
    if (failed) throw failed
    if (samples.length < steps) throw new Error(`idle check: only ${samples.length}/${steps} samples`)
    top = await sampler.top()
  } finally {
    clearTimeout(guard)
    await sampler.stop()
  }
  const used = samples.slice(0, steps)
  const raw = summarizeInterference(used)
  const summary: InterferenceSummary = {
    samples: raw.samples,
    foreignMean: Math.max(0, raw.foreignMean),
    foreignPeak10s: Math.max(0, raw.foreignPeak10s)
  }
  if (raw.serverSetForeignMean !== undefined) summary.serverSetForeignMean = Math.max(0, raw.serverSetForeignMean)
  return { ...checkInterference(summary, opts.thresholds), summary, top, samples: used }
}
