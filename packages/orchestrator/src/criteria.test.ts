import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CRITERIA, type BotFleetStats, type ProbeSample, type SysSample } from '@bedperf/core'
import { LOADGEN_SATURATED_REASON, evaluateStep, poolQuantiles, poolSummaries, stepOutcome, type MeasuredWindow } from './criteria.ts'

function sample (tps: number, opts: { p99?: number, max?: number, t?: number } = {}): ProbeSample {
  const mean = 1000 / tps
  return {
    type: 'sample', v: 1, tick: 0, t: opts.t ?? 0, windowMs: 1000, ticks: Math.round(tps), tps,
    interval: { mean, p50: mean, p95: mean * 1.05, p99: opts.p99 ?? mean * 1.1, max: opts.max ?? mean * 1.2 },
    over50: 1, over100: 0, players: 10
  }
}

function sys (util?: number): SysSample {
  const s: SysSample = { pid: 1, t: 0, intervalMs: 1000, cpuPct: 50, rssBytes: 1e9, net: { rxBytesPerSec: 100, txBytesPerSec: 200, scope: 'process' } }
  if (util !== undefined) s.mainThread = { tid: 1, cpuPct: util * 100, util }
  return s
}

function bots (opts: { joinFailures?: number, disc?: number, saturated?: boolean, spawned?: number, rtt?: number } = {}): BotFleetStats {
  const s: BotFleetStats = {
    t: 0, target: 10, connected: 10, spawned: opts.spawned ?? 10,
    joinFailures: opts.joinFailures ?? 0, unexpectedDisconnects: opts.disc ?? 0,
    loadgen: { workers: 1, eventLoopLagP99Ms: 1, maxWorkerCpuPct: 10, saturated: opts.saturated ?? false }
  }
  if (opts.rtt !== undefined) s.rttMs = { n: 10, min: opts.rtt, max: opts.rtt * 2, mean: opts.rtt, p50: opts.rtt, p95: opts.rtt * 1.5, p99: opts.rtt * 1.9 }
  return s
}

function win (over: Partial<MeasuredWindow> = {}): MeasuredWindow {
  return {
    probe: Array.from({ length: 60 }, () => sample(20)),
    sys: Array.from({ length: 60 }, () => sys(0.5)),
    bots: [bots(), bots()],
    ...over
  }
}

test('healthy window passes with aggregates', () => {
  const r = evaluateStep(win({ players: 10 }), DEFAULT_CRITERIA)
  assert.equal(r.pass, true, r.failReasons.join())
  assert.deepEqual(r.failReasons, [])
  assert.equal(r.tps.n, 60)
  assert.equal(r.tps.mean, 20)
  assert.equal(r.tickIntervalMs.n, 1200)
  assert.equal(r.tickIntervalMs.mean, 50)
  assert.equal(r.tickIntervalMs.max, 60)
  assert.ok(r.tickIntervalMs.p99 > 50 && r.tickIntervalMs.p99 <= 60)
  assert.equal(r.over50, 60)
  assert.equal(r.over100, 0)
  assert.equal(r.mainThreadUtil?.mean, 0.5)
  assert.equal(r.cpuPct?.mean, 50)
  assert.equal(r.rssBytes?.mean, 1e9)
  assert.equal(r.netRxBytesPerSec, 100)
  assert.equal(r.netTxBytesPerSec, 200)
  assert.equal(r.botFailures, 0)
  assert.equal(r.loadgenSaturated, false)
  assert.equal(stepOutcome(r), 'pass')
})

test('low average TPS fails', () => {
  const r = evaluateStep(win({ probe: Array.from({ length: 60 }, () => sample(19.7)) }), DEFAULT_CRITERIA)
  assert.equal(r.pass, false)
  assert.ok(r.failReasons.some(x => x.startsWith('avg TPS 19.70 < 19.8')), r.failReasons.join())
  assert.equal(stepOutcome(r), 'fail')
})

