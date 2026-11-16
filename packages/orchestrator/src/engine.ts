import {
  DEFAULT_COOLDOWN_SEC, DEFAULT_GATES, DEFAULT_SAMPLING, DEFAULT_TPS_DIVERGENCE, Kinds, percentile,
  type BdsServer, type BdsServerEvents, type BenchmarkConfig, type BotFleetStats, type Envelope, type ForeignProcess, type GametimeSample, type GatesConfig,
  type InterferenceSample, type InterferenceSummary, type InterferenceThresholds, type LoadGenerator, type LoadGenOptions, type PlacementPlan,
  type PlacementVerification, type ProbeRecord, type ProcessGroupName, type RepeatStatus, type RepeatSummary, type RunMeta,
  type RunPlacementMeta, type RunResult, type Sampler, type StepResult, type SysSample
} from '@bedperf/core'
import { LOADGEN_SATURATED_REASON, stepOutcome } from './criteria.ts'
import { RunRecorder } from './recorder.ts'
import { REPEAT_END_KIND, REPEAT_START_KIND, STEP_FACTS_KIND, stepFromEnvelopes, type StepFacts } from './recompute.ts'
import { planNext, searchBounds, type SearchDone, type SearchStep } from './search.ts'
import { settle, viewsIncomplete } from './settle.ts'

export interface Logger {
  info (msg: string): void
  warn (msg: string): void
  error (msg: string): void
}

export const consoleLogger: Logger = {
  info: msg => { console.log(`[bedperf] ${msg}`) },
  warn: msg => { console.warn(`[bedperf] ${msg}`) },
  error: msg => { console.error(`[bedperf] ${msg}`) }
}

export const silentLogger: Logger = { info () {}, warn () {}, error () {} }

/** CPU placement as the engine sees it: a plan made once per run, and how to check / apply it. */
export interface EnginePlacement {
  plan: PlacementPlan
  /** How the server set is applied (`preexec`, `post-spawn`); recorded in meta.json. */
  method: string
  /** Verify the server process against `plan.serverCpus` / `plan.priority`. */
  verifyServer (pid: number): Promise<PlacementVerification>
  /** Put a load-generator worker on the bot CPUs. */
  applyWorker? (pid: number): Promise<{ ok: boolean, error?: string }>
}

/** Result of an idle check (see @bedperf/sysmon `idleCheck`). */
export interface IdleGateResult {
  ok: boolean
  reasons: string[]
  summary: InterferenceSummary
  /** Busiest foreign processes. */
  top: ForeignProcess[]
}

/** Machine-level interference sampler (see @bedperf/sysmon `createMachineSampler`). */
export interface MachineSamplerLike extends Sampler<InterferenceSample> {
  setGroup (group: ProcessGroupName, pids: number[]): void
}

/** Everything the engine needs from the outside world. All real I/O goes through here. */
export interface EngineDeps {
  /** A fresh, not yet started server instance for repeat `repeat` (0-based). */
  createServer (repeat: number): Promise<BdsServer>
  /** A fresh load generator for repeat `repeat`. */
  createLoadGen (repeat: number): LoadGenerator
  /** OS sampler for the server process. */
  createSampler (pid: number): Sampler<SysSample>
  /** Console commands to run once after the server starts (the scenario's `serverSetup`). */
  scenarioSetup (): string[]
  /** Parent directory of run directories: the run is written to `<runsDir>/<runId>/`. */
  runsDir: string
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
  /** Default: a real timer. */
  sleep?: (ms: number) => Promise<void>
  logger?: Logger
  /** Overrides for the options passed to `LoadGenerator.start` (e.g. host, version). */
  loadGenOptions?: Partial<LoadGenOptions>
  /** CPU placement; absent = none (no verification, no placement in meta). */
  placement?: EnginePlacement
  /** Idle gate before each repeat; absent = no idle check. */
  idleCheck? (opts: { durationSec: number, serverCpus?: number[], thresholds: InterferenceThresholds }): Promise<IdleGateResult>
  /** Machine interference sampler for a repeat; absent = no interference gate. */
  createMachineSampler? (opts: { serverCpus?: number[] }): MachineSamplerLike
  /** Tick-counter (`time query gametime`) sampler for a started server; absent / undefined = none. */
  createGametimeSampler? (server: BdsServer, intervalMs: number): Sampler<GametimeSample> | undefined
  /** Told when a hold window opens and closes (the simulation enforces R7 with it). */
  onHold? (open: boolean): void
}

