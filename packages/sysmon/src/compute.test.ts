import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeSample, createComputeState } from './compute.ts'
import type { RawReading } from './types.ts'

const MB = 1024 * 1024

/** Build a reading at time t (ms) with cumulative per-thread CPU ms given as [tid, ms]. */
function raw (t: number, threads: Array<[number, number]>, extra: Partial<RawReading> = {}): RawReading {
  return {
    t,
    procCpuMs: threads.reduce((a, [, ms]) => a + ms, 0),
    rssBytes: 100 * MB,
    threads: threads.map(([tid, cpuMs]) => ({ tid, cpuMs })),
    ...extra
  }
}

test('process and thread rates from deltas', () => {
  const st = createComputeState({ pid: 42, topThreads: 2 })
  const a = raw(0, [[1, 100], [2, 50], [3, 0]], { privateBytes: 5, handles: 7, net: [{ name: 'eth0', rxBytes: 1000, txBytes: 0 }], sysCpu: { busyMs: 0, totalMs: 0 } })
  const b = raw(1000, [[1, 400], [2, 150], [3, 10]], { privateBytes: 6, handles: 8, net: [{ name: 'eth0', rxBytes: 3000, txBytes: 500 }, { name: 'vpn', rxBytes: 9e9, txBytes: 9e9 }], sysCpu: { busyMs: 2000, totalMs: 8000 } })
  const s = computeSample(a, b, st)!
  assert.equal(s.pid, 42)
  assert.equal(s.t, 1000)
  assert.equal(s.intervalMs, 1000)
  assert.equal(s.cpuPct, 41) // (560 - 150) / 1000
  assert.equal(s.rssBytes, 100 * MB)
  assert.equal(s.privateBytes, 6)
  assert.equal(s.handles, 8)
  assert.equal(s.threadCount, 3)
  assert.deepEqual(s.threads, [{ tid: 1, cpuPct: 30 }, { tid: 2, cpuPct: 10 }])
  assert.deepEqual(s.mainThread, { tid: 1, cpuPct: 30, util: 0.3 })
  // 'vpn' appeared in this interval: its lifetime bytes are not a delta.
  assert.deepEqual(s.net, { rxBytesPerSec: 2000, txBytesPerSec: 500, scope: 'system' })
  assert.equal(s.systemCpuPct, 25)
})

test('multi-core process can exceed 100 %, util clamps to 1', () => {
  const st = createComputeState({ pid: 1 })
  const s = computeSample(raw(0, [[1, 0], [2, 0]]), raw(500, [[1, 600], [2, 400]]), st)!
  assert.equal(s.cpuPct, 200)
  // Thread deltas are capped to the interval (timer granularity can overshoot).
  assert.equal(s.mainThread!.tid, 1)
  assert.equal(s.mainThread!.cpuPct, 100)
  assert.equal(s.mainThread!.util, 1)
})

test('non-positive interval yields null', () => {
  const st = createComputeState({ pid: 1 })
  assert.equal(computeSample(raw(1000, [[1, 0]]), raw(1000, [[1, 5]]), st), null)
  assert.equal(computeSample(raw(1000, [[1, 0]]), raw(900, [[1, 5]]), st), null)
})

test('new thread counts its whole cumulative CPU; negative deltas never go below 0', () => {
  const st = createComputeState({ pid: 1 })
  const s = computeSample(raw(0, [[1, 500]], { procCpuMs: 500 }), raw(1000, [[1, 600], [9, 250]], { procCpuMs: 400 }), st)!
  assert.equal(s.cpuPct, 0)
  assert.deepEqual(s.threads, [{ tid: 9, cpuPct: 25 }, { tid: 1, cpuPct: 10 }])
})

