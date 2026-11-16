import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadScenario, SCENARIO_NAMES, SCENARIOS, scenarioModule } from './index.ts'
import {
  commonSetupCommands, directionAngle, GOLDEN_ANGLE, numParam, parseCommonSetup, raceAbort, ABORTED, ScenarioParamError,
  sleep, spiralCell, yawTowards
} from './common.ts'
import * as walk from './scenarios/walk.ts'
import * as explore from './scenarios/explore.ts'
import * as build from './scenarios/build.ts'
import * as chat from './scenarios/chat.ts'
import * as mobs from './scenarios/mobs.ts'
import * as entityStress from './scenarios/entity-stress.ts'
import * as idle from './scenarios/idle.ts'
import { fakeBot, fakeCtx, seeded } from './fake-bot.test-util.ts'

const PARSERS: Record<string, (p: Record<string, unknown>) => unknown> = {
  idle: idle.parseParams,
  walk: walk.parseParams,
  explore: explore.parseParams,
  build: build.parseParams,
  chat: chat.parseParams,
  mobs: mobs.parseParams,
  'entity-stress': entityStress.parseParams
}

// ------------------------------------------------------------------------------------------------ registry

test('registry: every module default-exports a Scenario with the registry name', async () => {
  const files = readdirSync(fileURLToPath(new URL('./scenarios/', import.meta.url))).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.deepEqual(files.map(f => f.replace(/\.ts$/, '')).sort(), [...SCENARIO_NAMES].sort())
  for (const name of SCENARIO_NAMES) {
    const s = await loadScenario(name)
    assert.equal(s.name, name)
    assert.equal(typeof s.run, 'function')
    assert.ok(s.description.length > 0)
    assert.equal(scenarioModule(name), SCENARIOS[name].module)
    assert.ok(SCENARIOS[name].module.startsWith('file:'))
    const viaUrl = await loadScenario(SCENARIOS[name].module)
    assert.equal(viaUrl, s)
  }
})

test('registry: unknown names throw', async () => {
  assert.throws(() => scenarioModule('nope'), /unknown scenario/)
  await assert.rejects(loadScenario('node:path'), /does not default-export a Scenario/)
})

test('registry: defaults parse, serverSetup and botOptions work with defaults and with {}', async () => {
  for (const name of SCENARIO_NAMES) {
    const s = await loadScenario(name)
    const parse = PARSERS[name]!
    assert.doesNotThrow(() => parse({}), name)
    assert.doesNotThrow(() => parse({ ...SCENARIOS[name].defaults }), name)
    for (const params of [{}, { ...SCENARIOS[name].defaults }]) {
      const cmds = s.serverSetup?.(params) ?? []
      assert.ok(cmds.length > 0, name)
      for (const c of cmds) assert.ok(!c.startsWith('/'), `${name}: ${c} has a leading slash`)
      assert.deepEqual(s.botOptions?.(params), {})
    }
  }
})

// ------------------------------------------------------------------------------------------------ params

test('params: numbers are validated and default', () => {
  assert.equal(numParam({}, 'a', 3), 3)
  assert.equal(numParam({ a: '7' }, 'a', 3), 7)
  assert.throws(() => numParam({ a: 'x' }, 'a', 3), ScenarioParamError)
  assert.throws(() => numParam({ a: 1.5 }, 'a', 3, { int: true }), ScenarioParamError)
  assert.throws(() => numParam({ a: -1 }, 'a', 3, { min: 0 }), ScenarioParamError)
  assert.throws(() => numParam({ a: Infinity }, 'a', 3), ScenarioParamError)
})

test('params: per-scenario defaults and validation', () => {
  assert.deepEqual(walk.parseParams({}), { radius: 32, sprint: true, jump: 'stuck', checkIntervalMs: 500, stuckMs: 2000, maxLegSec: 30 })
  assert.equal(walk.parseParams({ radius: 8 }).radius, 8)
  assert.throws(() => walk.parseParams({ radius: 0 }), ScenarioParamError)
  assert.throws(() => walk.parseParams({ jump: 'sometimes' }), ScenarioParamError)

  assert.deepEqual(explore.parseParams({}), { mode: 'teleport', stepBlocks: 32, intervalSec: 2, maxDistance: 4096, gamemode: 'creative' })
  assert.throws(() => explore.parseParams({ mode: 'fly', gamemode: 'survival' }), ScenarioParamError)

  const b = build.parseParams({})
  assert.equal(b.mode, 'client')
  assert.equal(b.block, 'stone')
  assert.equal(build.parseParams({ block: 'minecraft:dirt' }).block, 'dirt')
  assert.throws(() => build.parseParams({ mode: 'magic' }), ScenarioParamError)
  assert.throws(() => build.parseParams({ plotRadius: 4, plotSpacing: 10 }), /plots would touch/)
  assert.throws(() => build.parseParams({ block: 'stone 1; op x' }), ScenarioParamError)

  assert.deepEqual(chat.parseParams({}), { intervalSec: 5, payloadBytes: 32 })
  assert.throws(() => chat.parseParams({ payloadBytes: 10_000 }), ScenarioParamError)

  assert.equal(mobs.parseParams({}).mobType, 'zombie')
  assert.equal(mobs.parseParams({}).count, 5)
  assert.throws(() => mobs.parseParams({ count: -1 }), ScenarioParamError)

  assert.equal(entityStress.parseParams({}).count, 100)
  assert.throws(() => entityStress.parseParams({ size: 500 }), ScenarioParamError)

  assert.throws(() => idle.parseParams({ viewDistance: 'huge' }), ScenarioParamError)
  assert.throws(() => idle.parseParams({ time: 'teatime' }), ScenarioParamError)
})

