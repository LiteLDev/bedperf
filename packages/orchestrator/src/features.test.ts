// Engine integration of the measurement-rigor features, on the simulation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RUN_FILES, type BenchmarkConfig, type BotFleetStats, type Envelope, type RunMeta } from '@bedperf/core'
import { parseConfig } from './config.ts'
import { EnvGateError, ExitCodes, exitCodeOf, runBenchmark } from './engine.ts'
import { recomputeRun, parseSamples } from './recompute.ts'
import { runSession, parseOrder, sessionSchedule } from './session.ts'
import { settleCheck, viewsIncomplete } from './settle.ts'
import { createSimDeps, createSimWorld, SimServer, type SimModel } from './sim.ts'

function cfg (over: Record<string, unknown> = {}): BenchmarkConfig {
  return parseConfig({
    name: 'feat',
    scenario: { module: 'sim://idle' },
    ramp: { start: 10, step: 10, max: 40, holdSec: 30, resolution: 2, settle: { mode: 'converge', minSec: 5, maxSec: 60, windowSec: 10, evalSec: 2 } },
    repeats: 1,
    warmupSec: 10,
    cooldownSec: 5,
    sampling: { gametimeIntervalSec: 1 },
    ...over
  })
}

async function withTmp<T> (fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-feat-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run (model: SimModel, config: BenchmarkConfig, dir: string) {
  const { deps, world } = createSimDeps(model, dir)
  const out = await runBenchmark(config, deps)
  return { out, world }
}

async function envelopes (dir: string): Promise<Envelope[]> {
  return parseSamples(await readFile(path.join(dir, RUN_FILES.samples), 'utf8'))
}

const stats = (t: number, uniq: number, spawned = 10): BotFleetStats => ({
  t, target: spawned, connected: spawned, spawned, joinFailures: 0, unexpectedDisconnects: 0, uniqChunks: uniq,
  loadgen: { workers: 1, eventLoopLagP99Ms: 1, maxWorkerCpuPct: 1, saturated: false }
})

test('settleCheck: rate per bot over the window, freshness, coverage', () => {
  const rules = { windowSec: 10, ratePerBot: 0.1, maxDataAgeSec: 5 }
  const flat = Array.from({ length: 12 }, (_, i) => stats(i * 1000, 1000))
  assert.deepEqual(settleCheck(flat, 11_000, rules), { ratePerBot: 0, fresh: true, converged: true })
  const growing = Array.from({ length: 12 }, (_, i) => stats(i * 1000, 1000 + i * 20))
  const g = settleCheck(growing, 11_000, rules)
  assert.equal(g.ratePerBot, 2)
  assert.equal(g.converged, false)
  assert.equal(settleCheck(flat, 30_000, rules).fresh, false)
  assert.equal(settleCheck(flat.slice(0, 3), 2_000, rules).ratePerBot, undefined, 'window not covered')
  assert.deepEqual(settleCheck([], 0, rules), { fresh: false, converged: false })
})

test('viewsIncomplete uses halfMedianFrac, else min vs median', () => {
  const s = stats(0, 0)
  assert.equal(viewsIncomplete(undefined), undefined)
  assert.equal(viewsIncomplete({ ...s, inView: { min: 10, median: 100, max: 120, halfMedianFrac: 0.9 } }), true)
  assert.equal(viewsIncomplete({ ...s, inView: { min: 10, median: 100, max: 120, halfMedianFrac: 0.96 } }), false)
  assert.equal(viewsIncomplete({ ...s, inView: { min: 60, median: 100, max: 120 } }), false)
  assert.equal(viewsIncomplete({ ...s, inView: { min: 10, median: 100, max: 120 } }), undefined)
})

test('steps carry counter TPS, tick CPU, interference, settle and view metrics; meta has placement and gates', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 25, noise: 0.02 }, cfg(), dir)
    assert.equal(out.result.maxPlayers[0], 25)
    assert.equal(out.result.kOk, 1)
    assert.equal(out.result.n, 1)
    assert.deepEqual(out.result.repeats, [{ index: 0, status: 'ok', statusReasons: [], maxPlayers: 25 }])
    const s = out.steps[0]!
    assert.ok(Math.abs(s.counterTps! - 20) < 0.5, `counterTps ${s.counterTps}`)
    assert.ok(s.counterTpsLow5! > 19)
    assert.ok(s.gametimeMaxGapMs! <= 1000)
    assert.equal(s.gametimeLatencyMs!.p50, 15)
    assert.ok(Number.isFinite(s.tickCpuMsPerTick), `tickCpuMsPerTick ${s.tickCpuMsPerTick}`)
    assert.equal(s.tickThreadSource, 'name')
    assert.ok(s.interference!.foreignMean < 0.05)
    assert.equal(s.placementVerified, true)
    assert.equal(s.settleCapped, false)
    assert.ok(s.settleSec! >= 5 && s.settleSec! < 60, `settleSec ${s.settleSec}`)
    assert.equal(s.viewsIncomplete, false)
    assert.ok(s.inViewMedian! > 250)
    assert.ok(s.uniqChunksPerBot! > 250)
    assert.equal(typeof s.chunksPerSec, 'number')
    assert.deepEqual(s.invalidReasons, [])
    const meta = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    assert.equal(meta.placement?.verified, true)
    assert.equal(meta.placement?.method, 'sim')
    assert.ok((meta.placement?.verifications ?? 0) > 2)
    assert.deepEqual(meta.placement?.serverCpus, [0, 1, 2, 3])
    assert.equal((meta.gates as Record<string, unknown>)['minCounterTps'], 19.8)
    assert.deepEqual(meta.network, { loopback: true })
    const envs = await envelopes(out.dir)
    assert.ok(envs.some(e => e.kind === 'bds.gametime'))
    assert.ok(envs.some(e => e.kind === 'sys.interference'))
    const end = envs.find(e => e.kind === 'orch.repeat.end')!.data as { outcome: { status: string, statusReasons: string[] } }
    assert.equal(end.outcome.status, 'ok')
    assert.equal(exitCodeOf(out.result), ExitCodes.ok)
  })
})

