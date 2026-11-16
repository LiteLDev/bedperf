import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preset } from '@bedperf/orchestrator'
import { SCENARIOS } from '@bedperf/scenarios'
import { applySets, parseArgs } from './args.ts'
import { botFamily, instanceProperties, makeRunId, resolveScenario } from './plan.ts'
import { configFromArgs } from './main.ts'

test('parseArgs handles flags, values, repeats and positionals', () => {
  const a = parseArgs(['run', '--preset', 'quick', '--set', 'ramp.max=40', '--set=seed=3', '--accept-eula', 'x'])
  assert.deepEqual(a.positionals, ['run', 'x'])
  assert.deepEqual(a.flags.get('set'), ['ramp.max=40', 'seed=3'])
  assert.deepEqual(a.flags.get('accept-eula'), ['true'])
  assert.throws(() => parseArgs(['--port']), /needs a value/)
})

test('applySets parses JSON values and keeps dotted property names whole', () => {
  const o = applySets({ ramp: { max: 1 } }, ['ramp.max=40', 'serverProperties.view-distance=8', 'name=abc', 'world.seed="12"'])
  assert.deepEqual(o, { ramp: { max: 40 }, serverProperties: { 'view-distance': 8 }, name: 'abc', world: { seed: '12' } })
})

test('resolveScenario accepts names, package aliases and custom modules', () => {
  assert.equal(resolveScenario('walk').module, SCENARIOS.walk.module)
  assert.equal(resolveScenario('@bedperf/scenarios/idle').name, 'idle')
  assert.equal(resolveScenario('build').needsOperator, true)
  assert.throws(() => resolveScenario('@bedperf/scenarios/nope'), /unknown scenario/)
  assert.deepEqual(resolveScenario('file:///x.ts'), { module: 'file:///x.ts', needsOperator: true })
})

test('instanceProperties enforces bot requirements and operator for op scenarios', () => {
  const c = preset('quick')
  c.serverProperties = { 'view-distance': 8 }
  c.world = { seed: 'abc', levelType: 'FLAT' }
  const p = instanceProperties(c, resolveScenario('build'))
  assert.equal(p['default-player-permission-level'], 'operator')
  assert.equal(p['level-seed'], 'abc')
  assert.equal(p['level-type'], 'FLAT')
  assert.equal(instanceProperties(c, resolveScenario('walk'))['default-player-permission-level'], undefined)

  c.serverProperties = { 'online-mode': true, 'server-port': 1 }
  assert.throws(() => instanceProperties(c, resolveScenario('walk')), /online-mode[\s\S]*server-port/)
  c.serverProperties = { 'online-mode': 'false', 'default-player-permission-level': 'member' }
  assert.doesNotThrow(() => instanceProperties(c, resolveScenario('walk')))
  assert.throws(() => instanceProperties(c, resolveScenario('mobs')), /needs default-player-permission-level=operator/)
})

test('botFamily maps BDS builds to tested bedboo families', () => {
  const tested = ['1.26.40', '1.26.45', '1.26.51', '1.26.60']
  assert.equal(botFamily('1.26.63.1', tested), '1.26.60')
  assert.equal(botFamily('1.26.60.6', tested), '1.26.60')
  assert.equal(botFamily('1.26.51.1', tested), '1.26.51')
  assert.equal(botFamily('1.26.45.1', tested), '1.26.45')
  assert.equal(botFamily('1.26.60', tested), '1.26.60')
  assert.equal(botFamily('1.26.70.1', tested), undefined)
  assert.equal(botFamily('1.27.0.2', tested), undefined)
  assert.equal(botFamily('1.21.0.3', tested), undefined)
})

test('makeRunId is sortable and safe', () => {
  assert.match(makeRunId(Date.UTC(2026, 0, 2, 3, 4, 5), 'quick-walk'), /^2026010\d-\d{6}-quick-walk$/)
})

test('configFromArgs layers preset, scenario, version and --set', async () => {
  const c = await configFromArgs(parseArgs(['run', '--scenario', 'walk', '--bds-version', '1.26.63.1', '--set', 'ramp.max=40', '--set', 'repeats=2']))
  assert.equal(c.name, 'quick-walk')
  assert.equal(c.scenario.module, 'walk')
  assert.equal(c.bdsVersion, '1.26.63.1')
  assert.equal(c.ramp.max, 40)
  assert.equal(c.repeats, 2)
  await assert.rejects(configFromArgs(parseArgs(['run', '--set', 'ramp.bogus=1'])), /unknown key/)
  await assert.rejects(configFromArgs(parseArgs(['run', '--preset', 'nope'])), /unknown preset/)
})
