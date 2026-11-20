// `bedperf run`: wires bds-install, bds-process, probe-addon, sysmon, placement, loadgen and scenarios
// into the orchestrator engine, then writes the HTML report.
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  AGENT_TOKEN_ENV, bdsVersionFor, resolveServerSpec, serverLabel,
  type AgentSpec, type BdsInstance, type BdsServer, type BenchmarkConfig, type GametimeSample, type LaunchSpec, type PlacementPlan,
  type PlacementSetVerification, type PlacementVerification, type RunArtifacts, type Sampler, type ServerSpec
} from '@bedperf/core'
import {
  bdsZipSha256, createInstance, destroyInstance, ensureBds, ensureServer, hashTree, hostPlatform, pristineDirOf, resolveVersion, SERVER_COMPLETE_MARKER,
  serverCacheDir, serverExeName, serverSlug, venvBin, type InstalledServer
} from '@bedperf/bds-install'
import { BdsProcess, GametimeSampler, type SpawnFn } from '@bedperf/bds-process'
import { packDir } from '@bedperf/probe-addon'
import { createMachineSampler, createProcessSampler, idleCheck } from '@bedperf/sysmon'
import {
  applyToPid, applyToServerTree, parseProfile, planPlacement, planUsable, readTopology, verifyPlacement, verifyServerProcesses, wrapSpawn,
  type ServerProcesses
} from '@bedperf/placement'
import { BotFleet } from '@bedperf/loadgen'
import { connectAgents, type AgentPool } from '@bedperf/agent'
import { loadScenario } from '@bedperf/scenarios'
import {
  consoleLogger, EngineAgents, EnvGateError, runBenchmark, runSession,
  type BenchmarkOutcome, type EngineDeps, type EnginePlacement, type Logger, type RepeatOrder, type SessionOutcome
} from '@bedperf/orchestrator'
import { writeReport } from '@bedperf/report'
import { botFamily, instanceProperties, makeRunId, resolveScenario } from './plan.ts'
import { UsageError } from './args.ts'
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
  /**
   * Run the bots on remote `bedperf agent`s (distributed run). Not part of config.json: the topology is
   * recorded in meta.json `topology`.
   */
  agents?: {
    specs: AgentSpec[]
    /** Address of this machine the agents' bots dial (see orchestrator `resolveBotTargetHost`). */
    botTargetHost: string
    /** Shared secret. Default `$BEDPERF_AGENT_TOKEN`. */
    token?: string
  }
}

export interface RunCommandResult extends BenchmarkOutcome {
  report?: string
}

export interface SessionCommandResult extends SessionOutcome {
  reports: string[]
}

