import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProbeRecord, ProbeSample } from '@bedperf/core'
import { PROBE_PACK_FOLDER, PROBE_PACK_UUID, PROBE_PACK_VERSION, installProbe, packDir, summarizeProbe } from './index.ts'

test('manifest matches exported constants and uses only stable @minecraft/server', () => {
  const m = JSON.parse(readFileSync(join(packDir(), 'manifest.json'), 'utf8'))
  assert.equal(m.format_version, 2)
  assert.equal(m.header.uuid, PROBE_PACK_UUID)
  assert.deepEqual(m.header.version, [...PROBE_PACK_VERSION])
  assert.deepEqual(m.dependencies, [{ module_name: '@minecraft/server', version: '2.11.0' }])
  assert.ok(existsSync(join(packDir(), m.modules[0].entry)))
  for (const f of ['main.js', 'probe-core.js']) {
    const src = readFileSync(join(packDir(), 'scripts', f), 'utf8')
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(x => x[1])
    for (const i of imports) assert.ok(i === '@minecraft/server' || i!.startsWith('./'), `${f} imports ${i}`)
  }
})

test('installProbe is idempotent and never writes through hard links', () => {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-probe-test-'))
  try {
    const inst = join(root, 'inst')
    const world = join(inst, 'worlds', 'lvl')
    mkdirSync(world, { recursive: true })
    mkdirSync(join(inst, 'behavior_packs'))
    // world_behavior_packs.json hard-linked to a "cache" file
    const cacheFile = join(root, 'cache.json')
    const other = { pack_id: '00000000-0000-0000-0000-000000000000', version: [1, 0, 0] }
    writeFileSync(cacheFile, JSON.stringify([other]))
    linkSync(cacheFile, join(world, 'world_behavior_packs.json'))

    installProbe(inst, 'lvl')
    installProbe(inst, 'lvl')

    assert.equal(readFileSync(cacheFile, 'utf8'), JSON.stringify([other]))
    const list = JSON.parse(readFileSync(join(world, 'world_behavior_packs.json'), 'utf8'))
    assert.deepEqual(list, [other, { pack_id: PROBE_PACK_UUID, version: [1, 0, 0] }])
    const installed = join(inst, 'behavior_packs', PROBE_PACK_FOLDER)
    assert.ok(existsSync(join(installed, 'manifest.json')))
    assert.ok(existsSync(join(installed, 'scripts', 'main.js')))

    // works on a fresh instance whose world does not exist yet
    installProbe(inst, 'fresh')
    assert.equal(JSON.parse(readFileSync(join(inst, 'worlds', 'fresh', 'world_behavior_packs.json'), 'utf8')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function sample (t: number, ticks: number, windowMs: number, extra: Partial<ProbeSample> = {}): ProbeSample {
  return {
    type: 'sample', v: 1, tick: t / 50, t, windowMs, ticks, tps: ticks / (windowMs / 1000),
    interval: { mean: windowMs / ticks, max: 60, p50: 50, p95: 55, p99: 60 },
    over50: 1, over100: 0, players: 2, ...extra
  }
}

test('summarizeProbe aggregates samples', () => {
  const recs: ProbeRecord[] = [
    sample(1000, 20, 1000),
    { type: 'mark', v: 1, tick: 1, t: 1500, label: 'x' },
    sample(2000, 10, 1000, { interval: { mean: 100, max: 300, p50: 50, p95: 250, p99: 300 }, over100: 2 }),
    sample(3000, 20, 1000, { entities: { total: 42, byDimension: { overworld: 42 }, topTypes: {} } })
  ]
  const s = summarizeProbe(recs)
  assert.equal(s.windows, 3)
  assert.equal(s.durationMs, 3000)
  assert.equal(s.ticks, 50)
  assert.ok(Math.abs(s.tps - 50 / 3) < 1e-9)
  assert.equal(s.windowTps.min, 10)
  assert.equal(s.windowTps.max, 20)
  assert.equal(s.intervalMean, 3000 / 50)
  assert.equal(s.intervalMax, 300)
  assert.equal(s.windowIntervalP99.max, 300)
  assert.equal(s.over50, 3)
  assert.equal(s.over100, 2)
  assert.equal(s.over50Rate, 3 / 50)
  assert.equal(s.players.mean, 2)
  assert.equal(s.entities.n, 1)
  assert.equal(s.entities.mean, 42)

  const w = summarizeProbe(recs, { fromT: 2000, toT: 2000 })
  assert.equal(w.windows, 1)
  assert.equal(w.tps, 10)

  const empty = summarizeProbe([])
  assert.equal(empty.windows, 0)
  assert.ok(Number.isNaN(empty.tps))
  assert.ok(Number.isNaN(empty.intervalMax))
})
