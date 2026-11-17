import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InterferenceSample } from '@bedperf/core'
import { allowedCpus, parseCpuList, resolveCpuScope, scopeSample } from './scope.ts'

test('parseCpuList', () => {
  assert.deepEqual(parseCpuList('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11])
  assert.deepEqual(parseCpuList('5,1,1'), [1, 5])
  assert.throws(() => parseCpuList('3-1'))
  assert.throws(() => parseCpuList('a'))
})

test('allowedCpus reads Cpus_allowed_list on Linux', { skip: process.platform !== 'linux' }, () => {
  assert.deepEqual(allowedCpus(() => 'Name:\tnode\nCpus_allowed:\tff\nCpus_allowed_list:\t2-4,7\n'), [2, 3, 4, 7])
  assert.equal(allowedCpus(() => 'Name:\tnode\n'), undefined)
})

test('resolveCpuScope: auto narrows only inside a smaller allocation', () => {
  assert.deepEqual(resolveCpuScope('auto', { allowed: () => [4, 5], logical: () => 8 }), [4, 5])
  assert.equal(resolveCpuScope('auto', { allowed: () => [0, 1, 2, 3], logical: () => 4 }), undefined)
  assert.equal(resolveCpuScope('auto', { allowed: () => undefined, logical: () => 4 }), undefined)
  assert.equal(resolveCpuScope('machine', { allowed: () => [1], logical: () => 4 }), undefined)
  assert.deepEqual(resolveCpuScope([3, 1, 3]), [1, 3])
})

test('scopeSample counts only the scoped CPUs', () => {
  const s: InterferenceSample = {
    t: 1, intervalMs: 1000, cpuBusy: [0.5, 0.5, 1, 1], busyCores: 3,
    groups: { server: 0, bots: 0.9, harness: 0.05 }, foreignCores: 2.05, serverSetForeignCores: 1
  }
  const x = scopeSample(s, [0, 1])
  assert.deepEqual(x.cpuBusy, [0.5, 0.5])
  assert.equal(x.busyCores, 1)
  assert.ok(Math.abs(x.foreignCores - 0.05) < 1e-9)
  assert.equal(x.serverSetForeignCores, undefined)
  assert.equal(s.serverSetForeignCores, 1, 'input untouched')
})
