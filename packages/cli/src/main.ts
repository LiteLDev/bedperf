#!/usr/bin/env node
// bedperf command line. Run with `node packages/cli/src/main.ts <command>` or `pnpm bedperf <command>`.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BenchmarkConfig, RunResult } from '@bedperf/core'
import { ensureBds, hostPlatform, resolveVersion } from '@bedperf/bds-install'
import {
  ConfigError, EnvGateError, ExitCodes, exitCodeOf, GATES_KEYS, loadConfig, parseConfig, parseOrder, PRESET_NAMES, preset, type PresetName
} from '@bedperf/orchestrator'
import { SCENARIOS } from '@bedperf/scenarios'
import { IncomparableRunsError, writeCompare, writeReport } from '@bedperf/report'
import { applySets, bool, flag, intFlag, parseArgs, UsageError, type ParsedArgs } from './args.ts'
import { analyzeCommand } from './analyze.ts'
import { LockHeldError } from './lock.ts'
import { runCommand, runSessionCommand, type RunCommandOptions } from './run.ts'

export const USAGE = `usage: bedperf <command> [options]

commands:
  run       run a benchmark and write runs/<id>/ with report.html
              --preset quick|standard|thorough   start from a built-in config (default quick)
              --config <file.json>               start from a config file instead
              --configs <a.json,b.json,...>      A/B session: one run dir per config under runs/<session>/,
                                                 repeats interleaved (see --order), plus session.json
              --order rotate|sequential|seeded:N repeat order of a session (default rotate)
              --machine-profile <file.json>      placement profile ({label, placement, gates}) merged
                                                 into the config's placement / gates
              --skip-idle-check                  do not run the idle gate before repeats
              --scenario <name>                  override scenario.module (${Object.keys(SCENARIOS).join(', ')})
              --set <path>=<value>               override any config field, e.g. --set ramp.max=60
                                                 or --set serverProperties.view-distance=8 (repeatable)
              --bds-version <v>                  latest | preview | x.y.z.w
              --runs-dir <dir>                   default <repo>/runs
              --port <n>                         BDS IPv4 port (default 19200, v6 = +1)
              --accept-eula                      allow downloading BDS (accepts the Minecraft EULA)
              --keep-instances                   keep BDS instance dirs after the run
              --no-report                        skip report.html
              --no-lock                          do not take the machine lock (one measured run per machine)
              --dry-run                          print the resolved config and exit
              exit codes: 0 ok, 2 usage, 3 environment gate (busy machine, unusable placement),
                          4 every repeat server_failed, 5 no ok repeat (invalid), 130 interrupted
  report    <runDir>                             (re)write <runDir>/report.html
  analyze   <runDir> [--write]                   recompute every step from samples.jsonl, check it against
                                                 steps.json and the file manifest (--write: rewrite steps.json)
  compare   <runDirA> <runDirB> [-o out.html]    write a comparison report
              --force                            compare even when config, machine, BDS build, ... differ
                                                 (otherwise exits 2 listing the mismatches)
  install   [latest|preview|x.y.z.w] --accept-eula   download BDS into the cache
  scenarios                                      list built-in scenarios
`

/**
 * Merge a placement profile (`{label?, placement?, gates?}`, the @bedperf/placement format) into a raw
 * config: placement fields override `placement`, known gate keys override `gates`.
 */
export function applyMachineProfile (raw: Record<string, unknown>, profile: unknown, source = 'machine profile'): void {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) throw new UsageError(`${source}: expected a JSON object`)
  const p = profile as Record<string, unknown>
  for (const k of Object.keys(p)) if (!['label', 'placement', 'gates'].includes(k)) throw new UsageError(`${source}: unknown key '${k}'`)
  const placement = { ...(raw['placement'] as Record<string, unknown> | undefined) }
  if (typeof p['label'] === 'string') placement['label'] = p['label']
  if (p['placement'] !== undefined) {
    if (p['placement'] === null || typeof p['placement'] !== 'object') throw new UsageError(`${source}: placement must be an object`)
    Object.assign(placement, p['placement'])
  }
  raw['placement'] = placement
  if (p['gates'] !== undefined) {
    const gates = { ...(raw['gates'] as Record<string, unknown> | undefined) }
    for (const [k, v] of Object.entries(p['gates'] as Record<string, unknown>)) {
      if (!(GATES_KEYS as readonly string[]).includes(k)) throw new UsageError(`${source}: unknown gate '${k}' (known: ${GATES_KEYS.join(', ')})`)
      gates[k] = v
    }
    raw['gates'] = gates
  }
}