test('worst-window TPS: discards the worst X % of windows', () => {
  // 200 windows: 2 bad ones = 1 %, both discarded at 1 %.
  const probe = [...Array.from({ length: 198 }, () => sample(20)), sample(15), sample(16)]
  const c = { ...DEFAULT_CRITERIA, minAvgTps: 19 }
  assert.equal(evaluateStep(win({ probe }), c).pass, true)
  // 3 bad windows: one survives the discard.
  const probe3 = [...probe.slice(1), sample(17), sample(18)].slice(0, 200)
  const r = evaluateStep(win({ probe: [...probe3, sample(18.5)] }), c)
  assert.equal(r.pass, false)
  assert.ok(r.failReasons.some(x => x.startsWith('worst-window TPS')), r.failReasons.join())
  // With 60 windows, 1 % discards nothing.
  const r60 = evaluateStep(win({ probe: [...Array.from({ length: 59 }, () => sample(20)), sample(18.9)] }), DEFAULT_CRITERIA)
  assert.ok(r60.failReasons.some(x => x.includes('worst-window TPS 18.90') && x.includes('discarding 0 of 60')), r60.failReasons.join())
  assert.equal(r60.failReasons.length, 1, 'avg is still fine')
})

test('discard pct never discards every window', () => {
  const r = evaluateStep(win({ probe: [sample(10)] }), { ...DEFAULT_CRITERIA, worstWindowDiscardPct: 99 })
  assert.ok(r.failReasons.some(x => x.startsWith('worst-window TPS 10.00')))
})

test('tick interval p99 above the limit fails', () => {
  const probe = Array.from({ length: 60 }, () => sample(20, { p99: 120, max: 150 }))
  const r = evaluateStep(win({ probe }), DEFAULT_CRITERIA)
  assert.equal(r.pass, false)
  assert.ok(r.failReasons.some(x => /^tick interval p99 \d+(\.\d)? ms > 80 ms$/.test(x)), r.failReasons.join())
  assert.equal(r.tickIntervalMs.max, 150)
})

test('a few spiky windows do not dominate pooled p99', () => {
  const probe = [...Array.from({ length: 99 }, () => sample(20)), sample(20, { p99: 500, max: 600 })]
  const r = evaluateStep(win({ probe }), DEFAULT_CRITERIA)
  assert.ok(r.tickIntervalMs.p99 <= 60, `p99 ${r.tickIntervalMs.p99}`)
  assert.equal(r.tickIntervalMs.max, 600)
})

test('main-thread util ceiling is optional', () => {
  const w = win({ sys: [sys(0.95), sys(0.97)] })
  assert.equal(evaluateStep(w, DEFAULT_CRITERIA).pass, true)
  const r = evaluateStep(w, { ...DEFAULT_CRITERIA, maxMainThreadUtil: 0.9 })
  assert.equal(r.pass, false)
  assert.ok(r.failReasons.some(x => x.startsWith('main-thread util 0.960 > 0.9')), r.failReasons.join())
  const missing = evaluateStep(win({ sys: [sys()] }), { ...DEFAULT_CRITERIA, maxMainThreadUtil: 0.9 })
  assert.ok(missing.failReasons.includes('no main-thread utilisation data in window'))
  assert.equal(missing.mainThreadUtil, undefined)
})

test('no sys samples: optional aggregates are absent', () => {
  const r = evaluateStep(win({ sys: [] }), DEFAULT_CRITERIA)
  assert.equal(r.pass, true)
  assert.equal(r.cpuPct, undefined)
  assert.equal(r.rssBytes, undefined)
  assert.equal(r.netRxBytesPerSec, undefined)
})

