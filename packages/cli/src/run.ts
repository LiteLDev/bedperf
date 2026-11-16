// `bedperf run`: wires bds-install, bds-process, probe-addon, sysmon, placement, loadgen and scenarios
// into the orchestrator engine, then writes the HTML report.
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { BdsInstance, BdsServer, BenchmarkConfig, GametimeSample, PlacementPlan, Sampler } from '@bedperf/core'
import { bdsZipSha256, createInstance, destroyInstance, ensureBds, hashTree, hostPlatform, pristineDirOf, resolveVersion, serverExeName } from '@bedperf/bds-install'
import { BdsProcess, GametimeSampler, type SpawnFn } from '@bedperf/bds-process'
import { packDir } from '@bedperf/probe-addon'
import { createMachineSampler, createProcessSampler, idleCheck } from '@bedperf/sysmon'
import { applyToPid, parseProfile, planPlacement, planUsable, readTopology, verifyPlacement, wrapSpawn } from '@bedperf/placement'
import { BotFleet } from '@bedperf/loadgen'
import { loadScenario } from '@bedperf/scenarios'
import {
  consoleLogger, EnvGateError, runBenchmark, runSession,
  type BenchmarkOutcome, type EngineDeps, type EnginePlacement, type Logger, type RepeatOrder, type SessionOutcome
} from '@bedperf/orchestrator'
import { writeReport } from '@bedperf/report'
import { botFamily, instanceProperties, makeRunId, resolveScenario } from './plan.ts'
import { acquireMachineLock, type MachineLock } from './lock.ts'
import pkg from '../package.json' with { type: 'json' }

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export interface RunCommandOptions {
  /** Parent of run directories. Default `<repo>/runs`. */
  runsDir?: string
  /** IPv4 port for BDS (v6 = +1). Default 19200. */
  port?: number
  acceptEula?: boolean
  /** Keep instance directories after the run (for debugging). */
  keepInstances?: boolean
  /** Skip report.html. */
  noReport?: boolean
  /** Presets from bds-install layered under the config's properties. Default ['bench-default']. */
  propertyPresets?: Array<'vanilla-default' | 'bench-default' | 'bench-flat'>
  logger?: Logger
  signal?: AbortSignal
  /** Take the machine lock (one measured run per machine). Default true. */
  lock?: boolean
  /** Lock file. Default `$BEDPERF_LOCK` or `<cache root>/machine.lock`. */
  lockPath?: string
  /** Do not run the idle gate before repeats. */
  skipIdleCheck?: boolean
}

export interface RunCommandResult extends BenchmarkOutcome {
  report?: string
}

export interface SessionCommandResult extends SessionOutcome {
  reports: string[]
}