test('settle is capped at maxSec when views never converge', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 15, viewDriftPerBot: 1 }, cfg({ ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0, settle: { mode: 'converge', minSec: 5, maxSec: 20, windowSec: 10, evalSec: 2 } } }), dir)
    for (const s of out.steps) {
      assert.equal(s.settleCapped, true)
      assert.equal(s.settleSec, 20)
    }
  })
})

test('fixed settle sleeps settleSec', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 15 }, cfg({ ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0, settleSec: 7, settle: { mode: 'fixed' } } }), dir)
    assert.ok(out.steps.every(s => s.settleSec === 7 && s.settleCapped === false))
  })
})

test('interference during one hold makes that step invalid; the retry passes', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 35, foreignLoad: c => c.holding && c.holds === 2 ? 2 : 0.02 }, cfg(), dir)
    const s1 = out.steps[1]!
    assert.equal(s1.pass, false)
    assert.match(s1.invalidReasons![0]!, /^interference: foreign load 2\.00 cores > 0\.25/)
    assert.equal(out.steps[2]!.players, s1.players, 'retried at the same load')
    assert.equal(out.steps[2]!.pass, true)
    assert.equal(out.result.maxPlayers[0], 35)
    assert.equal(out.result.repeats![0]!.status, 'ok')
  })
})

