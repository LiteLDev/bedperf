// @bedperf/loadgen: multi-process bedboo bot fleet implementing the core LoadGenerator contract.
// The controller (this module) assigns bot indices to worker processes (src/worker.ts), staggers joins
// globally, tracks per-bot state from worker events and aggregates worker reports into fleet stats.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { LoadGenerator, LoadGenOptions } from '@bedperf/core'
import { aggregateStats, DEFAULT_SATURATION, type FleetStats, type SaturationThresholds } from './aggregate.ts'
import type { BotEvent, ControllerMessage, RttOptions, WorkerInit, WorkerMessage, WorkerStats } from './protocol.ts'

export { aggregateAgents, aggregateStats, aggregateView, censoredMedian, nearestRank, DEFAULT_SATURATION } from './aggregate.ts'
export { ViewTracker, VIEW_N, inView, t90Rank, type BotViewSample } from './view.ts'
export type { AggregateInput, FleetStats, LiveWorker, SaturationThresholds } from './aggregate.ts'
export type { RttOptions, WorkerInit, ControllerMessage, WorkerMessage, WorkerStats, BotEvent } from './protocol.ts'
export { botRandom, botSeed, mulberry32, isSampled } from './rng.ts'

/** Module URL of the builtin `idle` scenario (bots stand still). */
export const IDLE_SCENARIO = new URL('./scenarios/idle.ts', import.meta.url).href

export const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url))

export const DEFAULT_RTT: RttOptions = { sampleRatio: 0.1, intervalMs: 5000, timeoutMs: 5000 }

/** LoadGenOptions plus loadgen-specific knobs (all optional). */
export interface BotFleetOptions extends LoadGenOptions {
  /** createBot → spawn deadline per bot, ms. Default 60000. */
  joinTimeoutMs?: number
  /** After asking a bot to leave, consider it gone after this long even without `end`, ms. Default 5000. */
  leaveTimeoutMs?: number
  /** start(): time worker 0 gets to load bedboo and the scenario, ms. Default 60000. */
  readyTimeoutMs?: number
  /** stop(): time workers get to end their bots before they are killed, ms. Default 10000. */
  stopGraceMs?: number
  /**
   * RTT probe. Also overridable per run via scenarioParams `rttSampleRatio` / `rttIntervalMs` / `rttTimeoutMs`.
   * Needs operator permission on the server (`default-player-permission-level=operator`).
   */
  rtt?: Partial<RttOptions>
  saturation?: Partial<SaturationThresholds>
  /**
   * Force full chunk payloads: keep the client blob cache reported as disabled and answer any blob hash with
   * `client_cache_blob_status { missing: all }`. Also settable per run via scenarioParams `forceFullChunks`.
   */
  forceFullChunks?: boolean
  /** Registry name of the scenario (see `WorkerInit.scenarioName`); lets remote agents use their local copy. */
  scenarioName?: string
  /** Node flags for worker processes. Default []. */
  workerExecArgv?: string[]
  /** Worker log lines (bot errors, stdout/stderr). Default: written to stderr with a `[loadgen wN]` prefix. */
  onLog?: (workerId: number, line: string) => void
}

/** Transport to one worker; the default forks src/worker.ts, tests inject fakes. */
export interface WorkerLink {
  send (msg: ControllerMessage): void
  onMessage (cb: (msg: WorkerMessage) => void): void
  onExit (cb: (code: number | null) => void): void
  kill (): void
  /** OS process id, when the worker is a real process on this machine (remote workers have none). */
  pid?: number
  /** Name of the remote agent running this worker; labelled links get a per-agent slice in the stats. */
  agent?: string
}

export type WorkerFactory = (workerId: number, opts: BotFleetOptions) => WorkerLink