export interface RunOptions {
  runId?: string
  /** Extra / overriding fields for meta.json (colocated, bedbooCommit, bedperfVersion, ...). */
  meta?: Partial<Omit<RunMeta, 'runId' | 'startedAt'>>
  /** Timeout passed to `scaleTo`. Default: 60 s + joinIntervalMs per added bot. */
  scaleTimeoutMs?: number
  /** Server start ready timeout. Default 180 s. */
  readyTimeoutMs?: number
  /** Stops the run between steps; the run then rejects with the abort reason. */
  signal?: AbortSignal
  /** Do not run the idle gate before the first repeat (the caller already did). */
  skipInitialIdleCheck?: boolean
}

export interface RepeatOutcome extends SearchDone {
  repeat: number
  status: RepeatStatus
  statusReasons: string[]
  /** Set when the repeat ended early because the server exited unexpectedly. */
  aborted?: string
  /** Index of the invalid repeat this one reran. */
  rerunOf?: number
}

export interface BenchmarkOutcome {
  runId: string
  dir: string
  result: RunResult
  steps: StepResult[]
  repeats: RepeatOutcome[]
}

/** The environment is not fit for measuring (idle gate, placement plan). CLI exit code 3. */
export class EnvGateError extends Error {
  readonly code = 'ENV_GATE'
  readonly reasons: string[]
  readonly top: ForeignProcess[]
  constructor (message: string, reasons: string[] = [], top: ForeignProcess[] = []) {
    super(message)
    this.name = 'EnvGateError'
    this.reasons = reasons
    this.top = top
  }
}

/** Process exit codes of `bedperf run`. */
export const ExitCodes = { ok: 0, error: 1, usage: 2, envGate: 3, serverFailed: 4, invalid: 5, interrupted: 130 } as const

/** 0 when a repeat measured (`ok`), 4 when every repeat was `server_failed`, else 5. */
export function exitCodeOf (result: Pick<RunResult, 'repeats' | 'kOk'>): number {
  const reps = result.repeats ?? []
  if ((result.kOk ?? reps.filter(r => r.status === 'ok').length) > 0) return ExitCodes.ok
  if (reps.length > 0 && reps.every(r => r.status === 'server_failed')) return ExitCodes.serverFailed
  return ExitCodes.invalid
}

/** Gates with defaults filled. */
export function resolveGates (config: Pick<BenchmarkConfig, 'gates'>): GatesConfig {
  return { ...DEFAULT_GATES, ...config.gates }
}

/**
 * Median of the per-repeat maxima of the `ok` repeats (mean of the middle two for an even count; 0
 * when none is ok). `maxPlayers` lists every repeat by index.
 */
export function aggregateRepeats (runId: string, configName: string, repeats: readonly RepeatOutcome[], steps: readonly StepResult[]): RunResult {
  const byIndex = [...repeats].sort((a, b) => a.repeat - b.repeat)
  const ok = byIndex.filter(r => (r.status ?? 'ok') === 'ok')
  const summaries: RepeatSummary[] = byIndex.map(r => ({
    index: r.repeat,
    status: r.status ?? 'ok',
    statusReasons: r.statusReasons ?? [],
    maxPlayers: r.maxPlayers,
    ...(r.rerunOf !== undefined ? { rerunOf: r.rerunOf } : {})
  }))
  return {
    runId,
    config: configName,
    maxPlayers: byIndex.map(r => r.maxPlayers),
    maxPlayersMedian: ok.length > 0 ? percentile(ok.map(r => r.maxPlayers), 50) : 0,
    capped: ok.some(r => r.capped),
    loadgenLimited: repeats.some(r => r.loadgenLimited) || steps.some(s => s.loadgenSaturated),
    invalidLimited: ok.some(r => r.invalidLimited),
    repeats: summaries,
    kOk: ok.length,
    n: byIndex.length
  }
}

