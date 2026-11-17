import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  benchConfigSha256, DEFAULT_CRITERIA, envelope, FLAVOR_BDS_VERSION, Kinds, NEUTRAL_LOADER_CONFIG, resolveServerSpec, RUN_FILES, serverBuildSha256, serverLabel,
  SERVER_PRESETS, serverSpecSha256, sha256Json, summarize, topologySha256
} from '@bedperf/core'
import type {
  AgentFleetSlice, AgentLinkEvent, AgentTelemetry, BenchmarkConfig, BotFleetStats, Envelope, GametimeSample, InterferenceSample, ProbeSample, RunMeta, RunResult,
  ServerArtifact, ServerBuildInfo, ServerPresetName, ServerSpec, StepResult, SysSample, TopologyMeta
} from '@bedperf/core'

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
  /** Exact per-repeat capacities, overriding `capacity` and its noise. */
  capacities?: number[]
  /** Emit `orch.repeat.start` / `orch.repeat.end` envelopes (default true; false = older run). */
  repeatMarks?: boolean
  /** Number of the first repeat (the orchestrator counts from 0; default 1). */
  repeatBase?: number
  /** Per-repeat overrides of the `orch.repeat.end` outcome, keyed by recorded repeat number. */
  repeatOutcomes?: Record<number, FixtureRepeatOutcome>
  /** Extra meta.json fields (configSha256, machine.fingerprint, ...), merged over the defaults. */
  metaExtra?: Record<string, unknown>
  /**
   * Emit the newer measurements: `sys.interference` and `bds.gametime` envelopes, tick-thread
   * `cpuMs` / `source`, bot view-load fields, the matching StepResult fields (counterTps,
   * tickCpuMsPerTick, interference, settle, views, invalidReasons, ...), provenance in meta.json
   * (configSha256, machine, harness, artifacts, placement, gates) and result.json `repeats[]`.
   */
  extended?: boolean
  /** With `extended`: placement kind recorded in meta.json (default 'physical'). */
  placementKind?: 'physical' | 'vcpu'
  /** With `extended`: harness has uncommitted changes. */
  dirty?: boolean
  /** With `extended`: a foreign-load spike during this step makes it invalid. */
  interferenceStep?: { repeat: number, index: number }
  /** With `extended`: tick-thread CPU per tick per player, ms (default from the util model). */
  tickCpuScale?: number
  /**
   * With `extended`: the server preset that ran. Sets config.server, meta.server (artifacts, build
   * hash, allocator, effective loader config, notes), benchConfigSha256 and a configSha256 that
   * includes the server; BDS is 1.26.60.6 (the build every flavor supports).
   */
  server?: ServerPresetName
  /** With `extended`: host OS (default win32; Wine presets run on linux). */
  os?: 'win32' | 'linux'
  /** With `extended`: bots ran on remote agents (meta.topology and agent envelopes). */
  topology?: FixtureTopology
}

/** Remote bot agents of a fixture run. */
export interface FixtureTopology {
  agents: Array<{ name: string, fingerprint: string, cpuModel: string, logical: number, physical?: number, ramGiB: number, os: string, cpus: number, weight: number, maxBots?: number, rttMs: [number, number, number] }>
  botTargetHost?: string
  /** This agent reports itself saturated during the hold of the first bisect step of `repeat`. */
  saturated?: { agent: string, repeat: number }
  /** This agent's connection is lost after `repeat`'s search (and reconnects for the next repeat). */
  lost?: { agent: string, repeat: number, reason: string }
}

