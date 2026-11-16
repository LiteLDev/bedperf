import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SysSample } from '@bedperf/core'
import { applyTickThreadRule, mainThreadCpuSeries, parseTickThreadRule, tickCpuMsPerTick } from './tickthread.ts'

test('parseTickThreadRule', () => {
  assert.deepEqual(parseTickThreadRule('lowest_tid_name:MC_SERVER'), { kind: 'lowest_tid_name', name: 'MC_SERVER' })
  assert.deepEqual(parseTickThreadRule('name:Server: main'), { kind: 'name', name: 'Server: main' })
  assert.deepEqual(parseTickThreadRule('busiest'), { kind: 'busiest' })
  for (const bad of ['', 'name', 'name:', 'lowest_tid_name:', 'busiest:x', 'java_main', 'foo:bar']) {
    assert.throws(() => parseTickThreadRule(bad), /bad tick thread rule/, bad)
  }
})

test('applyTickThreadRule', () => {
  const ths = [{ tid: 9, name: 'MC_SERVER' }, { tid: 3, name: 'MC_SERVER' }, { tid: 1, name: 'bedrock_server' }, { tid: 4 }]
  assert.equal(applyTickThreadRule(parseTickThreadRule('lowest_tid_name:MC_SERVER'), ths), 3)
  assert.equal(applyTickThreadRule(parseTickThreadRule('name:MC_SERVER'), ths), undefined)
  assert.equal(applyTickThreadRule(parseTickThreadRule('name:bedrock_server'), ths), 1)
  assert.equal(applyTickThreadRule(parseTickThreadRule('lowest_tid_name:nope'), ths), undefined)
  assert.equal(applyTickThreadRule(parseTickThreadRule('busiest'), ths), undefined)
})

test('tickCpuMsPerTick: interpolates CPU at tick sample times', () => {
  // Tick thread burns 500 ms CPU per 1000 ms wall (linear); server runs 20 TPS.
  const cpu = [0, 1000, 2000, 3000, 4000].map(t => ({ t, cpuMs: 10_000 + t / 2, tid: 7 }))
  // Tick observations off the CPU sampling grid: t=500 -> g=100, t=3500 -> g=160.
  const ticks = [{ t: 500, tick: 100 }, { t: 1700, tick: 124 }, { t: 3500, tick: 160 }]
  // CPU(3500) - CPU(500) = 1500 ms over 60 ticks = 25 ms/tick.
  assert.equal(tickCpuMsPerTick(cpu, ticks, 0, 4000), 25)
  // Window picks only the observations inside it: 1700..3500, 900 ms / 36 ticks.
  assert.equal(tickCpuMsPerTick(cpu, ticks, 1000, 4000), 25)
  // Unsorted input is fine.
  assert.equal(tickCpuMsPerTick([...cpu].reverse(), [...ticks].reverse(), 0, 4000), 25)
})

test('tickCpuMsPerTick: exact sample hits and non-linear CPU', () => {
  const cpu = [{ t: 0, cpuMs: 0 }, { t: 1000, cpuMs: 100 }, { t: 2000, cpuMs: 700 }]
  assert.equal(tickCpuMsPerTick(cpu, [{ t: 1000, tick: 0 }, { t: 2000, tick: 20 }], 0, 2000), 30)
  // t=1500 interpolates to 400.
  assert.equal(tickCpuMsPerTick(cpu, [{ t: 0, tick: 0 }, { t: 1500, tick: 10 }], 0, 2000), 40)
})

test('tickCpuMsPerTick: undefined when data is insufficient or the thread changes', () => {
  const cpu = [0, 1000, 2000, 3000].map(t => ({ t, cpuMs: t / 2, tid: 7 }))
  const ticks = [{ t: 500, tick: 0 }, { t: 2500, tick: 40 }]
  assert.equal(tickCpuMsPerTick(cpu, ticks, 0, 3000), 25)
  // One tick sample in window.
  assert.equal(tickCpuMsPerTick(cpu, ticks, 1000, 3000), undefined)
  // Tick counter reset inside the window.
  assert.equal(tickCpuMsPerTick(cpu, [{ t: 500, tick: 1000 }, { t: 1500, tick: 5 }, { t: 2500, tick: 1040 }], 0, 3000), undefined)
  // No tick progress.
  assert.equal(tickCpuMsPerTick(cpu, [{ t: 500, tick: 5 }, { t: 2500, tick: 5 }], 0, 3000), undefined)
  // CPU series does not cover the tick span (no extrapolation).
  assert.equal(tickCpuMsPerTick(cpu.slice(1), ticks, 0, 3000), undefined)
  assert.equal(tickCpuMsPerTick(cpu.slice(0, 2), ticks, 0, 3000), undefined)
  assert.equal(tickCpuMsPerTick([], ticks, 0, 3000), undefined)
  // Tid change inside the bracketing samples.
  const switched = cpu.map(p => p.t === 2000 ? { ...p, tid: 8 } : p)
  assert.equal(tickCpuMsPerTick(switched, ticks, 0, 3000), undefined)
  // ...but a change outside the used span does not matter.
  const outside = [...cpu, { t: 4000, cpuMs: 5, tid: 9 }]
  assert.equal(tickCpuMsPerTick(outside, ticks, 0, 3000), 25)
  // CPU going backwards (e.g. reused tid) is rejected.
  const back = cpu.map(p => p.t === 3000 ? { ...p, cpuMs: 0 } : p)
  assert.equal(tickCpuMsPerTick(back, ticks, 0, 3000), undefined)
})

test('mainThreadCpuSeries keeps samples with cpuMs', () => {
  const s = (t: number, mt?: SysSample['mainThread']): SysSample => {
    const o: SysSample = { pid: 1, t, intervalMs: 1000, cpuPct: 0, rssBytes: 0 }
    if (mt) o.mainThread = mt
    return o
  }
  assert.deepEqual(mainThreadCpuSeries([
    s(1000, { tid: 3, cpuPct: 0, util: 0, cpuMs: 5 }),
    s(2000),
    s(3000, { tid: 3, cpuPct: 0, util: 0 }),
    s(4000, { tid: 4, cpuPct: 0, util: 0, source: 'name', cpuMs: 9 })
  ]), [{ t: 1000, cpuMs: 5, tid: 3 }, { t: 4000, cpuMs: 9, tid: 4 }])
})
