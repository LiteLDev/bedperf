import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InterferenceSample } from '@bedperf/core'
import {
  assignGroups, busyFractions, checkInterference, cpuTimesFromOs, createMachineSampler, idleCheck, parseProcStatCpus,
  peakMean, summarizeInterference, topForeign, type CpuTimes
} from './machine.ts'
import type { ProcEntry, ProcTable } from './proctable.ts'
import { createLinuxProcTable, parsePidStat } from './proctable-linux.ts'
import { parseProcTableLine, windowsProcTableScript } from './proctable-windows.ts'

const e = (pid: number, ppid: number, cpuMs = 0, start = 1, name = `p${pid}`): ProcEntry => ({ pid, ppid, cpuMs, start, name })

test('parseProcStatCpus: busy excludes idle and iowait, counts steal; fills offline CPUs', () => {
  const text = [
    'cpu  100 0 100 800 50 0 0 0 0 0',
    'cpu0 10 1 20 100 5 2 3 4 0 0',
    'cpu2 1 0 1 8 0 0 0 0',
    'intr 123'
  ].join('\n')
  const c = parseProcStatCpus(text)
  assert.equal(c.length, 3)
  assert.deepEqual(c[0], { busy: 10 + 1 + 20 + 2 + 3 + 4, total: 145 })
  assert.deepEqual(c[1], { busy: 0, total: 0 })
  assert.deepEqual(c[2], { busy: 2, total: 10 })
})

test('cpuTimesFromOs: Windows irq is already inside sys', () => {
  const list = [{ model: '', speed: 0, times: { user: 10, nice: 0, sys: 20, idle: 70, irq: 5 } }]
  assert.deepEqual(cpuTimesFromOs(list, 'win32'), [{ busy: 30, total: 100 }])
  assert.deepEqual(cpuTimesFromOs(list, 'darwin'), [{ busy: 35, total: 105 }])
})

test('busyFractions: per-CPU deltas, unclamped, zero span reads 0', () => {
  const a: CpuTimes[] = [{ busy: 0, total: 0 }, { busy: 5, total: 10 }, { busy: 1, total: 1 }]
  const b: CpuTimes[] = [{ busy: 50, total: 100 }, { busy: 5, total: 10 }, { busy: 3, total: 2 }]
  assert.deepEqual(busyFractions(a, b), [0.5, 0, 2])
})

test('assignGroups: first group wins, descendants follow, other roots are not entered', () => {
  // harness 1 -> server 10 -> 11 -> 12 ; harness 1 -> bots 20, 21 ; 1 -> 30 (harness child) ; 99 foreign
  const table = [e(1, 0), e(10, 1), e(11, 10), e(12, 11), e(20, 1), e(21, 1), e(22, 20), e(30, 1), e(99, 0)]
  const m = assignGroups(table, { server: [10], bots: [20, 21], harness: [1] })
  assert.equal(m.get(10), 'server')
  assert.equal(m.get(12), 'server')
  assert.equal(m.get(20), 'bots')
  assert.equal(m.get(22), 'bots')
  assert.equal(m.get(21), 'bots')
  assert.equal(m.get(1), 'harness')
  assert.equal(m.get(30), 'harness')
  assert.equal(m.has(99), false)
  // A root inside another group's tree still belongs to its own group.
  const m2 = assignGroups(table, { server: [1], bots: [20] })
  assert.equal(m2.get(10), 'server')
  assert.equal(m2.get(20), 'bots')
  assert.equal(m2.get(22), 'bots')
})

test('assignGroups: a reused parent pid does not adopt older orphans; absent roots still count', () => {
  const table = [e(5, 0, 0, 100), e(6, 5, 0, 50), e(7, 5, 0, 150)]
  const m = assignGroups(table, { server: [5], harness: [42] })
  assert.equal(m.has(6), false)
  assert.equal(m.get(7), 'server')
  assert.equal(m.get(42), 'harness')
})

test('topForeign: busiest first, threshold, new processes count fully, own and pid 0 skipped', () => {
  const before = new Map([e(3, 0, 1000), e(4, 0, 0), e(5, 0, 0)].map(x => [`${x.pid}:${x.start}`, x]))
  const after = [e(0, 0, 99999), e(3, 0, 3000), e(4, 0, 50), e(5, 0, 5000), e(6, 0, 2000), e(7, 0, 1), e(8, 0, 2000, 9)]
  const top = topForeign(before, after, new Set([5]), 10, 2)
  assert.deepEqual(top, [{ pid: 3, name: 'p3', cores: 0.2 }, { pid: 6, name: 'p6', cores: 0.2 }])
  assert.deepEqual(topForeign(before, after, new Set(), 10, 10, 0.01).map(r => r.pid), [5, 3, 6, 8])
})