/** Run the idle gate; throws `EnvGateError` when the machine is busy. No-op without `deps.idleCheck` or with `gates.idleSec = 0`. */
export async function initialIdleGate (config: BenchmarkConfig, deps: EngineDeps): Promise<IdleGateResult | undefined> {
  const res = await runIdleCheck(config, deps)
  if (res !== undefined && !res.ok) {
    const log = deps.logger ?? consoleLogger
    log.error(`machine is not idle: ${res.reasons.join('; ')}`)
    for (const p of res.top.slice(0, 5)) log.error(`  ${p.name} (pid ${p.pid}): ${p.cores.toFixed(2)} cores`)
    throw new EnvGateError(`machine is not idle: ${res.reasons.join('; ')}`, res.reasons, res.top)
  }
  return res
}

async function runIdleCheck (config: BenchmarkConfig, deps: EngineDeps): Promise<IdleGateResult | undefined> {
  const g = resolveGates(config)
  if (deps.idleCheck === undefined || !(g.idleSec > 0)) return undefined
  const serverCpus = deps.placement?.plan.serverCpus
  return await deps.idleCheck({
    durationSec: g.idleSec,
    ...(serverCpus !== undefined ? { serverCpus } : {}),
    thresholds: { foreignMean: g.idleForeignMean, foreignPeak10s: g.idleForeignPeak10s, serverSetForeignMean: g.idleServerSetForeignMean }
  })
}

/** Console commands allowed while a hold window is open (R7): probe marks / pings only. */
export const HOLD_COMMAND_RE = /^scriptevent bedperf:/

function placementMeta (p: EnginePlacement): RunPlacementMeta {
  const m: RunPlacementMeta = {
    kind: p.plan.kind,
    method: p.method,
    serverCpus: [...p.plan.serverCpus],
    botCpus: [...p.plan.botCpus],
    harnessCpus: [...p.plan.harnessCpus],
    priority: p.plan.priority,
    verified: true,
    verifications: 0,
    checks: p.plan.checks
  }
  if (p.plan.profileSha256 !== undefined) m.profileSha256 = p.plan.profileSha256
  if (p.plan.label !== undefined) m.label = p.plan.label
  return m
}

function resolvedGatesMeta (config: BenchmarkConfig, deps: EngineDeps): Record<string, unknown> {
  return {
    ...resolveGates(config),
    minCounterTps: config.criteria.minCounterTps ?? config.criteria.minAvgTps,
    maxProbeCounterTpsDivergence: config.criteria.maxProbeCounterTpsDivergence ?? DEFAULT_TPS_DIVERGENCE,
    gametimeIntervalSec: (config.sampling ?? DEFAULT_SAMPLING).gametimeIntervalSec,
    idleCheck: deps.idleCheck !== undefined,
    interference: deps.createMachineSampler !== undefined,
    gametime: deps.createGametimeSampler !== undefined,
    placement: deps.placement !== undefined
  }
}

interface RepeatResources {
  server?: BdsServer
  sampler?: Sampler<SysSample>
  machine?: MachineSamplerLike
  gametime?: Sampler<GametimeSample>
  loadgen?: LoadGenerator
}

/**
 * One benchmark run (one config, one run dir), driven slot by slot: `runBenchmark` runs all its
 * slots in a row, `runSession` interleaves several runs.
 */
export class BenchmarkRun {
  readonly config: BenchmarkConfig
  readonly rec: RunRecorder
  readonly steps: StepResult[] = []
  readonly repeats: RepeatOutcome[] = []
  private readonly deps: EngineDeps
  private readonly opts: RunOptions
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: Logger
  private nextIndex = 0
  private holdOpen = false

  private constructor (config: BenchmarkConfig, deps: EngineDeps, opts: RunOptions, rec: RunRecorder) {
    this.config = config
    this.deps = deps
    this.opts = opts
    this.rec = rec
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.log = deps.logger ?? consoleLogger
  }

