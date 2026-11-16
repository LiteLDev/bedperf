import type { SysSample } from '@bedperf/core'

/**
 * How the tick (main) thread is identified:
 * - `lowest_tid_name:<N>`: the lowest tid among threads named `N`. On Linux threads created
 *   by a named thread inherit its name, so several threads can be called `MC_SERVER`; the
 *   tick thread is the first (lowest tid) one.
 * - `name:<N>`: the ONE thread named `N`; no match when there are none or several.
 * - `busiest`: no name matching; always the busiest-thread heuristic.
 * Whenever a name rule finds no thread, the busiest-thread heuristic is the fallback.
 */
export type TickThreadRule =
  | { kind: 'lowest_tid_name', name: string }
  | { kind: 'name', name: string }
  | { kind: 'busiest' }

/** BDS names its tick thread `MC_SERVER`. */
export const DEFAULT_TICK_THREAD_RULE = 'lowest_tid_name:MC_SERVER'

/** Parse a rule string (see `TickThreadRule`). Throws on anything else. */
export function parseTickThreadRule (rule: string): TickThreadRule {
  if (rule === 'busiest') return { kind: 'busiest' }
  const i = rule.indexOf(':')
  const kind = i < 0 ? rule : rule.slice(0, i)
  const name = i < 0 ? '' : rule.slice(i + 1)
  if ((kind === 'lowest_tid_name' || kind === 'name') && name !== '') return { kind, name }
  throw new Error(`bad tick thread rule ${JSON.stringify(rule)} (expected lowest_tid_name:<name>, name:<name> or busiest)`)
}

/** The tid the rule selects among `threads`, or undefined when it finds no single answer. */
export function applyTickThreadRule (rule: TickThreadRule, threads: ReadonlyArray<{ tid: number, name?: string }>): number | undefined {
  if (rule.kind === 'busiest') return undefined
  const matches = threads.filter(t => t.name === rule.name).map(t => t.tid)
  if (rule.kind === 'name') return matches.length === 1 ? matches[0] : undefined
  return matches.length ? Math.min(...matches) : undefined
}

/** Cumulative CPU of the tick thread at time `t` (epoch ms). `tid` guards against thread switches. */
export interface ThreadCpuPoint { t: number, cpuMs: number, tid?: number }
/** Server tick counter `tick` observed at time `t` (epoch ms), e.g. from a probe. */
export interface TickPoint { t: number, tick: number }

/** `{t, cpuMs, tid}` points of the main thread from sysmon samples (those carrying `cpuMs`). */
export function mainThreadCpuSeries (samples: readonly SysSample[]): ThreadCpuPoint[] {
  const out: ThreadCpuPoint[] = []
  for (const s of samples) {
    const m = s.mainThread
    if (m?.cpuMs !== undefined) out.push({ t: s.t, cpuMs: m.cpuMs, tid: m.tid })
  }
  return out
}

/**
 * Tick-thread CPU per executed tick over the window [t0, t1], in ms of CPU per tick:
 *
 *   (CPU(t_b) - CPU(t_a)) / (g_b - g_a)
 *
 * where `t_a`/`t_b` are the first/last tick observations inside the window, `g` the tick
 * counter there, and CPU is the tick thread's cumulative CPU linearly interpolated between
 * the CPU samples that bracket each of those times (no extrapolation).
 *
 * This is NOT MSPT. It counts only time the tick thread was on a CPU; time it spent blocked
 * (locks, I/O, waiting on workers) or runnable-but-descheduled is excluded, so it is a lower
 * bound on the work each tick costs, not the tick's wall-clock duration.
 *
 * Returns undefined when there are fewer than two tick observations in the window, no tick
 * advanced, the tick counter went backwards inside the window, the CPU series does not cover `t_a`..`t_b`, CPU decreases anywhere in it, or the thread
 * (`tid`) changes anywhere in the CPU samples used.
 */
export function tickCpuMsPerTick (cpu: readonly ThreadCpuPoint[], ticks: readonly TickPoint[], t0: number, t1: number): number | undefined {
  const inWin = ticks.filter(p => p.t >= t0 && p.t <= t1 && Number.isFinite(p.tick)).sort((x, y) => x.t - y.t)
  if (inWin.length < 2) return undefined
  const a = inWin[0]!
  const b = inWin.at(-1)!
  const dTicks = b.tick - a.tick
  if (!(b.t > a.t) || !(dTicks > 0)) return undefined
  // A counter that goes backwards (server restart, probe reconnect) makes g_b - g_a meaningless.
  for (let i = 1; i < inWin.length; i++) if (inWin[i]!.tick < inWin[i - 1]!.tick) return undefined

  const pts = cpu.filter(p => Number.isFinite(p.cpuMs) && Number.isFinite(p.t)).sort((x, y) => x.t - y.t)
  // Index of the last point at or before a.t and of the first point at or after b.t.
  let lo = -1
  for (let i = 0; i < pts.length && pts[i]!.t <= a.t; i++) lo = i
  let hi = -1
  for (let i = pts.length - 1; i >= 0 && pts[i]!.t >= b.t; i--) hi = i
  if (lo < 0 || hi < 0 || hi < lo) return undefined
  const tid = pts[lo]!.tid
  for (let i = lo; i <= hi; i++) {
    if (pts[i]!.tid !== tid) return undefined
    // Cumulative CPU never decreases for one thread; a drop means a reused tid or bad data.
    if (i > lo && pts[i]!.cpuMs < pts[i - 1]!.cpuMs) return undefined
  }

  const at = (t: number): number => {
    let i = lo
    while (i < hi && pts[i + 1]!.t <= t) i++
    const p = pts[i]!
    if (p.t === t || i === hi) return p.cpuMs
    const q = pts[i + 1]!
    return p.cpuMs + (q.cpuMs - p.cpuMs) * (t - p.t) / (q.t - p.t)
  }
  return (at(b.t) - at(a.t)) / dTicks
}