export function forkWorker (workerId: number, opts: BotFleetOptions): WorkerLink {
  const child = fork(WORKER_PATH, [], {
    execArgv: opts.workerExecArgv ?? [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
    windowsHide: true
  })
  const log = opts.onLog ?? ((id: number, line: string) => { process.stderr.write(`[loadgen w${id}] ${line}\n`) })
  // spawn failures and failed IPC writes surface here; the 'exit' handler does the bookkeeping
  child.on('error', err => log(workerId, `worker process error: ${err.message}`))
  if (child.stdout) createInterface({ input: child.stdout }).on('line', l => log(workerId, l))
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', l => {
      if (!/ExperimentalWarning|--trace-warnings/.test(l)) log(workerId, l)
    })
  }
  return {
    send: msg => { if (child.connected) child.send(msg, err => { if (err) log(workerId, `IPC send failed: ${err.message}`) }) },
    onMessage: cb => { child.on('message', m => cb(m as WorkerMessage)) },
    onExit: cb => { child.once('exit', code => cb(code)) },
    kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') },
    ...(child.pid !== undefined ? { pid: child.pid } : {})
  }
}

interface BotEntry {
  state: 'queued' | 'joining' | 'spawned' | 'leaving'
  seq: number
  connected: boolean
  /** Connect retries used by this index since its last scaleTo request. */
  retries?: number
}

interface WorkerRec {
  id: number
  link: WorkerLink
  alive: boolean
  ready: Promise<void>
  startedAt: number
  lastReportAt: number
  latest?: WorkerStats
  exited: Promise<void>
  /** Asked to stop because scale-down left it without bots. */
  retiring: boolean
}

/** After a worker dies before becoming ready, joins for its group fail fast for this long instead of re-forking. */
const BROKEN_WORKER_BACKOFF_MS = 10_000