const sample = (t: number, foreign: number, set?: number): InterferenceSample => {
  const s: InterferenceSample = {
    t, intervalMs: 1000, cpuBusy: [], busyCores: foreign, groups: { server: 0, bots: 0, harness: 0 }, foreignCores: foreign
  }
  if (set !== undefined) s.serverSetForeignCores = set
  return s
}

test('peakMean and summarizeInterference', () => {
  assert.equal(peakMean([1, 2, 3], 10), 2)
  assert.equal(peakMean([0, 0, 4, 4, 0], 2), 4)
  assert.ok(Number.isNaN(peakMean([], 10)))
  const xs = Array.from({ length: 30 }, (_, i) => sample(i, i >= 10 && i < 20 ? 2 : -0.1))
  const s = summarizeInterference(xs.reverse())
  assert.equal(s.samples, 30)
  assert.ok(Math.abs(s.foreignMean - (20 - 2) / 30) < 1e-9)
  assert.equal(s.foreignPeak10s, 2)
  assert.equal(s.serverSetForeignMean, undefined)
  assert.equal(summarizeInterference([sample(0, 1, 0.5), sample(1, 1, 1.5)]).serverSetForeignMean, 1)
})

test('checkInterference: defaults and overrides', () => {
  assert.deepEqual(checkInterference({ samples: 10, foreignMean: 0.1, foreignPeak10s: 1 }), { ok: true, reasons: [] })
  const bad = checkInterference({ samples: 10, foreignMean: 0.3, foreignPeak10s: 2, serverSetForeignMean: 0.5 })
  assert.equal(bad.ok, false)
  assert.equal(bad.reasons.length, 3)
  assert.ok(bad.reasons[0]!.includes('0.30'))
  assert.equal(checkInterference({ samples: 10, foreignMean: 0.3, foreignPeak10s: 2, serverSetForeignMean: 0.5 },
    { foreignMean: 1, foreignPeak10s: 3, serverSetForeignMean: 1 }).ok, true)
  assert.equal(checkInterference({ samples: 0, foreignMean: Number.NaN, foreignPeak10s: Number.NaN }).ok, false)
  assert.equal(checkInterference({ samples: 5, foreignMean: Number.NaN, foreignPeak10s: 0 }).ok, false)
})

/** A fake machine: 4 CPUs; each tick advances time by 1 s and every process by its rate (cores). */
function fakeMachine (procs: Array<{ pid: number, ppid: number, rate: number, name?: string }>, cpuBusy: number[]) {
  let t = 0
  const cum = new Map<number, number>()
  const cpu = cpuBusy.map(() => ({ busy: 0, total: 0 }))
  const advance = (): void => {
    t += 1000
    for (const p of procs) cum.set(p.pid, (cum.get(p.pid) ?? 0) + p.rate * 1000)
    cpuBusy.forEach((b, i) => { cpu[i]!.busy += b * 1000; cpu[i]!.total += 1000 })
  }
  const entry = (p: typeof procs[number], name: boolean): ProcEntry =>
    ({ pid: p.pid, ppid: p.ppid, cpuMs: cum.get(p.pid) ?? 0, start: 1, name: name ? (p.name ?? `p${p.pid}`) : '' })
  let scans = 0
  let closed = false
  const table: ProcTable = {
    async scan () { scans++; return procs.map(p => entry(p, true)) },
    async read (pids) { return procs.filter(p => pids.includes(p.pid)).map(p => entry(p, false)) },
    async close () { closed = true }
  }
  return {
    table,
    now: () => t,
    cpuTimes: (): CpuTimes[] => { advance(); return cpu.map(c => ({ ...c })) },
    get scans () { return scans },
    get closed () { return closed }
  }
}

