import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarize, encodeProbeLine, parseProbeLine, type ProbeSample } from './index.ts'

test('percentile interpolates like numpy', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
  assert.equal(percentile([5], 99), 5)
  assert.ok(Number.isNaN(percentile([], 50)))
  assert.equal(percentile([10, 0], 100), 10)
})

test('summarize ignores non-finite values', () => {
  const s = summarize([1, 2, Number.NaN, 3])
  assert.equal(s.n, 3)
  assert.equal(s.mean, 2)
  assert.equal(s.min, 1)
  assert.equal(s.max, 3)
})

test('probe line round-trips even with a BDS log prefix', () => {
  const rec: ProbeSample = {
    type: 'sample', v: 1, tick: 100, t: 1, windowMs: 1000, ticks: 20, tps: 20,
    interval: { mean: 50, max: 52, p50: 50, p95: 51, p99: 52 }, over50: 3, over100: 0, players: 2
  }
  const line = `[2026-11-16 10:00:00:000 INFO] [Scripting] ${encodeProbeLine(rec)}`
  assert.deepEqual(parseProbeLine(line), rec)
  assert.equal(parseProbeLine('[INFO] Server started.'), undefined)
  assert.equal(parseProbeLine('BEDPERF|{not json'), undefined)
  assert.equal(parseProbeLine('BEDPERF|{"type":"other"}'), undefined)
})
