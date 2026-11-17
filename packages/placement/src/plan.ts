import type { CpuSpec, PlacementCheck, PlacementMode, PlacementPlan, PlacementProfile } from '@bedperf/core'
import { formatCpuList, normalizeCpus, parseCpuList } from './cpus.ts'
import { profileSha256 } from './profile.ts'
import { coresOf, type Core, type CpuTopology } from './topology.ts'

/** The bots need at least this many logical CPUs so they never limit the server. */
export const MIN_BOT_CPUS = 4

/**
 * Logical CPUs the harness gets of its own when no bots share the machine with it (`remote-bots`
 * on the server machine, `bots-only` on an agent): enough for the orchestrator or agent event loop
 * plus sysmon sampling and log/probe parsing, which together stay well under two busy CPUs.
 */
export const HARNESS_CPUS = 2

export interface PlanOptions {
  /** Where the bots run. `remote`: on agent machines (distributed run), so none are placed here. Default `local`. */
  bots?: 'local' | 'remote'
  /** `bots-only`: plan an agent machine that runs bot workers and the agent, no server. Default `server`. */
  role?: 'server' | 'bots-only'
}

function explicit (spec: CpuSpec): number[] | undefined {
  if (spec === 'auto' || spec === 'bot') return undefined
  return typeof spec === 'string' ? parseCpuList(spec) : normalizeCpus(spec)
}

const sortNum = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b)

/** Cores in the order bots and harness take them: slowest class first, then highest-numbered first. */
const slowestFirst = (cores: Core[]): Core[] => [...cores].sort((a, b) => a.efficiency - b.efficiency || b.cpus[0]! - a.cpus[0]!)

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
  const quota = Math.ceil(cores.length / 4)
  const half = Math.floor(cores.length / 2)
  const botCores: Core[] = []
  for (const core of slowestFirst(cores)) {
    const logical = botCores.reduce((n, c) => n + c.cpus.length, 0)
    if (botCores.length >= half || (botCores.length >= quota && logical >= MIN_BOT_CPUS)) break
    botCores.push(core)
  }
  const bots = new Set(botCores.flatMap(c => c.cpus))
  return { server: sortNum(cores.flatMap(c => c.cpus).filter(c => !bots.has(c))), bots: sortNum(bots) }
}

/**
 * The harness's own cores on a machine without local bots: the slowest, highest-numbered whole
 * cores until it holds HARNESS_CPUS logical CPUs or a quarter of the cores (rounded up), whichever
 * comes first. Takes at least one core, so callers keep at least two.
 */
export function harnessCores (cores: Core[]): { harness: number[], rest: Core[] } {
  const quota = Math.ceil(cores.length / 4)
  const taken: Core[] = []
  for (const core of slowestFirst(cores)) {
    const logical = taken.reduce((n, c) => n + c.cpus.length, 0)
    if (logical >= HARNESS_CPUS || taken.length >= quota) break
    taken.push(core)
  }
  return { harness: sortNum(taken.flatMap(c => c.cpus)), rest: cores.filter(c => !taken.includes(c)) }
}

/** CPUs of the fastest efficiency class among `cores` (non-empty). */
function fastest (cores: Core[]): number[] {
  const top = Math.max(...cores.map(c => c.efficiency))
  return sortNum(cores.filter(c => c.efficiency === top).flatMap(c => c.cpus))
}

/**
 * Server machine of a distributed run (no local bots). Hybrid CPUs: the server gets every core of
 * the fastest class and the harness every slower core, if the fastest class holds at least a
 * quarter of the cores (rounded up; this keeps one "prime" core from becoming the whole server).
 * Otherwise the harness takes `harnessCores` and the server every other core.
 */
export function remoteSplit (cores: Core[]): { server: number[], harness: number[] } {
  const classes = sortNum(cores.map(c => c.efficiency))
  if (classes.length > 1) {
    const top = classes.at(-1)!
    if (cores.filter(c => c.efficiency === top).length >= Math.ceil(cores.length / 4)) {
      return { server: fastest(cores), harness: sortNum(cores.filter(c => c.efficiency !== top).flatMap(c => c.cpus)) }
    }
  }
  const { harness, rest } = harnessCores(cores)
  return { server: sortNum(rest.flatMap(c => c.cpus)), harness }
}

/** Cores with the reserved CPUs taken out (cores left empty are dropped). */
function freeCores (topology: CpuTopology, reserved: ReadonlySet<number>): Core[] {
  return coresOf(topology)
    .map(c => ({ ...c, cpus: c.cpus.filter(x => !reserved.has(x)) }))
    .filter(c => c.cpus.length > 0)
}

