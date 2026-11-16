// Unit tests for the pack's pure JS logic, checked against core's probe contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROBE_LINE_PREFIX, parseProbeLine, percentileSorted as corePercentile, type ProbeMark, type ProbePong, type ProbeSample } from '@bedperf/core'
import {
  PROBE_LINE_PREFIX as JS_PREFIX, PROBE_INFO_PREFIX, Probe, TickWindow, countEntities, encodeProbeLine, parseConfig,
  percentileSorted, DEFAULT_CONFIG, type ProbeEnv
} from '../pack/scripts/probe-core.js'

const SAMPLE_KEYS = ['type', 'v', 'tick', 't', 'windowMs', 'ticks', 'tps', 'interval', 'over50', 'over100', 'players']
const INTERVAL_KEYS = ['mean', 'max', 'p50', 'p95', 'p99']

function assertSampleShape (r: ProbeSample): void {
  const keys = Object.keys(r).filter(k => k !== 'entities')
  assert.deepEqual(keys.sort(), [...SAMPLE_KEYS].sort())
  assert.deepEqual(Object.keys(r.interval).sort(), [...INTERVAL_KEYS].sort())
  for (const k of ['tick', 't', 'windowMs', 'ticks', 'tps', 'over50', 'over100', 'players'] as const) {
    assert.equal(typeof r[k], 'number', k)
  }
  for (const k of INTERVAL_KEYS) assert.equal(typeof (r.interval as unknown as Record<string, unknown>)[k], 'number', k)
  if (r.entities) {
    assert.deepEqual(Object.keys(r.entities).sort(), ['byDimension', 'topTypes', 'total'])
    assert.equal(typeof r.entities.total, 'number')
  }
}

interface FakeEnv extends ProbeEnv {
  clock: number
  tickNo: number
  lines: string[]
  entityCost: number
}

function fakeEnv (): FakeEnv {
  const env: FakeEnv = {
    clock: 1_000_000,
    tickNo: 0,
    lines: [],
    entityCost: 0,
    now: () => env.clock,
    currentTick: () => env.tickNo,
    playerCount: () => 3,
    dimensions: () => [
      {
        id: 'overworld',
        dimension: {
          getEntities: () => {
            env.clock += env.entityCost
            return [{ typeId: 'minecraft:player' }, { typeId: 'minecraft:cow' }, { typeId: 'minecraft:cow' }]
          }
        }
      },
      { id: 'nether', dimension: { getEntities: () => [] } },
      { id: 'the_end', dimension: { getEntities: () => { throw new Error('unloaded') } } }
    ],
    log: l => { env.lines.push(l) }
  }
  return env
}

/** Advance `n` ticks of `dt` ms each. */
function run (probe: Probe, env: FakeEnv, n: number, dt: number | ((i: number) => number)): void {
  for (let i = 0; i < n; i++) {
    env.clock += typeof dt === 'number' ? dt : dt(i)
    env.tickNo++
    probe.onTick()
  }
}

test('prefix matches core', () => {
  assert.equal(JS_PREFIX, PROBE_LINE_PREFIX)
  assert.ok(!PROBE_INFO_PREFIX.includes(PROBE_LINE_PREFIX))
})

test('percentile matches core', () => {
  const xs = [50, 49, 51, 50, 120, 50, 48, 52]
  const sorted = [...xs].sort((a, b) => a - b)
  for (const p of [0, 1, 50, 95, 99, 100]) {
    assert.equal(percentileSorted(Float64Array.from(sorted), p), corePercentile(sorted, p))
  }
})

test('steady 20 TPS produces ~1 s samples that parse with core', () => {
  const env = fakeEnv()
  const probe = new Probe(env)
  run(probe, env, 1 + 20 * 12, 50)
  const recs = env.lines.map(l => parseProbeLine('[2026-11-16 16:15:28:495 INFO] [Scripting] ' + l))
  assert.equal(recs.length, 12)
  for (const r of recs) {
    assert.ok(r && r.type === 'sample')
    assertSampleShape(r)
    assert.equal(r.v, 1)
    assert.equal(r.ticks, 20)
    assert.equal(r.windowMs, 1000)
    assert.equal(r.tps, 20)
    assert.deepEqual(r.interval, { mean: 50, max: 50, p50: 50, p95: 50, p99: 50 })
    assert.equal(r.over50, 0)
    assert.equal(r.players, 3)
  }
  // entities every 5th window
  const withEntities = recs.flatMap((r, i) => r?.type === 'sample' && r.entities ? [i] : [])
  assert.deepEqual(withEntities, [4, 9])
  const e = (recs[4] as ProbeSample).entities!
  assert.deepEqual(e, { total: 3, byDimension: { overworld: 3, nether: 0 }, topTypes: { 'minecraft:cow': 2, 'minecraft:player': 1 } })
})

test('lag spikes show in interval stats and over50/over100', () => {
  const env = fakeEnv()
  const probe = new Probe(env, { entityEvery: 0 })
  run(probe, env, 1, 0)
  // 10 normal ticks, one 70 ms, one 150 ms, then normal until the window closes
  run(probe, env, 10, 50)
  run(probe, env, 1, 70)
  run(probe, env, 1, 150)
  run(probe, env, 20, 50)
  const r = parseProbeLine(env.lines[0]!) as ProbeSample
  assertSampleShape(r)
  assert.equal(r.over50, 2)
  assert.equal(r.over100, 1)
  assert.equal(r.interval.max, 150)
  assert.equal(r.ticks, 18) // 10*50 + 70 + 150 + 6*50 = 1020 >= 1000
  assert.equal(r.windowMs, 1020)
  assert.equal(r.tps, Math.round(18 / 1.02 * 1000) / 1000)
  assert.equal(r.entities, undefined)
})

