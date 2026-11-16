/**
 * Deterministic simulation of BDS + bot fleet + OS samplers + placement + idle gate on a virtual
 * clock, for tests and dry runs of the engine. Not a performance model of anything real.
 */
import type {
  BdsInstance, BdsServer, BdsServerEvents, BotFleetStats, GametimeSample, InterferenceSample, LoadGenerator, LoadGenOptions, PlacementPlan,
  PlacementVerification, ProbeSample, ProcessGroupName, Sampler, SysSample
} from '@bedperf/core'
import { HOLD_COMMAND_RE, silentLogger, type EngineDeps, type EnginePlacement, type IdleGateResult, type Logger, type MachineSamplerLike } from './engine.ts'

/** Virtual clock: `sleep` advances time instantly, firing due timers in order. */
export class SimClock {
  private t: number
  private seq = 0
  private readonly timers = new Map<number, { due: number, period: number, fn: () => void }>()

  constructor (startT: number = Date.UTC(2026, 0, 1)) {
    this.t = startT
  }

  readonly now = (): number => this.t

  /** Call `fn` every `periodMs`, first at now + periodMs. Returns a cancel function. */
  every (periodMs: number, fn: () => void): () => void {
    if (!(periodMs > 0)) throw new Error('period must be > 0')
    const id = ++this.seq
    this.timers.set(id, { due: this.t + periodMs, period: periodMs, fn })
    return () => { this.timers.delete(id) }
  }

  readonly sleep = async (ms: number): Promise<void> => {
    const target = this.t + Math.max(0, ms)
    for (;;) {
      let nextId: number | undefined
      let nextDue = Infinity
      for (const [id, tm] of this.timers) {
        if (tm.due < nextDue || (tm.due === nextDue && nextId !== undefined && id < nextId)) { nextDue = tm.due; nextId = id }
      }
      if (nextId === undefined || nextDue > target) break
      const tm = this.timers.get(nextId)!
      this.t = nextDue
      tm.due += tm.period
      tm.fn()
    }
    this.t = target
    await Promise.resolve()
  }
}

/** Context handed to time-varying knobs. */
export interface SimKnobContext {
  t: number
  /** Hold windows opened so far (1 during the first hold). */
  holds: number
  /** A hold window is open. */
  holding: boolean
  players: number
}

/** Capacity model. TPS is 20 (minus noise) while players <= capacity, then drops linearly. */
export interface SimModel {
  /** C: players the server holds at 20 TPS. `Infinity` never fails, 0 fails at any load. */
  capacity: number
  /** TPS lost per player above capacity. Default 0.5. */
  tpsDropPerPlayer?: number
  /** Each 1 s window's TPS is reduced by uniform [0, noise). Default 0.05. */
  noise?: number
  /** Loadgen reports saturation while its target exceeds this. */
  saturateAbove?: number
  /** Joins beyond this many bots fail. */
  maxJoinable?: number
  /** Server crashes (unexpected exit) once players exceed this. */
  crashAbove?: number
  seed?: number
  startT?: number
  /** Foreign CPU load on the machine, cores (interference sampler). Default 0.02. */
  foreignLoad?: number | ((ctx: SimKnobContext) => number)
  /** Foreign load seen by idle check number `n` (0-based), cores. Default 0.02. */
  idleForeign?: number | ((n: number) => number)
  /** Tick-counter reply latency, ms. Default 15. */
  gametimeLatencyMs?: number | ((ctx: SimKnobContext) => number)
  /** Ticks per second the tick counter runs ahead of the probe tick counter. Default 0. */
  gametimeRateOffset?: number | ((ctx: SimKnobContext) => number)
  /** The tick counter never answers. */
  gametimeDead?: boolean
  /** Unique chunk columns each bot ends up with. Default 300. */
  viewChunks?: number
  /** Time constant of a bot's chunk loading, s: uniq(t) = U (1 - e^(-t/τ)). Default 3. */
  viewTauSec?: number
  /** Bots keep discovering this many new chunks per second forever (never converges when > ratePerBot). Default 0. */
  viewDriftPerBot?: number
  /** Placement verification calls (0-based, counted over the whole simulation) that fail. */
  placementFailAt?: readonly number[]
}

