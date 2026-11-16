import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Kinds, RUN_FILES, type BenchmarkConfig, type Envelope, type RunMeta, type RunResult, type StepResult } from '@bedperf/core'
import { parseConfig } from './config.ts'
import { runBenchmark, type EngineDeps } from './engine.ts'
import { createSimDeps, type SimModel } from './sim.ts'
import { formatStepsTable } from './table.ts'

function cfg (over: Record<string, unknown> = {}): BenchmarkConfig {
  return parseConfig({
    name: 'sim-test',
    scenario: { module: 'sim://idle' },
    ramp: { start: 10, step: 10, max: 100, settleSec: 10, holdSec: 30, resolution: 2 },
    repeats: 3,
    warmupSec: 30,
    ...over
  })
}

async function withTmp<T> (fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-orch-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run (model: SimModel, config: BenchmarkConfig, runsDir: string, patch: Partial<EngineDeps> = {}) {
  const { deps, world } = createSimDeps(model, runsDir)
  const out = await runBenchmark(config, { ...deps, ...patch })
  return { out, world }
}

/** Validates the run dir layout; returns parsed artefacts. */
async function checkRunDir (dir: string): Promise<{ envs: Envelope[], steps: StepResult[], result: RunResult, meta: RunMeta }> {
  const files = await readdir(dir)
  for (const f of [RUN_FILES.config, RUN_FILES.meta, RUN_FILES.samples, RUN_FILES.steps, RUN_FILES.result]) {
    assert.ok(files.includes(f), `missing ${f}`)
  }
  JSON.parse(await readFile(path.join(dir, RUN_FILES.config), 'utf8'))
  const meta = JSON.parse(await readFile(path.join(dir, RUN_FILES.meta), 'utf8')) as RunMeta
  assert.equal(typeof meta.startedAt, 'string')
  assert.equal(typeof meta.finishedAt, 'string')
  assert.ok(meta.host.cpuCount > 0)
  assert.ok(meta.host.totalMemBytes > 0)
  const steps = JSON.parse(await readFile(path.join(dir, RUN_FILES.steps), 'utf8')) as StepResult[]
  const result = JSON.parse(await readFile(path.join(dir, RUN_FILES.result), 'utf8')) as RunResult
  const lines = (await readFile(path.join(dir, RUN_FILES.samples), 'utf8')).split('\n')
  assert.equal(lines.at(-1), '', 'jsonl ends with a newline')
  const envs = lines.slice(0, -1).map((l, i) => {
    const e = JSON.parse(l) as Envelope
    assert.equal(typeof e.t, 'number', `line ${i}: t`)
    assert.ok(['probe', 'sys', 'bot', 'bds', 'orch'].includes(e.src), `line ${i}: src ${e.src}`)
    assert.equal(typeof e.kind, 'string', `line ${i}: kind`)
    assert.ok('data' in e, `line ${i}: data`)
    return e
  })
  for (let i = 1; i < envs.length; i++) assert.ok(envs[i]!.t >= envs[i - 1]!.t, `envelope ${i} goes back in time`)
  assert.equal(envs[0]!.kind, Kinds.runStart)
  assert.equal(envs.at(-1)!.kind, Kinds.runEnd)
  for (const k of [Kinds.probeSample, Kinds.probeMark, Kinds.sysSample, Kinds.botStats, Kinds.stepStart, Kinds.stepEnd]) {
    assert.ok(envs.some(e => e.kind === k), `no ${k} envelope`)
  }
  assert.equal(envs.filter(e => e.kind === Kinds.stepEnd).length, steps.length)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!
    assert.ok(s.endT > s.startT)
    if (i > 0) assert.ok(s.startT >= steps[i - 1]!.endT, `step ${i} not monotonic in time`)
  }
  return { envs, steps, result, meta }
}