/** Two remote agents; agent-b saturates in repeat 2, agent-a's connection drops after repeat 1. */
export function remoteTopologyFixture (): FixtureTopology {
  return {
    agents: [
      { name: 'agent-3f9a1c20', fingerprint: '3f9a1c20d4e5b6a7', cpuModel: 'Intel(R) Core(TM) i9-13900K', logical: 32, physical: 24, ramGiB: 62.6, os: 'linux', cpus: 16, weight: 1, rttMs: [0.21, 0.34, 0.92] },
      { name: 'agent-8b7c6d5e', fingerprint: '8b7c6d5e4f3a2b1c', cpuModel: 'AMD Ryzen 7 5800X 8-Core Processor', logical: 16, physical: 8, ramGiB: 31.3, os: 'linux', cpus: 8, weight: 1, maxBots: 60, rttMs: [0.28, 0.41, 1.37] }
    ],
    botTargetHost: '10.0.0.10',
    saturated: { agent: 'agent-8b7c6d5e', repeat: 2 },
    lost: { agent: 'agent-3f9a1c20', repeat: 1, reason: 'socket closed (ECONNRESET)' }
  }
}

function fakeSha (...parts: string[]): string {
  return sha256Json(parts)
}

function deepMerge (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k]
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur)
      ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
      : v
  }
  return out
}

/** LeviLamina's upstream config.json defaults (abridged) that the neutral defaults merge over. */
const LEVILAMINA_UPSTREAM_CONFIG = {
  version: 31,
  language: 'system',
  logger: { colorLog: true, logLevel: 4, playerInfoLevel: 'Info' },
  modules: {
    crashLogger: { enabled: true, useBuiltin: true, uploadToSentry: true },
    commands: { tpdimCommand: true, crashCommand: true }
  },
  targeted: {
    enableStatistics: true,
    vulnerabilityFixes: { limitIPFrequency: true, rejectInvalidPackets: true }
  }
}

/** meta.server of a server preset as bds-install would write it (realistic, synthetic hashes). */
export function serverMetaFor (preset: ServerPresetName, os: 'win32' | 'linux' = 'win32', loaderConfig?: Record<string, unknown>): ServerBuildInfo {
  const spec: ServerSpec = resolveServerSpec(loaderConfig !== undefined ? { ...SERVER_PRESETS[preset], mods: [...SERVER_PRESETS[preset].mods], loaderConfig } : { ...SERVER_PRESETS[preset], mods: [...SERVER_PRESETS[preset].mods] })
  const bdsVersion = FLAVOR_BDS_VERSION.levilamina
  const levi = spec.flavor === 'levilamina'
  const platform: 'win' | 'linux' = levi || os === 'win32' ? 'win' : 'linux'
  const artifacts: ServerArtifact[] = [{ name: 'bds', version: bdsVersion, sha256: fakeSha('bds', bdsVersion, platform), source: `https://www.minecraft.net/bedrockdedicatedserver/bin-${platform}/bedrock-server-${bdsVersion}.zip` }]
  if (levi) {
    artifacts.push({ name: 'levilamina', version: spec.versions.levilamina!, sha256: fakeSha('levilamina', spec.versions.levilamina!), source: `github.com/LiteLDev/LeviLamina@${spec.versions.levilamina}` })
    artifacts.push({ name: 'lip', version: '0.29.0', sha256: fakeSha('lip', '0.29.0') })
  }
  if (spec.mods.includes('levioptimize')) artifacts.push({ name: 'levioptimize', version: spec.versions.levioptimize!, sha256: fakeSha('levioptimize', spec.versions.levioptimize!), source: `github.com/LiteLDev/LeviOptimize@${spec.versions.levioptimize}` })
  if (spec.flavor === 'endstone') artifacts.push({ name: 'endstone', version: spec.versions.endstone!, sha256: fakeSha('endstone', spec.versions.endstone!, os), source: `pypi:endstone==${spec.versions.endstone}` })
  if (spec.runtime === 'wine') artifacts.push({ name: 'wine', version: '10.0', sha256: fakeSha('wine', '10.0') })
  const notes: string[] = []
  const info: ServerBuildInfo = {
    spec,
    label: serverLabel(spec),
    specSha256: serverSpecSha256(spec),
    bdsVersion,
    binaryPlatform: platform,
    exeName: levi ? 'bedrock_server_mod.exe' : platform === 'win' ? 'bedrock_server.exe' : 'bedrock_server',
    artifacts,
    buildSha256: serverBuildSha256(artifacts),
    notes
  }
  if (spec.flavor === 'endstone' && os === 'linux') {
    info.allocator = 'mimalloc-preload'
    notes.push('Endstone preloads mimalloc on Linux (LD_PRELOAD); the other flavors run the binary\'s own allocator.')
  }
  if (levi) {
    info.loaderConfig = deepMerge(deepMerge(LEVILAMINA_UPSTREAM_CONFIG, NEUTRAL_LOADER_CONFIG.levilamina), spec.loaderConfig ?? {})
    notes.push('LeviLamina is installed with lip; telemetry, crash upload and per-IP connection throttling are turned off (benchmark-neutral defaults).')
  }
  if (spec.runtime === 'wine') notes.push('The Windows LeviLamina build runs under Wine 10.0 on a Linux host (WINEPREFIX per instance, wineserver stopped between repeats).')
  return info
}

