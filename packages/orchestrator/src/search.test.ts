import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StepOutcome } from './criteria.ts'
import { planNext, type SearchDone, type SearchState, type SearchStep } from './search.ts'

type Ramp = SearchState['ramp']

/** Drive planNext against an oracle until done. */
function drive (ramp: Ramp, oracle: (players: number, attempt: number) => StepOutcome, limit = 200): { done: SearchDone, steps: Array<SearchStep & { phase: string }> } {
  const history: SearchStep[] = []
  const steps: Array<SearchStep & { phase: string }> = []
  const attempts = new Map<number, number>()
  for (let i = 0; i < limit; i++) {
    const d = planNext({ ramp, history })
    if (d.done) return { done: d, steps }
    const a = attempts.get(d.players) ?? 0
    attempts.set(d.players, a + 1)
    const outcome = oracle(d.players, a)
    history.push({ players: d.players, outcome })
    steps.push({ players: d.players, outcome, phase: d.phase })
  }
  throw new Error('search did not terminate')
}

const capacity = (c: number) => (p: number): StepOutcome => p <= c ? 'pass' : 'fail'
const R: Ramp = { start: 10, step: 10, max: 200, resolution: 2 }

test('ramp then bisect to resolution', () => {
  const { done, steps } = drive(R, capacity(37))
  assert.deepEqual(steps.map(s => s.players), [10, 20, 30, 40, 35, 37, 38])
  assert.deepEqual(steps.map(s => s.phase), ['ramp', 'ramp', 'ramp', 'ramp', 'bisect', 'bisect', 'bisect'])
  assert.equal(done.maxPlayers, 37)
  assert.equal(done.firstFail, 38)
  assert.equal(done.capped, false)
  assert.equal(done.loadgenLimited, false)
})

test('result is always within [C - resolution, C] for many capacities and ramps', () => {
  for (const res of [0, 1, 2, 5]) {
    for (const step of [1, 7, 10, 25]) {
      for (const start of [1, 5, 10]) {
        for (let c = 0; c <= 120; c++) {
          const ramp = { start, step, max: 100, resolution: res }
          const { done } = drive(ramp, capacity(c))
          if (c >= 100) {
            assert.equal(done.maxPlayers, 100)
            assert.equal(done.capped, true)
            continue
          }
          assert.equal(done.capped, false)
          assert.ok(done.maxPlayers <= c, `res=${res} step=${step} start=${start} c=${c} got ${done.maxPlayers}`)
          if (res > 0) assert.ok(done.maxPlayers >= c - res, `res=${res} step=${step} start=${start} c=${c} got ${done.maxPlayers}`)
          else assert.ok(done.maxPlayers >= Math.min(c, start) - step || done.maxPlayers === 0)
        }
      }
    }
  }
})

test('resolution 1 finds the exact capacity', () => {
  assert.equal(drive({ ...R, resolution: 1 }, capacity(37)).done.maxPlayers, 37)
})

test('resolution 0 disables bisection', () => {
  const { done, steps } = drive({ ...R, resolution: 0 }, capacity(37))
  assert.deepEqual(steps.map(s => s.players), [10, 20, 30, 40])
  assert.equal(done.maxPlayers, 30)
})

test('max reached with pass is capped; last step is clamped to max', () => {
  const { done, steps } = drive({ start: 10, step: 30, max: 50, resolution: 2 }, capacity(Infinity))
  assert.deepEqual(steps.map(s => s.players), [10, 40, 50])
  assert.equal(done.maxPlayers, 50)
  assert.equal(done.capped, true)
})

test('start == max', () => {
  assert.deepEqual(drive({ start: 5, step: 5, max: 5, resolution: 1 }, capacity(9)).done, { done: true, maxPlayers: 5, capped: true, loadgenLimited: false, invalidLimited: false })
})