test('common setup: defaults and overrides', () => {
  const cmds = commonSetupCommands(parseCommonSetup({}))
  for (const c of ['gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule doMobSpawning false',
    'gamerule randomTickSpeed 1', 'time set noon']) assert.ok(cmds.includes(c), c)
  const o = commonSetupCommands(parseCommonSetup({ mobSpawning: true, time: 'midnight', difficulty: 'hard', extraSetup: ['say hi'] }))
  assert.ok(o.includes('gamerule doMobSpawning true'))
  assert.ok(o.includes('time set midnight'))
  assert.ok(o.includes('difficulty hard'))
  assert.equal(o.at(-1), 'say hi')
  // scenario-specific defaults
  const mobSetup = mobs.default.serverSetup!({})
  assert.ok(mobSetup.includes('difficulty normal'))
  assert.ok(mobSetup.includes('time set midnight'))
  assert.ok(mobSetup.includes('gamerule doMobSpawning false'))
  const es = entityStress.default.serverSetup!({ count: 10 })
  assert.ok(es.some(c => /^tickingarea add .* bedperf_stress true$/.test(c)))
})

// ------------------------------------------------------------------------------------------------ layout

test('layout: spiral cells are unique, compact and deterministic', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) {
    const c = spiralCell(i)
    const k = `${c.x},${c.z}`
    assert.ok(!seen.has(k), `duplicate cell ${k} at ${i}`)
    seen.add(k)
    // the first n cells fit in the smallest odd square holding n
    const ring = Math.ceil((Math.sqrt(i + 1) - 1) / 2)
    assert.ok(Math.max(Math.abs(c.x), Math.abs(c.z)) <= ring)
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8, 9].map(spiralCell), [
    { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }, { x: -1, z: 1 }, { x: -1, z: 0 }, { x: 1, z: -1 }, { x: 2, z: -1 }
  ])
})

test('layout: build plots never overlap', () => {
  const p = build.parseParams({})
  const centers = Array.from({ length: 200 }, (_, i) => build.plotCenter(i, p))
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const a = centers[i]!
      const b = centers[j]!
      assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) >= 2 * p.plotRadius + 3)
    }
  }
  assert.deepEqual(build.plotCenter(0, p), { x: 0, z: 0 })
  assert.deepEqual(build.plotCenter(1, { ...p, originX: 100, originZ: -50 }), { x: 116, z: -50 })
  const rnd = seeded(1)
  for (let i = 0; i < 500; i++) {
    const c = build.randomCell(rnd, 2)
    assert.ok(c.dx !== 0 || c.dz !== 0)
    assert.ok(Math.abs(c.dx) <= 2 && Math.abs(c.dz) <= 2)
  }
})

test('layout: explore headings follow the golden angle and legs restart outward', () => {
  assert.equal(directionAngle(0), 0)
  assert.ok(Math.abs(directionAngle(1) - GOLDEN_ANGLE) < 1e-12)
  // headings of the first n bots are well spread: min angular gap among 10 bots > 0.2 rad
  const angles = Array.from({ length: 10 }, (_, i) => directionAngle(i)).sort((a, b) => a - b)
  for (let i = 1; i < angles.length; i++) assert.ok(angles[i]! - angles[i - 1]! > 0.2)
  const p = { stepBlocks: 100, maxDistance: 300 }
  const t1 = explore.exploreTarget(2, 1, p, 0, 0)
  const t3 = explore.exploreTarget(2, 3, p, 0, 0)
  const t4 = explore.exploreTarget(2, 4, p, 0, 0)
  assert.ok(Math.abs(Math.hypot(t1.x, t1.z) - 100) < 2)
  assert.ok(Math.abs(Math.hypot(t3.x, t3.z) - 300) < 2)
  assert.equal(t3.leg, 0)
  assert.equal(t4.leg, 1)
  assert.ok(Math.abs(Math.hypot(t4.x, t4.z) - 100) < 2)
  assert.deepEqual(explore.exploreTarget(2, 3, p, 0, 0), t3)
})

