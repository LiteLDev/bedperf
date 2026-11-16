#!/usr/bin/env node
// bedperf command line. Run with `node packages/cli/src/main.ts <command>` or `pnpm bedperf <command>`.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BenchmarkConfig } from '@bedperf/core'
import { ensureBds, hostPlatform, resolveVersion } from '@bedperf/bds-install'
import { loadConfig, parseConfig, PRESET_NAMES, preset, type PresetName } from '@bedperf/orchestrator'
import { SCENARIOS } from '@bedperf/scenarios'
import { writeCompare, writeReport } from '@bedperf/report'
import { applySets, bool, flag, intFlag, parseArgs, type ParsedArgs } from './args.ts'
import { runCommand } from './run.ts'

export const USAGE = `usage: bedperf <command> [options]

commands:
  run       run a benchmark and write runs/<id>/ with report.html
              --preset quick|standard|thorough   start from a built-in config (default quick)
              --config <file.json>               start from a config file instead
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
  report    <runDir>                             (re)write <runDir>/report.html
  compare   <runDirA> <runDirB> [-o out.html]    write a comparison report
  install   [latest|preview|x.y.z.w] --accept-eula   download BDS into the cache
  scenarios                                      list built-in scenarios
`

/** Build the config for `run` from flags (pure apart from reading --config). */
export async function configFromArgs (args: ParsedArgs): Promise<BenchmarkConfig> {
  const file = flag(args, 'config')
  const presetName = flag(args, 'preset')
  if (file !== undefined && presetName !== undefined) throw new Error('use either --preset or --config, not both')
  let base: BenchmarkConfig
  if (file !== undefined) base = await loadConfig(resolve(file))
  else {
    const name = (presetName ?? 'quick') as PresetName
    if (!PRESET_NAMES.includes(name)) throw new Error(`unknown preset '${name}' (expected ${PRESET_NAMES.join(', ')})`)
    base = preset(name)
  }
  const raw = structuredClone(base) as unknown as Record<string, unknown>
  const scenario = flag(args, 'scenario')
  const sets = [...(args.flags.get('set') ?? [])]
  if (scenario !== undefined) {
    const sc = raw['scenario'] as { module: string, params?: Record<string, unknown> }
    // A different scenario starts from its own defaults: keep params only when the name is unchanged.
    if (sc.module !== scenario) raw['scenario'] = { module: scenario, params: {} }
    if (file === undefined) raw['name'] = `${String(raw['name'])}-${scenario}`
  }
  const bds = flag(args, 'bds-version')
  if (bds !== undefined) raw['bdsVersion'] = bds
  applySets(raw, sets)
  return parseConfig(raw, file ?? `preset ${presetName ?? 'quick'}`)
}

async function main (argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const [cmd, ...rest] = args.positionals
  if (cmd === undefined || bool(args, 'help') || bool(args, 'h')) {
    process.stdout.write(USAGE)
    return cmd === undefined && !bool(args, 'help') && !bool(args, 'h') ? 1 : 0
  }
  switch (cmd) {
    case 'run': {
      const config = await configFromArgs(args)
      if (bool(args, 'dry-run')) {
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
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
      const res = await runCommand(config, {
        ...(runsDir !== undefined ? { runsDir } : {}),
        ...(port !== undefined ? { port } : {}),
        acceptEula: bool(args, 'accept-eula'),
        keepInstances: bool(args, 'keep-instances'),
        noReport: bool(args, 'no-report'),
        lock: !bool(args, 'no-lock'),
        signal: ac.signal
      })
      const r = res.result
      console.log(`\nmax players at 20 TPS: ${r.maxPlayersMedian} (repeats: ${r.maxPlayers.join(', ')})${r.capped ? ' — capped by ramp.max' : ''}${r.loadgenLimited ? ' — LOADGEN LIMITED' : ''}`)
      console.log(`run dir: ${res.dir}`)
      if (res.report !== undefined) console.log(`report:  ${res.report}`)
      return 0
    }
    case 'report': {
      const dir = rest[0]
      if (dir === undefined) throw new Error('report needs a run directory')
      console.log(await writeReport(resolve(dir)))
      return 0
    }
    case 'compare': {
      const [a, b] = rest
      if (a === undefined || b === undefined) throw new Error('compare needs two run directories')
      const out = flag(args, 'o') ?? flag(args, 'out') ?? 'compare.html'
      console.log(await writeCompare(resolve(a), resolve(b), resolve(out)))
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
      throw new Error(`unknown command '${cmd}'\n\n${USAGE}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
    console.error(`bedperf: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