test('machine sampler: groups, foreign, server-set foreign, top every topInterval', async () => {
  // 4 CPUs: busy 1.0, 1.0, 0.5, 0.25 = 2.75 cores. Server 100 (+ child 101) 1.2 cores, bots 0.3,
  // harness 0.05, foreign 900 at 1.0 core and 901 at 0.2.
  const m = fakeMachine([
    { pid: 1, ppid: 0, rate: 0.05 }, { pid: 100, ppid: 1, rate: 1.0 }, { pid: 101, ppid: 100, rate: 0.2 },
    { pid: 200, ppid: 1, rate: 0.3 }, { pid: 900, ppid: 0, rate: 1.0, name: 'av.exe' }, { pid: 901, ppid: 0, rate: 0.2 }
  ], [1, 1, 0.5, 0.25])
  const samples: InterferenceSample[] = []
  const s = createMachineSampler({
    intervalMs: 1, topIntervalMs: 3000, serverCpus: [0, 1], groups: { harness: [1], server: [100] },
    procTable: m.table, now: m.now, cpuTimes: m.cpuTimes, clock: () => 0
  })
  s.setGroup('bots', [200])
  await s.start(x => samples.push(x))
  while (samples.length < 7) await new Promise(r => setTimeout(r, 2))
  await s.stop()
  assert.equal(m.closed, true)
  const x = samples[0]!
  assert.deepEqual(x.cpuBusy, [1, 1, 0.5, 0.25])
  assert.ok(Math.abs(x.groups.server - 1.2) < 1e-9)
  assert.ok(Math.abs(x.groups.bots - 0.3) < 1e-9)
  assert.ok(Math.abs(x.groups.harness - 0.05) < 1e-9)
  assert.ok(Math.abs(x.foreignCores - 1.2) < 1e-9)
  assert.ok(Math.abs(x.serverSetForeignCores! - 0.8) < 1e-9)
  const withTop = samples.filter(y => y.top)
  assert.ok(withTop.length >= 1)
  assert.deepEqual(withTop[0]!.top, [{ pid: 900, name: 'av.exe', cores: 1 }, { pid: 901, name: 'p901', cores: 0.2 }])
})

test('machine sampler: setGroup at runtime moves a process out of foreign', async () => {
  const m = fakeMachine([{ pid: 1, ppid: 0, rate: 0 }, { pid: 50, ppid: 0, rate: 1 }], [1, 0])
  const samples: InterferenceSample[] = []
  const s = createMachineSampler({ intervalMs: 1, groups: { harness: [1] }, procTable: m.table, now: m.now, cpuTimes: m.cpuTimes })
  await s.start(x => samples.push(x))
  while (samples.length < 2) await new Promise(r => setTimeout(r, 2))
  s.setGroup('bots', [50])
  const n = samples.length
  while (samples.length < n + 3) await new Promise(r => setTimeout(r, 2))
  await s.stop()
  assert.equal(samples[0]!.foreignCores, 1)
  assert.equal(samples[0]!.serverSetForeignCores, undefined)
  const last = samples.at(-1)!
  assert.equal(last.groups.bots, 1)
  assert.equal(last.foreignCores, 0)
})

test('machine sampler: a process leaving its group is not charged its lifetime CPU in top', async () => {
  const m = fakeMachine([{ pid: 1, ppid: 0, rate: 0 }, { pid: 50, ppid: 0, rate: 0.5 }], [0.5])
  const samples: InterferenceSample[] = []
  const s = createMachineSampler({ intervalMs: 1, topIntervalMs: 2000, groups: { harness: [1], bots: [50] }, procTable: m.table, now: m.now, cpuTimes: m.cpuTimes })
  await s.start(x => samples.push(x))
  while (samples.length < 4) await new Promise(r => setTimeout(r, 2))
  s.setGroup('bots', [])
  while (!samples.some(x => x.top?.length)) await new Promise(r => setTimeout(r, 2))
  await s.stop()
  const top = samples.find(x => x.top?.length)!.top!
  assert.equal(top[0]!.pid, 50)
  assert.ok(top[0]!.cores <= 0.5 + 1e-9, `cores ${top[0]!.cores}`)
})

test('machine sampler: out-of-range serverCpus are rejected at start', async () => {
  const m = fakeMachine([], [0, 0])
  const s = createMachineSampler({ serverCpus: [1, 2], procTable: m.table, now: m.now, cpuTimes: m.cpuTimes })
  await assert.rejects(s.start(() => {}), /serverCpus 2 out of range/)
})