test('fail at the very first step bisects down towards 0', () => {
  const { done, steps } = drive(R, capacity(3))
  assert.deepEqual(steps.map(s => s.players), [10, 5, 2, 3])
  assert.equal(done.maxPlayers, 3)
  const none = drive(R, capacity(0))
  assert.deepEqual(none.steps.map(s => s.players), [10, 5, 2])
  assert.equal(none.done.maxPlayers, 0)
  assert.equal(none.done.firstFail, 2)
  assert.equal(none.done.capped, false)
})

test('invalid step is retried once at the same load', () => {
  const { done, steps } = drive(R, (p, attempt) => p === 20 && attempt === 0 ? 'invalid' : capacity(37)(p))
  assert.deepEqual(steps.map(s => s.players), [10, 20, 20, 30, 40, 35, 37, 38])
  assert.equal(done.maxPlayers, 37)
  assert.equal(done.loadgenLimited, false)
  const d = planNext({ ramp: R, history: [{ players: 10, outcome: 'pass' }, { players: 20, outcome: 'invalid' }] })
  assert.deepEqual(d, { done: false, players: 20, phase: 'ramp', retry: true })
})

test('invalid twice in a row stops with loadgenLimited', () => {
  const { done, steps } = drive(R, p => p > 25 ? 'invalid' : 'pass')
  assert.deepEqual(steps.map(s => s.players), [10, 20, 30, 30])
  assert.deepEqual(done, { done: true, maxPlayers: 20, capped: false, loadgenLimited: true, invalidLimited: true, invalidReasons: ['loadgen saturated'] })
})

test('invalid during bisect is retried in the bisect phase', () => {
  const d = planNext({ ramp: R, history: [{ players: 10, outcome: 'pass' }, { players: 20, outcome: 'fail' }, { players: 15, outcome: 'invalid' }] })
  assert.deepEqual(d, { done: false, players: 15, phase: 'bisect', retry: true })
  const stop = planNext({ ramp: R, history: [{ players: 10, outcome: 'pass' }, { players: 20, outcome: 'fail' }, { players: 15, outcome: 'invalid' }, { players: 15, outcome: 'invalid' }] })
  assert.deepEqual(stop, { done: true, maxPlayers: 10, capped: false, loadgenLimited: true, invalidLimited: true, invalidReasons: ['loadgen saturated'], firstFail: 20 })
})

test('invalid for other reasons stops invalidLimited without loadgenLimited', () => {
  const stop = planNext({
    ramp: R,
    history: [
      { players: 10, outcome: 'pass' },
      { players: 20, outcome: 'invalid', reasons: ['placement_mismatch'] },
      { players: 20, outcome: 'invalid', reasons: ['loadgen saturated', 'interference: x'] }
    ]
  })
  assert.deepEqual(stop, {
    done: true, maxPlayers: 10, capped: false, loadgenLimited: false, invalidLimited: true,
    invalidReasons: ['placement_mismatch', 'loadgen saturated', 'interference: x']
  })
})

test('noisy non-monotonic outcomes still converge below the lowest fail', () => {
  // 35 fails by noise although 37 would pass.
  const { done } = drive(R, p => p === 35 ? 'fail' : capacity(37)(p))
  assert.equal(done.maxPlayers, 33)
  assert.equal(done.firstFail, 35)
})

test('pure: same state, same decision; history not mutated', () => {
  const history: SearchStep[] = [{ players: 10, outcome: 'pass' }]
  const frozen = Object.freeze([...history])
  assert.deepEqual(planNext({ ramp: R, history: frozen }), planNext({ ramp: R, history: frozen }))
  assert.deepEqual(planNext({ ramp: R, history: [] }), { done: false, players: 10, phase: 'ramp', retry: false })
})

test('rejects an invalid ramp', () => {
  assert.throws(() => planNext({ ramp: { start: 0, step: 1, max: 1, resolution: 1 }, history: [] }), /invalid ramp/)
  assert.throws(() => planNext({ ramp: { start: 5, step: 1, max: 1, resolution: 1 }, history: [] }), /invalid ramp/)
})
