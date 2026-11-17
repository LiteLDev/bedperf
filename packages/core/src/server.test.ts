import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bdsVersionFor, benchConfigSha256, resolveServerSpec, SERVER_PRESETS, serverBuildSha256, serverLabel, serverSpecSha256, topologySha256
} from './index.ts'

test('resolveServerSpec pins only the components the flavor uses', () => {
  assert.deepEqual(resolveServerSpec(undefined), { flavor: 'bds', mods: [], runtime: 'native', versions: {} })
  const ll = resolveServerSpec({ ...SERVER_PRESETS['levilamina-levioptimize-wine'], mods: ['levioptimize', 'levioptimize'] })
  assert.deepEqual(ll.versions, { levilamina: '26.60.7', levioptimize: '0.18.0' })
  assert.deepEqual(ll.mods, ['levioptimize'])
  assert.deepEqual(resolveServerSpec({ ...SERVER_PRESETS.endstone, versions: { levilamina: '1' } }).versions, { endstone: '0.11.15' })
})

test('serverLabel and bdsVersionFor', () => {
  assert.equal(serverLabel(undefined), 'bds')
  assert.equal(serverLabel({ ...SERVER_PRESETS['levilamina-levioptimize-wine'], mods: ['levioptimize'] }), 'levilamina+levioptimize (wine)')
  assert.equal(bdsVersionFor(undefined, 'latest'), 'latest')
  assert.equal(bdsVersionFor({ ...SERVER_PRESETS.endstone, mods: [] }, 'latest'), '1.26.60.6')
  assert.equal(bdsVersionFor({ ...SERVER_PRESETS.levilamina, mods: [] }, '1.26.60.6'), '1.26.60.6')
})

test('spec and build hashes are order independent', () => {
  const a = serverSpecSha256({ flavor: 'levilamina', mods: ['levioptimize'], runtime: 'native', versions: {} })
  const b = serverSpecSha256({ flavor: 'levilamina', mods: ['levioptimize'], runtime: 'native', versions: { levilamina: '26.60.7' } })
  assert.equal(a, b)
  const x = serverBuildSha256([{ name: 'bds', sha256: '1' }, { name: 'levilamina', sha256: '2' }])
  const y = serverBuildSha256([{ name: 'levilamina', sha256: '2' }, { name: 'bds', sha256: '1' }])
  assert.equal(x, y)
})

test('benchConfigSha256 ignores the server section', () => {
  assert.equal(benchConfigSha256({ name: 'a', server: { flavor: 'bds' } }), benchConfigSha256({ name: 'a' }))
  assert.notEqual(benchConfigSha256({ name: 'a' }), benchConfigSha256({ name: 'b' }))
})

test('topologySha256 ignores agent order and names', () => {
  const m = (fp: string) => ({ fingerprint: fp, os: 'linux', cpuModel: 'x', logical: 8, ramGiB: 16 })
  const h = { version: '0', node: 'v24' }
  const ag = (fp: string, name: string) => ({ name, addressId: name, machine: m(fp), harness: h, cpus: 8, weight: 1 })
  assert.equal(
    topologySha256({ mode: 'remote', agents: [ag('a', 'x'), ag('b', 'y')] }),
    topologySha256({ mode: 'remote', agents: [ag('b', 'p'), ag('a', 'q')] })
  )
})