test('machine sampler: persistent errors end sampling via onEnd', async () => {
  const table: ProcTable = { async scan () { throw new Error('nope') }, async read () { return [] }, async close () {} }
  const err = await new Promise<Error>(resolve => {
    const s = createMachineSampler({ intervalMs: 1, procTable: table, onEnd: (_r, e) => resolve(e) })
    void s.start(() => {})
  })
  assert.equal(err.message, 'nope')
})

test('idleCheck: floors at 0, gates, and reports top over the whole check', async () => {
  const m = fakeMachine([{ pid: 1, ppid: 0, rate: 0.5 }, { pid: 7, ppid: 0, rate: 0.4, name: 'busy' }], [0.5, 0.4, 0])
  const r = await idleCheck({
    durationSec: 0.005, intervalMs: 1, serverCpus: [1, 2], harnessRoot: 1, procTable: m.table, now: m.now, cpuTimes: m.cpuTimes
  })
  assert.equal(r.summary.samples, 5)
  assert.ok(Math.abs(r.summary.foreignMean - 0.4) < 1e-9)
  assert.ok(Math.abs(r.summary.serverSetForeignMean! - 0.4) < 1e-9)
  assert.equal(r.ok, false)
  assert.equal(r.reasons.length, 2)
  assert.deepEqual(r.top.map(x => x.name), ['busy'])
  assert.equal(m.closed, true)

  const q = fakeMachine([{ pid: 1, ppid: 0, rate: 0.6 }], [0.5, 0])
  const r2 = await idleCheck({ durationSec: 0.003, intervalMs: 1, harnessRoot: 1, procTable: q.table, now: q.now, cpuTimes: q.cpuTimes })
  assert.equal(r2.summary.foreignMean, 0) // -0.1 floored
  assert.equal(r2.ok, true)
})

test('parsePidStat and the Linux process table', async () => {
  const stat = '123 (my (odd) proc) S 45 123 123 0 -1 4194304 1 0 0 0 250 50 0 0 20 0 3 0 9000 1 1'
  assert.deepEqual(parsePidStat(stat), { comm: 'my (odd) proc', ppid: 45, cpuTicks: 300, startTicks: 9000 })
  const files: Record<string, string> = { '/p/123/stat': stat, '/p/45/stat': '45 (sh) S 1 0 0 0 -1 0 0 0 0 0 1 1 0 0 0 0 1 0 10 1 1' }
  const t = createLinuxProcTable({
    procRoot: '/p',
    readdir: async () => ['123', '45', '999', 'self', 'stat'],
    readFile: async p => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v }
  })
  const all = await t.scan()
  assert.deepEqual(all.map(x => x.pid), [123, 45])
  assert.deepEqual(all[0], { pid: 123, ppid: 45, cpuMs: 3000, start: 90_000, name: 'my (odd) proc' })
  assert.deepEqual((await t.read([45, 999])).map(x => x.pid), [45])
})

test('Windows helper: script is one line, replies parse', () => {
  const script = windowsProcTableScript()
  assert.ok(!script.includes('\n'))
  assert.ok(script.includes('NtQuerySystemInformation'))
  assert.equal(parseProcTableLine('noise'), null)
  assert.deepEqual(parseProcTableLine('BPPT {"seq":3,"p":[[4,0,10,5,"System"],[8,4,2,6],"x"]}'), {
    kind: 'table', seq: 3, entries: [{ pid: 4, ppid: 0, cpuMs: 10, start: 5, name: 'System' }, { pid: 8, ppid: 4, cpuMs: 2, start: 6, name: '' }]
  })
  assert.deepEqual(parseProcTableLine('BPPT {"seq":4,"error":"boom"}'), { kind: 'error', seq: 4, message: 'boom' })
  assert.equal(parseProcTableLine('BPPT {bad')!.kind, 'error')
})

test('real platform sampler produces finite samples', { skip: process.platform !== 'win32' && process.platform !== 'linux' }, async () => {
  const samples: InterferenceSample[] = []
  const s = createMachineSampler({ intervalMs: 200 })
  await s.start(x => samples.push(x))
  const deadline = Date.now() + 30_000
  while (samples.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  await s.stop()
  assert.ok(samples.length >= 2)
  for (const x of samples) {
    assert.ok(Number.isFinite(x.foreignCores))
    assert.ok(x.cpuBusy.length > 0)
  }
})