test('main thread is sticky over the window and switches only on clear dominance', () => {
  const st = createComputeState({ pid: 1, mainThreadWindow: 3 })
  let cum = new Map<number, number>([[1, 0], [2, 0]])
  let t = 0
  let prev = raw(t, [...cum])
  const step = (d1: number, d2: number): number | undefined => {
    t += 1000
    cum = new Map([[1, cum.get(1)! + d1], [2, cum.get(2)! + d2]])
    const cur = raw(t, [...cum])
    const s = computeSample(prev, cur, st)!
    prev = cur
    return s.mainThread?.tid
  }
  assert.equal(step(300, 100), 1)
  assert.equal(step(300, 100), 1)
  // Thread 2 is busier for one sample, but over the 3-sample window thread 1 still leads.
  assert.equal(step(100, 400), 1) // window: 1=700, 2=600
  // Window 1=500, 2=900: thread 2 leads by > 1.25x and takes over.
  assert.equal(step(100, 400), 2)
  // Slightly busier thread 1 does not flip it back (window 1=500 vs 2=1100 ... then near-equal).
  assert.equal(step(330, 300), 2) // window 1=530, 2=1100
  assert.equal(step(330, 300), 2) // 1=760, 2=1000
  assert.equal(step(330, 300), 2) // 1=990, 2=900: 990 < 900*1.25, stays sticky
  assert.equal(step(500, 100), 1) // 1=1160, 2=700: switches
})

test('main thread switches when the incumbent disappears', () => {
  const st = createComputeState({ pid: 1 })
  const a = raw(0, [[1, 0], [2, 0]])
  const b = raw(1000, [[1, 900], [2, 10]])
  assert.equal(computeSample(a, b, st)!.mainThread!.tid, 1)
  const c = raw(2000, [[2, 20], [3, 5]])
  assert.equal(computeSample(b, c, st)!.mainThread!.tid, 2)
})

test('thread names are propagated; topThreads 0 omits threads', () => {
  const st = createComputeState({ pid: 1, topThreads: 0 })
  const a: RawReading = { t: 0, procCpuMs: 0, rssBytes: 1, threads: [{ tid: 5, name: 'Server', cpuMs: 0 }] }
  const b: RawReading = { t: 1000, procCpuMs: 200, rssBytes: 1, threads: [{ tid: 5, name: 'Server', cpuMs: 200 }] }
  const s = computeSample(a, b, st)!
  assert.equal(s.threads, undefined)
  assert.deepEqual(s.mainThread, { tid: 5, name: 'Server', cpuPct: 20, util: 0.2 })
})

test('no thread data: no mainThread/threads; missing prev net/sysCpu: omitted; counter reset clamps to 0', () => {
  const st = createComputeState({ pid: 1 })
  const s = computeSample({ t: 0, procCpuMs: 0, rssBytes: 1 }, { t: 1000, procCpuMs: 100, rssBytes: 2, net: [{ name: 'a', rxBytes: 5, txBytes: 5 }] }, st)!
  assert.equal(s.mainThread, undefined)
  assert.equal(s.threads, undefined)
  assert.equal(s.net, undefined)
  assert.equal(s.systemCpuPct, undefined)
  const r = computeSample(
    { t: 0, procCpuMs: 0, rssBytes: 1, net: [{ name: 'a', rxBytes: 100, txBytes: 100 }] },
    { t: 1000, procCpuMs: 0, rssBytes: 1, net: [{ name: 'a', rxBytes: 50, txBytes: 300 }] }, st)!
  assert.deepEqual(r.net, { rxBytesPerSec: 0, txBytesPerSec: 200, scope: 'system' })
})

test('threadCount survives a failed thread read; missing prev threads skip thread rates', () => {
  const st = createComputeState({ pid: 1 })
  const noThreads = computeSample({ t: 0, procCpuMs: 0, rssBytes: 1 }, { t: 1000, procCpuMs: 10, rssBytes: 1, threadCount: 37 }, st)!
  assert.equal(noThreads.threadCount, 37)
  // prev lacks threads (transient read failure): long-lived threads must not look new (= 100 %).
  const s = computeSample({ t: 0, procCpuMs: 0, rssBytes: 1 }, raw(1000, [[1, 50_000], [2, 70_000]]), st)!
  assert.equal(s.threadCount, 2)
  assert.equal(s.threads, undefined)
  assert.equal(s.mainThread, undefined)
  assert.equal(st.window.length, 0)
})