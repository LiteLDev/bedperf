import {
  Kinds, percentile,
  type BdsServer, type BdsServerEvents, type BenchmarkConfig, type BotFleetStats, type LoadGenerator, type LoadGenOptions,
  type ProbeRecord, type ProbeSample, type RunMeta, type RunResult, type Sampler, type StepResult, type SysSample
} from '@bedperf/core'
import { evaluateStep, stepOutcome } from './criteria.ts'
import { RunRecorder } from './recorder.ts'
import { planNext, searchBounds, type SearchDone, type SearchStep } from './search.ts'

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
}

export interface RepeatOutcome extends SearchDone {
  repeat: number
  /** Set when the repeat ended early because the server exited unexpectedly. */
  aborted?: string
}

export interface BenchmarkOutcome {
  runId: string
  dir: string
  result: RunResult
  steps: StepResult[]
  repeats: RepeatOutcome[]
}

/** Median of per-repeat maxima (mean of the middle two for an even count). */
export function aggregateRepeats (runId: string, configName: string, repeats: readonly RepeatOutcome[], steps: readonly StepResult[]): RunResult {
  const maxPlayers = repeats.map(r => r.maxPlayers)
  return {
    runId,
    config: configName,
    maxPlayers,
    maxPlayersMedian: maxPlayers.length > 0 ? percentile(maxPlayers, 50) : 0,
    capped: repeats.some(r => r.capped),
    loadgenLimited: repeats.some(r => r.loadgenLimited) || steps.some(s => s.loadgenSaturated)
  }
}

/**
 * Keep records whose interval began at or after `startT`. Falls back to all records when that
 * would drop everything (e.g. clock skew between hosts), so a window is never emptied by trimming.
 */
function trimToHold<T> (xs: T[], intervalStart: (x: T) => number, startT: number): T[] {
  const kept = xs.filter(x => intervalStart(x) >= startT)
  return kept.length > 0 ? kept : xs
}

interface Collecting {
  label: string
  markT?: number
  probe: ProbeSample[]
  sys: SysSample[]
  bots: BotFleetStats[]
}

/**
 * Run the full benchmark: `config.repeats` independent searches, each on a fresh server.
 * Writes `<runsDir>/<runId>/` and resolves with the result. See README for the flow.
 */
export async function runBenchmark (config: BenchmarkConfig, deps: EngineDeps, opts: RunOptions = {}): Promise<BenchmarkOutcome> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const log = deps.logger ?? consoleLogger
  const rec = await RunRecorder.create({
    runsDir: deps.runsDir,
    config,
    now,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.meta !== undefined ? { meta: opts.meta } : {})
  })
  log.info(`run ${rec.runId} → ${rec.dir}`)
  rec.record('orch', Kinds.runStart, { runId: rec.runId, config: config.name, repeats: config.repeats })

  const steps: StepResult[] = []
  const repeats: RepeatOutcome[] = []
  try {
    for (let r = 0; r < config.repeats; r++) {
      opts.signal?.throwIfAborted()
      const out = await runRepeat(r, config, deps, opts, rec, steps, { now, sleep, log })
      repeats.push(out)
      log.info(`repeat ${r}: maxPlayers=${out.maxPlayers}${out.capped ? ' (capped)' : ''}${out.loadgenLimited ? ' (loadgen limited)' : ''}${out.aborted !== undefined ? ` (aborted: ${out.aborted})` : ''}`)
    }
    const result = aggregateRepeats(rec.runId, config.name, repeats, steps)
    await rec.writeResult(result)
    rec.record('orch', Kinds.runEnd, { ok: true, result })
    await rec.close()
    log.info(`run ${rec.runId}: maxPlayers median ${result.maxPlayersMedian} [${result.maxPlayers.join(', ')}]`)
    return { runId: rec.runId, dir: rec.dir, result, steps, repeats }
  } catch (err) {
    rec.record('orch', Kinds.runEnd, { ok: false, error: String((err as Error)?.stack ?? err) })
    await rec.writeSteps(steps).catch(() => {})
    await rec.close().catch(() => {})
    throw err
  }
}