test('walk: targets stay within the radius and steering yaw follows bedboo convention', () => {
  const rnd = seeded(7)
  for (let i = 0; i < 1000; i++) {
    const t = walk.randomTarget(rnd, 10, -5, 32)
    assert.ok(Math.hypot(t.x - 10, t.z + 5) <= 32 + 1e-9)
  }
  // yaw 0 faces -Z, yaw π/2 faces -X (bot.lookAt's atan2(-dx, -dz))
  assert.ok(Math.abs(yawTowards(0, 0, 0, -10)) < 1e-12)
  assert.ok(Math.abs(yawTowards(0, 0, -10, 0) - Math.PI / 2) < 1e-12)
})

test('chat: payloads have the exact size and never look like commands', () => {
  for (const n of [1, 5, 32, 256]) {
    const s = chat.chatPayload(3, 17, n, seeded(n))
    assert.equal(Buffer.byteLength(s), n)
    assert.ok(!s.startsWith('/'))
  }
  assert.equal(chat.chatPayload(1, 2, 40, seeded(9)), chat.chatPayload(1, 2, 40, seeded(9)))
})

test('entity-stress: pen commands stay under the fill limit', () => {
  const p = entityStress.parseParams({ size: 90 })
  for (const c of entityStress.penCommands(p)) {
    const [x0, y0, z0, x1, y1, z1] = c.split(' ').slice(1, 7).map(Number) as [number, number, number, number, number, number]
    const vol = (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1) * (Math.abs(z1 - z0) + 1)
    assert.ok(vol <= 32768, `${c}: ${vol}`)
  }
})

// ------------------------------------------------------------------------------------------------ abort

test('helpers: sleep and raceAbort return promptly on abort', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 20)
  await sleep(10_000, ac.signal)
  assert.equal(await raceAbort(new Promise(() => {}), ac.signal), ABORTED)
  assert.equal(await raceAbort(Promise.reject(new Error('late')), ac.signal), ABORTED)
  assert.ok(Date.now() - t0 < 1000)
})

const RUN_PARAMS: Record<string, Record<string, unknown>> = {
  walk: { checkIntervalMs: 50, stuckMs: 100 },
  explore: { intervalSec: 0.05 },
  build: { intervalMs: 10, plotRadius: 1 },
  'build-command': { mode: 'command', intervalMs: 10 },
  chat: { intervalSec: 0.05 },
  mobs: { attackIntervalMs: 50, maintainSec: 1 },
  'entity-stress': { maintainSec: 1, count: 3 }
}

for (const commands of ['ok', 'hang', 'reject'] as const) {
  for (const name of SCENARIO_NAMES) {
    test(`run: ${name} returns promptly after abort (commands ${commands})`, async () => {
      const s = await loadScenario(name)
      const variants = name === 'build' ? ['build', 'build-command'] : [name]
      for (const v of variants) {
        const { bot, calls } = fakeBot({ commands })
        const logs: string[] = []
        const ac = new AbortController()
        const done = s.run(bot, fakeCtx(0, RUN_PARAMS[v] ?? {}, logs), ac.signal)
        await new Promise(resolve => setTimeout(resolve, v.startsWith('build') ? 1000 : 400))
        const t0 = Date.now()
        ac.abort()
        await done
        assert.ok(Date.now() - t0 < 200, `${v} took ${Date.now() - t0} ms to stop`)
        if (commands === 'ok') {
          if (v === 'walk') assert.ok(calls.controls.some(([c, on]) => c === 'forward' && on) && calls.looks > 0)
          if (v === 'explore') assert.ok(calls.commands.some(c => c.startsWith('tp @s ')))
          if (v === 'build') assert.ok(calls.places > 0 && calls.digs > 0, JSON.stringify(calls))
          if (v === 'build-command') assert.ok(calls.commands.some(c => c.startsWith('setblock ')))
          if (v === 'chat') assert.ok(calls.chats.length > 0)
          if (v === 'mobs') assert.ok(calls.attacks > 0 && calls.commands.some(c => c.startsWith('summon zombie')))
          if (v === 'entity-stress') assert.ok(calls.commands.some(c => c.startsWith('fill ')) && calls.commands.some(c => c.startsWith('testfor ')))
        }
      }
    })
  }
}

test('run: an already-aborted signal returns immediately', async () => {
  for (const name of SCENARIO_NAMES) {
    const s = await loadScenario(name)
    const ac = new AbortController()
    ac.abort()
    const t0 = Date.now()
    await s.run(fakeBot().bot, fakeCtx(1, RUN_PARAMS[name] ?? {}), ac.signal)
    assert.ok(Date.now() - t0 < 100, name)
  }
})

test('run: entity-stress non-keepers idle without commands', async () => {
  const { bot, calls } = fakeBot()
  const ac = new AbortController()
  const done = entityStress.default.run(bot, fakeCtx(1, {}), ac.signal)
  await new Promise(resolve => setTimeout(resolve, 50))
  ac.abort()
  await done
  assert.equal(calls.commands.length, 0)
})