test('e2e: capacity 37, step 10, resolution 2, 3 repeats', async () => {
  await withTmp(async dir => {
    const C = 37
    const { out, world } = await run({ capacity: C, noise: 0.1, seed: 7 }, cfg({ ramp: { start: 10, step: 10, max: 200, settleSec: 20, holdSec: 60, resolution: 2 }, warmupSec: 60 }), dir)
    assert.equal(out.result.maxPlayers.length, 3)
    for (const m of out.result.maxPlayers) assert.ok(m >= C - 2 && m <= C, `repeat result ${m}`)
    assert.ok(out.result.maxPlayersMedian >= C - 2 && out.result.maxPlayersMedian <= C)
    assert.equal(out.result.capped, false)
    assert.equal(out.result.loadgenLimited, false)
    assert.equal(out.result.config, 'sim-test')
    assert.equal(out.runId, path.basename(out.dir))
    assert.match(out.runId, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_sim-test$/)

    const { steps, result, envs } = await checkRunDir(out.dir)
    assert.deepEqual(result, out.result)
    assert.equal(steps.length, out.steps.length)
    assert.deepEqual(steps.filter(s => s.repeat === 0).map(s => s.players), [10, 20, 30, 40, 35, 37, 38])
    assert.ok(steps.every(s => s.tps.n === 60), 'each hold has exactly the windows after the start mark')
    assert.ok(steps.filter(s => s.pass).every(s => s.players <= C))
    assert.ok(steps.filter(s => !s.pass).every(s => s.players > C))
    // Setup commands and marks reached the server; one server per repeat, all stopped.
    assert.equal(world.servers.length, 3)
    assert.equal(world.commands.filter(c => c === 'gamerule domobspawning false').length, 3)
    assert.ok(world.commands.includes('scriptevent bedperf:mark step-0-start'))
    assert.ok(envs.some(e => e.kind === 'probe.mark' && (e.data as { label: string }).label === 'step-3-start'))
    assert.equal(envs.filter(e => e.kind === 'orch.repeat.end').length, 3)

    console.log(`\nsteps (capacity ${C}, run ${out.runId}):\n${formatStepsTable(out.steps)}\n`)
  })
})

test('e2e: fail at the first step yields 0', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 0 }, cfg({ repeats: 1 }), dir)
    assert.deepEqual(out.result.maxPlayers, [0])
    assert.equal(out.result.maxPlayersMedian, 0)
    assert.ok(out.steps.every(s => !s.pass))
    assert.equal(out.steps[0]!.players, 10)
    await checkRunDir(out.dir)
  })
})

test('e2e: never-failing server is capped at ramp.max', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: Infinity }, cfg({ repeats: 2, ramp: { start: 10, step: 20, max: 50, settleSec: 5, holdSec: 10, resolution: 2 } }), dir)
    assert.deepEqual(out.result.maxPlayers, [50, 50])
    assert.equal(out.result.capped, true)
    assert.deepEqual(out.steps.filter(s => s.repeat === 0).map(s => s.players), [10, 30, 50])
    await checkRunDir(out.dir)
  })
})

test('e2e: saturating loadgen retries once then stops loadgenLimited', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 100, saturateAbove: 25 }, cfg({ repeats: 1 }), dir)
    assert.equal(out.result.loadgenLimited, true)
    assert.deepEqual(out.result.maxPlayers, [20])
    assert.deepEqual(out.steps.map(s => s.players), [10, 20, 30, 30])
    assert.deepEqual(out.steps.map(s => s.loadgenSaturated), [false, false, true, true])
    assert.equal(out.repeats[0]!.loadgenLimited, true)
    await checkRunDir(out.dir)
  })
})

test('join failures fail the step', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 100, maxJoinable: 24 }, cfg({ repeats: 1, ramp: { start: 10, step: 10, max: 100, settleSec: 5, holdSec: 10, resolution: 1 } }), dir)
    assert.deepEqual(out.result.maxPlayers, [24])
    const failed = out.steps.find(s => s.players === 30)!
    assert.ok(failed.failReasons.some(r => r.startsWith('bot failures')), failed.failReasons.join())
    assert.ok(failed.failReasons.includes('only 24/30 bots spawned'))
  })
})

test('server crash aborts the repeat but the run completes', async () => {
  await withTmp(async dir => {
    const { out } = await run({ capacity: 100, crashAbove: 25 }, cfg({ repeats: 2 }), dir)
    assert.deepEqual(out.result.maxPlayers, [20, 20])
    assert.match(out.repeats[0]!.aborted ?? '', /server exited unexpectedly/)
    // The crash is noticed while settling at 30 players: that step is never measured.
    assert.equal(out.steps.filter(s => s.repeat === 0).at(-1)!.players, 20)
    assert.equal(out.repeats[0]!.firstFail, 30)
    assert.equal(out.repeats[0]!.status, 'server_failed')
    await checkRunDir(out.dir)
  })
})