test('probe and counter TPS disagreeing invalidates steps; the repeat is invalid and rerun once', async () => {
  await withTmp(async dir => {
    const { out, world } = await run({ capacity: 100, gametimeRateOffset: 2 }, cfg(), dir)
    assert.match(out.steps[0]!.invalidReasons![0]!, /^tps_sources_disagree: probe 20\.\d+ vs counter 2\d\.\d+/)
    assert.deepEqual(out.result.repeats!.map(r => [r.index, r.status, r.rerunOf]), [[0, 'invalid', undefined], [1, 'invalid', 0]])
    assert.match(out.result.repeats![0]!.statusReasons[0]!, /invalid twice in a row at 10 players: tps_sources_disagree/)
    assert.equal(out.result.invalidLimited, true)
    assert.equal(out.result.loadgenLimited, false)
    assert.equal(out.result.kOk, 0)
    assert.equal(out.result.maxPlayersMedian, 0)
    assert.equal(exitCodeOf(out.result), ExitCodes.invalid)
    assert.equal(world.servers.length, 2)
  })
})

test('crash is server_failed and not rerun', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 100, crashAbove: 25 }, cfg({ repeats: 2 }), dir)
    assert.deepEqual(out.result.repeats!.map(r => [r.index, r.status, r.maxPlayers]), [[0, 'server_failed', 20], [1, 'server_failed', 20]])
    assert.match(out.result.repeats![0]!.statusReasons[0]!, /server exited unexpectedly/)
    assert.equal(exitCodeOf(out.result), ExitCodes.serverFailed)
  })
})

test('bots failing to join at the first step is server_failed', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 100, maxJoinable: 5 }, cfg(), dir)
    assert.equal(out.result.repeats![0]!.status, 'server_failed')
    assert.match(out.result.repeats![0]!.statusReasons[0]!, /not all bots could join at the first step/)
    assert.equal(out.steps.length, 1)
  })
})

test('a busy machine before a later repeat makes it invalid; it is rerun with a fresh index', async () => {
  await withTmp(async dir => {
    const { out, world } = await run({ capacity: 15, idleForeign: n => n === 1 ? 1 : 0.02 }, cfg({ repeats: 2, ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0 } }), dir)
    assert.deepEqual(out.result.repeats!.map(r => [r.index, r.status, r.rerunOf]), [[0, 'ok', undefined], [1, 'invalid', undefined], [2, 'ok', 1]])
    assert.match(out.result.repeats![1]!.statusReasons[0]!, /^idle_gate: foreign load 1\.00/)
    assert.deepEqual(out.result.maxPlayers, [10, 0, 10])
    assert.equal(out.result.maxPlayersMedian, 10)
    assert.equal(out.result.kOk, 2)
    assert.equal(out.result.n, 3)
    assert.equal(world.idleChecks, 3)
    assert.deepEqual(world.servers.map(s => s.pid === undefined ? -1 : s.pid), [10_000, 10_002])
  })
})

test('a busy machine before the first repeat throws EnvGateError and creates no run dir', async () => {
  await withTmp(async dir => {
    const { deps } = createSimDeps({ capacity: 10, idleForeign: 2 }, dir)
    await assert.rejects(runBenchmark(cfg(), deps), (err: unknown) => err instanceof EnvGateError && err.top[0]!.name === 'sim-hog')
    assert.deepEqual(existsSync(dir) ? await readdir(dir) : [], [])
  })
})

test('placement violation in a hold invalidates the step and marks meta unverified', async () => {
  await withTmp(async dir => {
    // Verification calls: 0 = ready, 1/2 = step 0 hold start/end, 3 = step 1 hold start.
    const { out } = await run({ capacity: 35, placementFailAt: [3] }, cfg(), dir)
    assert.equal(out.steps[1]!.placementVerified, false)
    assert.match(out.steps[1]!.invalidReasons![0]!, /^placement_mismatch: sim: process affinity widened/)
    assert.equal(out.steps[2]!.placementVerified, true)
    assert.equal(out.result.repeats![0]!.status, 'ok')
    const meta = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    assert.equal(meta.placement?.verified, false)
  })
})

test('placement violation at ready makes the repeat invalid', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 35, placementFailAt: [0] }, cfg(), dir)
    assert.equal(out.result.repeats![0]!.status, 'invalid')
    assert.match(out.result.repeats![0]!.statusReasons[0]!, /^placement_mismatch: at ready/)
    assert.equal(out.result.repeats![1]!.status, 'ok')
  })
})

