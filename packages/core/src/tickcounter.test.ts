import { test } from 'node:test'
import assert from 'node:assert/strict'
import { counterTps, lowTps, maxGap, latencySummary, monotonic, Kinds, type GametimeSample } from './index.ts'

/** Replies at `times` (ms) with the counter at `rate` ticks/s from 0, latency 2 ms. */
function series (times: number[], rate = 20): GametimeSample[] {
  return times.map(t => ({ t, sentAt: t - 2, gametime: Math.round(t / 1000 * rate), latencyMs: 2 }))
}

const sample = (t: number, gametime: number, latencyMs = 1): GametimeSample => ({ t, sentAt: t - latencyMs, gametime, latencyMs })

test('counterTps uses the first and last reply inside the window', () => {
  const s = series([0, 5000, 10_000, 15_000, 20_000])
  assert.equal(counterTps(s, 0, 20_000), 20)
  // Order of input does not matter.
  assert.equal(counterTps([...s].reverse(), 0, 20_000), 20)
  // Replies outside the window are ignored: [5000, 15000] covers 10 s of a 10.5 s window.
  assert.equal(counterTps([sample(5000, 100), sample(10_000, 150), sample(15_000, 250), sample(16_000, 99_999)], 4900, 15_400), 15)
})

test('counterTps is undefined below 90 % coverage or with too few replies', () => {
  const s = series([0, 5000, 10_000])
  assert.equal(counterTps(s, 0, 10_000), 20)
  assert.equal(counterTps(s, 0, 11_200), undefined) // 10 / 11.2 < 0.9
  assert.equal(counterTps(s, 0, 11_000), 20) // 10 / 11 >= 0.9
  assert.equal(counterTps(s, 0, 11_200, 0.5), 20)
  assert.equal(counterTps(series([1000]), 0, 1100), undefined)
  assert.equal(counterTps([], 0, 1000), undefined)
  assert.equal(counterTps(s, 10_000, 0), undefined)
  // Two replies at the same instant span nothing.
  assert.equal(counterTps([sample(1000, 1), sample(1000, 2)], 1000, 1000.5, 0), undefined)
})

test('counterTps does not clamp jittered readings above 20', () => {
  // 100 ticks in 4.9 s of reply time (the second reply came back early).
  const v = counterTps([sample(0, 0), sample(4900, 100)], 0, 5000)
  assert.ok(v !== undefined && v > 20)
})

test('lowTps finds the slowest stretch of at least minSpan', () => {
  // 20 TPS except one 5 s stretch at 10 TPS.
  const s = [sample(0, 0), sample(5000, 100), sample(10_000, 150), sample(15_000, 250), sample(20_000, 350)]
  assert.equal(lowTps(s), 10)
  // With 1 s replies, a 4.5 s minimum span takes 5 replies.
  const fine = series([0, 1000, 2000, 3000, 4000, 5000, 6000])
  assert.equal(lowTps(fine), 20)
  // Spans shorter than minSpan are never used on their own.
  assert.equal(lowTps([sample(0, 0), sample(4000, 0)]), undefined)
  assert.equal(lowTps([sample(0, 0), sample(4000, 0)], 4), 0)
  assert.equal(lowTps([]), undefined)
  // A long single span still counts.
  assert.equal(lowTps([sample(0, 0), sample(10_000, 150)]), 15)
})

test('maxGap counts from t0 and up to t1', () => {
  const s = series([1000, 2000, 6000])
  assert.equal(maxGap(s, 0, 7000), 4000)
  assert.equal(maxGap(s, 0, 20_000), 14_000)
  assert.equal(maxGap(s, 1500, 2500), 500)
  assert.equal(maxGap([], 0, 5000), 5000)
  assert.equal(maxGap(s, 5000, 5000), 0)
})

test('latencySummary', () => {
  const s = [1, 2, 3, 4, 100].map((l, i) => sample(i * 1000, i * 20, l))
  const l = latencySummary(s)
  assert.equal(l.n, 5)
  assert.equal(l.p50, 3)
  assert.equal(l.max, 100)
  assert.ok(l.p99 > 90 && l.p99 <= 100)
  const e = latencySummary([])
  assert.equal(e.n, 0)
  assert.ok(Number.isNaN(e.p50))
})

test('monotonic', () => {
  assert.equal(monotonic(series([0, 1000, 2000])), true)
  assert.equal(monotonic([sample(0, 5), sample(1000, 5)]), true)
  assert.equal(monotonic([sample(0, 5), sample(1000, 4)]), false)
  // Judged in receive order, not input order.
  assert.equal(monotonic([sample(1000, 6), sample(0, 5)]), true)
  assert.equal(monotonic([]), true)
})

test('bds.gametime envelope kind', () => {
  assert.equal(Kinds.bdsGametime, 'bds.gametime')
})
