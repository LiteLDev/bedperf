// `bedperf run`: wires bds-install, bds-process, probe-addon, sysmon, loadgen and scenarios into the
// orchestrator engine, then writes the HTML report.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import type { BdsInstance, BenchmarkConfig } from '@bedperf/core'
import { bdsZipSha256, createInstance, destroyInstance, ensureBds, hashTree, hostPlatform, pristineDirOf, resolveVersion, serverExeName } from '@bedperf/bds-install'
import { BdsProcess } from '@bedperf/bds-process'
import { packDir } from '@bedperf/probe-addon'
import { createProcessSampler } from '@bedperf/sysmon'
import { BotFleet } from '@bedperf/loadgen'
import { loadScenario } from '@bedperf/scenarios'
import { consoleLogger, runBenchmark, type BenchmarkOutcome, type Logger } from '@bedperf/orchestrator'
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
}

export interface RunCommandResult extends BenchmarkOutcome {
  report?: string
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

export async function runCommand (input: BenchmarkConfig, opts: RunCommandOptions = {}): Promise<RunCommandResult> {
  const log = opts.logger ?? consoleLogger
  const scenario = resolveScenario(input.scenario.module)
  // Validate everything that needs no I/O before downloading or starting anything.
  const properties = instanceProperties(input, scenario)
  const scen = await loadScenario(scenario.module)
  const params = input.scenario.params ?? {}
  const setup = scen.serverSetup?.(params) ?? []

  // One measured run per machine: taken before any download or server start, released in finally / on exit.
  const lock = opts.lock === false
    ? undefined
    : await acquireMachineLock({ bedperfVersion: pkg.version, ...(opts.lockPath !== undefined ? { path: opts.lockPath } : {}) })
  try {
    return await runLocked(input, opts, { log, scenario, properties, setup, lock })
  } finally {
    lock?.release()
  }
}

async function runLocked (
  input: BenchmarkConfig,
  opts: RunCommandOptions,
  ctx: { log: Logger, scenario: ReturnType<typeof resolveScenario>, properties: ReturnType<typeof instanceProperties>, setup: string[], lock: MachineLock | undefined }
): Promise<RunCommandResult> {
  const { log, scenario, properties, setup, lock } = ctx
  const { bdsVersion, botVersion } = await prepareBuild(input, { acceptEula: opts.acceptEula, log })
  // Record what actually ran: the concrete build and family instead of 'latest'.
  const config: BenchmarkConfig = { ...input, bdsVersion, botVersion }
  log.info(`BDS ${bdsVersion}, bots ${botVersion}, scenario ${scenario.name ?? scenario.module}`)

  const runsDir = resolve(opts.runsDir ?? join(REPO_ROOT, 'runs'))
  let runId = makeRunId(Date.now(), config.name)
  for (let i = 2; existsSync(join(runsDir, runId)); i++) runId = `${makeRunId(Date.now(), config.name)}-${i}`
  lock?.setRunId(runId)
  const runDir = join(runsDir, runId)
  const port = opts.port ?? 19200
  const instances: BdsInstance[] = []
  const commit = bedbooCommit()
  const zipSha = bdsZipSha256(bdsVersion)
  const packSha = probePackSha256()
  const artifacts = {
    ...(zipSha !== undefined ? { bdsZipSha256: zipSha } : {}),
    ...(packSha !== undefined ? { probePackSha256: packSha } : {}),
    ...(commit !== undefined ? { bedbooCommit: commit } : {})
  }

  try {
    const outcome = await runBenchmark(config, {
      runsDir,
      createServer: async repeat => {
        const instance = await createInstance({
          version: bdsVersion,
          port,
          presets: opts.propertyPresets ?? ['bench-default'],
          properties,
          behaviorPacks: [packDir()],
          ...(config.world.snapshot !== undefined ? { worldSnapshot: { id: config.world.snapshot } } : {})
        })
        instances.push(instance)
        log.info(`repeat ${repeat}: instance ${instance.dir}`)
        const proc = new BdsProcess(instance, { logFile: join(runDir, config.repeats > 1 ? `bds-r${repeat}.log` : 'bds.log') })
        proc.on('warning', msg => log.warn(`bds: ${msg}`))
        return proc
      },
      createLoadGen: () => new BotFleet(),
      createSampler: pid => createProcessSampler({ pid }),
      scenarioSetup: () => setup,
      loadGenOptions: { version: botVersion, scenarioModule: scenario.module },
      logger: log
    }, {
      runId,
      meta: { bdsVersion, botVersion, colocated: true, artifacts, ...(commit !== undefined ? { bedbooCommit: commit } : {}) },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {})
    })
    let report: string | undefined
    if (opts.noReport !== true) {
      report = await writeReport(outcome.dir)
      log.info(`report → ${report}`)
    }
    return { ...outcome, ...(report !== undefined ? { report } : {}) }
  } finally {
    if (opts.keepInstances !== true) {
      for (const inst of instances) {
        await destroyInstance(inst).catch(err => log.warn(`could not delete instance ${inst.dir}: ${String(err)}`))
      }
    }
  }
}
