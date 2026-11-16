import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downsample, interp, linreg, mean, median, niceTicks } from './math.ts'

test('median and mean ignore non-finite values', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), undefined)
  assert.equal(median([Number.NaN, 5]), 5)
  assert.equal(mean([1, 2, Number.NaN, 3]), 2)
  assert.equal(mean([]), undefined)
})

test('linreg recovers an exact line', () => {
  const fit = linreg([[0, 1], [10, 21], [20, 41], [30, 61]])!
  assert.ok(Math.abs(fit.slope - 2) < 1e-12)
  assert.ok(Math.abs(fit.intercept - 1) < 1e-12)
  assert.ok(Math.abs(fit.r2 - 1) < 1e-12)
  assert.equal(fit.n, 4)
})

test('linreg needs two distinct x values', () => {
  assert.equal(linreg([[1, 1]]), undefined)
  assert.equal(linreg([[1, 1], [1, 2]]), undefined)
  assert.equal(linreg([]), undefined)
})

test('interp interpolates inside the range only', () => {
  const pts: Array<[number, number]> = [[10, 100], [20, 200], [40, 300]]
  assert.equal(interp(pts, 10), 100)
  assert.equal(interp(pts, 15), 150)
  assert.equal(interp(pts, 30), 250)
  assert.equal(interp(pts, 40), 300)
  assert.equal(interp(pts, 5), undefined)
  assert.equal(interp(pts, 41), undefined)
})

test('niceTicks covers the range with round steps', () => {
  const t = niceTicks(0, 47)
  assert.equal(t.min, 0)
  assert.ok(t.max >= 47)
  assert.deepEqual(t.ticks, [0, 10, 20, 30, 40, 50])
  const big = niceTicks(1e15, 1e15 + 0.5)
  assert.ok(big.ticks.length > 1 && big.ticks.length < 20)
  const flat = niceTicks(20, 20)
  assert.ok(flat.min < 20 && flat.max > 20)
})

test('downsample keeps at most the bucket count and preserves minima', () => {
  const pts = Array.from({ length: 1000 }, (_, i): [number, number] => [i, i === 500 ? -5 : 1])
  const d = downsample(pts, 50, 'min')
  assert.ok(d.length <= 50)
  assert.ok(d.some(([, y]) => y === -5))
  assert.equal(downsample(pts.slice(0, 10), 50).length, 10)
})