  /** Create the run dir and record `orch.run.start`. */
  static async open (config: BenchmarkConfig, deps: EngineDeps, opts: RunOptions = {}): Promise<BenchmarkRun> {
    const meta: Partial<Omit<RunMeta, 'runId' | 'startedAt'>> = {
      ...(deps.placement !== undefined ? { placement: placementMeta(deps.placement) } : {}),
      gates: resolvedGatesMeta(config, deps),
      network: { loopback: /^(127\.|localhost$|::1$)/.test(deps.loadGenOptions?.host ?? '127.0.0.1') },
      ...opts.meta
    }
    const rec = await RunRecorder.create({
      runsDir: deps.runsDir,
      config,
      now: deps.now ?? Date.now,
      meta,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {})
    })
    const run = new BenchmarkRun(config, deps, opts, rec)
    run.log.info(`run ${rec.runId} → ${rec.dir}`)
    rec.record('orch', Kinds.runStart, { runId: rec.runId, config: config.name, repeats: config.repeats })
    return run
  }

  get runId (): string { return this.rec.runId }
  get dir (): string { return this.rec.dir }

  /**
   * Run repeat slot `slot`: one repeat, plus one rerun (fresh index) when it ends `invalid`. Every
   * repeat but the very first of the process is preceded by `cooldownSec` and the idle gate.
   */
  async runSlot (slot: number, first: boolean): Promise<RepeatOutcome[]> {
    const outs: RepeatOutcome[] = []
    let rerunOf: number | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      this.opts.signal?.throwIfAborted()
      const initial = first && attempt === 0
      if (!initial) {
        const cd = this.config.cooldownSec ?? DEFAULT_COOLDOWN_SEC
        if (cd > 0) {
          this.log.info(`cooldown ${cd}s`)
          await this.sleepAbortable(cd * 1000)
        }
        this.opts.signal?.throwIfAborted()
      }
      const index = this.nextIndex++
      // The idle gate of the very first repeat runs before the run dir exists (`initialIdleGate`).
      const gate = initial ? undefined : await runIdleCheck(this.config, this.deps)
      let out: RepeatOutcome
      if (gate !== undefined && !gate.ok) {
        this.log.warn(`repeat ${index}: machine is not idle: ${gate.reasons.join('; ')}`)
        for (const p of gate.top.slice(0, 5)) this.log.warn(`  ${p.name} (pid ${p.pid}): ${p.cores.toFixed(2)} cores`)
        out = this.skippedRepeat(index, [`idle_gate: ${gate.reasons.join('; ')}`], gate, rerunOf)
      } else {
        out = await this.runRepeat(index, rerunOf)
      }
      this.repeats.push(out)
      outs.push(out)
      this.log.info(`repeat ${index}: ${out.status} maxPlayers=${out.maxPlayers}${out.capped ? ' (capped)' : ''}${out.loadgenLimited ? ' (loadgen limited)' : ''}${out.statusReasons.length > 0 ? ` [${out.statusReasons.join('; ')}]` : ''}`)
      if (out.status !== 'invalid' || attempt === 1) break
      rerunOf = index
      this.log.warn(`repeat ${index} invalid: rerunning once`)
    }
    return outs
  }

  /** Write result.json, `orch.run.end` and close the run dir. */
  async finish (): Promise<BenchmarkOutcome> {
    const result = aggregateRepeats(this.rec.runId, this.config.name, this.repeats, this.steps)
    this.sealPlacement()
    await this.rec.writeResult(result)
    this.rec.record('orch', Kinds.runEnd, { ok: true, result })
    await this.rec.close()
    this.log.info(`run ${this.rec.runId}: maxPlayers median ${result.maxPlayersMedian} over ${result.kOk}/${result.n} ok repeats [${result.maxPlayers.join(', ')}]`)
    return { runId: this.rec.runId, dir: this.rec.dir, result, steps: this.steps, repeats: this.repeats }
  }

  /** Finalise the run dir after an error (`orch.run.end` with `ok: false`). Never throws. */
  async fail (err: unknown): Promise<void> {
    this.sealPlacement()
    this.rec.record('orch', Kinds.runEnd, { ok: false, error: String((err as Error)?.stack ?? err) })
    await this.rec.writeSteps(this.steps).catch(() => {})
    await this.rec.close().catch(() => {})
  }

  /** Placement counts as verified only when at least one verification ran and none failed. */
  private sealPlacement (): void {
    const pm = this.rec.meta.placement
    if (pm !== undefined && (pm.verifications ?? 0) === 0) pm.verified = false
  }

  /** `sleep` that rejects as soon as `opts.signal` aborts. */
  private async sleepAbortable (ms: number): Promise<void> {
    const signal = this.opts.signal
    if (signal === undefined) return await this.sleep(ms)
    signal.throwIfAborted()
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => { reject(signal.reason) }
          signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /** A repeat that never started a server (e.g. the idle gate failed). */
  private skippedRepeat (r: number, reasons: string[], gate: IdleGateResult | undefined, rerunOf: number | undefined): RepeatOutcome {
    this.rec.retain()
    this.rec.record('orch', REPEAT_START_KIND, { repeat: r, ...(rerunOf !== undefined ? { rerunOf } : {}) })
    if (gate !== undefined) this.rec.record('orch', 'orch.idle', { repeat: r, ok: gate.ok, reasons: gate.reasons, summary: gate.summary, top: gate.top.slice(0, 10) })
    const out: RepeatOutcome = { done: true, repeat: r, maxPlayers: 0, capped: false, loadgenLimited: false, invalidLimited: false, status: 'invalid', statusReasons: reasons }
    if (rerunOf !== undefined) out.rerunOf = rerunOf
    this.rec.record('orch', REPEAT_END_KIND, { repeat: r, outcome: out })
    return out
  }

  /** Send a console command, enforcing R7: nothing but probe commands while a hold window is open. */
  private send (server: BdsServer, command: string): void {
    if (this.holdOpen && !HOLD_COMMAND_RE.test(command)) throw new Error(`R7: console command '${command}' sent inside a hold window`)
    server.send(command)
  }

  private setHold (open: boolean): void {
    this.holdOpen = open
    this.deps.onHold?.(open)
  }

  /** Verify the server placement; records `orch.placement.verify`. */
  private async verify (server: BdsServer, r: number, phase: string, index?: number): Promise<{ ok: boolean, issues: string[] } | undefined> {
    const pl = this.deps.placement
    const pid = server.pid
    if (pl === undefined || pid === undefined) return undefined
    let ok: boolean
    let issues: string[]
    try {
      const v = await pl.verifyServer(pid)
      ok = v.verified
      issues = v.violations.map(x => x.message)
    } catch (err) {
      ok = false
      issues = [`verification failed: ${(err as Error).message ?? String(err)}`]
    }
    const pm = this.rec.meta.placement
    if (pm !== undefined) {
      pm.verifications = (pm.verifications ?? 0) + 1
      if (!ok) pm.verified = false
    }
    this.rec.record('orch', 'orch.placement.verify', { repeat: r, ...(index !== undefined ? { index } : {}), phase, pid, verified: ok, issues })
    if (!ok) this.log.warn(`repeat ${r}${index !== undefined ? ` step ${index}` : ''}: placement not verified at ${phase}: ${issues.join('; ')}`)
    return { ok, issues }
  }

  private async runRepeat (r: number, rerunOf: number | undefined): Promise<RepeatOutcome> {
    const rec = this.rec
    rec.retain()
    rec.record('orch', REPEAT_START_KIND, { repeat: r, ...(rerunOf !== undefined ? { rerunOf } : {}) })
    const res: RepeatResources = {}
    const ctx = { crashed: undefined as string | undefined }
    const onProbe: BdsServerEvents['probe'] = (p: ProbeRecord) => { rec.record('probe', `probe.${p.type}`, p) }
    const onExit: BdsServerEvents['exit'] = info => {
      rec.record('bds', Kinds.bdsEvent, { event: 'exit', ...info })
      if (!info.expected) ctx.crashed = `server exited unexpectedly (code ${info.code}, signal ${info.signal})`
    }
    let outcome: RepeatOutcome | undefined
    try {
      outcome = await this.repeatBody(r, res, ctx, onProbe, onExit)
      if (rerunOf !== undefined) outcome.rerunOf = rerunOf
    } finally {
      this.setHold(false)
      const warn = (what: string) => (err: unknown) => { this.log.warn(`${what} stop failed: ${String(err)}`) }
      if (res.loadgen !== undefined) await res.loadgen.stop().catch(warn('loadgen'))
      if (res.gametime !== undefined) await res.gametime.stop().catch(warn('gametime sampler'))
      if (res.sampler !== undefined) await res.sampler.stop().catch(warn('sampler'))
      if (res.server !== undefined) {
        await res.server.stop().catch(warn('server'))
        res.server.off('probe', onProbe)
        res.server.off('exit', onExit)
      }
      if (res.machine !== undefined) await res.machine.stop().catch(warn('machine sampler'))
      rec.record('orch', REPEAT_END_KIND, { repeat: r, outcome: outcome ?? null })
    }
    return outcome!
  }

  private async repeatBody (
    r: number,
    res: RepeatResources,
    ctx: { crashed: string | undefined },
    onProbe: BdsServerEvents['probe'],
    onExit: BdsServerEvents['exit']
  ): Promise<RepeatOutcome> {
    const { config, deps, opts, rec, log, now, sleep } = this
    const history: SearchStep[] = []
    const botStats: BotFleetStats[] = []
    const done = (status: RepeatStatus, statusReasons: string[], extra: Partial<RepeatOutcome> = {}): RepeatOutcome => {
      const { lo, hi } = searchBounds(history)
      const o: RepeatOutcome = { done: true, repeat: r, maxPlayers: lo, capped: false, loadgenLimited: false, invalidLimited: false, status, statusReasons, ...extra }
      if (o.firstFail === undefined && hi !== undefined) o.firstFail = hi
      return o
    }
    const serverFailed = (reason: string, failedAt?: number): RepeatOutcome => {
      const o = done('server_failed', [reason], { aborted: reason })
      if (o.firstFail === undefined && failedAt !== undefined) o.firstFail = failedAt
      return o
    }

    const server = res.server = await deps.createServer(r)
    server.on('probe', onProbe)
    server.on('exit', onExit)
    try {
      await server.start({ readyTimeoutMs: opts.readyTimeoutMs ?? 180_000 })
    } catch (err) {
      // The server itself did not come up (exited or never got ready): a result about the build, not the harness.
      const reason = (err as { reason?: string }).reason
      if (reason === 'exit' || reason === 'timeout') return serverFailed(`server did not start: ${(err as Error).message.split('\n')[0]}`)
      throw err
    }
    rec.record('bds', Kinds.bdsEvent, { event: 'ready', pid: server.pid })
    const pid = server.pid

    const serverCpus = deps.placement?.plan.serverCpus
    if (deps.createMachineSampler !== undefined) {
      const m = res.machine = deps.createMachineSampler(serverCpus !== undefined ? { serverCpus } : {})
      if (pid !== undefined) m.setGroup('server', [pid])
      await m.start(s => { rec.record('sys', Kinds.sysInterference, s) })
    }

    const ready = await this.verify(server, r, 'ready')
    if (ready !== undefined && !ready.ok) return done('invalid', [`placement_mismatch: at ready: ${ready.issues.join('; ')}`])

    for (const cmd of deps.scenarioSetup()) {
      this.send(server, cmd)
      rec.record('orch', 'orch.command', { command: cmd })
    }

    if (pid !== undefined) {
      res.sampler = deps.createSampler(pid)
      await res.sampler.start(s => { rec.record('sys', Kinds.sysSample, s) })
    } else {
      log.warn('server pid unknown; OS sampling disabled for this repeat')
    }

    let gametimeIntervalMs: number | undefined
    if (deps.createGametimeSampler !== undefined) {
      const ms = (config.sampling ?? DEFAULT_SAMPLING).gametimeIntervalSec * 1000
      const g = deps.createGametimeSampler(server, ms)
      if (g !== undefined) {
        res.gametime = g
        await g.start(s => { rec.record('bds', Kinds.bdsGametime, s) })
        gametimeIntervalMs = ms
      }
    }

    const loadgen = res.loadgen = deps.createLoadGen(r)
    loadgen.onStats(s => {
      botStats.push(s)
      if (botStats.length > 4096) botStats.splice(0, 2048)
      rec.record('bot', Kinds.botStats, s)
    })
    const workers = new Set<number>()
    loadgen.onWorkerSpawn?.(wpid => {
      workers.add(wpid)
      res.machine?.setGroup('bots', loadgen.pids?.() ?? [...workers])
      const apply = deps.placement?.applyWorker
      if (apply !== undefined) {
        apply(wpid).then(
          a => { rec.record('orch', 'orch.placement.apply', { repeat: r, role: 'bot', pid: wpid, ...a }); if (!a.ok) log.warn(`bot worker ${wpid}: placement not applied: ${a.error ?? ''}`) },
          (err: unknown) => { log.warn(`bot worker ${wpid}: placement failed: ${String(err)}`) }
        )
      }
    })
    const lgOpts: LoadGenOptions = {
      host: '127.0.0.1',
      port: server.instance.port,
      version: config.botVersion ?? config.bdsVersion,
      scenarioModule: config.scenario.module,
      scenarioParams: config.scenario.params ?? {},
      botsPerWorker: config.loadgen.botsPerWorker,
      joinIntervalMs: config.loadgen.joinIntervalMs,
      usernamePrefix: `bp${r}_`,
      seed: config.seed + r,
      statsIntervalMs: 1000,
      ...deps.loadGenOptions
    }
    await loadgen.start(lgOpts)

    log.info(`repeat ${r}: warmup ${config.warmupSec}s`)
    const warmStart = now()
    await sleep(config.warmupSec * 1000)
    if (ctx.crashed !== undefined) return serverFailed(ctx.crashed)

    // Idle-advance check: the tick counter must answer and move while the server idles.
    if (gametimeIntervalMs !== undefined && config.warmupSec * 1000 >= 2 * gametimeIntervalMs) {
      const replies = rec.retained.filter(e => e.kind === Kinds.bdsGametime).map(e => e.data as GametimeSample).filter(g => g.t >= warmStart)
      if (replies.length < 2) return done('invalid', [`gametime_probe_dead: ${replies.length} tick-counter replies during warmup`])
      if (!(replies.at(-1)!.gametime > replies[0]!.gametime)) return done('invalid', ['gametime_probe_dead: the tick counter did not advance during warmup'])
    }

    let prevPlayers = 0
    for (let index = 0; ; index++) {
      opts.signal?.throwIfAborted()
      if (ctx.crashed !== undefined) return serverFailed(ctx.crashed)
      const plan = planNext({ ramp: config.ramp, history })
      if (plan.done) return this.searchOutcome(r, plan, history)
      const { players, phase } = plan
      const prior = rec.retained
      let baselineEnv: Envelope | undefined
      for (let i = prior.length - 1; i >= 0; i--) if (prior[i]!.kind === Kinds.botStats) { baselineEnv = prior[i]; break }
      rec.record('orch', Kinds.stepStart, { repeat: r, index, players, phase, retry: plan.retry })
      // A step only reads envelopes from its own orch.step.start on, plus the last fleet stats before it.
      rec.retainFrom([...(baselineEnv !== undefined ? [baselineEnv] : []), rec.retained.at(-1)!])

      const added = Math.max(0, players - prevPlayers)
      await loadgen.scaleTo(players, opts.scaleTimeoutMs ?? 60_000 + added * config.loadgen.joinIntervalMs)
      prevPlayers = players
      const st = await settle(config.ramp, { now, sleep, stats: () => botStats, stop: () => ctx.crashed !== undefined, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) })
      if (ctx.crashed !== undefined) return serverFailed(ctx.crashed, players)
      const views = viewsIncomplete(botStats.at(-1))
      rec.record('orch', 'orch.settle', { repeat: r, index, ...st, ...(views !== undefined ? { viewsIncomplete: views } : {}) })
      if (st.settleCapped) log.warn(`repeat ${r} step ${index}: settle capped at ${st.settleSec.toFixed(0)}s (views still loading)`)

      const v0 = await this.verify(server, r, 'hold_start', index)
      const markLabel = `step-${index}-start`
      this.setHold(true)
      const startT = now()
      this.send(server, `scriptevent bedperf:mark ${markLabel}`)
      await sleep(config.ramp.holdSec * 1000)
      const endT = now()
      this.setHold(false)
      this.send(server, `scriptevent bedperf:mark step-${index}-end`)
      const v1 = await this.verify(server, r, 'hold_end', index)

      const facts: StepFacts = {
        repeat: r, index, players, phase, retry: plan.retry, startT, endT, markLabel,
        statsIntervalMs: lgOpts.statsIntervalMs,
        ...(gametimeIntervalMs !== undefined ? { gametimeIntervalMs } : {}),
        ...(res.machine !== undefined ? { interference: true } : {}),
        settleSec: st.settleSec,
        settleCapped: st.settleCapped,
        ...(views !== undefined ? { viewsIncomplete: views } : {}),
        ...(v0 !== undefined && v1 !== undefined
          ? { placementVerified: v0.ok && v1.ok, ...(v0.ok && v1.ok ? {} : { placementIssues: [...v0.issues, ...v1.issues] }) }
          : {}),
        ...(ctx.crashed !== undefined ? { crashed: ctx.crashed } : {})
      }
      const upto = rec.retained.length
      rec.record('orch', STEP_FACTS_KIND, facts)
      const step = stepFromEnvelopes(rec.retained.slice(0, upto), facts, config)
      this.steps.push(step)
      const outcome = stepOutcome(step)
      history.push({ players, outcome, ...(outcome === 'invalid' ? { reasons: step.invalidReasons ?? [LOADGEN_SATURATED_REASON] } : {}) })
      rec.record('orch', Kinds.stepEnd, step)
      await rec.writeSteps(this.steps)
      const why = [...step.failReasons, ...(step.invalidReasons ?? []).filter(x => !step.failReasons.includes(x))]
      log.info(`repeat ${r} step ${index} [${phase}] ${players} players: ${outcome} tps=${step.tps.mean.toFixed(2)}${step.counterTps !== undefined ? ` counter=${step.counterTps.toFixed(2)}` : ''} settle=${st.settleSec.toFixed(0)}s${why.length > 0 ? ` (${why.join('; ')})` : ''}`)

      if (ctx.crashed !== undefined) return serverFailed(ctx.crashed, players)
      // Not all bots could join the very first measured load level: the server cannot take any load.
      // (Disconnects after a successful join only fail the step.)
      if (outcome === 'fail' && history.filter(h => h.outcome !== 'invalid').length === 1) {
        const joins = step.failReasons.filter(x => /bots spawned/.test(x))
        if (joins.length > 0) return serverFailed(`not all bots could join at the first step: ${joins.join('; ')}`, players)
      }
    }
  }

  /** Status of a repeat whose search finished. */
  private searchOutcome (r: number, plan: SearchDone, history: readonly SearchStep[]): RepeatOutcome {
    const out: RepeatOutcome = { ...plan, repeat: r, status: 'ok', statusReasons: [] }
    if (plan.invalidLimited) {
      const reasons = plan.invalidReasons ?? []
      const env = reasons.filter(x => x !== LOADGEN_SATURATED_REASON)
      const anyPass = history.some(h => h.outcome === 'pass')
      if (env.length > 0 || !anyPass) {
        out.status = 'invalid'
        out.statusReasons = [`invalid twice in a row at ${history.at(-1)?.players ?? '?'} players: ${reasons.join('; ')}`]
      }
    }
    return out
  }
}

/**
 * Run the full benchmark: `config.repeats` repeat slots, each on a fresh server (an invalid repeat
 * is rerun once). The idle gate runs before the run dir is created; a busy machine throws
 * `EnvGateError`. Writes `<runsDir>/<runId>/` and resolves with the result. See README for the flow.
 */
export async function runBenchmark (config: BenchmarkConfig, deps: EngineDeps, opts: RunOptions = {}): Promise<BenchmarkOutcome> {
  if (opts.skipInitialIdleCheck !== true) await initialIdleGate(config, deps)
  const run = await BenchmarkRun.open(config, deps, { ...opts, skipInitialIdleCheck: true })
  try {
    for (let k = 0; k < config.repeats; k++) {
      opts.signal?.throwIfAborted()
      await run.runSlot(k, k === 0)
    }
  } catch (err) {
    await run.fail(err)
    throw err
  }
  return await run.finish()
}