/** CPUs of the whole cores that share nothing with `taken`; if none, every CPU not in `taken`. */
function restAvoiding (topology: CpuTopology, taken: readonly number[]): number[] {
  const set = new Set(taken)
  const all = coresOf(topology)
  const whole = all.filter(c => !c.cpus.some(x => set.has(x))).flatMap(c => c.cpus)
  return sortNum(whole.length ? whole : all.flatMap(c => c.cpus).filter(x => !set.has(x)))
}

/** Findings about a resolved placement that may make a run unfair or invalid. */
export function placementChecks (
  plan: Pick<PlacementPlan, 'serverCpus' | 'botCpus' | 'harnessCpus'>,
  topology: CpuTopology,
  mode: PlacementMode = 'local'
): PlacementCheck[] {
  const checks: PlacementCheck[] = []
  const known = new Map(topology.cpus.map(r => [r.cpu, r]))
  const all = sortNum([...plan.serverCpus, ...plan.botCpus, ...plan.harnessCpus])
  const unknown = all.filter(c => !known.has(c))
  if (unknown.length) {
    checks.push({ id: 'unknown_cpus', level: 'fail', summary: `CPUs ${formatCpuList(unknown)} do not exist or are not allowed for the harness`, detail: { cpus: unknown } })
  }
  if (mode !== 'bots-only' && plan.serverCpus.length === 0) {
    checks.push({ id: 'server_cpus', level: 'fail', summary: 'the server gets no CPUs' })
  }
  if (mode !== 'local' && plan.harnessCpus.length === 0) {
    checks.push({ id: 'harness_cpus', level: 'fail', summary: 'the harness gets no CPUs' })
  }
  if (mode === 'bots-only' && plan.botCpus.length === 0) {
    checks.push({ id: 'bot_cpus', level: 'fail', summary: 'the bot workers get no CPUs' })
  }
  if (mode === 'local' && plan.botCpus.length < MIN_BOT_CPUS) {
    checks.push({
      id: 'bot_cpus',
      level: 'fail',
      summary: `the bots get ${plan.botCpus.length} logical CPUs; at least ${MIN_BOT_CPUS} are needed so the bots never limit the server`,
      detail: { botCpus: plan.botCpus.length, min: MIN_BOT_CPUS }
    })
  }
  if (mode === 'bots-only') {
    const bots = new Set(plan.botCpus)
    const shared = plan.harnessCpus.filter(c => bots.has(c))
    // identical sets are the deliberate `harness_shared` fallback
    if (shared.length && !(shared.length === bots.size && shared.length === plan.harnessCpus.length)) {
      checks.push({ id: 'overlap', level: 'warn', summary: `CPUs ${formatCpuList(shared)} are shared by the bot workers and the agent`, detail: { cpus: shared } })
    }
  }
  if (mode === 'remote-bots') {
    checks.push({ id: 'bots_remote', level: 'info', summary: 'the bots run on agent machines; no bot CPUs are reserved on the server machine' })
  }
  const others = mode === 'local' ? 'bots/harness' : 'harness'
  const server = new Set(plan.serverCpus)
  const overlap = sortNum([...plan.botCpus, ...plan.harnessCpus].filter(c => server.has(c)))
  if (overlap.length) {
    checks.push({ id: 'overlap', level: 'warn', summary: `CPUs ${formatCpuList(overlap)} are shared by the server and the ${others}`, detail: { cpus: overlap } })
  }
  const serverCores = new Set(plan.serverCpus.map(c => known.get(c)?.core).filter(c => c !== undefined))
  const siblings = sortNum([...plan.botCpus, ...plan.harnessCpus].filter(c => {
    const r = known.get(c)
    return r !== undefined && !server.has(c) && serverCores.has(r.core)
  }))
  if (siblings.length) {
    checks.push({ id: 'smt_split', level: 'warn', summary: `CPUs ${formatCpuList(siblings)} are SMT siblings of server CPUs; ${mode === 'local' ? 'bot' : 'harness'} load on them slows the server`, detail: { cpus: siblings } })
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

/**
 * Resolve a profile against a topology. Never throws for an unusable plan; see `checks`. The plan's
 * `mode` records which of the three kinds of plan it is.
 *
 * `opts.bots: 'remote'` (`mode: 'remote-bots'`) plans the server machine of a distributed run: no
 * bot set, the server takes the fastest class whole (every core but the harness's on a single-class
 * CPU) and the harness gets its own set (`remoteSplit`). An explicit `botCpus` is ignored with a
 * warning, and `harnessCpus: "bot"` means auto.
 *
 * `opts.role: 'bots-only'` (`mode: 'bots-only'`) plans an agent machine: bot workers get every
 * allowed CPU, E-cores included (bots are network and JS bound, and nothing measured runs there),
 * except the agent's own `harnessCores`. `serverCpus` is ignored with a warning, and
 * `harnessCpus: "bot"` means auto.
 */
export function planPlacement (topology: CpuTopology, profile: PlacementProfile, opts: PlanOptions = {}): PlacementPlan {
  if (opts.role === 'bots-only') return planBotsOnly(topology, profile)
  if (opts.bots === 'remote') return planRemoteBots(topology, profile)
  return planLocal(topology, profile)
}

function finish (
  topology: CpuTopology,
  profile: PlacementProfile,
  mode: PlacementMode,
  sets: { server: number[], bots: number[], harness: number[] },
  checks: PlacementCheck[]
): PlacementPlan {
  const plan: PlacementPlan = {
    serverCpus: sets.server,
    botCpus: sets.bots,
    harnessCpus: sets.harness,
    priority: profile.placement.priority,
    kind: topology.placementKind,
    mode,
    checks: [],
    profileSha256: profileSha256(profile)
  }
  if (profile.label !== undefined) plan.label = profile.label
  plan.checks = [...checks, ...placementChecks(plan, topology, mode)]
  return plan
}

function planLocal (topology: CpuTopology, profile: PlacementProfile): PlacementPlan {
  const p = profile.placement
  const checks: PlacementCheck[] = []
  let server = explicit(p.serverCpus)
  let bots = explicit(p.botCpus)
  const explicitHarness = p.harnessCpus === 'bot' ? undefined : explicit(p.harnessCpus)
  // Explicit sets (harness included) are taken out before `auto` splits what is left.
  const reserved = new Set([...(server ?? []), ...(bots ?? []), ...(explicitHarness ?? [])])
  if (server === undefined || bots === undefined) {
    const cores = freeCores(topology, reserved)
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
  return finish(topology, profile, 'local', { server, bots: bots!, harness: explicitHarness ?? bots! }, checks)
}

function planRemoteBots (topology: CpuTopology, profile: PlacementProfile): PlacementPlan {
  const p = profile.placement
  const checks: PlacementCheck[] = []
  if (explicit(p.botCpus) !== undefined) {
    checks.push({ id: 'bot_cpus_ignored', level: 'warn', summary: 'botCpus is ignored: the bots run on agent machines' })
  }
  let server = explicit(p.serverCpus)
  let harness = p.harnessCpus === 'bot' ? undefined : explicit(p.harnessCpus)
  const cores = freeCores(topology, new Set([...(server ?? []), ...(harness ?? [])]))
  if (server === undefined && harness === undefined) {
    if (cores.length < 2) {
      // Without local bots one core can still run the server; the harness has to share it.
      server = sortNum(cores.flatMap(c => c.cpus))
      harness = server
      checks.push({ id: 'harness_shared', level: 'warn', summary: 'only one core: the harness shares the server CPUs' })
    } else {
      const split = remoteSplit(cores)
      server = split.server
      harness = split.harness
    }
  } else if (server === undefined) {
    server = cores.length ? fastest(cores) : []
  } else if (harness === undefined) {
    harness = restAvoiding(topology, server)
  }
  return finish(topology, profile, 'remote-bots', { server, bots: [], harness: harness! }, checks)
}

function planBotsOnly (topology: CpuTopology, profile: PlacementProfile): PlacementPlan {
  const p = profile.placement
  const checks: PlacementCheck[] = []
  if (explicit(p.serverCpus) !== undefined) {
    checks.push({ id: 'server_cpus_ignored', level: 'warn', summary: 'serverCpus is ignored on a bots-only (agent) machine' })
  }
  let bots = explicit(p.botCpus)
  let harness = p.harnessCpus === 'bot' ? undefined : explicit(p.harnessCpus)
  const cores = freeCores(topology, new Set([...(bots ?? []), ...(harness ?? [])]))
  const shared = (): void => {
    checks.push({ id: 'harness_shared', level: 'info', summary: 'too few cores for a separate agent set; the agent shares the bot CPUs' })
  }
  if (bots === undefined && harness === undefined) {
    if (cores.length < 2) {
      bots = sortNum(cores.flatMap(c => c.cpus))
      harness = bots
      shared()
    } else {
      const split = harnessCores(cores)
      harness = split.harness
      bots = sortNum(split.rest.flatMap(c => c.cpus))
    }
  } else if (bots === undefined) {
    bots = sortNum(cores.flatMap(c => c.cpus))
  } else if (harness === undefined) {
    harness = restAvoiding(topology, bots)
    if (harness.length === 0) { harness = bots; shared() }
  }
  checks.push({ id: 'bots_only', level: 'info', summary: 'bots-only machine: bot workers and the agent, no server' })
  return finish(topology, profile, 'bots-only', { server: [], bots: bots!, harness: harness! }, checks)
}

/** True when no check failed. */
export function planUsable (plan: PlacementPlan): boolean {
  return !plan.checks.some(c => c.level === 'fail')
}
