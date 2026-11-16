import { cpus } from 'node:os'
import type { Sampler, SysSample } from '@bedperf/core'
import { computeSample, createComputeState, type ComputeOptions } from './compute.ts'
import { createLinuxBackend } from './linux.ts'
import type { Backend, BackendResult, RawReading } from './types.ts'
import { createWindowsBackend } from './windows.ts'

export interface ProcessSamplerOptions extends ComputeOptions {
  intervalMs?: number
  /** Sample system-wide NIC counters (default true). */
  net?: boolean
  /**
   * Windows: collect thread names via GetThreadDescription (default true), needed to find the
   * tick thread by name (`tickThreadRule`). Names are re-read every `nameRefreshMs` (10 s).
   */
  threadNames?: boolean
  nameRefreshMs?: number
  /** Linux: per-thread CPU from task schedstat when available (default true). */
  schedstat?: boolean
  /** Linux: clock ticks per second (default 100). */
  clkTck?: number
  /** Consecutive backend read errors tolerated before giving up (default 3). */
  maxConsecutiveErrors?: number
  /**
   * Called once when sampling ends on its own: the target exited, or the backend kept failing.
   * Not called for an explicit `stop()`.
   */
  onEnd?: (reason: 'exited' | 'error', err?: Error) => void
  /** Override the platform backend (tests). */
  backend?: Backend
}

/** Sampler's own cost so far (local extension of the core `Sampler` contract). */
export interface SamplerOverhead {
  /** PID of the helper process (Windows PowerShell), if any. */
  helperPid?: number
  /** Cumulative CPU of the helper process, ms. */
  helperCpuMs?: number
  /** Wall time from `start()` until now or until sampling ended, ms. */
  wallMs: number
  samples: number
}

export interface ProcessSampler extends Sampler<SysSample> {
  overhead (): SamplerOverhead
}

/** Cumulative whole-machine CPU times summed over cores, ms. */
export function readSysCpu (): { busyMs: number, totalMs: number } {
  // On Windows libuv's `irq` (interrupt time) is already contained in `sys` (kernel time).
  const countIrq = process.platform !== 'win32'
  let busyMs = 0
  let totalMs = 0
  for (const c of cpus()) {
    const { user, nice, sys, idle, irq } = c.times
    const busy = user + nice + sys + (countIrq ? irq : 0)
    busyMs += busy
    totalMs += busy + idle
  }
  return { busyMs, totalMs }
}

export function createPlatformBackend (opts: ProcessSamplerOptions): Backend {
  const net = opts.net ?? true
  if (process.platform === 'win32') {
    const o: Parameters<typeof createWindowsBackend>[0] = { pid: opts.pid, net }
    if (opts.threadNames !== undefined) o.threadNames = opts.threadNames
    if (opts.nameRefreshMs !== undefined) o.nameRefreshMs = opts.nameRefreshMs
    return createWindowsBackend(o)
  }
  if (process.platform === 'linux') {
    const o: Parameters<typeof createLinuxBackend>[0] = { pid: opts.pid, net }
    if (opts.clkTck !== undefined) o.clkTck = opts.clkTck
    if (opts.schedstat !== undefined) o.schedstat = opts.schedstat
    return createLinuxBackend(o)
  }
  throw new Error(`sysmon: unsupported platform ${process.platform}`)
}

/** A single-use sampler: after `stop()` or after it ends on its own, create a new one. */
export function createProcessSampler (opts: ProcessSamplerOptions): ProcessSampler {
  const intervalMs = opts.intervalMs ?? 1000
  const maxErrors = Math.max(1, opts.maxConsecutiveErrors ?? 3)
  const state = createComputeState(opts)
  let backend: Backend | undefined
  let started = false
  let running = false
  let timer: NodeJS.Timeout | undefined
  let loopP: Promise<void> | undefined
  let wake: (() => void) | undefined
  let startedAt = 0
  let endedAt = 0
  let samples = 0
  let lastHelper: { pid?: number, cpuMs?: number } = {}

  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    wake = resolve
    timer = setTimeout(resolve, ms)
  })

  async function loop (be: Backend, onSample: (s: SysSample) => void): Promise<void> {
    let prev: RawReading | undefined
    let next = Date.now()
    let endReason: 'exited' | 'error' | undefined
    let endErr: Error | undefined
    let errors = 0
    while (running) {
      let res: BackendResult | undefined
      try {
        res = await be.read()
        errors = 0
      } catch (err) {
        if (!running) break
        if (++errors >= maxErrors) { endReason = 'error'; endErr = err as Error; break }
      }
      if (!running) break
      if (res?.kind === 'exited') { endReason = 'exited'; break }
      if (res) {
        const cur = res.raw
        cur.sysCpu = readSysCpu()
        if (prev) {
          const s = computeSample(prev, cur, state)
          if (s) {
            samples++
            try { onSample(s) } catch (err) { queueMicrotask(() => { throw err }) }
          }
        }
        prev = cur
      }
      next += intervalMs
      const now = Date.now()
      if (next < now) next = now // fell behind: don't burst
      await sleep(next - now)
    }
    running = false
    endedAt = Date.now()
    try { if (be.helper) lastHelper = be.helper() } catch {}
    try { await be.close() } catch {}
    if (endReason && opts.onEnd) {
      try { opts.onEnd(endReason, endErr) } catch (err) { queueMicrotask(() => { throw err }) }
    }
  }

  return {
    async start (onSample): Promise<void> {
      if (started) throw new Error('sampler already started (samplers are single-use)')
      started = true
      backend = opts.backend ?? createPlatformBackend(opts)
      running = true
      startedAt = Date.now()
      loopP = loop(backend, onSample)
    },
    async stop (): Promise<void> {
      if (!running) { await loopP; return }
      running = false
      if (timer) clearTimeout(timer)
      wake?.()
      // Closing aborts an in-flight read (e.g. a helper still starting up); close is idempotent.
      try { await backend?.close() } catch {}
      await loopP
    },
    overhead (): SamplerOverhead {
      let h = lastHelper
      if (running && backend?.helper) { try { h = backend.helper() } catch {} }
      const o: SamplerOverhead = { wallMs: startedAt ? (endedAt || Date.now()) - startedAt : 0, samples }
      if (h.pid !== undefined) o.helperPid = h.pid
      if (h.cpuMs !== undefined) o.helperCpuMs = h.cpuMs
      return o
    }
  }
}