test('a dead tick counter makes the repeat invalid', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 35, gametimeDead: true }, cfg(), dir)
    assert.deepEqual(out.result.repeats!.map(r => r.status), ['invalid', 'invalid'])
    assert.match(out.result.repeats![0]!.statusReasons[0]!, /^gametime_probe_dead/)
    assert.equal(out.steps.length, 0)
  })
})

test('R7: no console command but probe marks inside a hold; the sim refuses others', async () => {
  await withTmp(async dir => {
    const { world } = await run({ capacity: 15 }, cfg({ ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0 } }), dir)
    const inHold = world.commandLog.filter(c => c.holding)
    assert.ok(inHold.length > 0)
    assert.ok(inHold.every(c => /^scriptevent bedperf:mark step-\d+-start$/.test(c.command)), JSON.stringify(inHold))
  })
  const world = createSimWorld({ capacity: 1 })
  const s = new SimServer(world, 1)
  world.holding = true
  assert.throws(() => s.send('gamerule domobspawning false'), /R7/)
  s.send('scriptevent bedperf:mark x')
})

test('recompute from samples.jsonl reproduces steps.json byte for byte', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 35, noise: 0.3, foreignLoad: c => c.holding && c.holds === 2 ? 2 : 0.05 }, cfg({ repeats: 2 }), dir)
    const r = await recomputeRun(out.dir)
    assert.equal(r.steps.length, out.steps.length)
    assert.equal(r.legacySteps, 0)
    assert.equal(r.unchanged, true)
    assert.equal(r.json, await readFile(path.join(out.dir, RUN_FILES.steps), 'utf8'))
    assert.equal(r.manifest.present, true)
    assert.equal(r.manifest.ok, true)
  })
})

test('session schedules: sequential, rotate, seeded', () => {
  const fmt = (o: string): string => sessionSchedule([2, 2], parseOrder(o)).map(i => `${'AB'[i.config]}${i.slot}`).join(' ')
  assert.equal(fmt('sequential'), 'A0 A1 B0 B1')
  assert.equal(fmt('rotate'), 'A0 B0 B1 A1')
  assert.equal(fmt('seeded:7'), fmt('seeded:7'))
  assert.equal(sessionSchedule([3, 1], parseOrder('rotate')).map(i => `${'AB'[i.config]}${i.slot}`).join(' '), 'A0 B0 A1 A2')
  assert.throws(() => parseOrder('random'), /unknown order/)
})

test('rotate session writes one run dir per config and session.json', async () => {
  await withTmp(async dir => {
    const { deps } = createSimDeps({ capacity: 15 }, dir)
    const mk = (name: string): BenchmarkConfig => cfg({ name, repeats: 2, ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0 } })
    const res = await runSession([{ config: mk('a'), deps }, { config: mk('b'), deps }], { sessionId: 's1', dir, order: parseOrder('rotate'), now: deps.now! })
    assert.equal(res.exitCode, 0)
    assert.equal(res.runs.length, 2)
    const session = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')) as { order: string, configs: Array<{ name: string, dir: string }>, schedule: Array<{ config: string, slot: number }>, exitCode: number }
    assert.equal(session.order, 'rotate')
    assert.deepEqual(session.configs.map(c => c.name), ['a', 'b'])
    assert.deepEqual(session.schedule.map(s => `${s.config}${s.slot}`), ['a0', 'b0', 'b1', 'a1'])
    for (const c of session.configs) assert.ok(existsSync(path.join(dir, c.dir, RUN_FILES.result)))
    // Repeats of the two configs alternate in time.
    const starts = (await Promise.all(res.runs.map(async r => (await envelopes(r.dir)).filter(e => e.kind === 'orch.repeat.start').map(e => ({ t: e.t, run: r.result.config })))))
      .flat().sort((x, y) => x.t - y.t).map(x => x.run)
    assert.deepEqual(starts, ['a', 'b', 'b', 'a'])
  })
})