/** Shared mutable state between the simulated server, fleet and samplers. */
export interface SimWorld {
  clock: SimClock
  model: Required<Pick<SimModel, 'capacity' | 'tpsDropPerPlayer' | 'noise'>> & SimModel
  players: number
  random: () => number
  /** Every console command sent to any simulated server, in order. */
  commands: string[]
  /** `[t, command]` of every command, for R7 checks. */
  commandLog: Array<{ t: number, command: string, holding: boolean }>
  servers: SimServer[]
  /** A hold window is open (set through `EngineDeps.onHold`). */
  holding: boolean
  holds: number
  idleChecks: number
  verifications: number
}

function mulberry32 (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createSimWorld (model: SimModel): SimWorld {
  return {
    clock: new SimClock(model.startT),
    model: { tpsDropPerPlayer: 0.5, noise: 0.05, ...model },
    players: 0,
    random: mulberry32(model.seed ?? 1),
    commands: [],
    commandLog: [],
    servers: [],
    holding: false,
    holds: 0,
    idleChecks: 0,
    verifications: 0
  }
}

function knob (world: SimWorld, v: number | ((ctx: SimKnobContext) => number) | undefined, def: number): number {
  if (v === undefined) return def
  if (typeof v === 'number') return v
  return v({ t: world.clock.now(), holds: world.holds, holding: world.holding, players: world.players })
}

export function simTps (world: SimWorld, players: number): number {
  const { capacity, tpsDropPerPlayer, noise } = world.model
  const base = players <= capacity ? 20 : Math.max(1, 20 - tpsDropPerPlayer * (players - capacity))
  return Math.max(0.5, base - world.random() * noise)
}

export function simMainThreadUtil (world: SimWorld, players: number): number {
  const { capacity } = world.model
  if (players <= 0) return 0.05
  if (capacity <= 0) return 1
  return Math.min(1, Math.max(0.05, players / capacity * 0.9))
}

type Listeners = { [E in keyof BdsServerEvents]?: Set<BdsServerEvents[E]> }

export class SimServer implements BdsServer {
  readonly instance: BdsInstance = { dir: 'sim://bds', version: 'sim', platform: 'win', port: 19132, portV6: 19133, levelName: 'sim' }
  pid: number | undefined
  /** `time query gametime` counter. */
  gametime = 0
  private readonly world: SimWorld
  private readonly listeners: Listeners = {}
  private cancel: (() => void) | undefined
  private tick = 0
  private running = false

  constructor (world: SimWorld, pid: number) {
    this.world = world
    this.pid = pid
  }

  get isRunning (): boolean {
    return this.running
  }

  private emit<E extends keyof BdsServerEvents> (event: E, ...args: Parameters<BdsServerEvents[E]>): void {
    const set = this.listeners[event] as Set<(...a: Parameters<BdsServerEvents[E]>) => void> | undefined
    if (set === undefined) return
    for (const fn of [...set]) fn(...args)
  }

  on<E extends keyof BdsServerEvents> (event: E, listener: BdsServerEvents[E]): this {
    let set = this.listeners[event] as Set<BdsServerEvents[E]> | undefined
    if (set === undefined) {
      set = new Set()
      ;(this.listeners as Record<string, unknown>)[event] = set
    }
    set.add(listener)
    return this
  }

  off<E extends keyof BdsServerEvents> (event: E, listener: BdsServerEvents[E]): this {
    (this.listeners[event] as Set<BdsServerEvents[E]> | undefined)?.delete(listener)
    return this
  }

  async start (): Promise<void> {
    if (this.running) throw new Error('already started')
    this.running = true
    const clock = this.world.clock
    this.cancel = clock.every(1000, () => {
      const players = this.world.players
      if (this.world.model.crashAbove !== undefined && players > this.world.model.crashAbove) {
        this.crash()
        return
      }
      const tps = simTps(this.world, players)
      const ticks = Math.round(tps)
      this.tick += ticks
      this.gametime += Math.max(0, Math.round(ticks + knob(this.world, this.world.model.gametimeRateOffset, 0)))
      const mean = 1000 / tps
      const s: ProbeSample = {
        type: 'sample', v: 1, tick: this.tick, t: clock.now(), windowMs: 1000, ticks, tps,
        interval: { mean, max: mean * 1.15, p50: mean, p95: mean * 1.05, p99: mean * 1.1 },
        over50: tps < 20 ? ticks : Math.floor(ticks * 0.3),
        over100: tps < 10 ? ticks : 0,
        players
      }
      this.emit('line', `[Scripting] BEDPERF|${JSON.stringify(s)}`, 'stdout')
      this.emit('probe', s)
    })
    this.emit('ready')
  }

  private crash (): void {
    this.cancel?.()
    this.running = false
    this.pid = undefined
    this.emit('exit', { code: 1, signal: null, expected: false })
  }

  send (command: string): void {
    // R7: nothing but probe commands may reach the server while a hold window is open.
    if (this.world.holding && !HOLD_COMMAND_RE.test(command)) throw new Error(`R7 violated: '${command}' during a hold window`)
    this.world.commands.push(command)
    this.world.commandLog.push({ t: this.world.clock.now(), command, holding: this.world.holding })
    if (!this.running) return
    const m = /^scriptevent bedperf:mark (.+)$/.exec(command)
    if (m !== null) this.emit('probe', { type: 'mark', v: 1, tick: this.tick, t: this.world.clock.now(), label: m[1]! })
    const p = /^scriptevent bedperf:ping (.+)$/.exec(command)
    if (p !== null) this.emit('probe', { type: 'pong', v: 1, tick: this.tick, t: this.world.clock.now(), id: p[1]! })
  }

  async command (command: string): Promise<string[]> {
    this.send(command)
    return []
  }

  async stop (): Promise<void> {
    if (!this.running) return
    this.cancel?.()
    this.running = false
    this.emit('exit', { code: 0, signal: null, expected: true })
  }
}

export class SimLoadGen implements LoadGenerator {
  private readonly world: SimWorld
  private readonly listeners: Array<(s: BotFleetStats) => void> = []
  private readonly spawnListeners: Array<(pid: number) => void> = []
  private readonly workerPids: number[] = []
  private readonly basePid: number
  private cancel: (() => void) | undefined
  private target = 0
  private joinFailures = 0
  private started = false
  private botsPerWorker = 50
  /** Join time of each live bot, ms. */
  private joins: number[] = []
  private lastUniq: number | undefined

  constructor (world: SimWorld, basePid = 20_000) {
    this.world = world
    this.basePid = basePid
  }

  async start (opts: LoadGenOptions): Promise<void> {
    if (this.started) throw new Error('already started')
    this.started = true
    this.botsPerWorker = opts.botsPerWorker
    this.cancel = this.world.clock.every(opts.statsIntervalMs, () => { this.emitStats(opts.statsIntervalMs) })
  }

  private uniqOf (joinT: number, now: number): number {
    const U = this.world.model.viewChunks ?? 300
    const tau = (this.world.model.viewTauSec ?? 3) * 1000
    const dt = Math.max(0, now - joinT)
    return Math.round(U * (1 - Math.exp(-dt / tau)) + (this.world.model.viewDriftPerBot ?? 0) * dt / 1000)
  }

  private emitStats (intervalMs: number): void {
    const now = this.world.clock.now()
    const sat = this.world.model.saturateAbove !== undefined && this.target > this.world.model.saturateAbove
    const rtt = 1000 / simTps(this.world, this.world.players)
    const per = this.joins.map(j => this.uniqOf(j, now)).sort((a, b) => a - b)
    const uniq = per.reduce((a, b) => a + b, 0)
    const med = per.length > 0 ? per[Math.floor((per.length - 1) / 2)]! : 0
    const tau = (this.world.model.viewTauSec ?? 3) * 1000
    const t90 = this.joins.filter(j => now - j >= tau * Math.LN10).map(() => Math.round(tau * Math.LN10))
    const s: BotFleetStats = {
      t: now,
      target: this.target,
      connected: this.world.players,
      spawned: this.world.players,
      joinFailures: this.joinFailures,
      unexpectedDisconnects: 0,
      rttMs: { n: 4, min: rtt, max: rtt * 1.5, mean: rtt * 1.1, p50: rtt, p95: rtt * 1.3, p99: rtt * 1.45 },
      chunksPerSec: this.lastUniq === undefined ? 0 : Math.max(0, uniq - this.lastUniq) / (intervalMs / 1000),
      uniqChunks: uniq,
      loadgen: { workers: Math.max(1, Math.ceil(this.target / 50)), eventLoopLagP99Ms: sat ? 250 : 5, maxWorkerCpuPct: sat ? 100 : 20, saturated: sat, totalCores: this.world.players * 0.01 }
    }
    if (per.length > 0) {
      s.inView = { min: per[0]!, median: med, max: per.at(-1)!, halfMedianFrac: per.filter(v => v >= 0.5 * med).length / per.length }
      if (t90.length > 0) s.viewT90Ms = { p50: t90[0]!, p90: t90[0]!, max: t90[0]!, n: t90.length }
    }
    this.lastUniq = uniq
    for (const l of this.listeners) l(s)
  }

  async scaleTo (n: number): Promise<void> {
    if (!this.started) throw new Error('not started')
    this.target = n
    const cap = this.world.model.maxJoinable
    const want = cap === undefined ? n : Math.min(n, cap)
    if (want > this.world.players && cap !== undefined && n > cap) this.joinFailures += n - cap
    const workers = Math.ceil(want / Math.max(1, this.botsPerWorker))
    while (this.workerPids.length < workers) {
      const pid = this.basePid + this.workerPids.length
      this.workerPids.push(pid)
      for (const l of this.spawnListeners) l(pid)
    }
    await this.world.clock.sleep(1000)
    const now = this.world.clock.now()
    while (this.joins.length < want) this.joins.push(now)
    if (this.joins.length > want) this.joins = this.joins.slice(0, want)
    this.world.players = want
  }

  onStats (listener: (s: BotFleetStats) => void): void {
    this.listeners.push(listener)
  }

  pids (): number[] {
    return [...this.workerPids]
  }

  onWorkerSpawn (listener: (pid: number) => void): void {
    this.spawnListeners.push(listener)
  }

  async stop (): Promise<void> {
    this.cancel?.()
    this.target = 0
    this.joins = []
    this.world.players = 0
  }
}

export class SimSampler implements Sampler<SysSample> {
  private readonly world: SimWorld
  private readonly pid: number
  private cancel: (() => void) | undefined
  private cpuMs = 0

  constructor (world: SimWorld, pid: number) {
    this.world = world
    this.pid = pid
  }

  async start (onSample: (s: SysSample) => void): Promise<void> {
    this.cancel = this.world.clock.every(1000, () => {
      const players = this.world.players
      const util = simMainThreadUtil(this.world, players)
      this.cpuMs += util * 1000
      onSample({
        pid: this.pid,
        t: this.world.clock.now(),
        intervalMs: 1000,
        cpuPct: util * 100 + 15 + players * 0.5,
        mainThread: { tid: 1, name: 'MC_SERVER', cpuPct: util * 100, util, source: 'name', cpuMs: this.cpuMs },
        threadCount: 40,
        rssBytes: 300e6 + players * 12e6,
        net: { rxBytesPerSec: players * 2000, txBytesPerSec: players * 20000, scope: 'process' }
      })
    })
  }

  async stop (): Promise<void> {
    this.cancel?.()
  }
}

/** Interference sampler: foreign load from `model.foreignLoad`. */
export class SimMachineSampler implements MachineSamplerLike {
  readonly groups: Partial<Record<ProcessGroupName, number[]>> = {}
  private readonly world: SimWorld
  private readonly serverCpus: number[] | undefined
  private cancel: (() => void) | undefined

  constructor (world: SimWorld, serverCpus?: number[]) {
    this.world = world
    this.serverCpus = serverCpus
  }

  setGroup (group: ProcessGroupName, pids: number[]): void {
    this.groups[group] = [...pids]
  }

  async start (onSample: (s: InterferenceSample) => void): Promise<void> {
    this.cancel = this.world.clock.every(1000, () => {
      const foreign = knob(this.world, this.world.model.foreignLoad, 0.02)
      const server = simMainThreadUtil(this.world, this.world.players) + 0.15
      const bots = this.world.players * 0.01
      const groups = { server, bots, harness: 0.05 }
      const s: InterferenceSample = {
        t: this.world.clock.now(),
        intervalMs: 1000,
        cpuBusy: [],
        busyCores: server + bots + 0.05 + foreign,
        groups,
        foreignCores: foreign
      }
      if (this.serverCpus !== undefined) s.serverSetForeignCores = foreign * 0.1
      onSample(s)
    })
  }

  async stop (): Promise<void> {
    this.cancel?.()
  }
}

/** Tick-counter sampler reading `SimServer.gametime`. */
export class SimGametimeSampler implements Sampler<GametimeSample> {
  private readonly world: SimWorld
  private readonly server: SimServer
  private readonly intervalMs: number
  private cancel: (() => void) | undefined

  constructor (world: SimWorld, server: SimServer, intervalMs: number) {
    this.world = world
    this.server = server
    this.intervalMs = intervalMs
  }

  async start (onSample: (s: GametimeSample) => void): Promise<void> {
    this.cancel = this.world.clock.every(this.intervalMs, () => {
      if (this.world.model.gametimeDead === true || !this.server.isRunning) return
      const t = this.world.clock.now()
      const lat = knob(this.world, this.world.model.gametimeLatencyMs, 15)
      onSample({ t, sentAt: t - lat, gametime: this.server.gametime, latencyMs: lat })
    })
  }

  async stop (): Promise<void> {
    this.cancel?.()
  }
}

/** The fixed placement plan of the simulation: server on CPUs 0-3, bots and harness on 4-7. */
export const SIM_PLAN: PlacementPlan = {
  serverCpus: [0, 1, 2, 3],
  botCpus: [4, 5, 6, 7],
  harnessCpus: [4, 5, 6, 7],
  priority: 'normal',
  kind: 'physical',
  checks: [{ id: 'sim', level: 'ok', summary: 'simulated placement' }],
  profileSha256: '0'.repeat(64)
}

export function simPlacement (world: SimWorld): EnginePlacement {
  return {
    plan: SIM_PLAN,
    method: 'sim',
    async verifyServer (pid: number): Promise<PlacementVerification> {
      const n = world.verifications++
      const bad = world.model.placementFailAt?.includes(n) ?? false
      return {
        verified: !bad,
        pid,
        expectedCpus: SIM_PLAN.serverCpus,
        processCpus: bad ? [0, 1, 2, 3, 4] : SIM_PLAN.serverCpus,
        priority: 'normal',
        narrowed: [],
        threadCount: 40,
        checks: [],
        violations: bad ? [{ kind: 'process_affinity', message: 'sim: process affinity widened to 0-4' }] : []
      }
    },
    async applyWorker () {
      return { ok: true }
    }
  }
}

export interface SimFeatures {
  placement?: boolean
  idleCheck?: boolean
  interference?: boolean
  gametime?: boolean
}

/** Engine deps wired to a fresh simulated world. Every feature (placement, idle gate, interference, tick counter) is on unless disabled. */
export function createSimDeps (model: SimModel, runsDir: string, opts: { logger?: Logger, setup?: string[], features?: SimFeatures } = {}): { deps: EngineDeps, world: SimWorld } {
  const world = createSimWorld(model)
  const f = { placement: true, idleCheck: true, interference: true, gametime: true, ...opts.features }
  const deps: EngineDeps = {
    createServer: async repeat => {
      const s = new SimServer(world, 10_000 + repeat)
      world.servers.push(s)
      return s
    },
    createLoadGen: repeat => new SimLoadGen(world, 20_000 + repeat * 100),
    createSampler: pid => new SimSampler(world, pid),
    scenarioSetup: () => opts.setup ?? ['gamerule domobspawning false'],
    runsDir,
    now: world.clock.now,
    sleep: world.clock.sleep,
    logger: opts.logger ?? silentLogger,
    onHold: open => {
      world.holding = open
      if (open) world.holds++
    }
  }
  if (f.placement) deps.placement = simPlacement(world)
  if (f.idleCheck) {
    deps.idleCheck = async ({ durationSec, thresholds }): Promise<IdleGateResult> => {
      const n = world.idleChecks++
      await world.clock.sleep(durationSec * 1000)
      const v = world.model.idleForeign
      const foreign = v === undefined ? 0.02 : typeof v === 'number' ? v : v(n)
      const ok = foreign <= thresholds.foreignMean && foreign <= thresholds.foreignPeak10s
      return {
        ok,
        reasons: ok ? [] : [`foreign load ${foreign.toFixed(2)} cores > ${thresholds.foreignMean}`],
        summary: { samples: durationSec, foreignMean: foreign, foreignPeak10s: foreign },
        top: ok ? [] : [{ pid: 4242, name: 'sim-hog', cores: foreign }]
      }
    }
  }
  if (f.interference) deps.createMachineSampler = ({ serverCpus }) => new SimMachineSampler(world, serverCpus)
  if (f.gametime) deps.createGametimeSampler = (server, intervalMs) => server instanceof SimServer ? new SimGametimeSampler(world, server, intervalMs) : undefined
  return { deps, world }
}