async function runRepeat (
  r: number,
  config: BenchmarkConfig,
  deps: EngineDeps,
  opts: RunOptions,
  rec: RunRecorder,
  allSteps: StepResult[],
  env: { now: () => number, sleep: (ms: number) => Promise<void>, log: Logger }
): Promise<RepeatOutcome> {
  const { now, sleep, log } = env
  rec.record('orch', 'orch.repeat.start', { repeat: r })

  let collecting: Collecting | undefined
  let lastBotStats: BotFleetStats | undefined
  let crashed: string | undefined
  const history: SearchStep[] = []

  const onProbe: BdsServerEvents['probe'] = (p: ProbeRecord) => {
    rec.record('probe', `probe.${p.type}`, p)
    if (collecting === undefined) return
    if (p.type === 'sample') collecting.probe.push(p)
    else if (p.type === 'mark' && p.label === collecting.label) collecting.markT = p.t
  }
  const onExit: BdsServerEvents['exit'] = info => {
    rec.record('bds', Kinds.bdsEvent, { event: 'exit', ...info })
    if (!info.expected) crashed = `server exited unexpectedly (code ${info.code}, signal ${info.signal})`
  }

  let server: BdsServer | undefined
  let sampler: Sampler<SysSample> | undefined
  let loadgen: LoadGenerator | undefined
  let outcome: RepeatOutcome | undefined
  try {
    server = await deps.createServer(r)
    server.on('probe', onProbe)
    server.on('exit', onExit)
    await server.start({ readyTimeoutMs: opts.readyTimeoutMs ?? 180_000 })
    rec.record('bds', Kinds.bdsEvent, { event: 'ready', pid: server.pid })
    for (const cmd of deps.scenarioSetup()) {
      server.send(cmd)
      rec.record('orch', 'orch.command', { command: cmd })
    }

    if (server.pid !== undefined) {
      sampler = deps.createSampler(server.pid)
      await sampler.start(s => {
        rec.record('sys', Kinds.sysSample, s)
        collecting?.sys.push(s)
      })
    } else {
      log.warn('server pid unknown; OS sampling disabled for this repeat')
    }

    loadgen = deps.createLoadGen(r)
    loadgen.onStats(s => {
      lastBotStats = s
      rec.record('bot', Kinds.botStats, s)
      collecting?.bots.push(s)
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
    await sleep(config.warmupSec * 1000)

    const abortOnCrash = (reason: string, failedAt?: number): RepeatOutcome => {
      const { lo, hi } = searchBounds(history)
      const o: RepeatOutcome = { done: true, repeat: r, maxPlayers: lo, capped: false, loadgenLimited: false, aborted: reason }
      const ff = hi ?? failedAt
      if (ff !== undefined) o.firstFail = ff
      return o
    }

    let prevPlayers = 0
    for (let index = 0; ; index++) {
      opts.signal?.throwIfAborted()
      if (crashed !== undefined) {
        // Crashed between steps (e.g. during warmup): don't measure a dead server.
        outcome = abortOnCrash(crashed)
        break
      }
      const plan = planNext({ ramp: config.ramp, history })
      if (plan.done) {
        outcome = { ...plan, repeat: r }
        break
      }
      const { players, phase } = plan
      const baseline = lastBotStats
      rec.record('orch', Kinds.stepStart, { repeat: r, index, players, phase, retry: plan.retry })

      const added = Math.max(0, players - prevPlayers)
      await loadgen.scaleTo(players, opts.scaleTimeoutMs ?? 60_000 + added * config.loadgen.joinIntervalMs)
      prevPlayers = players
      await sleep(config.ramp.settleSec * 1000)

      const label = `step-${index}-start`
      collecting = { label, probe: [], sys: [], bots: [] }
      const startT = now()
      server.send(`scriptevent bedperf:mark ${label}`)
      await sleep(config.ramp.holdSec * 1000)
      const endT = now()
      const win = collecting
      collecting = undefined
      server.send(`scriptevent bedperf:mark step-${index}-end`)

      // Drop probe windows that began before the server saw the start mark, and sys/bot intervals
      // that began before the hold: they overlap the scale/settle period.
      const markT = win.markT
      const probe = markT === undefined ? win.probe : win.probe.filter(s => s.t - s.windowMs >= markT)
      const evalRes = evaluateStep({
        probe,
        sys: trimToHold(win.sys, s => s.t - s.intervalMs, startT),
        bots: trimToHold(win.bots, b => b.t - lgOpts.statsIntervalMs, startT),
        ...(baseline !== undefined ? { botBaseline: baseline } : {}),
        players
      }, config.criteria)
      if (crashed !== undefined) {
        evalRes.pass = false
        evalRes.failReasons.push(crashed)
      }
      const step: StepResult = { repeat: r, index, players, phase, startT, endT, ...evalRes }
      allSteps.push(step)
      history.push({ players, outcome: stepOutcome(step) })
      rec.record('orch', Kinds.stepEnd, step, endT)
      await rec.writeSteps(allSteps)
      log.info(`repeat ${r} step ${index} [${phase}] ${players} players: ${stepOutcome(step)} tps=${step.tps.mean.toFixed(2)}${step.failReasons.length > 0 ? ` (${step.failReasons.join('; ')})` : ''}`)

      if (crashed !== undefined) {
        outcome = abortOnCrash(crashed, players)
        break
      }
    }
  } finally {
    collecting = undefined
    if (loadgen !== undefined) await loadgen.stop().catch(err => { log.warn(`loadgen stop failed: ${String(err)}`) })
    if (sampler !== undefined) await sampler.stop().catch(err => { log.warn(`sampler stop failed: ${String(err)}`) })
    if (server !== undefined) {
      await server.stop().catch(err => { log.warn(`server stop failed: ${String(err)}`) })
      server.off('probe', onProbe)
      server.off('exit', onExit)
    }
    rec.record('orch', 'orch.repeat.end', { repeat: r, outcome: outcome ?? null })
  }
  if (outcome === undefined) throw new Error(`repeat ${r} ended without a search result`)
  return outcome
}
