import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CRITERIA, envelope, Kinds, RUN_FILES, summarize } from '@bedperf/core'
import type { BenchmarkConfig, BotFleetStats, Envelope, ProbeSample, RunMeta, RunResult, StepResult, SysSample } from '@bedperf/core'

export interface FixtureOptions {
  name?: string
  runId?: string
  seed?: number
  /** Mean players at which the tick thread saturates. */
  capacity?: number
  repeats?: number
  /** Epoch ms of the run start. */
  startMs?: number
  rampStart?: number
  rampStep?: number
  rampMax?: number
  resolution?: number
  settleSec?: number
  holdSec?: number
  /** Main-thread utilisation with no players. */
  baseUtil?: number
  baseRssBytes?: number
  memPerPlayerBytes?: number
  netTxPerPlayer?: number
  /** Steps above this player count are invalidated by loadgen saturation. */
  saturateAbove?: number
  /** Omit result.json, as if the run had been aborted. */
  aborted?: boolean
  /** Omit sysmon (sys.sample) envelopes and the derived step fields. */
  noSys?: boolean
  /** Raw lines appended to samples.jsonl (e.g. malformed lines). */
  extraLines?: string[]
}

export interface Fixture {
  dir: string
  config: BenchmarkConfig
  meta: RunMeta
  steps: StepResult[]
  result: RunResult
  /** Per-repeat true capacity used by the model. */
  capacities: number[]
}

