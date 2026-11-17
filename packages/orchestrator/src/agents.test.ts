// Distributed runs (bots on remote agents) through the engine, on the simulation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Kinds, RUN_FILES, topologySha256, type AgentLinkEvent, type AgentTelemetry, type BenchmarkConfig, type Envelope, type RunMeta } from '@bedperf/core'
import { addressHost, agentAddressId, EngineAgents, isLoopbackHost, localTopology, parseAgentSpecs, resolveBotTargetHost, type AgentPoolLike } from './agents.ts'
import { parseConfig } from './config.ts'
import { evaluateStep } from './criteria.ts'
import { EnvGateError, runBenchmark } from './engine.ts'
import { parseSamples, recomputeRun } from './recompute.ts'
import { createSimDeps, type SimModel } from './sim.ts'

function cfg (over: Record<string, unknown> = {}): BenchmarkConfig {
  return parseConfig({
    name: 'dist',
    scenario: { module: 'sim://idle' },
    ramp: { start: 10, step: 10, max: 40, holdSec: 30, resolution: 2, settle: { mode: 'fixed', minSec: 5 } },
    repeats: 1,
    warmupSec: 10,
    cooldownSec: 5,
    sampling: { gametimeIntervalSec: 1 },
    ...over
  })
}

async function withTmp<T> (fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-dist-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run (model: SimModel, config: BenchmarkConfig, dir: string) {
  const { deps, world } = createSimDeps(model, dir)
  try {
    const out = await runBenchmark(config, deps)
    const meta = JSON.parse(await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    const envs = parseSamples(await readFile(path.join(out.dir, RUN_FILES.samples), 'utf8'))
    return { out, world, meta, envs }
  } finally {
    await deps.agents?.close()
  }
}

const links = (envs: Envelope[]): AgentLinkEvent[] => envs.filter(e => e.kind === Kinds.agentLink).map(e => e.data as AgentLinkEvent)

test('agent specs, bot target host and loopback rules', () => {
  assert.deepEqual(parseAgentSpecs('10.0.0.5:19260, lg2:19261'), [{ address: '10.0.0.5:19260' }, { address: 'lg2:19261' }])
  assert.deepEqual(parseAgentSpecs([{ address: '[::1]:19260', name: 'a', weight: 2, maxBots: 40 }, 'h']), [{ address: '[::1]:19260', name: 'a', weight: 2, maxBots: 40 }, { address: 'h' }])
  assert.throws(() => parseAgentSpecs('a:1,a:1'), /twice/)
  assert.throws(() => parseAgentSpecs('lg1,LG1:19260'), /twice/, 'the default port counts')
  assert.throws(() => parseAgentSpecs('a:99999'), /out of range/)
  assert.throws(() => parseAgentSpecs([{ address: 'a:1', color: 'red' }]), /unknown key/)
  assert.throws(() => parseAgentSpecs([{ address: 'a:1', weight: 0 }]), /weight/)
  assert.equal(addressHost('[::1]:5'), '::1')
  assert.equal(addressHost('10.1.2.3:5'), '10.1.2.3')
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('[::1]') && !isLoopbackHost('10.0.0.1'))
  // all agents on this machine: loopback is derivable
  assert.equal(resolveBotTargetHost([{ address: '127.0.0.1:1' }], undefined), '127.0.0.1')
  assert.throws(() => resolveBotTargetHost([{ address: '10.0.0.5:1' }], undefined), /--bot-target-host is required/)
  assert.throws(() => resolveBotTargetHost([{ address: '10.0.0.5:1' }], '127.0.0.1'), /loopback address/)
  assert.equal(resolveBotTargetHost([{ address: '10.0.0.5:1' }], ' 10.0.0.10 '), '10.0.0.10')
  assert.equal(agentAddressId('10.0.0.5:1').length, 16)
})

test('distributed run: topology meta, agent telemetry and link envelopes, remote placement, no config change', async () => withTmp(async dir => {
  const model: SimModel = { capacity: 25, agents: { count: 3 } }
  const { out, world, meta, envs } = await run(model, cfg(), dir)
  assert.equal(out.result.maxPlayersMedian, 25)
  assert.equal(world.agentConnects, 1)
  const t = meta.topology!
  assert.equal(t.mode, 'remote')
  assert.equal(t.botTargetHost, '10.0.0.10')
  assert.deepEqual(t.agents.map(a => a.name), ['sim-agent-0', 'sim-agent-1', 'sim-agent-2'])
  assert.equal(t.agents[0]!.addressId, agentAddressId('10.0.1.1:19260'))
  assert.ok(!JSON.stringify(t).includes('10.0.1.1'), 'agent addresses are not recorded')
  assert.equal(t.agents[1]!.link?.rttMs.n, 10)
  assert.equal(t.sha256, topologySha256({ mode: 'remote', agents: t.agents }))
  assert.equal(meta.colocated, false)
  assert.deepEqual(meta.network, { loopback: false })
  assert.equal(meta.placement?.mode, 'remote-bots')
  assert.deepEqual(meta.placement?.botCpus, [])
  // telemetry envelopes carry the agent name; link events: connected + stats for each agent
  const tel = envs.filter(e => e.kind === Kinds.agentTelemetry)
  assert.ok(tel.length > 30)
  assert.ok(tel.every(e => e.src === 'agent' && typeof (e.data as AgentTelemetry).agent === 'string'))
  const ls = links(envs)
  assert.equal(ls.filter(e => e.event === 'connected').length, 3)
  assert.equal(ls.filter(e => e.event === 'stats').length, 3)
  // per-agent slices in the fleet stats
  const bots = envs.filter(e => e.kind === Kinds.botStats).at(-1)!.data as { loadgen: { agents?: unknown[] } }
  assert.equal(bots.loadgen.agents?.length, 3)
  // agent hosts are not part of the config: same config hash as a local run
  const local = await run({ capacity: 25 }, cfg(), path.join(dir, 'local'))
  assert.equal(local.meta.configSha256, meta.configSha256)
  assert.deepEqual(local.meta.topology, localTopology())
  assert.notEqual(local.meta.topology!.sha256, t.sha256)
  // the steps recompute unchanged from samples.jsonl
  const rc = await recomputeRun(out.dir)
  assert.ok(rc.unchanged, 'recomputed steps match steps.json')
}))

test('a saturated agent invalidates the steps it saturates', async () => withTmp(async dir => {
  const { out } = await run({ capacity: 100, agents: { count: 2, saturate: { agent: 1, above: 25 } } }, cfg(), dir)
  // saturated above 25: 30 is invalid twice in a row, the search stops at 20
  assert.equal(out.result.maxPlayersMedian, 20)
  assert.ok(out.result.loadgenLimited)
  const bad = out.steps.filter(s => s.players > 25)
  assert.ok(bad.length > 0 && bad.every(s => s.loadgenSaturated && (s.invalidReasons ?? []).includes('loadgen saturated')))
  assert.ok(out.steps.filter(s => s.players <= 25).every(s => s.pass))
}))

test('agent foreign load over the gates invalidates the hold with the agent named', async () => withTmp(async dir => {
  const foreign = ({ holding, agent }: { holding: boolean, agent: number }): number => holding && agent === 0 ? 0.6 : 0.02
  const { out } = await run({ capacity: 100, agents: { count: 2, foreign } }, cfg(), dir)
  const s = out.steps[0]!
  assert.ok((s.invalidReasons ?? []).some(x => /^agent_interference: sim-agent-0 foreign load 0\.60 cores > 0\.25/.test(x)), String(s.invalidReasons))
  assert.equal(out.repeats[0]!.status, 'invalid')
}))

test('an agent lost during a hold: step and repeat invalid, the rerun reconnects', async () => withTmp(async dir => {
  const { out, world, envs } = await run({ capacity: 100, agents: { count: 2, drop: { agent: 1, atHold: 2 } } }, cfg(), dir)
  assert.ok(world.agentDropped)
  assert.equal(world.agentConnects, 2, 'reconnected for the rerun')
  const lostStep = out.steps.find(s => (s.invalidReasons ?? []).some(x => x.startsWith('agent_lost: sim-agent-1')))
  assert.ok(lostStep !== undefined, 'the hold during which the agent was lost is invalid')
  assert.equal(lostStep.index, 1)
  assert.equal(out.repeats.length, 2)
  assert.equal(out.repeats[0]!.status, 'invalid')
  assert.match(out.repeats[0]!.statusReasons[0]!, /^agent_lost: sim-agent-1 \(sim: agent dropped\)/)
  assert.equal(out.repeats[1]!.status, 'ok')
  assert.equal(out.repeats[1]!.rerunOf, 0)
  assert.equal(out.result.maxPlayersMedian, 40)
  const ls = links(envs)
  assert.ok(ls.some(e => e.event === 'lost' && e.agent === 'sim-agent-1'))
  assert.equal(ls.filter(e => e.event === 'connected').length, 4)
  const rc = await recomputeRun(out.dir)
  assert.ok(rc.unchanged)
}))

test('agents that cannot be connected are an environment gate (no run dir)', async () => withTmp(async dir => {
  const { deps } = createSimDeps({ capacity: 10, agents: { count: 2, connectFail: 'connect ECONNREFUSED' } }, dir)
  await assert.rejects(runBenchmark(cfg(), deps), (err: unknown) => err instanceof EnvGateError && /agent 10\.0\.1\.1:19260: connect ECONNREFUSED/.test(err.message))
}))

test('a busy agent machine fails the initial idle gate', async () => withTmp(async dir => {
  const { deps } = createSimDeps({ capacity: 10, agents: { count: 2, idleForeign: 0.9 } }, dir)
  await assert.rejects(runBenchmark(cfg(), deps), (err: unknown) => err instanceof EnvGateError && /agent sim-agent-0: foreign load 0\.90/.test(err.message))
}))

test('evaluateStep: agent_lost and agent_interference', () => {
  const base = { probe: [], sys: [], bots: [] }
  const crit = { minAvgTps: 19, minWorstWindowTps: 18, worstWindowDiscardPct: 0, maxTickIntervalP99Ms: 80, maxBotFailures: 0 }
  const lost = evaluateStep({ ...base, agentsLost: [{ agent: 'a', event: 'lost', reason: 'x' }, { agent: 'a', event: 'lost' }] }, crit)
  assert.deepEqual(lost.invalidReasons, ['agent_lost: a (x)'])
  const tel = (t: number, foreignCores: number): { t: number, data: AgentTelemetry } => ({ t, data: { agent: 'b', intervalMs: 1000, busyCores: 1, botCores: 0.5, foreignCores, logicalCpus: 8, saturated: false, reasons: [] } })
  const quiet = evaluateStep({ ...base, agentTelemetry: [tel(1000, 0.1), tel(2000, 0.1)] }, crit)
  assert.deepEqual(quiet.invalidReasons, [])
  const busy = evaluateStep({ ...base, agentTelemetry: [tel(1000, 0.1), tel(2000, 0.9)] }, crit)
  assert.match(busy.invalidReasons![0]!, /^agent_interference: b foreign load 0\.50 cores > 0\.25/)
})

test('EngineAgents: link events while nobody listens are kept for the next repeat; lost agents trigger a reconnect', async () => {
  let connects = 0
  const alive = [true]
  const pool = (): AgentPoolLike => ({
    agents: [{ name: 'x', spec: { address: '127.0.0.1:1' }, info: { name: 'x', protocol: 1, machine: { fingerprint: 'f', os: 'linux', cpuModel: 'c', logical: 2, ramGiB: 1 }, harness: { version: '0', node: 'v24' }, cpus: 2 }, weight: 1, maxBots: undefined, get alive () { return alive[0]! }, lostReason: undefined }],
    measureLink: async () => ({ x: { rttMs: { min: 1, median: 1, max: 1, n: 1 }, clockOffsetMs: 0 } }),
    idleCheckAll: async () => ({}),
    startTelemetry () {},
    close: async () => {}
  })
  const a = new EngineAgents({
    specs: [{ address: '127.0.0.1:1' }],
    botTargetHost: '127.0.0.1',
    connect: async ev => { connects++; ev.link({ agent: 'x', event: 'connected' }); return pool() }
  })
  const p = await a.ensure()
  assert.equal(await a.ensure(), p)
  assert.equal(connects, 1)
  assert.deepEqual(a.takePending(), [{ agent: 'x', event: 'connected' }])
  assert.deepEqual(a.takePending(), [])
  alive[0] = false
  assert.deepEqual(a.lost(), [{ name: 'x', reason: undefined }])
  alive[0] = true
  await a.ensure()
  assert.equal(connects, 1, 'still alive: no reconnect')
  alive[0] = false
  const q = a.ensure()
  alive[0] = true
  await q
  assert.equal(connects, 2)
  assert.equal(a.topology().agents[0]!.addressId, agentAddressId('127.0.0.1:1'))
  await a.close()
  await assert.rejects(a.ensure(), /closed/)
})
