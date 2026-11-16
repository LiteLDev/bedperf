import type { SysSample } from '@bedperf/core'
import type { RawReading } from './types.ts'

export interface ComputeOptions {
  pid: number
  /** Top-N threads reported per sample (0 disables `threads`). */
  topThreads?: number
  /** Sliding window, in samples, used to pick the main thread. */
  mainThreadWindow?: number
  /**
   * A challenger replaces the sticky main thread only if its windowed CPU exceeds the
   * incumbent's by this factor.
   */
  switchFactor?: number
}

export interface ComputeState {
  pid: number
  topThreads: number
  mainThreadWindow: number
  switchFactor: number
  /** Per-sample thread CPU deltas (ms), newest last, at most `mainThreadWindow` entries. */
  window: Array<Map<number, number>>
  mainTid?: number
}

export function createComputeState (opts: ComputeOptions): ComputeState {
  return {
    pid: opts.pid,
    topThreads: Math.max(0, opts.topThreads ?? 5),
    mainThreadWindow: Math.max(1, opts.mainThreadWindow ?? 10),
    switchFactor: opts.switchFactor ?? 1.25,
    window: []
  }
}

const round2 = (x: number): number => Math.round(x * 100) / 100
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/**
 * Turn two successive cumulative readings into a `SysSample`. Updates `state` (main-thread
 * window). Returns null when `cur` is not after `prev` (nothing to compute a rate over).
 */
export function computeSample (prev: RawReading, cur: RawReading, state: ComputeState): SysSample | null {
  const dt = cur.t - prev.t
  if (!(dt > 0)) return null

  const sample: SysSample = {
    pid: state.pid,
    t: cur.t,
    intervalMs: dt,
    cpuPct: round2(Math.max(0, cur.procCpuMs - prev.procCpuMs) / dt * 100),
    rssBytes: cur.rssBytes
  }
  if (cur.privateBytes !== undefined) sample.privateBytes = cur.privateBytes
  if (cur.handles !== undefined) sample.handles = cur.handles

  const threadCount = cur.threadCount ?? cur.threads?.length
  if (threadCount !== undefined) sample.threadCount = threadCount

  // Thread rates need thread data in BOTH readings; otherwise every thread would look new.
  if (cur.threads && prev.threads) {
    const prevCpu = new Map<number, number>()
    for (const th of prev.threads) prevCpu.set(th.tid, th.cpuMs)
    const deltas = new Map<number, number>()
    const names = new Map<number, string>()
    for (const th of cur.threads) {
      const before = prevCpu.get(th.tid)
      // A thread new in this interval (or a reused tid, seen as a negative delta) can only
      // have run since it was created, i.e. within this interval: count all of it, capped.
      let d = before === undefined || th.cpuMs < before ? th.cpuMs : th.cpuMs - before
      d = clamp(d, 0, dt)
      deltas.set(th.tid, d)
      if (th.name !== undefined) names.set(th.tid, th.name)
    }

    state.window.push(deltas)
    while (state.window.length > state.mainThreadWindow) state.window.shift()
    pickMainThread(state, deltas)

    const pct = (tid: number): number => round2((deltas.get(tid) ?? 0) / dt * 100)
    const withName = <T extends { tid: number }>(o: T): T & { name?: string } => {
      const name = names.get(o.tid)
      return name === undefined ? o : { ...o, name }
    }

    if (state.topThreads > 0) {
      sample.threads = [...deltas.keys()]
        .sort((a, b) => (deltas.get(b)! - deltas.get(a)!) || a - b)
        .slice(0, state.topThreads)
        .map(tid => withName({ tid, cpuPct: pct(tid) }))
    }
    if (state.mainTid !== undefined) {
      const cpuPct = pct(state.mainTid)
      sample.mainThread = withName({ tid: state.mainTid, cpuPct, util: clamp(Math.round(cpuPct * 100) / 10000, 0, 1) })
    }
  }

  if (cur.net && prev.net) {
    // Only interfaces present in both readings; a counter that went backwards was reset.
    const before = new Map(prev.net.map(n => [n.name, n]))
    let rx = 0
    let tx = 0
    for (const n of cur.net) {
      const p = before.get(n.name)
      if (!p) continue
      rx += Math.max(0, n.rxBytes - p.rxBytes)
      tx += Math.max(0, n.txBytes - p.txBytes)
    }
    sample.net = {
      rxBytesPerSec: Math.round(rx / dt * 1000),
      txBytesPerSec: Math.round(tx / dt * 1000),
      scope: 'system'
    }
  }

  if (cur.sysCpu && prev.sysCpu) {
    const total = cur.sysCpu.totalMs - prev.sysCpu.totalMs
    if (total > 0) sample.systemCpuPct = round2(clamp((cur.sysCpu.busyMs - prev.sysCpu.busyMs) / total * 100, 0, 100))
  }
  return sample
}

/** Busiest thread over the window, sticky unless a challenger clearly dominates. */
function pickMainThread (state: ComputeState, latest: Map<number, number>): void {
  const sums = new Map<number, number>()
  for (const m of state.window) {
    for (const [tid, d] of m) {
      // Only threads alive now are candidates.
      if (latest.has(tid)) sums.set(tid, (sums.get(tid) ?? 0) + d)
    }
  }
  let best: number | undefined
  let bestSum = -1
  for (const [tid, s] of sums) {
    if (s > bestSum || (s === bestSum && best !== undefined && tid < best)) { best = tid; bestSum = s }
  }
  if (best === undefined) { delete state.mainTid; return }
  const inc = state.mainTid
  if (inc === undefined || !latest.has(inc)) { state.mainTid = best; return }
  const incSum = sums.get(inc) ?? 0
  if (best !== inc && bestSum > incSum * state.switchFactor) state.mainTid = best
}