function mulberry32 (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MiB = 1024 * 1024

/**
 * Synthesizes a realistic run directory: a ramp + bisect search per repeat, with ~1 Hz probe,
 * sysmon and bot-fleet envelopes carrying noise, and the matching steps.json / result.json.
 * The model saturates the main thread at `capacity` players (±4 % per repeat); TPS drops beyond it.
 */
export async function generateRun (dir: string, opts: FixtureOptions = {}): Promise<Fixture> {
  const o = {
    name: 'walk-default',
    runId: '20260101-000000-fixture',
    seed: 1,
    capacity: 40,
    repeats: 3,
    startMs: Date.UTC(2026, 0, 1, 12, 0, 0),
    rampStart: 10,
    rampStep: 10,
    rampMax: 80,
    resolution: 2,
    settleSec: 5,
    holdSec: 20,
    baseUtil: 0.12,
    baseRssBytes: 720 * MiB,
    memPerPlayerBytes: 9 * MiB,
    netTxPerPlayer: 24_000,
    ...opts
  }
  const rnd = mulberry32(o.seed)
  const gauss = (): number => {
    const u = Math.max(rnd(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
  }

  const config: BenchmarkConfig = {
    name: o.name,
    bdsVersion: '1.26.63.1',
    botVersion: '1.26.60',
    serverProperties: {
      'server-name': 'bedperf',
      'max-players': 200,
      'view-distance': 10,
      'tick-distance': 4,
      'max-threads': 8,
      gamemode: 'survival',
      difficulty: 'easy',
      'level-type': 'DEFAULT',
      'online-mode': false,
      'allow-cheats': true,
      'enable-lan-visibility': false,
      transport: 'raknet',
      'content-log-console-output-enabled': true
    },
    world: { seed: '-1234567890', levelType: 'DEFAULT' },
    scenario: { module: '@bedperf/scenarios/walk', params: { radius: 32 } },
    loadgen: { botsPerWorker: 25, joinIntervalMs: 250 },
    ramp: { start: o.rampStart, step: o.rampStep, max: o.rampMax, settleSec: o.settleSec, holdSec: o.holdSec, resolution: o.resolution },
    criteria: { ...DEFAULT_CRITERIA },
    repeats: o.repeats,
    warmupSec: 10,
    seed: o.seed
  }

  const lines: string[] = []
  const emit = (e: Envelope): void => { lines.push(JSON.stringify(e)) }
  const steps: StepResult[] = []
  const capacities: number[] = []
  let t = o.startMs
  let tick = 0
  emit(envelope('orch', Kinds.runStart, { runId: o.runId }, t))

  for (let r = 1; r <= o.repeats; r++) {
    const cap = o.capacity * (1 + 0.04 * gauss())
    capacities.push(cap)
    const perPlayer = (0.98 - o.baseUtil) / cap
    let players = 0
    let index = 0
    let leak = 0

    /** One second of samples; returns the window's probe sample. */
    const second = (target: number): { probe: ProbeSample, sys: SysSample, bot: BotFleetStats } => {
      players = players < target ? Math.min(target, players + 6) : target
      const load = o.baseUtil + perPlayer * players + 0.012 * gauss()
      const util = Math.min(0.995, Math.max(0.02, load + 0.01 * gauss()))
      const over = Math.max(0, load - 0.98)
      const tps = Math.min(20, over > 0 ? (20 * 0.98) / load + 0.25 * gauss() : 20 - Math.abs(0.03 * gauss()))
      const ticks = Math.round(tps)
      const meanI = 1000 / Math.max(tps, 1)
      const p99 = meanI * (1.04 + 0.03 * Math.min(3, Math.abs(gauss()))) + over * 300
      tick += ticks
      t += 1000
      const probe: ProbeSample = {
        type: 'sample',
        v: 1,
        tick,
        t,
        windowMs: 1000,
        ticks,
        tps: Number(tps.toFixed(3)),
        interval: { mean: meanI, max: p99 * 1.1, p50: meanI, p95: p99 * 0.95, p99 },
        over50: over > 0 ? Math.round(over * 40) : (rnd() < 0.05 ? 1 : 0),
        over100: over > 0.1 ? Math.round(over * 10) : 0,
        players
      }
      if (tick % 5 === 0) probe.entities = { total: 40 + players * 2, byDimension: { overworld: 40 + players * 2 }, topTypes: { 'minecraft:player': players } }
      leak += 4096
      const sys: SysSample = {
        pid: 4242,
        t,
        intervalMs: 1000,
        cpuPct: util * 100 + 18 + players * 0.6 + 3 * gauss(),
        mainThread: { tid: 4243, cpuPct: util * 100, util },
        threadCount: 64,
        rssBytes: o.baseRssBytes + o.memPerPlayerBytes * players + leak + 2 * MiB * gauss(),
        privateBytes: o.baseRssBytes * 1.1 + o.memPerPlayerBytes * players,
        net: {
          rxBytesPerSec: Math.max(0, 3_000 * players * (1 + 0.05 * gauss())),
          txBytesPerSec: Math.max(0, o.netTxPerPlayer * players * (1 + 0.05 * gauss())),
          scope: 'process'
        },
        systemCpuPct: 30 + util * 20
      }
      const rtt = 6 + 4 * players / cap + over * 400
      const bot: BotFleetStats = {
        t,
        target,
        connected: players,
        spawned: players,
        joinFailures: 0,
        unexpectedDisconnects: 0,
        rttMs: summarize(Array.from({ length: 8 }, () => Math.max(1, rtt * (1 + 0.15 * gauss())))),
        correctionsPerSec: over * 30,
        loadgen: { workers: Math.max(1, Math.ceil(players / 25)), eventLoopLagP99Ms: 8, maxWorkerCpuPct: 20 + players, saturated: o.saturateAbove !== undefined && players > o.saturateAbove }
      }
      emit(envelope('probe', Kinds.probeSample, probe, t))
      if (o.noSys !== true) emit(envelope('sys', Kinds.sysSample, sys, t))
      emit(envelope('bot', Kinds.botStats, bot, t))
      return { probe, sys, bot }
    }

    // Warmup.
    for (let i = 0; i < config.warmupSec; i++) second(0)
    if (r === 1) emit(envelope('bds', Kinds.bdsLog, { line: 'Server started.' }, t))

    const runStep = (n: number, phase: 'ramp' | 'bisect'): StepResult => {
      emit(envelope('orch', Kinds.stepStart, { repeat: r, index, players: n, phase }, t))
      for (let i = 0; i < o.settleSec; i++) second(n)
      const startT = t
      const held = Array.from({ length: o.holdSec }, () => second(n))
      const endT = t
      const tpsVals = held.map((h) => h.probe.tps)
      const tps = summarize(tpsVals)
      const tickIntervalMs = summarize(held.map((h) => h.probe.interval.p99))
      const sorted = [...tpsVals].sort((a, b) => a - b)
      const worst = sorted[Math.floor(sorted.length * config.criteria.worstWindowDiscardPct / 100)] ?? Number.NaN
      const saturated = held.some((h) => h.bot.loadgen.saturated)
      const failReasons: string[] = []
      if (saturated) failReasons.push('loadgen saturated: step invalid')
      if (tps.mean < config.criteria.minAvgTps) failReasons.push(`mean TPS ${tps.mean.toFixed(2)} < ${config.criteria.minAvgTps}`)
      if (worst < config.criteria.minWorstWindowTps) failReasons.push(`worst window TPS ${worst.toFixed(2)} < ${config.criteria.minWorstWindowTps}`)
      if (tickIntervalMs.p99 > config.criteria.maxTickIntervalP99Ms) failReasons.push(`tick p99 ${tickIntervalMs.p99.toFixed(1)} ms > ${config.criteria.maxTickIntervalP99Ms} ms`)
      const step: StepResult = {
        repeat: r,
        index,
        players: n,
        phase,
        startT,
        endT,
        tps,
        tickIntervalMs,
        over50: held.reduce((s, h) => s + h.probe.over50, 0),
        over100: held.reduce((s, h) => s + h.probe.over100, 0),
        rttMs: summarize(held.map((h) => h.bot.rttMs!.p95)),
        botFailures: 0,
        loadgenSaturated: saturated,
        pass: failReasons.length === 0,
        failReasons
      }
      if (o.noSys !== true) {
        step.mainThreadUtil = summarize(held.map((h) => h.sys.mainThread!.util))
        step.cpuPct = summarize(held.map((h) => h.sys.cpuPct))
        step.rssBytes = summarize(held.map((h) => h.sys.rssBytes))
        step.netRxBytesPerSec = summarize(held.map((h) => h.sys.net!.rxBytesPerSec)).mean
        step.netTxBytesPerSec = summarize(held.map((h) => h.sys.net!.txBytesPerSec)).mean
      }
      emit(envelope('orch', Kinds.stepEnd, step, t))
      steps.push(step)
      index++
      return step
    }

    let lo = 0
    let hi: number | undefined
    for (let n = o.rampStart; n <= o.rampMax; n += o.rampStep) {
      const s = runStep(n, 'ramp')
      if (s.pass) lo = n
      else if (!s.loadgenSaturated) { hi = n; break } else break
    }
    if (hi !== undefined && o.resolution > 0) {
      while (hi - lo > o.resolution) {
        const mid = Math.floor((lo + hi) / 2)
        const s = runStep(mid, 'bisect')
        if (s.pass) lo = mid
        else if (!s.loadgenSaturated) hi = mid
        else break
      }
    }
    // Scale down and restart on a fresh instance.
    for (let i = 0; i < 3; i++) second(0)
    t += 15_000
  }
  emit(envelope('orch', Kinds.runEnd, { runId: o.runId }, t))
  emit(envelope('orch', 'orch.custom.future', { anything: true }, t))
  lines.push(...(o.extraLines ?? []))

  const maxPlayers = Array.from({ length: o.repeats }, (_, i) => {
    const pass = steps.filter((s) => s.repeat === i + 1 && s.pass).map((s) => s.players)
    return pass.length > 0 ? Math.max(...pass) : 0
  })
  const sortedMax = [...maxPlayers].sort((a, b) => a - b)
  const mid = sortedMax.length >> 1
  const result: RunResult = {
    runId: o.runId,
    config: o.name,
    maxPlayers,
    maxPlayersMedian: sortedMax.length % 2 === 1 ? sortedMax[mid]! : (sortedMax[mid - 1]! + sortedMax[mid]!) / 2,
    capped: maxPlayers.some((m) => m >= o.rampMax),
    loadgenLimited: steps.some((s) => s.loadgenSaturated)
  }
  const meta: RunMeta = {
    runId: o.runId,
    startedAt: new Date(o.startMs).toISOString(),
    finishedAt: new Date(t).toISOString(),
    bdsVersion: config.bdsVersion,
    botVersion: config.botVersion!,
    host: { os: 'win32', arch: 'x64', cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor', cpuCount: 32, totalMemBytes: 64 * 1024 * MiB, hostname: 'bench-01' },
    bedperfVersion: '0.0.0',
    bedbooCommit: 'fc62cc3',
    colocated: true
  }

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, RUN_FILES.config), JSON.stringify(config, null, 2))
  await writeFile(join(dir, RUN_FILES.meta), JSON.stringify(meta, null, 2))
  await writeFile(join(dir, RUN_FILES.steps), JSON.stringify(steps, null, 2))
  if (o.aborted !== true) await writeFile(join(dir, RUN_FILES.result), JSON.stringify(result, null, 2))
  await writeFile(join(dir, RUN_FILES.samples), lines.join('\n') + '\n')
  return { dir, config, meta, steps, result, capacities }
}
