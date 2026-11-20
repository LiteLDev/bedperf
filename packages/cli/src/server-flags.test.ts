import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SERVER_PRESET_NAMES, SERVER_PRESETS, type PlacementSetVerification, type PlacementVerification, type ServerSpec } from '@bedperf/core'
import { applySets, parseArgs, UsageError } from './args.ts'
import { configFromArgs, exitCodeForError, serverPresetFlag } from './main.ts'
import { botFamily } from './plan.ts'
import { checkServerHost, flattenSetVerification, moddedBuildCached } from './run.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('--server sets config.server from a preset; --set refines it', async () => {
  const c = await configFromArgs(parseArgs(['run', '--server', 'levilamina-levioptimize', '--set', 'server.versions.levilamina=26.60.8', '--set', 'server.versions.levioptimize=0.20']))
  assert.deepEqual(c.server, { flavor: 'levilamina', mods: ['levioptimize'], runtime: 'native', versions: { levilamina: '26.60.8', levioptimize: '0.20' } })
  assert.equal(c.name, 'quick', 'the config name stays: implementation comparisons need the same benchmark config')
  const e = await configFromArgs(parseArgs(['run', '--server', 'endstone']))
  assert.deepEqual(e.server, { flavor: 'endstone', mods: [], runtime: 'native', versions: { endstone: '0.11.15' } })
  const d = await configFromArgs(parseArgs(['run']))
  assert.equal(d.server, undefined)
  const l = await configFromArgs(parseArgs(['run', '--server', 'levilamina', '--set', 'server.loaderConfig.targeted.enableStatistics=true']))
  assert.deepEqual(l.server?.loaderConfig, { targeted: { enableStatistics: true } })
  for (const name of SERVER_PRESET_NAMES) {
    const c2 = await configFromArgs(parseArgs(['run', '--server', name]))
    assert.equal(c2.server?.flavor, SERVER_PRESETS[name].flavor)
  }
})

test('--server rejects unknown presets and invalid combinations as usage errors', async () => {
  assert.throws(() => serverPresetFlag(parseArgs(['run', '--server', 'paper'])), UsageError)
  await assert.rejects(configFromArgs(parseArgs(['run', '--server', 'paper'])), /unknown server preset 'paper'/)
  const err = await configFromArgs(parseArgs(['run', '--server', 'endstone', '--set', 'server.runtime=wine'])).catch((e: unknown) => e)
  assert.match(String(err), /"wine" runs a Windows build of BDS or LeviLamina \(flavor endstone runs natively\)/)
  assert.equal(exitCodeForError(err), 2)
  await assert.rejects(configFromArgs(parseArgs(['run', '--server', 'levilamina', '--set', 'server.mods=["nope"]'])), /unknown mod/)
})

test('server.versions values stay strings under --set', () => {
  assert.deepEqual(applySets({}, ['server.versions.endstone=0.10', 'server.flavor=endstone', 'ramp.max=0.10']), {
    server: { versions: { endstone: '0.10' }, flavor: 'endstone' }, ramp: { max: 0.1 }
  })
})

test('checkServerHost: Wine is Linux-only, native LeviLamina Windows-only', () => {
  const p = (n: keyof typeof SERVER_PRESETS): ServerSpec => SERVER_PRESETS[n] as ServerSpec
  assert.throws(() => checkServerHost(p('levilamina-wine'), 'win32'), (e: unknown) => e instanceof UsageError && /--server levilamina\)/.test(e.message))
  assert.throws(() => checkServerHost(p('levilamina-levioptimize-wine'), 'win32'), /--server levilamina-levioptimize\)/)
  assert.throws(() => checkServerHost(p('levilamina'), 'linux'), /--server levilamina-wine\)/)
  for (const ok of ['bds', 'endstone', 'levilamina', 'levilamina-levioptimize'] as const) assert.doesNotThrow(() => checkServerHost(p(ok), 'win32'))
  for (const ok of ['bds', 'endstone', 'levilamina-wine', 'levilamina-levioptimize-wine'] as const) assert.doesNotThrow(() => checkServerHost(p(ok), 'linux'))
})

test('moddedBuildCached: marker, game executable and (Endstone) venv must all be there', () => {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-cached-'))
  try {
    assert.equal(moddedBuildCached(root, 'levilamina'), false)
    writeFileSync(join(root, '.bedperf-complete.json'), JSON.stringify({ format: 2, build: { exeName: 'bedrock_server_mod.exe' } }))
    assert.equal(moddedBuildCached(root, 'levilamina'), false, 'executable missing: ensureServer would reinstall')
    mkdirSync(join(root, 'server'))
    writeFileSync(join(root, 'server', 'bedrock_server_mod.exe'), '')
    assert.equal(moddedBuildCached(root, 'levilamina'), true)
    assert.equal(moddedBuildCached(root, 'endstone', 'linux'), false, 'venv missing')
    mkdirSync(join(root, 'venv', 'bin'), { recursive: true })
    writeFileSync(join(root, 'venv', 'bin', 'python'), '')
    assert.equal(moddedBuildCached(root, 'endstone', 'linux'), true)
    writeFileSync(join(root, '.bedperf-complete.json'), JSON.stringify({ format: 1, build: { exeName: 'bedrock_server_mod.exe' } }))
    assert.equal(moddedBuildCached(root, 'levilamina'), false, 'old marker format')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('modded flavors pin BDS 1.26.60.6, which has a bot family', () => {
  assert.equal(botFamily('1.26.60.6', ['1.26.40', '1.26.45', '1.26.51', '1.26.60']), '1.26.60')
})

test('flattenSetVerification: launcher/helper violations fail it, exited members do not', () => {
  const v = (pid: number, violations: PlacementVerification['violations']): PlacementVerification => ({
    verified: violations.length === 0, pid, expectedCpus: [0, 1], processCpus: [0, 1], priority: 'normal', narrowed: [], threadCount: 3, checks: [], violations
  })
  const set: PlacementSetVerification = {
    verified: false,
    server: v(10, []),
    members: [
      { role: 'server', verification: v(10, []) },
      { role: 'launcher', verification: v(9, [{ kind: 'process_gone', message: 'gone' }]) },
      { role: 'aux', verification: v(700, [{ kind: 'process_affinity', message: 'affinity 0-7' }]) }
    ],
    checks: [{ id: 'aux_placement', level: 'fail', summary: 'aux process 700: affinity 0-7' }]
  }
  const f = flattenSetVerification(set)
  assert.equal(f.pid, 10)
  assert.equal(f.verified, false)
  assert.deepEqual(f.violations, [{ kind: 'process_affinity', message: 'aux process 700: affinity 0-7' }])
  assert.equal(flattenSetVerification({ ...set, verified: true, members: set.members.slice(0, 2) }).violations.length, 0)
})