test('bot failures are a delta against the baseline', () => {
  const base = bots({ joinFailures: 3, disc: 1 })
  assert.equal(evaluateStep(win({ botBaseline: base, bots: [bots({ joinFailures: 3, disc: 1 })] }), DEFAULT_CRITERIA).pass, true)
  const r = evaluateStep(win({ botBaseline: base, bots: [bots({ joinFailures: 3, disc: 1 }), bots({ joinFailures: 4, disc: 2 })] }), DEFAULT_CRITERIA)
  assert.equal(r.botFailures, 2)
  assert.ok(r.failReasons.includes('bot failures 2 > 0'))
  assert.equal(evaluateStep(win({ botBaseline: base, bots: [bots({ joinFailures: 4, disc: 2 })] }), { ...DEFAULT_CRITERIA, maxBotFailures: 2 }).pass, true)
  // Without a baseline the first record of the window is the baseline.
  assert.equal(evaluateStep(win({ bots: [bots({ joinFailures: 5 }), bots({ joinFailures: 6 })] }), DEFAULT_CRITERIA).botFailures, 1)
})

test('fleet below target fails', () => {
  const r = evaluateStep(win({ players: 10, bots: [bots({ spawned: 8 })] }), DEFAULT_CRITERIA)
  assert.ok(r.failReasons.includes('only 8/10 bots spawned'))
})

test('missing probe data fails with a reason', () => {
  const r = evaluateStep(win({ probe: [] }), DEFAULT_CRITERIA)
  assert.equal(r.pass, false)
  assert.deepEqual(r.failReasons, ['no probe data in window'])
  assert.equal(r.tps.n, 0)
  assert.ok(Number.isNaN(r.tps.mean))
})

test('missing bot stats fails with a reason', () => {
  const r = evaluateStep(win({ bots: [] }), DEFAULT_CRITERIA)
  assert.deepEqual(r.failReasons, ['no bot stats in window'])
})

test('loadgen saturation marks the step invalid', () => {
  const r = evaluateStep(win({ bots: [bots(), bots({ saturated: true })] }), DEFAULT_CRITERIA)
  assert.equal(r.pass, false)
  assert.equal(r.loadgenSaturated, true)
  assert.equal(r.failReasons[0], LOADGEN_SATURATED_REASON)
  assert.equal(stepOutcome(r), 'invalid')
  // Other violations are still reported, but the outcome stays invalid.
  const r2 = evaluateStep(win({ probe: [sample(10)], bots: [bots({ saturated: true })] }), DEFAULT_CRITERIA)
  assert.equal(stepOutcome(r2), 'invalid')
  assert.ok(r2.failReasons.length > 1)
})

test('rtt summaries are pooled', () => {
  const r = evaluateStep(win({ bots: [bots({ rtt: 50 }), bots({ rtt: 150 })] }), DEFAULT_CRITERIA)
  assert.equal(r.rttMs?.n, 20)
  assert.equal(r.rttMs?.mean, 100)
  assert.equal(r.rttMs?.min, 50)
  assert.equal(r.rttMs?.max, 300)
  assert.ok(r.rttMs!.p50 >= 50 && r.rttMs!.p50 <= 150)
  assert.equal(evaluateStep(win(), DEFAULT_CRITERIA).rttMs, undefined)
})

test('poolQuantiles reproduces window quantiles', () => {
  const pts = poolQuantiles([{ n: 21, p50: 50, p95: 55, p99: 60, max: 70 }])
  assert.equal(pts.length, 21)
  assert.equal(pts.at(-1), 70)
  assert.equal(pts[10], 50)
  assert.deepEqual(poolQuantiles([{ n: 0, p50: 1, p95: 1, p99: 1, max: 1 }]), [])
  assert.equal(poolSummaries([]), undefined)
})

test('evaluateStep is pure', () => {
  const w = win()
  const snapshot = structuredClone(w)
  evaluateStep(w, DEFAULT_CRITERIA)
  assert.deepEqual(w, snapshot)
  assert.deepEqual(evaluateStep(w, DEFAULT_CRITERIA), evaluateStep(w, DEFAULT_CRITERIA))
})