test('server crash during warmup aborts the repeat without measuring', async () => {
  await withTmp(async dir => {
    // crashAbove -1: the first probe tick (during warmup, 0 players) crashes the server.
    const { out } = await run({ capacity: 100, crashAbove: -1 }, cfg({ repeats: 1 }), dir)
    assert.deepEqual(out.result.maxPlayers, [0])
    assert.equal(out.steps.length, 0)
    assert.match(out.repeats[0]!.aborted ?? '', /server exited unexpectedly/)
    assert.equal(out.repeats[0]!.firstFail, undefined)
  })
})

test('sys/bot intervals overlapping the settle period are trimmed', async () => {
  await withTmp(async dir => {
    // The loadgen is saturated while scaling. Its first stats interval inside the hold still
    // overlaps the scale-up (it began 500 ms before the hold) and reports saturation.
    const { deps } = createSimDeps({ capacity: 100 }, dir)
    let holdStart = Infinity
    let tainted = 0
    const createLoadGen: EngineDeps['createLoadGen'] = r => {
      const lg = deps.createLoadGen(r)
      return {
        start: o => lg.start(o),
        onStats: l => {
          lg.onStats(s => {
            const overlaps = s.t > holdStart && s.t - 1000 < holdStart
            if (overlaps) tainted++
            l(overlaps ? { ...s, loadgen: { ...s.loadgen, saturated: true } } : s)
          })
        },
        stop: () => lg.stop(),
        scaleTo: async n => {
          await lg.scaleTo(n)
          await deps.sleep!(500)
          holdStart = deps.now!() // settleSec 0: the hold starts now
        }
      }
    }
    const out = await runBenchmark(cfg({ repeats: 1, ramp: { start: 10, step: 10, max: 30, settleSec: 0, holdSec: 5, resolution: 2, settle: { mode: 'fixed' } }, sampling: { gametimeIntervalSec: 1 } }), { ...deps, createLoadGen })
    assert.ok(tainted >= 1, 'at least one saturated interval overlapped a hold start')
    assert.ok(out.steps.every(s => !s.loadgenSaturated), out.steps.map(s => s.failReasons.join()).join('|'))
    assert.deepEqual(out.result.maxPlayers, [30])
  })
})

test('setup errors propagate, everything is stopped and the run dir is finalised', async () => {
  await withTmp(async dir => {
    const { deps, world } = createSimDeps({ capacity: 10 }, dir)
    let stopped = 0
    const failing: EngineDeps = {
      ...deps,
      createLoadGen: r => {
        const lg = deps.createLoadGen(r)
        return { ...lg, onStats: l => { lg.onStats(l) }, start: async () => { throw new Error('boom') }, scaleTo: n => lg.scaleTo(n), stop: async () => { stopped++; await lg.stop() } }
      }
    }
    await assert.rejects(runBenchmark(cfg(), failing), /boom/)
    assert.equal(stopped, 1)
    assert.equal(world.servers.length, 1)
    const runs = await readdir(dir)
    assert.equal(runs.length, 1)
    const samples = (await readFile(path.join(dir, runs[0]!, RUN_FILES.samples), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as Envelope)
    const end = samples.at(-1)!
    assert.equal(end.kind, Kinds.runEnd)
    assert.equal((end.data as { ok: boolean }).ok, false)
    const meta = JSON.parse(await readFile(path.join(dir, runs[0]!, RUN_FILES.meta), 'utf8')) as RunMeta
    assert.equal(typeof meta.finishedAt, 'string')
  })
})

test('abort signal stops the run between steps', async () => {
  await withTmp(async dir => {
    const { deps } = createSimDeps({ capacity: 50 }, dir)
    const ac = new AbortController()
    let n = 0
    const sleep = async (ms: number) => { await deps.sleep!(ms); if (++n === 6) ac.abort(new Error('stop requested')) }
    await assert.rejects(runBenchmark(cfg(), { ...deps, sleep }, { signal: ac.signal }), /stop requested/)
  })
})

test('same config name and clock: runIds do not collide', async () => {
  await withTmp(async dir => {
    const c = cfg({ repeats: 1, ramp: { start: 10, step: 10, max: 10, settleSec: 1, holdSec: 2, resolution: 2 } })
    const a = await run({ capacity: 100 }, c, dir)
    const b = await run({ capacity: 100 }, c, dir)
    assert.notEqual(a.out.runId, b.out.runId)
    assert.equal(b.out.runId, `${a.out.runId}-2`)
  })
})
