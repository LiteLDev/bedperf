import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CRITERIA, DEFAULT_GATES, DEFAULT_PLACEMENT, DEFAULT_SETTLE, DEFAULT_TPS_DIVERGENCE } from '@bedperf/core'
import { ConfigError, DEFAULT_RAMP, loadConfig, parseConfig } from './config.ts'
import { PRESET_NAMES, preset, presets } from './presets.ts'

const minimal = { name: 'mini', scenario: { module: '@bedperf/scenarios/idle' } }

test('minimal config gets all defaults', () => {
  const c = parseConfig(minimal)
  assert.equal(c.name, 'mini')
  assert.equal(c.bdsVersion, 'latest')
  assert.deepEqual(c.criteria, { ...DEFAULT_CRITERIA, maxProbeCounterTpsDivergence: DEFAULT_TPS_DIVERGENCE })
  assert.deepEqual(c.ramp, { ...DEFAULT_RAMP, settle: DEFAULT_SETTLE })
  assert.deepEqual(c.placement, DEFAULT_PLACEMENT)
  assert.deepEqual(c.gates, DEFAULT_GATES)
  assert.equal(c.cooldownSec, 60)
  assert.equal(c.ramp.settleSec, 20)
  assert.equal(c.ramp.holdSec, 60)
  assert.equal(c.ramp.resolution, 2)
  assert.equal(c.repeats, 3)
  assert.equal(c.warmupSec, 60)
  assert.deepEqual(c.serverProperties, {})
  assert.deepEqual(c.world, {})
  assert.equal(c.botVersion, undefined)
})

test('partial ramp / criteria are merged with defaults', () => {
  const c = parseConfig({ ...minimal, ramp: { step: 5 }, criteria: { minAvgTps: 19.5, maxMainThreadUtil: 0.8 } })
  assert.equal(c.ramp.step, 5)
  assert.equal(c.ramp.start, DEFAULT_RAMP.start)
  assert.equal(c.criteria.minAvgTps, 19.5)
  assert.equal(c.criteria.maxMainThreadUtil, 0.8)
  assert.equal(c.criteria.maxTickIntervalP99Ms, 80)
})

test('input is not mutated and params are cloned', () => {
  const raw = { ...minimal, scenario: { module: 'x', params: { r: 1 } } }
  const c = parseConfig(raw)
  c.scenario.params!['r'] = 2
  assert.equal(raw.scenario.params.r, 1)
})

test('collects every issue with paths', () => {
  try {
    parseConfig({ name: 'bad name!', ramp: { step: -1, start: 1.5, holdSec: 0 }, criteria: { maxMainThreadUtil: 2, typo: 1 }, repeats: 0, extra: true, serverProperties: { a: {} } })
    assert.fail('should throw')
  } catch (err) {
    assert.ok(err instanceof ConfigError)
    const msg = err.issues.join('\n')
    for (const needle of ['config.name', 'config.scenario', 'config.ramp.step', 'config.ramp.start', 'config.ramp.holdSec', 'config.criteria.maxMainThreadUtil', 'config.criteria.typo: unknown key', 'config.repeats', 'config.extra: unknown key', 'config.serverProperties.a']) {
      assert.ok(msg.includes(needle), `missing issue for ${needle}:\n${msg}`)
    }
    assert.match(err.message, /^invalid benchmark config/)
  }
})

test('rejects start > max and wrong types', () => {
  assert.throws(() => parseConfig({ ...minimal, ramp: { start: 50, max: 10 } }), /config\.ramp\.start: must be <= ramp\.max/)
  assert.throws(() => parseConfig({ ...minimal, ramp: { start: 600, max: 'x' } }), (e: unknown) => e instanceof ConfigError && e.issues.length === 1 && e.issues[0]!.startsWith('config.ramp.max'))
  assert.throws(() => parseConfig({ ...minimal, repeats: '3' }), /config\.repeats: expected a finite number, got "3"/)
  assert.throws(() => parseConfig({ ...minimal, world: { levelType: 'flat' } }), /config\.world\.levelType/)
  assert.throws(() => parseConfig(null), /expected a JSON object/)
  assert.throws(() => parseConfig([]), /expected a JSON object/)
})

test('world seed accepts integers and is stored as string', () => {
  assert.equal(parseConfig({ ...minimal, world: { seed: 42 } }).world.seed, '42')
})

test('loadConfig reads files and reports bad JSON / missing files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-cfg-'))
  try {
    const good = path.join(dir, 'good.json')
    await writeFile(good, JSON.stringify(minimal))
    assert.equal((await loadConfig(good)).name, 'mini')
    const bad = path.join(dir, 'bad.json')
    await writeFile(bad, '{ nope')
    await assert.rejects(loadConfig(bad), (e: unknown) => e instanceof ConfigError && /not valid JSON/.test(e.message) && e.message.includes(bad))
    await assert.rejects(loadConfig(path.join(dir, 'missing.json')), /cannot read config file/)
    assert.equal((await loadConfig(minimal)).name, 'mini')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('presets are valid and carry the bench basics', () => {
  for (const name of PRESET_NAMES) {
    const p = presets[name]
    assert.equal(p.name, name)
    assert.equal(p.serverProperties['view-distance'], 10)
    assert.equal(p.serverProperties['tick-distance'], 4)
    assert.equal(p.serverProperties['max-players'], 1000)
    assert.equal(p.serverProperties['default-player-permission-level'], 'operator')
    assert.deepEqual(parseConfig(p), p, 'preset round-trips through validation')
  }
  assert.ok(presets.quick.ramp.holdSec < presets.standard.ramp.holdSec)
  assert.ok(presets.standard.ramp.holdSec < presets.thorough.ramp.holdSec)
  assert.equal(presets.standard.repeats, 3)
  const copy = preset('quick')
  copy.ramp.max = 1
  assert.notEqual(presets.quick.ramp.max, 1)
})