test('TickWindow keeps aggregates past capacity', () => {
  const w = new TickWindow(4)
  w.tick(0)
  for (let i = 1; i <= 10; i++) w.tick(i * 50)
  const s = w.flush(10, 0)
  assert.equal(s.ticks, 10)
  assert.equal(s.windowMs, 500)
  assert.equal(s.interval.mean, 50)
})

test('mark, ping and info', () => {
  const env = fakeEnv()
  const probe = new Probe(env)
  env.tickNo = 77
  assert.equal(probe.onScriptEvent('bedperf:mark', ' hello world '), undefined)
  assert.equal(probe.onScriptEvent('bedperf:ping', 'abc'), 'abc')
  const mark = parseProbeLine(env.lines[0]!) as ProbeMark
  const pong = parseProbeLine(env.lines[1]!) as ProbePong
  assert.deepEqual(mark, { type: 'mark', v: 1, tick: 77, t: env.clock, label: 'hello world' })
  assert.deepEqual(pong, { type: 'pong', v: 1, tick: 77, t: env.clock, id: 'abc' })
  assert.equal(encodeProbeLine(mark), env.lines[0])
  probe.onScriptEvent('bedperf:info', '')
  assert.ok(env.lines[2]!.startsWith(PROBE_INFO_PREFIX))
  assert.equal(parseProbeLine(env.lines[2]!), undefined)
  assert.equal(probe.onScriptEvent('other:thing', 'x'), undefined)
})

test('config at runtime', () => {
  const env = fakeEnv()
  const probe = new Probe(env)
  probe.onScriptEvent('bedperf:config', '{"windowMs":500,"entityEvery":1}')
  assert.equal(probe.config.windowMs, 500)
  env.lines.length = 0
  run(probe, env, 1 + 20, 50)
  const recs = env.lines.map(l => parseProbeLine(l) as ProbeSample)
  assert.equal(recs.length, 2)
  assert.ok(recs.every(r => r.windowMs === 500 && r.entities))
  // invalid config keeps the old one and reports the error
  probe.onScriptEvent('bedperf:config', '{"windowMs":5}')
  assert.equal(probe.config.windowMs, 500)
  assert.match(env.lines.at(-1)!, /config-error/)
})

test('parseConfig validation', () => {
  assert.deepEqual(parseConfig('{}', DEFAULT_CONFIG), { ...DEFAULT_CONFIG })
  assert.deepEqual(parseConfig('{"entityEvery":0}', DEFAULT_CONFIG), { ...DEFAULT_CONFIG, entityEvery: 0 })
  assert.throws(() => parseConfig('[]', DEFAULT_CONFIG))
  assert.throws(() => parseConfig('{"windowMs":1.5}', DEFAULT_CONFIG))
  assert.throws(() => parseConfig('{"foo":1}', DEFAULT_CONFIG))
  assert.throws(() => parseConfig('nope', DEFAULT_CONFIG))
})

test('slow entity scans back off', () => {
  const env = fakeEnv()
  env.entityCost = 50 // > default 10 ms budget
  const probe = new Probe(env, { entityEvery: 1 })
  run(probe, env, 1 + 20 * 8, 50)
  const samples = env.lines.map(l => parseProbeLine(l)).filter((r): r is ProbeSample => r?.type === 'sample')
  const idx = samples.flatMap((r, i) => r.entities ? [i] : [])
  // period doubles after each over-budget scan: windows 0, 2, 6
  assert.deepEqual(idx, [0, 2, 6])
  assert.equal(probe.maxScanMs, 50)
  assert.ok(env.lines.some(l => l.includes('entity-backoff')))
})

test('backoff recovers once scans are cheap again', () => {
  const env = fakeEnv()
  env.entityCost = 50
  const probe = new Probe(env, { entityEvery: 1 })
  run(probe, env, 1 + 20, 50) // one slow scan -> backoff 2
  assert.equal(probe.backoff, 2)
  env.entityCost = 0
  run(probe, env, 20 * 3, 50)
  assert.equal(probe.backoff, 1)
})

test('wall clock stepping backwards keeps windows consistent', () => {
  const w = new TickWindow()
  w.tick(10_000)
  for (let i = 1; i <= 10; i++) w.tick(10_000 + i * 50)
  w.tick(5_000) // clock jumps back 5.5 s
  let elapsed = 0
  for (let i = 1; i <= 10; i++) elapsed = w.tick(5_000 + i * 50)
  assert.equal(elapsed, 1000)
  const s = w.flush(0, 0)
  assert.equal(s.windowMs, 1000)
  assert.equal(s.ticks, 21)
})

test('countEntities caps topTypes at 10', () => {
  const list = Array.from({ length: 15 }, (_, i) => Array.from({ length: i + 1 }, () => ({ typeId: `t${i}` }))).flat()
  const e = countEntities([{ id: 'overworld', dimension: { getEntities: () => list } }])
  assert.equal(Object.keys(e.topTypes).length, 10)
  assert.equal(e.topTypes.t14, 15)
  assert.equal(e.topTypes.t4, undefined)
  assert.equal(e.total, 120)
})
