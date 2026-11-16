import type { CpuSpec, PlacementCheck, PlacementPlan, PlacementProfile } from '@bedperf/core'
import { formatCpuList, normalizeCpus, parseCpuList } from './cpus.ts'
import { profileSha256 } from './profile.ts'
import { coresOf, type Core, type CpuTopology } from './topology.ts'

/** The bots need at least this many logical CPUs so they never limit the server. */
export const MIN_BOT_CPUS = 4

function explicit (spec: CpuSpec): number[] | undefined {
  if (spec === 'auto' || spec === 'bot') return undefined
  return typeof spec === 'string' ? parseCpuList(spec) : normalizeCpus(spec)
}

const sortNum = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b)

/**
 * Split cores between server and bots. Whole cores move together, so SMT siblings never split.
 * Hybrid CPUs: the server gets the fastest class and the bots the rest, if that gives the bots
 * at least MIN_BOT_CPUS. Otherwise bots take the slowest, highest-numbered cores until they hold
 * half the cores, or both a quarter of them (rounded up) and MIN_BOT_CPUS logical CPUs.
 */
export function autoSplit (cores: Core[]): { server: number[], bots: number[] } {
  const classes = sortNum(cores.map(c => c.efficiency))
  if (classes.length > 1) {
    const top = classes.at(-1)!
    const server = cores.filter(c => c.efficiency === top).flatMap(c => c.cpus)
    const bots = cores.filter(c => c.efficiency !== top).flatMap(c => c.cpus)
    if (bots.length >= MIN_BOT_CPUS) return { server: sortNum(server), bots: sortNum(bots) }
  }
  const order = [...cores].sort((a, b) => a.efficiency - b.efficiency || b.cpus[0]! - a.cpus[0]!)
  const quota = Math.ceil(cores.length / 4)
  const half = Math.floor(cores.length / 2)
  const botCores: Core[] = []
  for (const core of order) {
    const logical = botCores.reduce((n, c) => n + c.cpus.length, 0)
    if (botCores.length >= half || (botCores.length >= quota && logical >= MIN_BOT_CPUS)) break
    botCores.push(core)
  }
  const bots = new Set(botCores.flatMap(c => c.cpus))
  return { server: sortNum(cores.flatMap(c => c.cpus).filter(c => !bots.has(c))), bots: sortNum(bots) }
}

/** Findings about a resolved placement that may make a run unfair or invalid. */
export function placementChecks (plan: Pick<PlacementPlan, 'serverCpus' | 'botCpus' | 'harnessCpus'>, topology: CpuTopology): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  const known = new Map(topology.cpus.map(r => [r.cpu, r]))
  const all = sortNum([...plan.serverCpus, ...plan.botCpus, ...plan.harnessCpus])
  const unknown = all.filter(c => !known.has(c))
  if (unknown.length) {
    checks.push({ id: 'unknown_cpus', level: 'fail', summary: `CPUs ${formatCpuList(unknown)} do not exist or are not allowed for the harness`, detail: { cpus: unknown } })
  }
  if (plan.serverCpus.length === 0) {
    checks.push({ id: 'server_cpus', level: 'fail', summary: 'the server gets no CPUs' })
  }
  if (plan.botCpus.length < MIN_BOT_CPUS) {
    checks.push({
      id: 'bot_cpus',
      level: 'fail',
      summary: `the bots get ${plan.botCpus.length} logical CPUs; at least ${MIN_BOT_CPUS} are needed so the bots never limit the server`,
      detail: { botCpus: plan.botCpus.length, min: MIN_BOT_CPUS }
    })
  }
  const server = new Set(plan.serverCpus)
  const overlap = sortNum([...plan.botCpus, ...plan.harnessCpus].filter(c => server.has(c)))
  if (overlap.length) {
    checks.push({ id: 'overlap', level: 'warn', summary: `CPUs ${formatCpuList(overlap)} are shared by the server and the bots/harness`, detail: { cpus: overlap } })
  }
  const serverCores = new Set(plan.serverCpus.map(c => known.get(c)?.core).filter(c => c !== undefined))
  const siblings = sortNum([...plan.botCpus, ...plan.harnessCpus].filter(c => {
    const r = known.get(c)
    return r !== undefined && !server.has(c) && serverCores.has(r.core)
  }))
  if (siblings.length) {
    checks.push({ id: 'smt_split', level: 'warn', summary: `CPUs ${formatCpuList(siblings)} are SMT siblings of server CPUs; bot load on them slows the server`, detail: { cpus: siblings } })
  }
  const serverClasses = sortNum(plan.serverCpus.map(c => known.get(c)?.efficiency ?? 0))
  if (serverClasses.length > 1) {
    checks.push({ id: 'server_classes', level: 'warn', summary: 'the server CPU set mixes performance and efficiency cores', detail: { classes: serverClasses } })
  }
  if (topology.platform === 'win32' && all.some(c => c >= 64)) {
    checks.push({ id: 'processor_group', level: 'fail', summary: 'affinity masks only reach the first 64 logical CPUs (processor group 0)' })
  }
  if (topology.placementKind === 'vcpu') {
    checks.push({ id: 'vcpu', level: 'info', summary: `virtualized host (${topology.virtualization}): CPUs are vCPUs and core/SMT layout is not guaranteed` })
  }
  return checks
}

/** Resolve a profile against a topology. Never throws for an unusable plan; see `checks`. */
export function planPlacement (topology: CpuTopology, profile: PlacementProfile): PlacementPlan {
  const p = profile.placement
  const checks: PlacementCheck[] = []
  let server = explicit(p.serverCpus)
  let bots = explicit(p.botCpus)
  const explicitHarness = p.harnessCpus === 'bot' ? undefined : explicit(p.harnessCpus)
  // Explicit sets (harness included) are taken out before `auto` splits what is left.
  const reserved = new Set([...(server ?? []), ...(bots ?? []), ...(explicitHarness ?? [])])
  if (server === undefined || bots === undefined) {
    const cores = coresOf(topology)
      .map(c => ({ ...c, cpus: c.cpus.filter(x => !reserved.has(x)) }))
      .filter(c => c.cpus.length > 0)
    if (server === undefined && bots === undefined) {
      if (cores.length < 2) {
        checks.push({ id: 'too_few_cores', level: 'fail', summary: 'auto placement needs at least two physical cores; set serverCpus and botCpus' })
        server = sortNum(cores.flatMap(c => c.cpus))
        bots = []
      } else {
        const split = autoSplit(cores)
        server = split.server
        bots = split.bots
      }
    } else {
      // One side explicit: the other gets every remaining allowed CPU.
      const rest = sortNum(cores.flatMap(c => c.cpus))
      if (server === undefined) server = rest
      else bots = rest
    }
  }
  const harness = explicitHarness ?? bots!
  const plan: PlacementPlan = {
    serverCpus: server,
    botCpus: bots!,
    harnessCpus: harness,
    priority: p.priority,
    kind: topology.placementKind,
    checks: [],
    profileSha256: profileSha256(profile)
  }
  if (profile.label !== undefined) plan.label = profile.label
  plan.checks = [...checks, ...placementChecks(plan, topology)]
  return plan
}

/** True when no check failed. */
export function planUsable (plan: PlacementPlan): boolean {
  return !plan.checks.some(c => c.level === 'fail')
}