function bedbooCommit (): string | undefined {
  try {
    return execFileSync('git', ['-C', join(REPO_ROOT, 'vendor', 'bedboo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

function probePackSha256 (): string | undefined {
  try {
    return hashTree(packDir())
  } catch {
    return undefined
  }
}

function testedBotVersions (): string[] {
  const require = createRequire(import.meta.url)
  const b = require('bedboo') as { testedVersions?: string[] }
  return b.testedVersions ?? []
}

/** Resolve the BDS build (downloading it if needed) and the bot family. */
export async function prepareBuild (config: BenchmarkConfig, opts: { acceptEula?: boolean, log: Logger }): Promise<{ bdsVersion: string, botVersion: string }> {
  const platform = hostPlatform()
  const resolved = await resolveVersion(config.bdsVersion, platform)
  // Already extracted: no download, so no EULA flag needed (ensureBds demands it unconditionally).
  if (existsSync(join(pristineDirOf(resolved.version, { platform }), serverExeName(platform)))) {
    return { bdsVersion: resolved.version, botVersion: pickBotVersion(config, resolved.version) }
  }
  const ensured = await ensureBds(resolved, {
    acceptEula: opts.acceptEula === true,
    onProgress: p => { if (p.phase === 'extract') opts.log.info(`extracting BDS ${resolved.version}`) }
  }).catch((err: Error) => {
    if (/acceptEula/.test(err.message)) {
      throw new Error(`BDS ${resolved.version} is not in the cache. Downloading it means accepting the Minecraft EULA (https://www.minecraft.net/eula): rerun with --accept-eula.`)
    }
    throw err
  })
  if (!ensured.cached) opts.log.info(`installed BDS ${resolved.version} → ${ensured.dir}`)
  return { bdsVersion: resolved.version, botVersion: pickBotVersion(config, resolved.version) }
}

function pickBotVersion (config: BenchmarkConfig, bdsVersion: string): string {
  const tested = testedBotVersions()
  const botVersion = config.botVersion ?? botFamily(bdsVersion, tested)
  if (botVersion === undefined) {
    throw new Error(`no bedboo protocol family for BDS ${bdsVersion} (bedboo tests: ${tested.join(', ')}). Pin bdsVersion or set botVersion.`)
  }
  return botVersion
}

/**
 * Plan the CPU placement of a config (once per run). Throws `EnvGateError` when a check fails (unless
 * `placement.enabled` is false, which returns undefined).
 */
export async function planRunPlacement (config: BenchmarkConfig, log: Logger): Promise<PlacementPlan | undefined> {
  const pc = config.placement
  if (pc === undefined || !pc.enabled) return undefined
  const profile = parseProfile({
    ...(pc.label !== undefined ? { label: pc.label } : {}),
    placement: { serverCpus: pc.serverCpus, botCpus: pc.botCpus, harnessCpus: pc.harnessCpus, priority: pc.priority }
  })
  const plan = planPlacement(await readTopology(), profile)
  for (const c of plan.checks) {
    if (c.level === 'warn') log.warn(`placement: ${c.summary}`)
    else if (c.level === 'info') log.info(`placement: ${c.summary}`)
  }
  if (!planUsable(plan)) {
    const fails = plan.checks.filter(c => c.level === 'fail').map(c => c.summary)
    throw new EnvGateError(`CPU placement is not usable: ${fails.join('; ')} (set placement.enabled=false to run without placement)`, fails)
  }
  log.info(`placement (${plan.kind}): server CPUs ${plan.serverCpus.join(',')}, bots ${plan.botCpus.join(',')}, harness ${plan.harnessCpus.join(',')}, priority ${plan.priority}`)
  return plan
}

async function applyHarness (plan: PlacementPlan, log: Logger): Promise<void> {
  try {
    const r = await applyToPid(process.pid, plan.harnessCpus, 'normal')
    if (!r.ok) log.warn(`placement: harness not placed: ${[r.affinityError, r.priorityError].filter(Boolean).join('; ')}`)
  } catch (err) {
    log.warn(`placement: harness not placed: ${String(err)}`)
  }
}

function enginePlacement (plan: PlacementPlan): EnginePlacement {
  return {
    plan,
    method: process.platform === 'win32' ? 'post-spawn' : 'preexec',
    verifyServer: pid => verifyPlacement(pid, plan),
    applyWorker: async pid => {
      const r = await applyToPid(pid, plan.botCpus, 'normal')
      const error = [r.affinityError, r.priorityError].filter(Boolean).join('; ')
      return r.ok ? { ok: true } : { ok: false, error }
    }
  }
}

/**
 * A BdsProcess placed on the plan's server CPUs: Linux starts it under `taskset` (and `nice`); Windows
 * applies affinity and priority right after the spawn, and `start()` resolves only once that is done.
 */
function placedServer (instance: BdsInstance, logFile: string, plan: PlacementPlan | undefined, log: Logger): BdsProcess {
  if (plan === undefined) return new BdsProcess(instance, { logFile })
  let applied: Promise<void> = Promise.resolve()
  const spawn: SpawnFn = (command, args, options) => {
    const w = wrapSpawn(command, args, plan)
    const child = nodeSpawn(w.command, w.args, options)
    if (w.postSpawnApplyRequired && child.pid !== undefined) {
      applied = applyToPid(child.pid, plan.serverCpus, plan.priority).then(
        r => { if (!r.ok) log.warn(`placement: server not placed: ${[r.affinityError, r.priorityError].filter(Boolean).join('; ')}`) },
        (err: unknown) => { log.warn(`placement: server not placed: ${String(err)}`) }
      )
    }
    return child
  }
  const proc = new BdsProcess(instance, { logFile, spawn })
  const start = proc.start.bind(proc)
  proc.start = async (o?: { readyTimeoutMs?: number }) => {
    await start(o)
    await applied
  }
  return proc
}

function gametimeSampler (server: BdsServer, intervalMs: number): Sampler<GametimeSample> | undefined {
  if (!(server instanceof BdsProcess)) return undefined
  const g = new GametimeSampler(server, { intervalMs })
  return {
    start: async onSample => { g.on('sample', onSample); g.start() },
    stop: () => g.stop()
  }
}

interface Prepared {
  config: BenchmarkConfig
  scenario: ReturnType<typeof resolveScenario>
  properties: ReturnType<typeof instanceProperties>
  setup: string[]
}

/** Everything that needs no server: scenario, properties, BDS build. */
async function prepare (input: BenchmarkConfig, opts: RunCommandOptions, log: Logger): Promise<Prepared> {
  const scenario = resolveScenario(input.scenario.module)
  const properties = instanceProperties(input, scenario)
  const scen = await loadScenario(scenario.module)
  const setup = scen.serverSetup?.(input.scenario.params ?? {}) ?? []
  const { bdsVersion, botVersion } = await prepareBuild(input, { acceptEula: opts.acceptEula, log })
  // Record what actually ran: the concrete build and family instead of 'latest'.
  const config: BenchmarkConfig = { ...input, bdsVersion, botVersion }
  log.info(`${config.name}: BDS ${bdsVersion}, bots ${botVersion}, scenario ${scenario.name ?? scenario.module}`)
  return { config, scenario, properties, setup }
}

function artifactsMeta (bdsVersion: string): { artifacts: Record<string, string>, commit: string | undefined } {
  const commit = bedbooCommit()
  const zipSha = bdsZipSha256(bdsVersion)
  const packSha = probePackSha256()
  return {
    commit,
    artifacts: {
      ...(zipSha !== undefined ? { bdsZipSha256: zipSha } : {}),
      ...(packSha !== undefined ? { probePackSha256: packSha } : {}),
      ...(commit !== undefined ? { bedbooCommit: commit } : {})
    }
  }
}

function makeDeps (
  p: Prepared,
  ctx: { runsDir: string, runDir: string, port: number, plan: PlacementPlan | undefined, instances: BdsInstance[], log: Logger, opts: RunCommandOptions }
): EngineDeps {
  const { config } = p
  const { log, plan } = ctx
  return {
    runsDir: ctx.runsDir,
    createServer: async repeat => {
      const instance = await createInstance({
        version: config.bdsVersion,
        port: ctx.port,
        presets: ctx.opts.propertyPresets ?? ['bench-default'],
        properties: p.properties,
        behaviorPacks: [packDir()],
        ...(config.world.snapshot !== undefined ? { worldSnapshot: { id: config.world.snapshot } } : {})
      })
      ctx.instances.push(instance)
      log.info(`repeat ${repeat}: instance ${instance.dir}`)
      const logName = config.repeats === 1 && repeat === 0 ? 'bds.log' : `bds-r${repeat}.log`
      const proc = placedServer(instance, join(ctx.runDir, logName), plan, log)
      proc.on('warning', msg => log.warn(`bds: ${msg}`))
      return proc
    },
    createLoadGen: () => new BotFleet(),
    createSampler: pid => createProcessSampler({ pid }),
    scenarioSetup: () => p.setup,
    loadGenOptions: { version: config.botVersion ?? config.bdsVersion, scenarioModule: p.scenario.module },
    logger: log,
    ...(plan !== undefined ? { placement: enginePlacement(plan) } : {}),
    ...(ctx.opts.skipIdleCheck === true ? {} : { idleCheck: o => idleCheck(o) }),
    createMachineSampler: o => createMachineSampler(o.serverCpus !== undefined ? { serverCpus: o.serverCpus } : {}),
    createGametimeSampler: gametimeSampler
  }
}

async function withLock<T> (opts: RunCommandOptions, fn: (lock: MachineLock | undefined) => Promise<T>): Promise<T> {
  // One measured run per machine: taken before any download or server start, released in finally / on exit.
  const lock = opts.lock === false
    ? undefined
    : await acquireMachineLock({ bedperfVersion: pkg.version, ...(opts.lockPath !== undefined ? { path: opts.lockPath } : {}) })
  try {
    return await fn(lock)
  } finally {
    lock?.release()
  }
}

function freshId (dir: string, name: string, taken: Set<string> = new Set()): string {
  let id = makeRunId(Date.now(), name)
  for (let i = 2; existsSync(join(dir, id)) || taken.has(id); i++) id = `${makeRunId(Date.now(), name)}-${i}`
  taken.add(id)
  return id
}

async function destroyAll (instances: BdsInstance[], opts: RunCommandOptions, log: Logger): Promise<void> {
  if (opts.keepInstances === true) return
  for (const inst of instances) {
    await destroyInstance(inst).catch(err => log.warn(`could not delete instance ${inst.dir}: ${String(err)}`))
  }
}

export async function runCommand (input: BenchmarkConfig, opts: RunCommandOptions = {}): Promise<RunCommandResult> {
  const log = opts.logger ?? consoleLogger
  // Validate everything that needs no I/O before downloading or starting anything.
  instanceProperties(input, resolveScenario(input.scenario.module))
  return await withLock(opts, async lock => {
    const p = await prepare(input, opts, log)
    const plan = await planRunPlacement(p.config, log)
    if (plan !== undefined) await applyHarness(plan, log)
    const runsDir = resolve(opts.runsDir ?? join(REPO_ROOT, 'runs'))
    const runId = freshId(runsDir, p.config.name)
    lock?.setRunId(runId)
    const instances: BdsInstance[] = []
    const { artifacts, commit } = artifactsMeta(p.config.bdsVersion)
    try {
      const deps = makeDeps(p, { runsDir, runDir: join(runsDir, runId), port: opts.port ?? 19200, plan, instances, log, opts })
      const outcome = await runBenchmark(p.config, deps, {
        runId,
        meta: { bdsVersion: p.config.bdsVersion, botVersion: p.config.botVersion!, colocated: true, artifacts, ...(commit !== undefined ? { bedbooCommit: commit } : {}) },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      })
      let report: string | undefined
      if (opts.noReport !== true) {
        report = await writeReport(outcome.dir)
        log.info(`report → ${report}`)
      }
      return { ...outcome, ...(report !== undefined ? { report } : {}) }
    } finally {
      await destroyAll(instances, opts, log)
    }
  })
}

/**
 * A/B session: several configs, their repeats interleaved by `order`. Writes
 * `<runsDir>/<sessionId>/session.json` plus one run dir per config inside it.
 */
export async function runSessionCommand (inputs: readonly BenchmarkConfig[], order: RepeatOrder, opts: RunCommandOptions = {}): Promise<SessionCommandResult> {
  const log = opts.logger ?? consoleLogger
  if (inputs.length === 0) throw new Error('a session needs at least one config')
  for (const c of inputs) instanceProperties(c, resolveScenario(c.scenario.module))
  return await withLock(opts, async lock => {
    const prepared: Prepared[] = []
    for (const c of inputs) prepared.push(await prepare(c, opts, log))
    const plans: Array<PlacementPlan | undefined> = []
    for (const p of prepared) plans.push(await planRunPlacement(p.config, log))
    const first = plans.find(x => x !== undefined)
    if (first !== undefined) {
      if (plans.some(x => x !== undefined && x.harnessCpus.join(',') !== first.harnessCpus.join(','))) {
        log.warn('placement: the configs of this session plan different harness CPU sets; the harness uses the first one')
      }
      await applyHarness(first, log)
    }
    const runsDir = resolve(opts.runsDir ?? join(REPO_ROOT, 'runs'))
    const sessionId = freshId(runsDir, 'session')
    lock?.setRunId(sessionId)
    const dir = join(runsDir, sessionId)
    const instances: BdsInstance[] = []
    const taken = new Set<string>()
    try {
      const entries = prepared.map((p, i) => {
        const runId = freshId(dir, p.config.name, taken)
        const { artifacts, commit } = artifactsMeta(p.config.bdsVersion)
        return {
          config: p.config,
          deps: makeDeps(p, { runsDir: dir, runDir: join(dir, runId), port: opts.port ?? 19200, plan: plans[i], instances, log, opts }),
          opts: { runId, meta: { bdsVersion: p.config.bdsVersion, botVersion: p.config.botVersion!, colocated: true, artifacts, ...(commit !== undefined ? { bedbooCommit: commit } : {}) } }
        }
      })
      const out = await runSession(entries, { sessionId, dir, order, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) })
      const reports: string[] = []
      if (opts.noReport !== true) {
        for (const r of out.runs) {
          const rep = await writeReport(r.dir)
          reports.push(rep)
          log.info(`report → ${rep}`)
        }
      }
      return { ...out, reports }
    } finally {
      await destroyAll(instances, opts, log)
    }
  })
}