export interface FixtureRepeatOutcome {
  status?: 'ok' | 'invalid' | 'server_failed'
  statusReasons?: string[]
  /** `outcome.aborted`, as an orchestrator sets it when the server exits mid-repeat. */
  aborted?: string
  /** Do not emit `orch.repeat.end` for this repeat (the run was cut off). */
  noEnd?: boolean
  /** Emit `orch.repeat.end` with `outcome: null` (the repeat threw). */
  nullOutcome?: boolean
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
  const serverInfo = o.extended === true && o.server !== undefined ? serverMetaFor(o.server, o.os ?? (SERVER_PRESETS[o.server].runtime === 'wine' ? 'linux' : 'win32')) : undefined
  if (serverInfo !== undefined) {
    // Same benchmark across server fixtures: `seed` only varies the synthetic noise.
    config.seed = 1
    config.bdsVersion = serverInfo.bdsVersion
    config.server = { ...SERVER_PRESETS[o.server!], mods: [...SERVER_PRESETS[o.server!].mods] }
  }
  const topo = o.extended === true ? o.topology : undefined
  const weights = topo?.agents.reduce((s, a) => s + a.weight, 0) ?? 1
  let satAgent: string | undefined

  const lines: string[] = []
  const emit = (e: Envelope): void => { lines.push(JSON.stringify(e)) }
  const steps: StepResult[] = []
  const capacities: number[] = []
  let t = o.startMs
  let tick = 0
  emit(envelope('orch', Kinds.runStart, { runId: o.runId }, t))
  const linkStats = (a: FixtureTopology['agents'][number]): AgentLinkEvent['stats'] => ({ rttMs: { min: a.rttMs[0], median: a.rttMs[1], max: a.rttMs[2], n: 20 }, clockOffsetMs: 3.2 })
  for (const a of topo?.agents ?? []) {
    emit(envelope('orch', Kinds.agentLink, { agent: a.name, event: 'connected' } satisfies AgentLinkEvent, t))
    emit(envelope('orch', Kinds.agentLink, { agent: a.name, event: 'stats', stats: linkStats(a) } satisfies AgentLinkEvent, t))
  }

