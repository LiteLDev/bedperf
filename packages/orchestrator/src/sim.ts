/**
 * Deterministic simulation of BDS + bot fleet + OS sampler on a virtual clock, for tests
 * and dry runs of the engine. Not a performance model of anything real.
 */
import type {
  BdsInstance, BdsServer, BdsServerEvents, BotFleetStats, LoadGenerator, LoadGenOptions, ProbeSample, Sampler, SysSample
} from '@bedperf/core'
import { silentLogger, type EngineDeps, type Logger } from './engine.ts'

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
}

/** Shared mutable state between the simulated server, fleet and sampler. */
export interface SimWorld {
  clock: SimClock
  model: Required<Pick<SimModel, 'capacity' | 'tpsDropPerPlayer' | 'noise'>> & SimModel
  players: number
  random: () => number
  /** Every console command sent to any simulated server, in order. */
  commands: string[]
  servers: SimServer[]
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
    servers: []
  }
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
  private readonly world: SimWorld
  private readonly listeners: Listeners = {}
  private cancel: (() => void) | undefined
  private tick = 0
  private running = false

  constructor (world: SimWorld, pid: number) {
    this.world = world
    this.pid = pid
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
    this.world.commands.push(command)
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
  private cancel: (() => void) | undefined
  private target = 0
  private joinFailures = 0
  private started = false

  constructor (world: SimWorld) {
    this.world = world
  }

  async start (opts: LoadGenOptions): Promise<void> {
    if (this.started) throw new Error('already started')
    this.started = true
    this.cancel = this.world.clock.every(opts.statsIntervalMs, () => { this.emitStats() })
  }

  private emitStats (): void {
    const sat = this.world.model.saturateAbove !== undefined && this.target > this.world.model.saturateAbove
    const rtt = 1000 / simTps(this.world, this.world.players)
    const s: BotFleetStats = {
      t: this.world.clock.now(),
      target: this.target,
      connected: this.world.players,
      spawned: this.world.players,
      joinFailures: this.joinFailures,
      unexpectedDisconnects: 0,
      rttMs: { n: 4, min: rtt, max: rtt * 1.5, mean: rtt * 1.1, p50: rtt, p95: rtt * 1.3, p99: rtt * 1.45 },
      loadgen: { workers: Math.max(1, Math.ceil(this.target / 50)), eventLoopLagP99Ms: sat ? 250 : 5, maxWorkerCpuPct: sat ? 100 : 20, saturated: sat }
    }
    for (const l of this.listeners) l(s)
  }

  async scaleTo (n: number): Promise<void> {
    if (!this.started) throw new Error('not started')
    this.target = n
    const cap = this.world.model.maxJoinable
    const want = cap === undefined ? n : Math.min(n, cap)
    if (want > this.world.players && cap !== undefined && n > cap) this.joinFailures += n - cap
    await this.world.clock.sleep(1000)
    this.world.players = want
  }

  onStats (listener: (s: BotFleetStats) => void): void {
    this.listeners.push(listener)
  }

  async stop (): Promise<void> {
    this.cancel?.()
    this.target = 0
    this.world.players = 0
  }
}

export class SimSampler implements Sampler<SysSample> {
  private readonly world: SimWorld
  private readonly pid: number
  private cancel: (() => void) | undefined

  constructor (world: SimWorld, pid: number) {
    this.world = world
    this.pid = pid
  }

  async start (onSample: (s: SysSample) => void): Promise<void> {
    this.cancel = this.world.clock.every(1000, () => {
      const players = this.world.players
      const util = simMainThreadUtil(this.world, players)
      onSample({
        pid: this.pid,
        t: this.world.clock.now(),
        intervalMs: 1000,
        cpuPct: util * 100 + 15 + players * 0.5,
        mainThread: { tid: 1, name: 'MainThread', cpuPct: util * 100, util },
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

/** Engine deps wired to a fresh simulated world. */
export function createSimDeps (model: SimModel, runsDir: string, opts: { logger?: Logger, setup?: string[] } = {}): { deps: EngineDeps, world: SimWorld } {
  const world = createSimWorld(model)
  const deps: EngineDeps = {
    createServer: async repeat => {
      const s = new SimServer(world, 10_000 + repeat)
      world.servers.push(s)
      return s
    },
    createLoadGen: () => new SimLoadGen(world),
    createSampler: pid => new SimSampler(world, pid),
    scenarioSetup: () => opts.setup ?? ['gamerule domobspawning false'],
    runsDir,
    now: world.clock.now,
    sleep: world.clock.sleep,
    logger: opts.logger ?? silentLogger
  }
  return { deps, world }
}