async function machineProfile (args: ParsedArgs): Promise<{ profile: unknown, file: string } | undefined> {
  const file = flag(args, 'machine-profile')
  if (file === undefined) return undefined
  try {
    return { profile: JSON.parse(await readFile(resolve(file), 'utf8')), file }
  } catch (err) {
    throw new UsageError(`--machine-profile ${file}: ${(err as Error).message}`)
  }
}

/** Build the config for `run` from flags (pure apart from reading --config / --machine-profile). */
export async function configFromArgs (args: ParsedArgs): Promise<BenchmarkConfig> {
  const file = flag(args, 'config')
  const presetName = flag(args, 'preset')
  if (file !== undefined && presetName !== undefined) throw new UsageError('use either --preset or --config, not both')
  let base: BenchmarkConfig
  if (file !== undefined) base = await loadConfig(resolve(file))
  else {
    const name = (presetName ?? 'quick') as PresetName
    if (!PRESET_NAMES.includes(name)) throw new UsageError(`unknown preset '${name}' (expected ${PRESET_NAMES.join(', ')})`)
    base = preset(name)
  }
  return await overrideConfig(base, args, file ?? `preset ${presetName ?? 'quick'}`, file === undefined)
}

/** The configs of an A/B session (`--configs a.json,b.json`), each with the same overrides. */
export async function configsFromArgs (args: ParsedArgs): Promise<BenchmarkConfig[]> {
  const list = flag(args, 'configs')
  if (list === undefined) throw new UsageError('--configs needs a comma-separated list of config files')
  if (flag(args, 'config') !== undefined || flag(args, 'preset') !== undefined) throw new UsageError('use --configs without --config / --preset')
  const files = list.split(',').map(s => s.trim()).filter(s => s !== '')
  if (files.length < 2) throw new UsageError('--configs needs at least two config files')
  const out: BenchmarkConfig[] = []
  for (const f of files) out.push(await overrideConfig(await loadConfig(resolve(f)), args, f, false))
  return out
}

async function overrideConfig (base: BenchmarkConfig, args: ParsedArgs, source: string, renameForScenario: boolean): Promise<BenchmarkConfig> {
  const raw = structuredClone(base) as unknown as Record<string, unknown>
  const scenario = flag(args, 'scenario')
  const sets = [...(args.flags.get('set') ?? [])]
  if (scenario !== undefined) {
    const sc = raw['scenario'] as { module: string, params?: Record<string, unknown> }
    // A different scenario starts from its own defaults: keep params only when the name is unchanged.
    if (sc.module !== scenario) raw['scenario'] = { module: scenario, params: {} }
    if (renameForScenario) raw['name'] = `${String(raw['name'])}-${scenario}`
  }
  const bds = flag(args, 'bds-version')
  if (bds !== undefined) raw['bdsVersion'] = bds
  const mp = await machineProfile(args)
  if (mp !== undefined) applyMachineProfile(raw, mp.profile, mp.file)
  applySets(raw, sets)
  return parseConfig(raw, source)
}