  const base = o.repeatBase ?? 1
  const ext = o.extended === true
  const cpuScale = o.tickCpuScale ?? 1
  for (let k = 1; k <= o.repeats; k++) {
    const r = k - 1 + base
    const noise = o.capacity * (1 + 0.04 * gauss())
    const cap = o.capacities?.[k - 1] ?? noise
    if (o.repeatMarks !== false) emit(envelope('orch', 'orch.repeat.start', { repeat: r }, t))
    capacities.push(cap)
    const perPlayer = (0.98 - o.baseUtil) / cap
    let players = 0
    let index = 0
    let leak = 0
    // Fresh server per repeat: new tick thread, CPU time and tick counter start over.
    const tid = 4243 + k
    let cpuMs = 0
    const tick0 = tick
    let spike = false
    let lastGametime = Number.NEGATIVE_INFINITY

    /** One second of samples; returns the window's probe sample. */
    const second = (target: number): { probe: ProbeSample, sys: SysSample, bot: BotFleetStats, intf?: InterferenceSample } => {
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
      cpuMs += util * 1000 * cpuScale
      const sys: SysSample = {
        pid: 4242,
        t,
        intervalMs: 1000,
        cpuPct: util * 100 + 18 + players * 0.6 + 3 * gauss(),
        mainThread: ext ? { tid, name: 'MC_SERVER', cpuPct: util * 100, util, source: 'name', cpuMs: Math.round(cpuMs) } : { tid: 4243, cpuPct: util * 100, util },
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
      if (topo !== undefined) {
        // Bots split across agents by weight; each agent reports its fleet slice and machine telemetry.
        const slices: AgentFleetSlice[] = topo.agents.map((a) => {
          const bots = Math.round(players * a.weight / weights)
          const sat = satAgent === a.name
          return { agent: a.name, workers: Math.max(1, Math.ceil(bots / 25)), bots, totalCores: Number((0.12 + bots * 0.035 + (sat ? a.cpus * 0.8 : 0) + 0.02 * rnd()).toFixed(3)), eventLoopLagP99Ms: sat ? 240 : 6 + 4 * rnd(), maxWorkerCpuPct: sat ? 99 : 15 + bots, saturated: sat }
        })
        bot.loadgen.agents = slices
        bot.loadgen.saturated = bot.loadgen.saturated || slices.some((s) => s.saturated)
        bot.loadgen.totalCores = slices.reduce((s, x) => s + (x.totalCores ?? 0), 0)
        for (const [i, a] of topo.agents.entries()) {
          const sl = slices[i]!
          const foreign = 0.04 + 0.03 * rnd()
          const tel: AgentTelemetry = {
            agent: a.name,
            intervalMs: 1000,
            busyCores: Number((sl.totalCores + 0.08 + foreign).toFixed(3)),
            botCores: sl.totalCores,
            foreignCores: Number(foreign.toFixed(3)),
            logicalCpus: a.logical,
            netRxBytesPerSec: sl.bots * 24_000,
            netTxBytesPerSec: sl.bots * 3_000,
            saturated: sl.saturated,
            reasons: sl.saturated ? [`cpu: bot workers ${sl.totalCores.toFixed(1)}/${a.cpus} cores`, 'event loop lag p99 240 ms'] : []
          }
          emit(envelope('agent', Kinds.agentTelemetry, tel, t))
        }
      }
      let intf: InterferenceSample | undefined
      if (ext) {
        const p50 = 1200 + 35 * players + over * 20_000 + 150 * gauss()
        bot.chunksPerSec = Math.max(0, players * 11 * (1 + 0.1 * gauss()))
        bot.uniqChunks = players * (420 + 2 * players)
        bot.inView = { min: Math.max(0, 300 - over * 900), median: Math.max(0, 437 - over * 400 + 2 * gauss()), max: 441 }
        bot.viewT90Ms = { p50: Math.max(100, p50), p90: Math.max(100, p50 * 1.6), max: Math.max(100, p50 * 2.4), n: players }
        const foreign = (spike ? 1.4 : 0.06) + 0.03 * gauss()
        intf = {
          t,
          intervalMs: 1000,
          cpuBusy: [util, 0.3, 0.2, 0.1],
          busyCores: util + 0.6 + foreign,
          groups: { server: util + 0.3, bots: 0.25 + players * 0.01, harness: 0.05 },
          foreignCores: foreign,
          serverSetForeignCores: (spike ? 0.5 : 0.01) + 0.005 * gauss()
        }
        emit(envelope('sys', Kinds.sysInterference, intf, t))
        // Tick counter every 5 s, a few ms of console round trip.
        if ((t - o.startMs) % 5000 === 0) {
          const latencyMs = 2 + Math.round(Math.abs(gauss()) * 2)
          const gametime = Math.max(lastGametime, tick - tick0)
          lastGametime = gametime
          const g: GametimeSample = { t, sentAt: t - latencyMs, gametime, latencyMs }
          emit(envelope('bds', Kinds.bdsGametime, g, t))
        }
      }
      emit(envelope('probe', Kinds.probeSample, probe, t))
      if (o.noSys !== true) emit(envelope('sys', Kinds.sysSample, sys, t))
      emit(envelope('bot', Kinds.botStats, bot, t))
      return intf !== undefined ? { probe, sys, bot, intf } : { probe, sys, bot }
    }

    // Warmup.
    for (let i = 0; i < config.warmupSec; i++) second(0)
    if (k === 1) emit(envelope('bds', Kinds.bdsLog, { line: 'Server started.' }, t))

    const runStep = (n: number, phase: 'ramp' | 'bisect'): StepResult => {
      emit(envelope('orch', Kinds.stepStart, { repeat: r, index, players: n, phase }, t))
      for (let i = 0; i < o.settleSec; i++) second(n)
      const startT = t
      spike = ext && o.interferenceStep !== undefined && o.interferenceStep.repeat === r && o.interferenceStep.index === index
      const firstBisect = phase === 'bisect' && !steps.some((s) => s.repeat === r && s.phase === 'bisect')
      satAgent = topo?.saturated !== undefined && topo.saturated.repeat === r && firstBisect ? topo.saturated.agent : undefined
      const held = Array.from({ length: o.holdSec }, () => second(n))
      spike = false
      satAgent = undefined
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
      if (ext) {
        const x = step as StepResult & Record<string, unknown>
        const ticks = held.reduce((sum, h) => sum + h.probe.ticks, 0)
        const blocks = Array.from({ length: Math.floor(held.length / 5) }, (_, i) => held.slice(i * 5, i * 5 + 5).reduce((sum, h) => sum + h.probe.ticks, 0) / 5)
        const intf = held.map((h) => h.intf!)
        const foreign = intf.map((i) => i.foreignCores)
        const peak = Math.max(...foreign.map((_, i) => summarize(foreign.slice(i, i + 10)).mean).slice(0, Math.max(1, foreign.length - 9)))
        const interference = { samples: intf.length, foreignMean: summarize(foreign).mean, foreignPeak10s: peak, serverSetForeignMean: summarize(intf.map((i) => i.serverSetForeignCores!)).mean }
        const invalidReasons: string[] = []
        if (saturated) invalidReasons.push('loadgen saturated')
        if (interference.foreignMean > 0.5) invalidReasons.push(`interference: foreign mean ${interference.foreignMean.toFixed(2)} cores > 0.50`)
        const overloaded = n > cap
        x.counterTps = ticks / held.length
        x.counterTpsLow5 = blocks.length > 0 ? Math.min(...blocks) : x.counterTps
        x.gametimeMaxGapMs = 5000
        x.gametimeLatencyMs = summarize([2, 3, 2, 4])
        x.tickCpuMsPerTick = summarize(held.map((h) => h.sys.mainThread!.util * 1000 * cpuScale / Math.max(1, h.probe.ticks))).mean
        x.tickThreadSource = 'name'
        x.interference = interference
        x.placementVerified = true
        x.settleSec = overloaded ? o.settleSec * 3 : o.settleSec
        x.settleCapped = overloaded
        x.viewsIncomplete = n > cap * 1.15
        x.inViewMedian = summarize(held.map((h) => h.bot.inView!.median)).mean
        x.viewT90MsP50 = summarize(held.map((h) => h.bot.viewT90Ms!.p50)).mean
        x.chunksPerSec = summarize(held.map((h) => h.bot.chunksPerSec!)).mean
        x.uniqChunksPerBot = n > 0 ? held.at(-1)!.bot.uniqChunks! / Math.max(1, held.at(-1)!.bot.spawned) : 0
        x.invalidReasons = invalidReasons
        if (invalidReasons.length > 0 && !saturated) {
          step.pass = false
          step.failReasons = [...failReasons, ...invalidReasons.map((reason) => `${reason}: step invalid`)]
        }
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
    const invalidStep = (s: StepResult): boolean => s.loadgenSaturated || ((s as StepResult & { invalidReasons?: string[] }).invalidReasons?.length ?? 0) > 0
    for (let n = o.rampStart; n <= o.rampMax; n += o.rampStep) {
      let s = runStep(n, 'ramp')
      // An interference-invalid step is retried once (a saturated loadgen ends the search).
      if (!s.loadgenSaturated && invalidStep(s)) s = runStep(n, 'ramp')
      if (s.pass) lo = n
      else if (!invalidStep(s)) { hi = n; break } else break
    }
    if (hi !== undefined && o.resolution > 0) {
      while (hi - lo > o.resolution) {
        const mid = Math.floor((lo + hi) / 2)
        let s = runStep(mid, 'bisect')
        if (!s.loadgenSaturated && invalidStep(s)) s = runStep(mid, 'bisect')
        if (s.pass) lo = mid
        else if (!invalidStep(s)) hi = mid
        else break
      }
    }
    // Scale down and restart on a fresh instance.
    for (let i = 0; i < 3; i++) second(0)
    if (topo?.lost !== undefined && topo.lost.repeat === r) {
      emit(envelope('orch', Kinds.agentLink, { agent: topo.lost.agent, event: 'lost', reason: topo.lost.reason } satisfies AgentLinkEvent, t))
      emit(envelope('orch', Kinds.agentLink, { agent: topo.lost.agent, event: 'connected' } satisfies AgentLinkEvent, t + 4000))
    }
    const ov = o.repeatOutcomes?.[r] ?? {}
    if (o.repeatMarks !== false && ov.noEnd !== true) {
      const passing = steps.filter((s) => s.repeat === r && s.pass).map((s) => s.players)
      const best = passing.length > 0 ? Math.max(...passing) : 0
      const outcome: Record<string, unknown> = {
        done: true,
        repeat: r,
        maxPlayers: best,
        capped: best >= o.rampMax,
        loadgenLimited: steps.some((s) => s.repeat === r && s.loadgenSaturated)
      }
      if (ov.aborted !== undefined) outcome.aborted = ov.aborted
      if (ov.status !== undefined) outcome.status = ov.status
      if (ov.statusReasons !== undefined) outcome.statusReasons = ov.statusReasons
      emit(envelope('orch', 'orch.repeat.end', { repeat: r, outcome: ov.nullOutcome === true ? null : outcome }, t))
    }
    t += 15_000
  }
  emit(envelope('orch', Kinds.runEnd, { runId: o.runId }, t))
  emit(envelope('orch', 'orch.custom.future', { anything: true }, t))
  lines.push(...(o.extraLines ?? []))

  const maxPlayers = Array.from({ length: o.repeats }, (_, i) => {
    const pass = steps.filter((s) => s.repeat === i + base && s.pass).map((s) => s.players)
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
  if (ext) {
    const statuses = maxPlayers.map((mp, i) => {
      const ov = o.repeatOutcomes?.[i + base] ?? {}
      const status = ov.status ?? (ov.aborted !== undefined || ov.nullOutcome === true ? (ov.nullOutcome === true ? 'invalid' : 'server_failed') : 'ok')
      return { index: i + base, status, statusReasons: ov.statusReasons ?? (ov.aborted !== undefined ? [ov.aborted] : []), maxPlayers: mp }
    })
    Object.assign(result, { repeats: statuses, kOk: statuses.filter((x) => x.status === 'ok').length, n: statuses.length, invalidLimited: false })
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
  if (ext) {
    const vcpu = o.placementKind === 'vcpu'
    Object.assign(meta, {
      configSha256: '5be0c3a7d1f04e29b6a8c7d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2',
      machine: { fingerprint: vcpu ? '9d3c4b5a6f7e8d90' : '1a2b3c4d5e6f7a8b', os: 'win32', cpuModel: 'AMD Ryzen 9 7950X 16-Core Processor', logical: 32, ...(vcpu ? {} : { physical: 16 }), ramGiB: 63.2 },
      harness: { version: '0.0.0', git: '2acaef1d6c5b4a39281706f5e4d3c2b1a0918273', dirty: o.dirty === true, node: 'v24.11.0' },
      artifacts: {
        bdsZipSha256: '8e1d4c2b9a7f6e5d4c3b2a19f8e7d6c5b4a39281706f5e4d3c2b1a0918273645',
        probePackSha256: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
        bedbooCommit: 'fc62cc3'
      },
      placement: {
        profileSha256: 'c0ffee00d15ea5e0c0ffee00d15ea5e0c0ffee00d15ea5e0c0ffee00d15ea5e0',
        kind: vcpu ? 'vcpu' : 'physical',
        method: vcpu ? 'affinity (vcpu)' : 'affinity + priority class',
        serverCpus: [0, 1, 2, 3, 4, 5, 6, 7],
        botCpus: [8, 9, 10, 11, 12, 13, 14, 15],
        priority: 'above_normal',
        verified: true,
        checks: [
          { id: 'server-smt-siblings', level: 'ok', summary: 'server CPUs take whole physical cores' },
          { id: 'bot-separate-cores', level: vcpu ? 'warn' : 'ok', summary: vcpu ? 'virtual CPUs: core separation cannot be verified' : 'bots run on separate physical cores' }
        ]
      },
      gates: { foreignMean: 0.5, foreignPeak10s: 1.0, serverSetForeignMean: 0.1, settleMaxSec: o.settleSec * 3, minOkRepeats: 3 }
    })
    const linux = (o.os ?? (serverInfo?.spec.runtime === 'wine' ? 'linux' : 'win32')) === 'linux'
    if (linux) {
      meta.host = { ...meta.host, os: 'linux' }
      meta.machine = { ...meta.machine!, fingerprint: vcpu ? '7c6b5a4f3e2d1c0b' : 'a1b2c3d4e5f6a7b8', os: 'linux' }
    }
    if (serverInfo !== undefined) {
      meta.server = serverInfo
      meta.configSha256 = sha256Json(config)
      meta.benchConfigSha256 = benchConfigSha256(config)
      const bds = serverInfo.artifacts.find((x) => x.name === 'bds')
      meta.artifacts = { ...meta.artifacts, ...(bds?.sha256 !== undefined ? { bdsZipSha256: bds.sha256 } : {}), server: serverInfo.artifacts }
    }
    if (topo !== undefined) {
      const agents: TopologyMeta['agents'] = topo.agents.map((a, i) => ({
        name: a.name,
        addressId: fakeSha('addr', a.name).slice(0, 12),
        machine: { fingerprint: a.fingerprint, os: a.os, cpuModel: a.cpuModel, logical: a.logical, ...(a.physical !== undefined ? { physical: a.physical } : {}), ramGiB: a.ramGiB },
        harness: { version: '0.0.0', git: '2acaef1d6c5b4a39281706f5e4d3c2b1a0918273', dirty: false, node: 'v24.11.0' },
        cpus: a.cpus,
        weight: a.weight,
        ...(a.maxBots !== undefined ? { maxBots: a.maxBots } : {}),
        link: { rttMs: { min: a.rttMs[0], median: a.rttMs[1], max: a.rttMs[2], n: 20 }, clockOffsetMs: 3.2 + i },
        placement: { botCpus: Array.from({ length: a.cpus }, (_, k) => a.logical - a.cpus + k), verified: true }
      }))
      meta.topology = { mode: 'remote', ...(topo.botTargetHost !== undefined ? { botTargetHost: topo.botTargetHost } : {}), agents, sha256: topologySha256({ mode: 'remote', agents }) }
      meta.colocated = false
      meta.network = { loopback: false }
    }
  }
  await writeFile(join(dir, RUN_FILES.meta), JSON.stringify({ ...meta, ...o.metaExtra }, null, 2))
  await writeFile(join(dir, RUN_FILES.steps), JSON.stringify(steps, null, 2))
  if (o.aborted !== true) await writeFile(join(dir, RUN_FILES.result), JSON.stringify(result, null, 2))
  await writeFile(join(dir, RUN_FILES.samples), lines.join('\n') + '\n')
  return { dir, config, meta, steps, result, capacities }
}
