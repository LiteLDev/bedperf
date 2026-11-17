import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  benchConfigSha256, Kinds, RUN_FILES, SERVER_PRESETS, sha256Json,
  type BenchmarkConfig, type BdsServer, type Envelope, type PlacementVerification, type RunMeta, type ServerSpec
} from '@bedperf/core'
import { ConfigError, parseConfig } from './config.ts'
import { runBenchmark } from './engine.ts'
import { createSimDeps, SimServer, simServerBuild } from './sim.ts'

const minimal = { name: 'mini', scenario: { module: '@bedperf/scenarios/idle' } }

function issues (raw: unknown): string[] {
  try {
    parseConfig(raw)
  } catch (err) {
    if (err instanceof ConfigError) return err.issues
    throw err
  }
  return []
}

test('server: absent stays absent; presets parse and get pinned versions', () => {
  assert.equal(parseConfig(minimal).server, undefined)
  const c = parseConfig({ ...minimal, server: SERVER_PRESETS['levilamina-levioptimize-wine'] })
  assert.deepEqual(c.server, { flavor: 'levilamina', mods: ['levioptimize'], runtime: 'wine', versions: { levilamina: '26.60.7', levioptimize: '0.18.0' } })
  const e = parseConfig({ ...minimal, server: { flavor: 'endstone', versions: { endstone: '0.11.14' } } })
  assert.deepEqual(e.server, { flavor: 'endstone', mods: [], runtime: 'native', versions: { endstone: '0.11.14' } })
  assert.deepEqual(parseConfig({ ...minimal, server: { flavor: 'bds' } }).server, { flavor: 'bds', mods: [], runtime: 'native', versions: {} })
  const lc = parseConfig({ ...minimal, server: { flavor: 'levilamina', loaderConfig: { targeted: { enableStatistics: true } } } })
  assert.deepEqual(lc.server?.loaderConfig, { targeted: { enableStatistics: true } })
})

test('server: invalid sections list every problem', () => {
  assert.match(issues({ ...minimal, server: { flavor: 'paper' } }).join('\n'), /server\.flavor: expected one of: bds, levilamina, endstone/)
  assert.match(issues({ ...minimal, server: {} }).join('\n'), /server\.flavor: required/)
  assert.match(issues({ ...minimal, server: { flavor: 'endstone', runtime: 'wine' } }).join('\n'), /server\.runtime: "wine" runs the Windows build of LeviLamina only/)
  assert.match(issues({ ...minimal, server: { flavor: 'bds', runtime: 'docker' } }).join('\n'), /server\.runtime: expected one of: native, wine/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', mods: ['worldedit'] } }).join('\n'), /server\.mods: unknown mod \(known: levioptimize\)/)
  assert.match(issues({ ...minimal, server: { flavor: 'endstone', mods: ['levioptimize'] } }).join('\n'), /server\.mods: mods need flavor levilamina/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', mods: 'levioptimize' } }).join('\n'), /server\.mods: expected an array/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', versions: { endstone: '0.11.15' } } }).join('\n'), /server\.versions\.endstone: applies to flavor endstone, not levilamina/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', versions: { levioptimize: '0.18.0' } } }).join('\n'), /mods does not include levioptimize/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', versions: { levilamina: 26 } } }).join('\n'), /server\.versions\.levilamina: expected a non-empty string/)
  assert.match(issues({ ...minimal, server: { flavor: 'levilamina', versions: { lip: '1' } } }).join('\n'), /server\.versions\.lip: unknown key/)
  assert.match(issues({ ...minimal, server: { flavor: 'endstone', loaderConfig: {} } }).join('\n'), /server\.loaderConfig: only LeviLamina/)
  assert.match(issues({ ...minimal, server: { flavor: 'bds', extra: 1 } }).join('\n'), /server\.extra: unknown key/)
  assert.match(issues({ ...minimal, server: 'levilamina' }).join('\n'), /server: expected an object/)
})

async function withTmp<T> (fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-srv-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function cfg (server?: ServerSpec): BenchmarkConfig {
  return parseConfig({
    name: 'flavor',
    scenario: { module: 'sim://idle' },
    ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0 },
    repeats: 1,
    warmupSec: 10,
    sampling: { gametimeIntervalSec: 1 },
    ...(server !== undefined ? { server } : {})
  })
}