async function main (argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const [cmd, ...rest] = args.positionals
  if (cmd === undefined || bool(args, 'help') || bool(args, 'h')) {
    process.stdout.write(USAGE)
    return cmd === undefined && !bool(args, 'help') && !bool(args, 'h') ? 2 : 0
  }
  switch (cmd) {
    case 'run': {
      const session = flag(args, 'configs') !== undefined
      const configs = session ? await configsFromArgs(args) : [await configFromArgs(args)]
      const order = parseOrderFlag(flag(args, 'order') ?? 'rotate')
      if (bool(args, 'dry-run')) {
        process.stdout.write(`${JSON.stringify(session ? configs : configs[0], null, 2)}\n`)
        return 0
      }
      const ac = new AbortController()
      let interrupts = 0
      process.on('SIGINT', () => {
        if (++interrupts > 1) process.exit(130)
        console.error('[bedperf] interrupt: stopping after the current step (press Ctrl+C again to kill)')
        ac.abort(new Error('interrupted'))
      })
      const runsDir = flag(args, 'runs-dir')
      const port = intFlag(args, 'port')
      const ropts: RunCommandOptions = {
        ...(runsDir !== undefined ? { runsDir } : {}),
        ...(port !== undefined ? { port } : {}),
        acceptEula: bool(args, 'accept-eula'),
        keepInstances: bool(args, 'keep-instances'),
        noReport: bool(args, 'no-report'),
        lock: !bool(args, 'no-lock'),
        skipIdleCheck: bool(args, 'skip-idle-check'),
        signal: ac.signal
      }
      try {
        if (session) {
          const res = await runSessionCommand(configs, order, ropts)
          for (const run of res.runs) printResult(run.result, run.dir)
          console.log(`session: ${res.dir}`)
          return res.exitCode
        }
        const res = await runCommand(configs[0]!, ropts)
        printResult(res.result, res.dir)
        if (res.report !== undefined) console.log(`report:  ${res.report}`)
        return exitCodeOf(res.result)
      } catch (err) {
        if (ac.signal.aborted) {
          console.error(`bedperf: interrupted${err instanceof Error && err.message !== 'interrupted' ? ` (${err.message})` : ''}`)
          return ExitCodes.interrupted
        }
        throw err
      }
    }
    case 'analyze': {
      const dir = rest[0]
      if (dir === undefined) throw new UsageError('analyze needs a run directory')
      const res = await analyzeCommand(resolve(dir), { write: bool(args, 'write') })
      for (const l of res.lines) console.log(l)
      return res.exitCode
    }
    case 'report': {
      const dir = rest[0]
      if (dir === undefined) throw new UsageError('report needs a run directory')
      console.log(await writeReport(resolve(dir)))
      return 0
    }
    case 'compare': {
      const [a, b] = rest
      if (a === undefined || b === undefined) throw new UsageError('compare needs two run directories')
      const out = flag(args, 'o') ?? flag(args, 'out') ?? 'compare.html'
      try {
        console.log(await writeCompare(resolve(a), resolve(b), resolve(out), { force: bool(args, 'force') }))
      } catch (err) {
        if (!(err instanceof IncomparableRunsError)) throw err
        console.error('bedperf: runs are not comparable:')
        for (const m of err.mismatches) console.error(`  ${m.label}: A ${m.a ?? '-'}, B ${m.b ?? '-'}`)
        console.error('pass --force to compare anyway (the page then carries a warning banner)')
        return 2
      }
      return 0
    }
    case 'install': {
      const resolved = await resolveVersion(rest[0] ?? 'latest', hostPlatform(), { preview: bool(args, 'preview') })
      const r = await ensureBds(resolved, {
        acceptEula: bool(args, 'accept-eula'),
        onProgress: p => { if (p.phase === 'extract') console.log('extracting…') }
      })
      console.log(`BDS ${r.version} (${r.platform}) ${r.cached ? 'already cached' : 'installed'} at ${r.dir}`)
      return 0
    }
    case 'scenarios': {
      for (const [name, e] of Object.entries(SCENARIOS)) {
        console.log(`${name.padEnd(14)} ${e.needsOperator ? '[op] ' : '     '}${e.description}`)
        console.log(`${''.padEnd(19)}params: ${JSON.stringify(e.defaults)}`)
      }
      return 0
    }
    default:
      throw new UsageError(`unknown command '${cmd}'\n\n${USAGE}`)
  }
}

function parseOrderFlag (s: string): ReturnType<typeof parseOrder> {
  try {
    return parseOrder(s)
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

function printResult (r: RunResult, dir: string): void {
  const reps = r.repeats ?? []
  const notOk = reps.filter(x => x.status !== 'ok')
  console.log(`\n${r.config}: max players at 20 TPS: ${r.maxPlayersMedian} over ${r.kOk ?? reps.length}/${r.n ?? reps.length} ok repeats (repeats: ${r.maxPlayers.join(', ')})${r.capped ? ' — capped by ramp.max' : ''}${r.loadgenLimited ? ' — LOADGEN LIMITED' : ''}${r.invalidLimited === true && !r.loadgenLimited ? ' — INVALID-STEP LIMITED' : ''}`)
  for (const x of notOk) console.log(`  repeat ${x.index}: ${x.status}${x.statusReasons.length > 0 ? ` (${x.statusReasons.join('; ')})` : ''}`)
  console.log(`run dir: ${dir}`)
}

/** Exit code for an error thrown out of `main`. */
export function exitCodeForError (err: unknown): number {
  if (err instanceof UsageError || err instanceof ConfigError) return ExitCodes.usage
  if (err instanceof EnvGateError || err instanceof LockHeldError) return ExitCodes.envGate
  return ExitCodes.error
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
    console.error(`bedperf: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = exitCodeForError(err)
  })
}
