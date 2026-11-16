import { test } from 'node:test'
import assert from 'node:assert/strict'
import { botRandom, botSeed, isSampled, mulberry32 } from './rng.ts'

const take = (f: () => number, n: number): number[] => Array.from({ length: n }, () => f())

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = take(mulberry32(42), 1000)
  assert.deepEqual(a, take(mulberry32(42), 1000))
  assert.ok(a.every(x => x >= 0 && x < 1))
  assert.notDeepEqual(a.slice(0, 10), take(mulberry32(43), 10))
  const mean = a.reduce((s, x) => s + x, 0) / a.length
  assert.ok(Math.abs(mean - 0.5) < 0.05)
})

test('botRandom: same (seed, index) → same stream; different index or seed → different stream', () => {
  assert.deepEqual(take(botRandom(7, 3), 20), take(botRandom(7, 3), 20))
  assert.notDeepEqual(take(botRandom(7, 3), 5), take(botRandom(7, 4), 5))
  assert.notDeepEqual(take(botRandom(7, 3), 5), take(botRandom(8, 3), 5))
  const seeds = new Set(Array.from({ length: 1000 }, (_, i) => botSeed(1, i)))
  assert.equal(seeds.size, 1000)
})

test('isSampled selects an evenly spread fraction including bot 0', () => {
  const pick = (r: number, n: number): number[] => Array.from({ length: n }, (_, i) => i).filter(i => isSampled(i, r))
  assert.deepEqual(pick(0.1, 30), [0, 10, 20])
  assert.equal(pick(0.25, 100).length, 25)
  assert.deepEqual(pick(0, 10), [])
  assert.equal(pick(1, 10).length, 10)
  assert.deepEqual(pick(0.1, 5), [0])
})