test('sim: meta.server, artifacts.server and benchConfigSha256 are recorded', async () => {
  await withTmp(async dir => {
    const spec = SERVER_PRESETS['levilamina-levioptimize'] as ServerSpec
    const { deps } = createSimDeps({ capacity: 100 }, dir, { server: spec })
    const config = cfg(spec)
    const out = await runBenchmark(config, deps)
    const meta = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    const build = simServerBuild(spec)
    assert.equal(meta.server?.label, 'levilamina+levioptimize')
    assert.equal(meta.server?.bdsVersion, '1.26.60.6')
    assert.deepEqual(meta.server, JSON.parse(JSON.stringify(build)))
    assert.deepEqual(meta.artifacts?.server, build.artifacts)
    assert.deepEqual(meta.server?.loaderConfig, { modules: { crashLogger: { uploadToSentry: false } }, targeted: { enableStatistics: false, vulnerabilityFixes: { limitIPFrequency: false } } })
    const written = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.config), 'utf8')) as BenchmarkConfig
    assert.equal(meta.benchConfigSha256, benchConfigSha256(written))
    assert.equal(meta.configSha256, sha256Json(written))
    // Same benchmark on another server: same benchConfigSha256, different configSha256.
    const other = cfg(SERVER_PRESETS.endstone as ServerSpec)
    assert.equal(benchConfigSha256(other), benchConfigSha256(config))
    assert.notEqual(sha256Json(other), sha256Json(config))
  })
})

test('sim without a server spec writes no meta.server (old behaviour)', async () => {
  await withTmp(async dir => {
    const { deps } = createSimDeps({ capacity: 100 }, dir)
    const out = await runBenchmark(cfg(), deps)
    const meta = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    assert.equal(meta.server, undefined)
    assert.equal(typeof meta.benchConfigSha256, 'string')
  })
})

test('launcher-started server: game pid is sampled and verified, launcher and helpers join the server group', async () => {
  await withTmp(async dir => {
    const { deps, world } = createSimDeps({ capacity: 100 }, dir, { server: SERVER_PRESETS['levilamina-wine'] as ServerSpec })
    const groups: number[][] = []
    const verified: Array<{ pid: number, launcher?: number }> = []
    const sampled: number[] = []
    let auxCalls = 0
    const machine = deps.createMachineSampler!
    deps.createMachineSampler = o => {
      const m = machine(o)
      const set = m.setGroup.bind(m)
      m.setGroup = (g, pids) => { if (g === 'server') groups.push([...pids]); set(g, pids) }
      return m
    }
    const createSampler = deps.createSampler
    deps.createSampler = pid => { sampled.push(pid); return createSampler(pid) }
    const verify = deps.placement!.verifyServer
    deps.placement!.verifyServer = async (pid: number, server?: BdsServer): Promise<PlacementVerification> => {
      verified.push({ pid, ...(server?.launcherPid !== undefined ? { launcher: server.launcherPid } : {}) })
      return await verify(pid)
    }
    deps.createServer = async repeat => {
      const s = new SimServer(world, 10_000 + repeat) as SimServer & { launcherPid?: number, auxPids?: () => Promise<number[]> }
      s.launcherPid = 9_000
      s.auxPids = async () => { auxCalls++; return auxCalls > 1 ? [700, 701] : [700] }
      world.servers.push(s)
      return s
    }
    const out = await runBenchmark(cfg(SERVER_PRESETS['levilamina-wine'] as ServerSpec), deps)
    assert.deepEqual(sampled, [10_000])
    assert.ok(verified.length >= 3)
    assert.ok(verified.every(v => v.pid === 10_000 && v.launcher === 9_000))
    assert.deepEqual(groups[0], [10_000, 9_000, 700])
    // Refreshed before each hold.
    assert.equal(groups.length, 1 + out.steps.length)
    assert.deepEqual(groups.at(-1), [10_000, 9_000, 700, 701])
    const lines = (await readFile(path.join(out.dir, RUN_FILES.samples), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Envelope)
    const ready = lines.find(e => e.kind === Kinds.bdsEvent && (e.data as { event: string }).event === 'ready')
    assert.deepEqual(ready?.data, { event: 'ready', pid: 10_000, launcherPid: 9_000 })
  })
})