function num (v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export class BotFleet implements LoadGenerator {
  private readonly spawnWorker: WorkerFactory
  private readonly now: () => number
  private opts: BotFleetOptions | null = null
  private init: Omit<WorkerInit, 'workerId'> | null = null
  private thresholds: SaturationThresholds = DEFAULT_SATURATION
  private readonly workers = new Map<number, WorkerRec>()
  /** Workers being retired after a scale-down (awaited by stop()). */
  private readonly retired = new Set<WorkerRec>()
  /** worker id -> time until which it is considered broken (died before ready). */
  private readonly brokenUntil = new Map<number, number>()
  private readonly bots = new Map<number, BotEntry>()
  private queue: number[] = []
  private pumpTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private lastJoinAt = Number.NEGATIVE_INFINITY
  private lastStatsAt = 0
  private seq = 0
  private target = 0
  private joinFailures = 0
  private unexpectedDisconnects = 0
  private connectRetries = 0
  private reports: WorkerStats[] = []
  private readonly listeners: Array<(s: FleetStats) => void> = []
  private readonly waiters = new Set<() => void>()
  private stopping = false
  private readonly spawnListeners: Array<(pid: number) => void> = []
  /** agent name -> reasons its machine is saturated (fed by agent telemetry). */
  private readonly external = new Map<string, string[]>()

  constructor (deps: { spawnWorker?: WorkerFactory, now?: () => number } = {}) {
    this.spawnWorker = deps.spawnWorker ?? forkWorker
    this.now = deps.now ?? (() => Date.now())
  }

  async start (opts: BotFleetOptions): Promise<void> {
    if (this.opts) throw new Error('BotFleet already started')
    if (!(opts.botsPerWorker >= 1)) throw new Error('botsPerWorker must be >= 1')
    if (!(opts.statsIntervalMs > 0)) throw new Error('statsIntervalMs must be > 0')
    if (!(opts.joinIntervalMs >= 0) || !Number.isFinite(opts.joinIntervalMs)) throw new Error('joinIntervalMs must be a finite number >= 0')
    if (opts.connectRetries !== undefined && !(Number.isInteger(opts.connectRetries) && opts.connectRetries >= 0)) throw new Error('connectRetries must be an integer >= 0')
    const p = opts.scenarioParams ?? {}
    this.opts = opts
    this.thresholds = { ...DEFAULT_SATURATION, ...opts.saturation }
    this.init = {
      host: opts.host,
      port: opts.port,
      version: opts.version,
      scenarioModule: opts.scenarioModule,
      ...(opts.scenarioName !== undefined ? { scenarioName: opts.scenarioName } : {}),
      scenarioParams: p,
      usernamePrefix: opts.usernamePrefix,
      seed: opts.seed,
      statsIntervalMs: opts.statsIntervalMs,
      joinTimeoutMs: opts.joinTimeoutMs ?? 60_000,
      leaveTimeoutMs: opts.leaveTimeoutMs ?? 5000,
      forceFullChunks: typeof p.forceFullChunks === 'boolean' ? p.forceFullChunks : opts.forceFullChunks ?? false,
      rtt: {
        sampleRatio: num(p.rttSampleRatio) ?? opts.rtt?.sampleRatio ?? DEFAULT_RTT.sampleRatio,
        intervalMs: num(p.rttIntervalMs) ?? opts.rtt?.intervalMs ?? DEFAULT_RTT.intervalMs,
        timeoutMs: num(p.rttTimeoutMs) ?? opts.rtt?.timeoutMs ?? DEFAULT_RTT.timeoutMs
      }
    }
    this.lastStatsAt = this.now()
    // The first worker validates the setup (scenario module loads) before any bot is requested.
    const w0 = this.ensureWorker(0)
    const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        w0.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`loadgen worker 0 not ready within ${readyTimeoutMs} ms`)), readyTimeoutMs)
        })
      ])
      clearTimeout(timer)
    } catch (err) {
      clearTimeout(timer)
      await this.stop()
      throw err
    }
    this.statsTimer = setInterval(() => this.emitStats(), opts.statsIntervalMs)
  }

  async scaleTo (n: number, timeoutMs?: number): Promise<void> {
    const opts = this.requireStarted()
    if (this.stopping) throw new Error('BotFleet is stopping')
    if (!Number.isInteger(n) || n < 0) throw new Error(`scaleTo: invalid bot count ${n}`)
    this.target = n

    // scale down: highest indices first
    const down = [...this.bots.keys()].filter(i => i >= n).sort((a, b) => b - a)
    for (const i of down) {
      const e = this.bots.get(i)!
      if (e.state === 'queued') this.bots.delete(i)
      else if (e.state !== 'leaving') this.requestLeave(i, e)
    }

    // scale up: lowest missing indices first
    let added = 0
    for (let i = 0; i < n; i++) {
      if (this.bots.has(i)) continue
      this.bots.set(i, { state: 'queued', seq: ++this.seq, connected: false })
      this.queue.push(i)
      added++
    }
    if (added > 0) this.queue.sort((a, b) => a - b)
    this.pump()
    this.changed()

    const pending = this.queue.length
    await this.waitFor(() => this.settled(), timeoutMs ?? 60_000 + pending * opts.joinIntervalMs)
  }

  onStats (listener: (s: FleetStats) => void): void {
    this.listeners.push(listener)
  }

  async stop (): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null }
    this.queue = []
    const graceMs = this.opts?.stopGraceMs ?? 10_000
    const exits: Array<Promise<void>> = []
    for (const w of [...this.workers.values(), ...this.retired]) {
      if (!w.alive) continue
      if (!w.retiring) this.safeSend(w, { type: 'stop', graceMs })
      exits.push(Promise.race([
        w.exited,
        new Promise<void>(resolve => {
          const t = setTimeout(() => { w.link.kill(); resolve() }, graceMs + 5000)
          void w.exited.then(() => clearTimeout(t))
        })
      ]))
    }
    await Promise.all(exits)
    this.retired.clear()
    this.bots.clear()
    this.changed()
  }

  /** OS pids of the live worker processes (retiring ones included until they exit). */
  pids (): number[] {
    const out: number[] = []
    for (const w of [...this.workers.values(), ...this.retired]) {
      if (w.alive && w.link.pid !== undefined && !out.includes(w.link.pid)) out.push(w.link.pid)
    }
    return out
  }

  /** `listener(pid)` runs for every worker process started from now on (re-forks included). */
  onWorkerSpawn (listener: (pid: number) => void): void {
    this.spawnListeners.push(listener)
  }

  /**
   * Mark (non-empty `reasons`) or clear (empty) a saturated load-generator machine, e.g. from agent telemetry.
   * While set, every interval's `loadgen.saturated` is true and the agent's slice is marked saturated.
   */
  setExternalSaturation (agent: string, reasons: readonly string[]): void {
    if (reasons.length > 0) this.external.set(agent, [...reasons])
    else this.external.delete(agent)
  }

  /** Current per-state counts (for diagnostics and tests). */
  snapshot (): { target: number, queued: number, joining: number, spawned: number, leaving: number, connected: number, workers: number, joinFailures: number, unexpectedDisconnects: number } {
    const c = { queued: 0, joining: 0, spawned: 0, leaving: 0, connected: 0 }
    for (const e of this.bots.values()) {
      c[e.state]++
      if (e.connected) c.connected++
    }
    return {
      target: this.target,
      ...c,
      workers: [...this.workers.values()].filter(w => w.alive).length,
      joinFailures: this.joinFailures,
      unexpectedDisconnects: this.unexpectedDisconnects
    }
  }

  /** Indices currently held by bots in a given state, ascending. */
  indices (state: BotEntry['state']): number[] {
    return [...this.bots.entries()].filter(([, e]) => e.state === state).map(([i]) => i).sort((a, b) => a - b)
  }

  /** Build the stats for the interval ending now and send them to listeners (normally timer-driven). */
  emitStats (): FleetStats {
    const now = this.now()
    const snap = this.snapshot()
    const staleMs = 3 * (this.opts?.statsIntervalMs ?? 1000) + 2000
    const stats = aggregateStats({
      t: now,
      target: this.target,
      connected: snap.connected,
      spawned: snap.spawned,
      joinFailures: this.joinFailures,
      unexpectedDisconnects: this.unexpectedDisconnects,
      ...(this.opts?.connectRetries ? { connectRetries: this.connectRetries } : {}),
      elapsedMs: now - this.lastStatsAt,
      reports: this.reports,
      workers: [...this.workers.values()].filter(w => w.alive).map(w => ({
        ...(w.latest ? { latest: w.latest } : {}),
        ...(w.link.agent !== undefined ? { agent: w.link.agent } : {}),
        sinceMs: now - (w.latest ? w.lastReportAt : w.startedAt)
      })),
      thresholds: this.thresholds,
      staleMs,
      ...(this.external.size > 0 ? { externalSaturation: Object.fromEntries(this.external) } : {})
    })
    this.reports = []
    this.lastStatsAt = now
    for (const l of this.listeners) {
      try { l(stats) } catch (err) { this.log(-1, `stats listener threw: ${(err as Error)?.message}`) }
    }
    return stats
  }

  // ---- internals ----

  private requireStarted (): BotFleetOptions {
    if (!this.opts || !this.init) throw new Error('BotFleet not started')
    return this.opts
  }

  private log (workerId: number, line: string): void {
    if (this.opts?.onLog) this.opts.onLog(workerId, line)
    else process.stderr.write(`[loadgen${workerId >= 0 ? ` w${workerId}` : ''}] ${line}\n`)
  }

  private settled (): boolean {
    for (const e of this.bots.values()) if (e.state !== 'spawned') return false
    return true
  }

  private waitFor (cond: () => boolean, timeoutMs: number): Promise<void> {
    if (cond()) return Promise.resolve()
    return new Promise(resolve => {
      const check = (): void => { if (cond()) done() }
      const timer = setTimeout(() => done(), timeoutMs)
      const done = (): void => { clearTimeout(timer); this.waiters.delete(check); resolve() }
      this.waiters.add(check)
    })
  }

  private changed (): void {
    for (const w of [...this.waiters]) w()
  }

  private workerOf (index: number): number {
    return Math.floor(index / this.opts!.botsPerWorker)
  }

  private safeSend (w: WorkerRec, msg: ControllerMessage): boolean {
    if (!w.alive) return false
    try { w.link.send(msg); return true } catch { return false }
  }

  private ensureWorker (id: number): WorkerRec {
    const existing = this.workers.get(id)
    if (existing?.alive && !existing.retiring) return existing
    if ((this.brokenUntil.get(id) ?? 0) > this.now()) throw new Error(`worker ${id} failed to start recently`)
    const link = this.spawnWorker(id, this.opts!)
    if (link.pid !== undefined) {
      for (const l of this.spawnListeners) {
        try { l(link.pid) } catch (err) { this.log(-1, `worker spawn listener threw: ${(err as Error)?.message}`) }
      }
    }
    let onReady!: () => void
    let onFail!: (err: Error) => void
    const ready = new Promise<void>((resolve, reject) => { onReady = resolve; onFail = reject })
    ready.catch(() => {})
    let onExited!: () => void
    const exited = new Promise<void>(resolve => { onExited = resolve })
    const rec: WorkerRec = { id, link, alive: true, ready, startedAt: this.now(), lastReportAt: this.now(), exited, retiring: false }
    let isReady = false
    this.workers.set(id, rec)
    link.onMessage(msg => {
      if (this.workers.get(id) !== rec) return
      switch (msg.type) {
        case 'ready': isReady = true; onReady(); break
        case 'fatal': this.log(id, `fatal: ${msg.error}`); onFail(new Error(`loadgen worker ${id}: ${msg.error}`)); break
        case 'log': this.log(id, msg.msg); break
        case 'stats':
          rec.latest = msg
          rec.lastReportAt = this.now()
          this.reports.push(msg)
          break
        case 'bot': this.onBotEvent(msg); break
        case 'stopped': break
      }
    })
    link.onExit(code => {
      rec.alive = false
      onFail(new Error(`loadgen worker ${id} exited (code ${code}) before it was ready`))
      onExited()
      this.retired.delete(rec)
      if (rec.retiring) return
      if (!isReady) this.brokenUntil.set(id, this.now() + BROKEN_WORKER_BACKOFF_MS)
      if (this.workers.get(id) === rec) this.onWorkerExit(rec, code)
    })
    this.safeSend(rec, { type: 'init', init: { ...this.init!, workerId: id } })
    return rec
  }

  private onWorkerExit (rec: WorkerRec, code: number | null): void {
    if (this.stopping) return
    this.log(rec.id, `worker exited unexpectedly (code ${code})`)
    for (const [i, e] of [...this.bots.entries()]) {
      if (this.workerOf(i) !== rec.id) continue
      if (e.state === 'queued') continue // re-forked when its turn comes
      if (e.state === 'joining') this.joinFailures++
      else if (e.state === 'spawned') this.unexpectedDisconnects++
      this.release(i, e)
    }
    this.pump()
    this.changed()
  }

  private onBotEvent (msg: BotEvent): void {
    const e = this.bots.get(msg.index)
    if (!e) return
    if (msg.seq !== e.seq) return
    switch (msg.event) {
      case 'connect':
        e.connected = true
        break
      case 'spawn':
        e.connected = true
        if (e.state === 'joining') e.state = 'spawned'
        break
      case 'fail':
        if (e.state === 'joining' && !e.connected && (e.retries ?? 0) < (this.opts?.connectRetries ?? 0) && !this.stopping) {
          // the transport never came up (no `connect`): try the same index again, as a client would
          this.connectRetries++
          this.log(this.workerOf(msg.index), `bot ${msg.index}: connect failed (${msg.reason ?? 'no reason given'}), retry ${(e.retries ?? 0) + 1}/${this.opts!.connectRetries}`)
          this.bots.set(msg.index, { state: 'queued', seq: ++this.seq, connected: false, retries: (e.retries ?? 0) + 1 })
          this.queue.push(msg.index)
          this.queue.sort((a, b) => a - b)
          this.pump()
          break
        }
        if (e.state !== 'leaving') {
          this.joinFailures++
          this.log(this.workerOf(msg.index), `bot ${msg.index}: join failed: ${msg.reason ?? 'no reason given'}`)
        }
        this.release(msg.index, e)
        break
      case 'disconnect':
        if (e.state !== 'leaving') {
          this.unexpectedDisconnects++
          this.log(this.workerOf(msg.index), `bot ${msg.index}: disconnected: ${msg.reason ?? 'no reason given'}`)
        }
        this.release(msg.index, e)
        break
      case 'left':
        this.release(msg.index, e)
        break
    }
    this.changed()
  }

  /**
   * Free an index after its bot's final event. A bot that was leaving and whose index is wanted again (quick
   * scale-down then scale-up) is re-queued; failed bots are not retried until the next scaleTo().
   */
  private release (index: number, e: BotEntry): void {
    this.bots.delete(index)
    if (e.state === 'leaving' && index < this.target && !this.stopping) {
      this.bots.set(index, { state: 'queued', seq: ++this.seq, connected: false })
      this.queue.push(index)
      this.queue.sort((a, b) => a - b)
      this.pump()
    }
    this.maybeRetire(this.workerOf(index))
  }

  /** Stop a worker that scale-down left without bots and that the current target does not need. */
  private maybeRetire (id: number): void {
    if (this.stopping || id === 0) return
    const w = this.workers.get(id)
    if (!w?.alive || w.retiring) return
    if (id < Math.ceil(this.target / this.opts!.botsPerWorker)) return
    for (const i of this.bots.keys()) if (this.workerOf(i) === id) return
    w.retiring = true
    this.retired.add(w)
    this.workers.delete(id)
    if (!this.safeSend(w, { type: 'stop', graceMs: this.opts?.stopGraceMs ?? 10_000 })) w.link.kill()
  }

  private requestLeave (index: number, e: BotEntry): void {
    const w = this.workers.get(this.workerOf(index))
    e.state = 'leaving'
    if (!w || !this.safeSend(w, { type: 'leave', index, seq: e.seq })) this.release(index, e)
  }

  private nextQueued (): number | undefined {
    while (this.queue.length > 0) {
      const i = this.queue[0]!
      if (this.bots.get(i)?.state === 'queued') return i
      this.queue.shift()
    }
    return undefined
  }

  private pump (): void {
    if (this.pumpTimer || this.stopping) return
    if (this.nextQueued() === undefined) return
    const wait = Math.max(0, this.lastJoinAt + this.opts!.joinIntervalMs - this.now())
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null
      if (this.stopping) return
      const i = this.nextQueued()
      if (i !== undefined) {
        this.queue.shift()
        this.dispatchJoin(i)
        this.lastJoinAt = this.now()
      }
      this.pump()
    }, wait)
  }

  private dispatchJoin (index: number): void {
    const e = this.bots.get(index)!
    let w: WorkerRec
    try {
      w = this.ensureWorker(this.workerOf(index))
    } catch (err) {
      this.log(-1, `cannot start worker for bot ${index}: ${(err as Error)?.message}`)
      this.joinFailures++
      this.bots.delete(index)
      this.changed()
      return
    }
    e.state = 'joining'
    if (!this.safeSend(w, { type: 'join', index, seq: e.seq })) {
      this.joinFailures++
      this.bots.delete(index)
      this.changed()
    }
  }
}
