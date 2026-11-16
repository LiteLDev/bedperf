import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SysSample } from '@bedperf/core'
import { createProcessSampler } from './sampler.ts'
import type { Backend, BackendResult } from './types.ts'

function fakeBackend (results: Array<BackendResult | Error>): Backend & { closed: boolean, reads: number } {
  const be = {
    closed: false,
    reads: 0,
    async read (): Promise<BackendResult> {
      const r = results[be.reads++]
      if (r === undefined) return { kind: 'exited' }
      if (r instanceof Error) throw r
      return r
    },
    async close (): Promise<void> { be.closed = true }
  }
  return be
}

const reading = (t: number, cpu: number): BackendResult => ({
  kind: 'reading',
  raw: { t, procCpuMs: cpu, rssBytes: 1, threads: [{ tid: 1, cpuMs: cpu }] }
})

test('driver emits one sample per reading after the first, then stops on exit', async () => {
  const be = fakeBackend([reading(0, 0), reading(100, 50), reading(200, 60), { kind: 'exited' }, reading(300, 70)])
  const samples: SysSample[] = []
  const ended = new Promise<string>(resolve => {
    const s = createProcessSampler({ pid: 7, intervalMs: 5, backend: be, onEnd: r => resolve(r) })
    void s.start(x => samples.push(x))
  })
  assert.equal(await ended, 'exited')
  assert.equal(be.closed, true)
  assert.equal(be.reads, 4) // nothing read after exit
  assert.deepEqual(samples.map(s => s.cpuPct), [50, 10])
  assert.equal(samples[0]!.mainThread!.util, 0.5)
  assert.equal(typeof samples[0]!.systemCpuPct, 'number')
})

test('driver tolerates transient errors, reports persistent ones via onEnd', async () => {
  const be = fakeBackend([reading(0, 0), new Error('x'), reading(100, 10), new Error('a'), new Error('b'), new Error('boom')])
  const r = await new Promise<[string, Error | undefined]>(resolve => {
    const s = createProcessSampler({ pid: 7, intervalMs: 5, backend: be, onEnd: (reason, err) => resolve([reason, err]) })
    void s.start(() => {})
  })
  assert.equal(r[0], 'error')
  assert.equal(r[1]?.message, 'boom')
  assert.equal(be.closed, true)
  assert.equal(be.reads, 6)
})

test('stop() ends promptly and closes the backend without onEnd', async () => {
  let t = 0
  const be: Backend & { closed?: boolean } = {
    async read () { t += 1000; return reading(t, t / 10) },
    async close () { be.closed = true }
  }
  let ended = false
  const s = createProcessSampler({ pid: 7, intervalMs: 60_000, backend: be, onEnd: () => { ended = true } })
  await s.start(() => {})
  const t0 = Date.now()
  await s.stop()
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(be.closed, true)
  assert.equal(ended, false)
  await assert.rejects(s.start(() => {}))
})

test('windows backend samples its own process', { skip: process.platform !== 'win32' }, async () => {
  const s = createProcessSampler({ pid: process.pid, intervalMs: 300 })
  const samples: SysSample[] = []
  await s.start(x => samples.push(x))
  const busyUntil = Date.now() + 2500
  while (Date.now() < busyUntil) await new Promise(resolve => setImmediate(resolve))
  await s.stop()
  assert.ok(samples.length >= 3, `samples: ${samples.length}`)
  const last = samples.at(-1)!
  assert.equal(last.pid, process.pid)
  assert.ok(last.rssBytes > 10 * 1024 * 1024)
  assert.ok((last.threadCount ?? 0) > 1)
  assert.ok(last.mainThread !== undefined)
  assert.equal(last.net?.scope, 'system')
  const o = s.overhead()
  assert.ok(o.helperPid !== undefined && o.helperCpuMs !== undefined)
  assert.throws(() => process.kill(o.helperPid!, 0)) // helper is gone
})