function bedbooCommit (): string | undefined {
  try {
    // stderr ignored: a checkout without .git (e.g. the Docker image) just has no commit.
    return execFileSync('git', ['-C', join(REPO_ROOT, 'vendor', 'bedboo'), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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

/**
 * Usage errors of a server spec on this host: Wine runs LeviLamina's Windows build on Linux only, and
 * native LeviLamina is Windows-only.
 */
export function checkServerHost (spec: ServerSpec, platform: NodeJS.Platform = process.platform): void {
  const s = resolveServerSpec(spec)
  const native = [s.flavor, ...s.mods].join('-')
  if (s.runtime === 'wine' && platform === 'win32') {
    throw new UsageError(`server ${serverLabel(s)}: runtime 'wine' runs a Windows build on a Linux host; on Windows run it natively (--server ${native})`)
  }
  if (s.flavor === 'levilamina' && s.runtime === 'native' && platform !== 'win32') {
    throw new UsageError(`server ${serverLabel(s)}: LeviLamina is Windows-only; on Linux run it under Wine (--server ${native}-wine)`)
  }
}

/**
 * A modded build `ensureServer` will take from the cache without installing anything: the complete
 * marker plus the files it checks (the game executable in `server/`, Endstone's venv). Anything less
 * means a reinstall, which downloads and so needs the EULA flag.
 */
export function moddedBuildCached (root: string, flavor: ServerSpec['flavor'], platform: NodeJS.Platform = process.platform): boolean {
  try {
    const m = JSON.parse(readFileSync(join(root, SERVER_COMPLETE_MARKER), 'utf8')) as { format?: number, build?: { exeName?: string } }
    const exe = m.build?.exeName
    if (m.format !== 2 || typeof exe !== 'string' || !existsSync(join(root, 'server', exe))) return false
    return flavor !== 'endstone' || existsSync(venvBin(join(root, 'venv'), 'python', platform === 'win32' ? 'windows' : 'linux'))
  } catch {
    return false
  }
}

const EULA_HINT ='Downloading it means accepting the Minecraft EULA (https://www.minecraft.net/eula): rerun with --accept-eula.'

/**
 * Install (or find in the cache) the server `spec` for the requested BDS version (`latest`, `preview`
 * or exact; modded flavors map `latest`/`preview` to their pinned build). Vanilla keeps the fast path:
 * an already extracted build needs no EULA flag. A modded build already installed (complete marker
 * present) needs none either; anything that downloads does.
 */
export async function installServer (spec: ServerSpec, requested: string, opts: { acceptEula?: boolean, preview?: boolean, log: Logger }): Promise<InstalledServer> {
  const s = resolveServerSpec(spec)
  checkServerHost(s)
  const log = (line: string): void => { opts.log.info(line) }
  if (s.flavor === 'bds' && s.runtime === 'wine') {
    // The Windows build under lip's Wine: lip needs an exact game version.
    const resolved = await resolveVersion(requested, 'win', { preview: opts.preview === true })
    const cached = moddedBuildCached(serverCacheDir(s, resolved.version), s.flavor)
    if (!cached && opts.acceptEula !== true) throw new Error(`server ${serverLabel(s)} (BDS ${resolved.version}) is not installed. ${EULA_HINT}`)
    if (!cached) opts.log.info(`installing ${serverLabel(s)} on BDS ${resolved.version} (lip downloads; this can take minutes)`)
    return await ensureServer(s, { acceptEula: true, bdsVersion: resolved.version, log })
  }
  if (s.flavor === 'bds') {
    const platform = hostPlatform()
    const resolved = await resolveVersion(requested, platform, { preview: opts.preview === true })
    if (!existsSync(join(pristineDirOf(resolved.version, { platform }), serverExeName(platform)))) {
      const ensured = await ensureBds(resolved, {
        acceptEula: opts.acceptEula === true,
        onProgress: p => { if (p.phase === 'extract') opts.log.info(`extracting BDS ${resolved.version}`) }
      }).catch((err: Error) => {
        if (/acceptEula/.test(err.message)) throw new Error(`BDS ${resolved.version} is not in the cache. ${EULA_HINT}`)
        throw err
      })
      if (!ensured.cached) opts.log.info(`installed BDS ${resolved.version} → ${ensured.dir}`)
    }
    // Extracted: ensureServer only reads the cache (no download, no network for an exact version).
    return await ensureServer(s, { acceptEula: true, bdsVersion: resolved.version, log })
  }
  const bdsVersion = bdsVersionFor(s, requested)
  const cached = moddedBuildCached(serverCacheDir(s, bdsVersion), s.flavor)
  if (!cached && opts.acceptEula !== true) throw new Error(`server ${serverLabel(s)} (BDS ${bdsVersion}) is not installed. ${EULA_HINT}`)
  if (!cached) opts.log.info(`installing ${serverLabel(s)} on BDS ${bdsVersion} (lip / pip downloads; this can take minutes)`)
  return await ensureServer(s, { acceptEula: true, bdsVersion, log })
}

/** `bedperf install --server <preset>`. */
export async function installServerCommand (spec: ServerSpec, requested: string, opts: { acceptEula?: boolean, preview?: boolean, logger?: Logger } = {}): Promise<InstalledServer> {
  return await installServer(spec, requested, {
    ...(opts.acceptEula !== undefined ? { acceptEula: opts.acceptEula } : {}),
    ...(opts.preview !== undefined ? { preview: opts.preview } : {}),
    log: opts.logger ?? consoleLogger
  })
}

/** Resolve and install the server build (downloading it if needed) and pick the bot family. */
export async function prepareBuild (config: BenchmarkConfig, opts: { acceptEula?: boolean, log: Logger }): Promise<{ bdsVersion: string, botVersion: string, server: InstalledServer }> {
  const server = await installServer(config.server ?? resolveServerSpec(undefined), config.bdsVersion, opts)
  const bdsVersion = server.build.bdsVersion
  return { bdsVersion, botVersion: pickBotVersion(config, bdsVersion), server }
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
export async function planRunPlacement (config: BenchmarkConfig, log: Logger, o: { bots?: 'local' | 'remote' } = {}): Promise<PlacementPlan | undefined> {
  const pc = config.placement
  if (pc === undefined || !pc.enabled) return undefined
  const profile = parseProfile({
    ...(pc.label !== undefined ? { label: pc.label } : {}),
    placement: { serverCpus: pc.serverCpus, botCpus: pc.botCpus, harnessCpus: pc.harnessCpus, priority: pc.priority }
  })
  const plan = planPlacement(await readTopology(), profile, { bots: o.bots ?? 'local' })
  for (const c of plan.checks) {
    if (c.level === 'warn') log.warn(`placement: ${c.summary}`)
    else if (c.level === 'info') log.info(`placement: ${c.summary}`)
  }
  if (!planUsable(plan)) {
    const fails = plan.checks.filter(c => c.level === 'fail').map(c => c.summary)
    throw new EnvGateError(`CPU placement is not usable: ${fails.join('; ')} (set placement.enabled=false to run without placement)`, fails)
  }
  log.info(`placement (${plan.kind}${plan.mode !== undefined && plan.mode !== 'local' ? `, ${plan.mode}` : ''}): server CPUs ${plan.serverCpus.join(',')}, bots ${plan.botCpus.length > 0 ? plan.botCpus.join(',') : 'remote'}, harness ${plan.harnessCpus.join(',')}, priority ${plan.priority}`)
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

/**
 * One verification out of a launched server's set: the game process' result, failing when any member
 * (launcher, helpers) is outside the plan. Members that have exited are not violations.
 */
export function flattenSetVerification (set: PlacementSetVerification): PlacementVerification {
  const others = set.members
    .filter(m => m.role !== 'server')
    .flatMap(m => m.verification.violations
      .filter(v => v.kind !== 'process_gone')
      .map(v => ({ ...v, message: `${m.role} process ${m.verification.pid}: ${v.message}` })))
  return { ...set.server, verified: set.verified, checks: set.checks, violations: [...set.server.violations, ...others] }
}

/** The game process fully; with a launcher or helpers (wineserver) also those, for affinity. */
async function verifyServerSet (pid: number, server: BdsServer | undefined, plan: PlacementPlan): Promise<PlacementVerification> {
  const launcherPid = server?.launcherPid
  let auxPids: number[] = []
  try { auxPids = (await server?.auxPids?.()) ?? [] } catch {}
  if ((launcherPid === undefined || launcherPid === pid) && auxPids.length === 0) return await verifyPlacement(pid, plan)
  return flattenSetVerification(await verifyServerProcesses(plan, { serverPid: pid, ...(launcherPid !== undefined ? { launcherPid } : {}), auxPids }))
}

function enginePlacement (plan: PlacementPlan): EnginePlacement {
  return {
    plan,
    method: process.platform === 'win32' ? 'post-spawn' : 'preexec',
    verifyServer: (pid, server) => verifyServerSet(pid, server, plan),
    applyWorker: async pid => {
      const r = await applyToPid(pid, plan.botCpus, 'normal')
      const error = [r.affinityError, r.priorityError].filter(Boolean).join('; ')
      return r.ok ? { ok: true } : { ok: false, error }
    }
  }
}

/** Servers of the runs in progress (see `stopActiveServers`). */
const activeServers = new Set<BdsProcess>()
/** Instance dirs to delete if the process is forced to exit. */
const activeInstances = new Set<BdsInstance>()
/** One deletion per instance dir: the forced-exit path and the run's own cleanup may both ask for it. */
const deletions = new Map<string, Promise<void>>()

function destroyOnce (inst: BdsInstance): Promise<void> {
  let d = deletions.get(inst.dir)
  if (d === undefined) {
    d = destroyInstance(inst)
    deletions.set(inst.dir, d)
  }
  return d
}

/**
 * Stop every server this process started and that still runs (graceful `stop`, killed after
 * `timeoutMs`), then delete their instance dirs (unless kept). For a forced exit (second Ctrl+C,
 * SIGTERM): a launcher-started server on Linux runs in its own process group, so the terminal's
 * signal never reaches it, and `process.exit` skips the engine's cleanup.
 */
export async function stopActiveServers (opts: { timeoutMs?: number } = {}): Promise<void> {
  const t = opts.timeoutMs ?? 8000
  // Every wait is bounded: a run whose exit never completes must not keep the others (or the exit) waiting.
  const bounded = async (p: Promise<unknown>, ms: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([p, new Promise(resolve => { timer = setTimeout(resolve, ms) })])
    } catch {} finally {
      clearTimeout(timer)
    }
  }
  const servers = [...activeServers]
  activeServers.clear()
  await Promise.all(servers.map(async s => {
    await bounded(s.stop(t), t + 2000)
    if (s.pid !== undefined || s.launcherPid !== undefined) await bounded(s.kill(), 3000)
  }))
  for (const inst of [...activeInstances]) {
    await destroyOnce(inst).catch(() => {})
    activeInstances.delete(inst)
  }
}

/**
 * A BdsProcess for `launch`, placed on the plan's server CPUs. Linux starts the launcher under
 * `taskset` (and `nice`), which every descendant inherits (Wine's game process and wineserver,
 * Endstone's Python and its bedrock_server). Windows applies the plan to the launcher right after
 * the spawn (children created later inherit its mask) and again to the game process as soon as it is
 * identified (`serverPid`); `start()` resolves only once both are done.
 */
function placedServer (instance: BdsInstance, launch: LaunchSpec, logFile: string, plan: PlacementPlan | undefined, log: Logger): BdsProcess {
  if (plan === undefined) return new BdsProcess(instance, { logFile, launch })
  let pending: Array<Promise<void>> = []
  let launcher: number | undefined
  const applyTree = (procs: ServerProcesses): void => {
    pending.push(applyToServerTree(plan, procs).then(
      r => {
        if (r.ok) return
        const errs = r.results.flatMap(({ role, result: x }) => [x.affinityError, x.priorityError].filter(Boolean).map(e => `${role}: ${String(e)}`))
        log.warn(`placement: server not placed: ${errs.join('; ')}`)
      },
      (err: unknown) => { log.warn(`placement: server not placed: ${String(err)}`) }
    ))
  }
  const spawn: SpawnFn = (command, args, options) => {
    const w = wrapSpawn(command, args, plan)
    const child = nodeSpawn(w.command, w.args, options)
    pending = []
    launcher = child.pid
    if (w.postSpawnApplyRequired && child.pid !== undefined) applyTree({ launcherPid: child.pid })
    return child
  }
  const proc = new BdsProcess(instance, { logFile, spawn, launch })
  if (process.platform === 'win32') {
    proc.on('serverPid', pid => { if (pid !== launcher) applyTree({ serverPid: pid, ...(launcher !== undefined ? { launcherPid: launcher } : {}) }) })
  }
  const start = proc.start.bind(proc)
  proc.start = async (o?: { readyTimeoutMs?: number }) => {
    await start(o)
    await Promise.all(pending)
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
  server: InstalledServer
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
  const { bdsVersion, botVersion, server } = await prepareBuild(input, { acceptEula: opts.acceptEula, log })
  // Record what actually ran: the concrete build, family and server spec instead of 'latest' / absent.
  const config: BenchmarkConfig = { ...input, bdsVersion, botVersion, server: server.build.spec }
  log.info(`${config.name}: ${server.build.label} on BDS ${bdsVersion}, bots ${botVersion}, scenario ${scenario.name ?? scenario.module}`)
  return { config, server, scenario, properties, setup }
}

function artifactsMeta (server: InstalledServer): { artifacts: RunArtifacts, commit: string | undefined } {
  const commit = bedbooCommit()
  // The BDS archive the build came from (vanilla / Endstone: the bds-install sidecar; LeviLamina: lip's).
  // The sidecar fallback reads the zip of the build's own platform (a Wine run uses the Windows build).
  const zipSha = server.build.artifacts.find(a => a.name === 'bds')?.sha256 ?? bdsZipSha256(server.build.bdsVersion, { platform: server.build.binaryPlatform })
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
  ctx: { runsDir: string, runDir: string, port: number, plan: PlacementPlan | undefined, instances: BdsInstance[], log: Logger, opts: RunCommandOptions, agents?: EngineAgents<AgentPool> | undefined }
): EngineDeps {
  const { config } = p
  const { log, plan, agents } = ctx
  return {
    runsDir: ctx.runsDir,
    createServer: async repeat => {
      const instance = await createInstance({
        server: p.server,
        port: ctx.port,
        presets: ctx.opts.propertyPresets ?? ['bench-default'],
        properties: p.properties,
        behaviorPacks: [packDir()],
        ...(config.world.snapshot !== undefined ? { worldSnapshot: { id: config.world.snapshot } } : {})
      })
      ctx.instances.push(instance)
      if (ctx.opts.keepInstances !== true) activeInstances.add(instance)
      log.info(`repeat ${repeat}: instance ${instance.dir}`)
      const logName = config.repeats === 1 && repeat === 0 ? 'bds.log' : `bds-r${repeat}.log`
      const proc = placedServer(instance, p.server.launch(instance.dir), join(ctx.runDir, logName), plan, log)
      proc.on('warning', msg => log.warn(`bds: ${msg}`))
      proc.on('serverPid', pid => { if (pid !== proc.launcherPid) log.info(`repeat ${repeat}: game process ${pid} (launcher ${proc.launcherPid ?? '?'})`) })
      activeServers.add(proc)
      proc.on('exit', () => { activeServers.delete(proc) })
      return proc
    },
    createLoadGen: () => {
      if (agents === undefined) return new BotFleet()
      // the engine connects (or reconnects) the agents before every repeat
      const pool = agents.pool
      if (pool === undefined) throw new Error('bot agents are not connected')
      return new BotFleet({ spawnWorker: pool.workerFactory() })
    },
    createSampler: pid => createProcessSampler({ pid }),
    scenarioSetup: () => p.setup,
    loadGenOptions: {
      version: config.botVersion ?? config.bdsVersion,
      scenarioModule: p.scenario.module,
      // the engine points the bots at agents.botTargetHost
      ...(p.scenario.name !== undefined ? { scenarioName: p.scenario.name } : {}),
      ...(config.loadgen.saturation !== undefined ? { saturation: config.loadgen.saturation } : {})
    },
    serverBuild: p.server.build,
    logger: log,
    ...(plan !== undefined ? { placement: enginePlacement(plan) } : {}),
    ...(ctx.opts.skipIdleCheck === true ? {} : { idleCheck: o => idleCheck(o) }),
    createMachineSampler: o => createMachineSampler(o.serverCpus !== undefined ? { serverCpus: o.serverCpus } : {}),
    createGametimeSampler: gametimeSampler,
    ...(agents !== undefined ? { agents } : {})
  }
}

/** The remote agents of a distributed run (connected lazily by the engine), or undefined for local bots. */
function openAgents (opts: RunCommandOptions, log: Logger): EngineAgents<AgentPool> | undefined {
  const a = opts.agents
  if (a === undefined || a.specs.length === 0) return undefined
  const token = a.token ?? process.env[AGENT_TOKEN_ENV] ?? ''
  return new EngineAgents<AgentPool>({
    specs: a.specs,
    botTargetHost: a.botTargetHost,
    idleCheck: opts.skipIdleCheck !== true,
    connect: async events => {
      log.info(`connecting to ${a.specs.length} bot agent(s): ${a.specs.map(s => s.address).join(', ')}`)
      const pool = await connectAgents(a.specs, { token, onTelemetry: events.telemetry, onLink: events.link, log: line => { log.info(`agents: ${line}`) } })
      for (const h of pool.agents) log.info(`agent ${h.name}: ${h.info.machine.cpuModel}, ${h.info.cpus} CPUs, weight ${h.weight}${h.maxBots !== undefined ? `, max ${h.maxBots} bots` : ''}`)
      return pool
    }
  })
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

/** Run dir name: the config name, plus the server for a non-vanilla one (`quick-levilamina-levioptimize-wine`). */
function runName (config: BenchmarkConfig): string {
  const spec = resolveServerSpec(config.server)
  return spec.flavor === 'bds' && spec.runtime === 'native' ? config.name : `${config.name}-${serverSlug(spec)}`
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
    activeInstances.delete(inst)
    await destroyOnce(inst).catch(err => log.warn(`could not delete instance ${inst.dir}: ${String(err)}`))
  }
}

export async function runCommand (input: BenchmarkConfig, opts: RunCommandOptions = {}): Promise<RunCommandResult> {
  const log = opts.logger ?? consoleLogger
  // Validate everything that needs no I/O before downloading or starting anything.
  instanceProperties(input, resolveScenario(input.scenario.module))
  return await withLock(opts, async lock => {
    const p = await prepare(input, opts, log)
    const agents = openAgents(opts, log)
    const plan = await planRunPlacement(p.config, log, { bots: agents !== undefined ? 'remote' : 'local' })
    if (plan !== undefined) await applyHarness(plan, log)
    const runsDir = resolve(opts.runsDir ?? join(REPO_ROOT, 'runs'))
    const runId = freshId(runsDir, runName(p.config))
    lock?.setRunId(runId)
    const instances: BdsInstance[] = []
    const { artifacts, commit } = artifactsMeta(p.server)
    try {
      const deps = makeDeps(p, { runsDir, runDir: join(runsDir, runId), port: opts.port ?? 19200, plan, instances, log, opts, agents })
      const outcome = await runBenchmark(p.config, deps, {
        runId,
        meta: { bdsVersion: p.config.bdsVersion, botVersion: p.config.botVersion!, colocated: agents === undefined, artifacts, ...(commit !== undefined ? { bedbooCommit: commit } : {}) },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      })
      let report: string | undefined
      if (opts.noReport !== true) {
        report = await writeReport(outcome.dir)
        log.info(`report → ${report}`)
      }
      return { ...outcome, ...(report !== undefined ? { report } : {}) }
    } finally {
      await agents?.close().catch(err => { log.warn(`closing the bot agents failed: ${String(err)}`) })
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
    const agents = openAgents(opts, log)
    const plans: Array<PlacementPlan | undefined> = []
    for (const p of prepared) plans.push(await planRunPlacement(p.config, log, { bots: agents !== undefined ? 'remote' : 'local' }))
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
        const runId = freshId(dir, runName(p.config), taken)
        const { artifacts, commit } = artifactsMeta(p.server)
        return {
          config: p.config,
          deps: makeDeps(p, { runsDir: dir, runDir: join(dir, runId), port: opts.port ?? 19200, plan: plans[i], instances, log, opts, agents }),
          opts: { runId, meta: { bdsVersion: p.config.bdsVersion, botVersion: p.config.botVersion!, colocated: agents === undefined, artifacts, ...(commit !== undefined ? { bedbooCommit: commit } : {}) } }
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
      await agents?.close().catch(err => { log.warn(`closing the bot agents failed: ${String(err)}`) })
      await destroyAll(instances, opts, log)
    }
  })
}
