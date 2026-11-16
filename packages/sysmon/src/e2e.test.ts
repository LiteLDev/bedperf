// End-to-end against a real BDS. Run with BEDPERF_E2E=1 (needs the BDS cache, see repo README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SysSample } from '@bedperf/core'
import { createProcessSampler } from './sampler.ts'
import { mainThreadCpuSeries, tickCpuMsPerTick } from './tickthread.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const PORT = 19240
const MB = 1024 * 1024

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const fmt = (s: SysSample): string =>
  `cpu=${s.cpuPct.toFixed(1)}% main=${s.mainThread ? `${s.mainThread.tid}@${(s.mainThread.util * 100).toFixed(1)}%` : '-'} ` +
  `rss=${(s.rssBytes / MB).toFixed(0)}MB priv=${((s.privateBytes ?? 0) / MB).toFixed(0)}MB h=${s.handles} thr=${s.threadCount} ` +
  `sys=${s.systemCpuPct?.toFixed(1)}% net=${s.net ? `${s.net.rxBytesPerSec}/${s.net.txBytesPerSec}B/s` : '-'} ` +
  `top=${(s.threads ?? []).map(t => `${t.tid}:${t.cpuPct.toFixed(1)}`).join(',')}`

test('sysmon samples a real BDS, idle then with 5 bots', { skip: !e2e, timeout: 240_000 }, async () => {
  // Relative import: testkit is a workspace sibling used only by this gated test, not a dependency.
  const { startTestBds, createTestBot } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: PORT })
  const bots: Array<Awaited<ReturnType<typeof createTestBot>>> = []
  const samples: SysSample[] = []
  let ended: string | undefined
  const sampler = createProcessSampler({ pid: bds.proc.pid!, onEnd: r => { ended = r } })
  try {
    await sampler.start(s => { samples.push(s); console.log(`[${samples.length}] ${fmt(s)}`) })
    await sleep(3000)
    const ovA = sampler.overhead()
    await sleep(12_500)
    const idle = samples.slice()
    assert.ok(idle.length >= 12, `idle samples: ${idle.length}`)
    const last = idle.at(-1)!
    assert.ok(last.mainThread, 'mainThread found')
    assert.ok(idle.every(s => s.mainThread === undefined || (s.mainThread.util >= 0 && s.mainThread.util <= 1)))
    const idleUtil = idle.map(s => s.mainThread?.util ?? 0)
    assert.ok(mean(idleUtil) > 0 && mean(idleUtil) <= 1, `idle util ${mean(idleUtil)}`)
    assert.ok(last.rssBytes > 50 * MB, `rss ${last.rssBytes}`)

    for (let i = 0; i < 5; i++) bots.push(await createTestBot({ port: PORT, username: `u4bot${i}` }))
    const loadedFrom = samples.length
    await sleep(15_500)
    const loaded = samples.slice(loadedFrom)
    const ovB = sampler.overhead()
    assert.ok(loaded.length >= 12, `loaded samples: ${loaded.length}`)

    const idleCpu = mean(idle.map(s => s.cpuPct))
    const loadedUtil = mean(loaded.map(s => s.mainThread?.util ?? 0))
    const loadedCpu = mean(loaded.map(s => s.cpuPct))
    const helperCpuPct = (ovB.helperCpuMs! - ovA.helperCpuMs!) / (ovB.wallMs - ovA.wallMs) * 100
    console.log(`idle:   main util ${(mean(idleUtil) * 100).toFixed(2)}%  process cpu ${idleCpu.toFixed(2)}%`)
    console.log(`5 bots: main util ${(loadedUtil * 100).toFixed(2)}%  process cpu ${loadedCpu.toFixed(2)}%`)
    console.log(`main tids: idle=${[...new Set(idle.map(s => s.mainThread?.tid))].join(',')} loaded=${[...new Set(loaded.map(s => s.mainThread?.tid))].join(',')}`)
    console.log(`sampler overhead: helper pid ${ovB.helperPid}, ${ovB.helperCpuMs} ms total CPU, ` +
      `${helperCpuPct.toFixed(2)}% of one core in steady state over ${((ovB.wallMs - ovA.wallMs) / 1000).toFixed(1)} s`)
    assert.ok(loadedUtil > mean(idleUtil), 'main-thread util rises with bots')
    assert.ok(helperCpuPct < 10, `helper overhead ${helperCpuPct}%`)
  } finally {
    for (const b of bots) b.end()
    await sampler.stop()
    await bds.stop()
  }
  const helperPid = sampler.overhead().helperPid!
  assert.throws(() => process.kill(helperPid, 0), 'helper process is gone')
  assert.equal(ended, undefined)
})

test('sysmon finds the BDS tick thread by name and tracks its cumulative CPU', { skip: !e2e, timeout: 180_000 }, async () => {
  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: PORT })
  const samples: SysSample[] = []
  const sampler = createProcessSampler({ pid: bds.proc.pid!, intervalMs: 500 })
  try {
    await sampler.start(s => samples.push(s))
    await sleep(10_500)
  } finally {
    await sampler.stop()
    await bds.stop()
  }
  assert.ok(samples.length >= 15, `samples: ${samples.length}`)
  const mts = samples.map(s => s.mainThread).filter(m => m !== undefined)
  assert.equal(mts.length, samples.length, 'every sample has a main thread')
  const last = mts.at(-1)!
  console.log(`tick thread: tid=${last.tid} name=${last.name} source=${last.source} cpuMs=${last.cpuMs}`)
  console.log(`named threads: ${[...new Set(samples.flatMap(s => (s.threads ?? []).map(t => t.name ?? '?')))].join(', ')}`)
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.ok(mts.every(m => m.source === 'name' && m.name === 'MC_SERVER'), 'selected by name MC_SERVER')
    assert.equal(new Set(mts.map(m => m.tid)).size, 1, 'one tick thread throughout')
  }
  const cpu = mainThreadCpuSeries(samples)
  assert.equal(cpu.length, samples.length)
  for (let i = 1; i < cpu.length; i++) assert.ok(cpu[i]!.cpuMs >= cpu[i - 1]!.cpuMs, `cpuMs monotonic at ${i}`)
  // No probe here: approximate the tick counter with a nominal 20 TPS wall clock. An idle BDS
  // holds 20 TPS, so this is close to the real per-tick figure.
  const t0 = samples[0]!.t
  const ticks = samples.map(s => ({ t: s.t, tick: (s.t - t0) * 20 / 1000 }))
  const perTick = tickCpuMsPerTick(cpu, ticks, t0, samples.at(-1)!.t)
  console.log(`tick-thread CPU per tick (idle, ~20 TPS): ${perTick?.toFixed(3)} ms`)
  assert.ok(perTick !== undefined && Number.isFinite(perTick) && perTick > 0 && perTick < 50, `per tick ${perTick}`)
})

test('sysmon stops by itself when the target exits', { skip: !e2e, timeout: 180_000 }, async () => {
  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: PORT })
  const samples: SysSample[] = []
  const ended = new Promise<string>(resolve => {
    const s = createProcessSampler({ pid: bds.proc.pid!, intervalMs: 500, onEnd: r => resolve(r) })
    void s.start(x => samples.push(x))
  })
  await sleep(2000)
  await bds.stop()
  assert.equal(await ended, 'exited')
  const n = samples.length
  await sleep(1500)
  assert.equal(samples.length, n, 'no samples after exit')
})
