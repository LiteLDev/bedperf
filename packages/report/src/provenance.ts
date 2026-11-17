import { NEUTRAL_LOADER_CONFIG, serverLabel } from '@bedperf/core'
import type { ServerFlavor, ServerMod, ServerRuntime } from '@bedperf/core'
import { firstAt, fmt } from './format.ts'
import { num } from './math.ts'
import { topologyViewOf } from './topology.ts'
import { COMPARABILITY_FIELDS } from './types.ts'
import type { Headline, Provenance, RunData, ServerView, StepRow, Threat, TopologyView } from './types.ts'

/** meta.json paths of the BDS build hash, shared with the comparability check. */
const BDS_HASH_PATHS = COMPARABILITY_FIELDS.find((f) => f.key === 'bdsBuildSha256')?.paths ?? [['artifacts', 'bdsZipSha256']]

/** Fewest ok repeats for a publishable headline. */
export const MIN_PUBLISH_REPEATS = 3

function obj (v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function str (v: unknown): string | undefined {
  if (typeof v === 'string') return v === '' ? undefined : v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function bool (v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** "0-7,16" for a CPU list; strings (e.g. `auto`, kernel lists) pass through. */
export function cpuList (v: unknown): string | undefined {
  if (typeof v === 'string') return v === '' ? undefined : v
  if (!Array.isArray(v)) return undefined
  const xs = [...new Set(v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)))].sort((a, b) => a - b)
  if (xs.length === 0) return undefined
  const parts: string[] = []
  let lo = xs[0]!
  let prev = lo
  for (const x of [...xs.slice(1), Number.NaN]) {
    if (x === prev + 1) { prev = x; continue }
    parts.push(lo === prev ? String(lo) : `${lo}-${prev}`)
    lo = x
    prev = x
  }
  return `${parts.join(',')} (${xs.length})`
}

/** Flattens a gates object to [dotted key, value] pairs (scalars only). */
function flatten (v: unknown, prefix = ''): Array<[string, string]> {
  const o = obj(v)
  if (o === undefined) return []
  return Object.entries(o).flatMap(([k, x]): Array<[string, string]> => {
    const key = prefix === '' ? k : `${prefix}.${k}`
    if (obj(x) !== undefined) return flatten(x, key)
    if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return [[key, String(x)]]
    return []
  })
}

/** Flattens a JSON object to [dotted path, JSON value] pairs; arrays and scalars are leaves. */
function leaves (v: unknown, prefix = ''): Array<[string, string]> {
  const o = obj(v)
  if (o === undefined) return prefix === '' ? [] : [[prefix, JSON.stringify(v) ?? String(v)]]
  return Object.entries(o).flatMap(([k, x]) => leaves(x, prefix === '' ? k : `${prefix}.${k}`))
}

function valueAt (v: unknown, path: string): unknown {
  let cur: unknown = v
  for (const k of path.split('.')) {
    const o = obj(cur)
    if (o === undefined || !(k in o)) return undefined
    cur = o[k]
  }
  return cur
}

/** Reads meta.json `server`. A run without it is vanilla BDS, native (the only server older runs could use). */
export function serverViewOf (meta: unknown): ServerView {
  const m = obj(meta) ?? {}
  const s = obj(m.server)
  const bds = str(m.bdsVersion)
  if (s === undefined) {
    return { recorded: false, label: 'bds', flavor: 'bds', mods: [], runtime: 'native', versions: bds !== undefined ? [['bds', bds]] : [], artifacts: [], loaderOverrides: [], notes: [] }
  }
  const spec = obj(s.spec) ?? {}
  const flavor = str(spec.flavor) ?? 'bds'
  const mods = Array.isArray(spec.mods) ? spec.mods.filter((x): x is string => typeof x === 'string') : []
  const runtime = str(spec.runtime) ?? 'native'
  const label = str(s.label) ?? serverLabel({ flavor: flavor as ServerFlavor, mods: mods as ServerMod[], runtime: runtime as ServerRuntime, versions: {} })
  const versions: Array<[string, string]> = []
  const bdsVersion = str(s.bdsVersion) ?? bds
  if (bdsVersion !== undefined) versions.push(['bds', bdsVersion])
  for (const [k, v] of Object.entries(obj(spec.versions) ?? {})) {
    const x = str(v)
    if (x !== undefined) versions.push([k, x])
  }
  const artifacts = Array.isArray(s.artifacts)
    ? s.artifacts.flatMap((a) => {
      const o = obj(a)
      const name = str(o?.name)
      if (o === undefined || name === undefined) return []
      const out: ServerView['artifacts'][number] = { name }
      const version = str(o.version); if (version !== undefined) out.version = version
      const sha = str(o.sha256); if (sha !== undefined) out.sha256 = sha
      return [out]
    })
    : []
  // Keys that differ from the loader's upstream defaults: bedperf's neutral defaults for the
  // flavor, then the config's own overrides (which win on the same path).
  const neutral = new Map(leaves((NEUTRAL_LOADER_CONFIG as Record<string, unknown>)[flavor]))
  const user = new Map(leaves(spec.loaderConfig))
  const effective = s.loaderConfig
  const loaderOverrides: ServerView['loaderOverrides'] = []
  for (const path of new Set([...neutral.keys(), ...user.keys()])) {
    const declared = user.get(path) ?? neutral.get(path)!
    const eff = valueAt(effective, path)
    loaderOverrides.push({ path, value: eff !== undefined ? JSON.stringify(eff) : declared, source: user.has(path) ? 'user' : 'neutral' })
  }
  const view: ServerView = {
    recorded: true,
    label,
    flavor,
    mods,
    runtime,
    versions,
    artifacts,
    loaderOverrides,
    notes: Array.isArray(s.notes) ? s.notes.filter((x): x is string => typeof x === 'string' && x !== '') : []
  }
  const set = <K extends keyof ServerView>(k: K, v: ServerView[K] | undefined): void => { if (v !== undefined) view[k] = v }
  set('binaryPlatform', str(s.binaryPlatform))
  set('exeName', str(s.exeName))
  set('specSha256', str(s.specSha256))
  set('buildSha256', str(s.buildSha256))
  set('allocator', str(s.allocator))
  if (obj(effective) !== undefined) view.loaderConfig = effective
  return view
}

/** Reads provenance and environment fields from meta.json, all optional. */
export function provenanceOf (meta: unknown): Provenance {
  const m = obj(meta) ?? {}
  const machine = obj(m.machine)
  const harness = obj(m.harness)
  const artifacts = obj(m.artifacts) ?? {}
  const placement = obj(m.placement)
  const p: Provenance = { gates: flatten(m.gates) }
  const set = <K extends keyof Provenance>(k: K, v: Provenance[K] | undefined): void => { if (v !== undefined) p[k] = v }
  set('configSha256', str(m.configSha256))
  set('machineFingerprint', str(machine?.fingerprint) ?? str(m.machineFingerprint))
  if (machine !== undefined) {
    p.machine = {}
    const os = str(machine.os); if (os !== undefined) p.machine.os = os
    const cpu = str(machine.cpuModel); if (cpu !== undefined) p.machine.cpuModel = cpu
    const logical = num(machine.logical); if (logical !== undefined) p.machine.logical = logical
    const physical = num(machine.physical); if (physical !== undefined) p.machine.physical = physical
    const ram = num(machine.ramGiB); if (ram !== undefined) p.machine.ramGiB = ram
  }
  if (harness !== undefined) {
    p.harness = {}
    const version = str(harness.version); if (version !== undefined) p.harness.version = version
    const git = str(harness.git); if (git !== undefined) p.harness.git = git
    const dirty = bool(harness.dirty); if (dirty !== undefined) p.harness.dirty = dirty
    const node = str(harness.node); if (node !== undefined) p.harness.node = node
  }
  set('bdsZipSha256', firstAt(m, BDS_HASH_PATHS))
  set('probePackSha256', str(artifacts.probePackSha256))
  set('bedbooCommit', str(artifacts.bedbooCommit) ?? str(m.bedbooCommit))
  if (placement !== undefined) {
    const checks = Array.isArray(placement.checks)
      ? placement.checks.flatMap((c) => {
        const o = obj(c)
        if (o === undefined) return []
        return [{ id: str(o.id) ?? '', level: str(o.level) ?? 'info', summary: str(o.summary) ?? '' }]
      })
      : []
    p.placement = { checks }
    const pl = p.placement
    const fields: Array<[keyof typeof pl, string | undefined]> = [
      ['profileSha256', str(placement.profileSha256)],
      ['kind', str(placement.kind)],
      ['method', str(placement.method)],
      ['serverCpus', cpuList(placement.serverCpus)],
      ['botCpus', cpuList(placement.botCpus)],
      ['priority', str(placement.priority)]
    ]
    for (const [k, v] of fields) if (v !== undefined) (pl as Record<string, unknown>)[k] = v
    const verified = bool(placement.verified)
    if (verified !== undefined) pl.verified = verified
  }
  return p
}

function plural (n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Unique values with their counts, most frequent first: "a (3), b". */
function tally (xs: readonly string[]): string {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => n > 1 ? `${k} (${n})` : k).join('; ')
}

const LEVEL_ORDER: Record<Threat['level'], number> = { bad: 0, warn: 1, info: 2 }

/**
 * Threats to validity and disclosures. `bad` items make the headline not publishable: fewer than
 * MIN_PUBLISH_REPEATS ok repeats, a dirty harness, an aborted run or a placement that did not verify.
 */
export function threatsOf (run: RunData, h: Headline, steps: readonly StepRow[], p: Provenance, server: ServerView = serverViewOf(run.meta), topology: TopologyView = topologyViewOf(run, steps, 0)): Threat[] {
  const out: Threat[] = []
  const meta = obj(run.meta) ?? {}
  if (h.kOk < MIN_PUBLISH_REPEATS) {
    out.push({ id: 'repeats', level: 'bad', text: `Not publishable: ${h.kOk}/${h.n} repeats ok; at least ${MIN_PUBLISH_REPEATS} ok repeats are needed for a headline.` })
  }
  if (h.aborted) out.push({ id: 'aborted', level: 'bad', text: 'The run was aborted (no result.json); the headline was recomputed from the recorded steps.' })
  if (p.harness?.dirty === true) {
    out.push({ id: 'dirty', level: 'bad', text: `Unofficial: the harness had uncommitted changes${p.harness.git !== undefined ? ` on top of ${p.harness.git.slice(0, 12)}` : ''}; the measuring code is not reproducible from a commit.` })
  }
  if (p.placement?.verified === false) {
    out.push({ id: 'placement', level: 'bad', text: 'CPU placement did not verify: the server was not confined to its planned CPUs or priority.' })
  }
  const unverifiedSteps = steps.filter((s) => s.placementVerified === false)
  if (unverifiedSteps.length > 0 && p.placement?.verified !== false) {
    out.push({ id: 'placement-steps', level: 'warn', text: `Placement mismatch during ${plural(unverifiedSteps.length, 'step')}.` })
  }
  if (p.placement?.kind === 'vcpu') {
    out.push({ id: 'vcpu', level: 'warn', text: 'Virtual CPUs (VM or WSL2): core and SMT topology are not reliable, and the hypervisor can steal time; numbers do not transfer to bare metal.' })
  }
  const invalid = steps.filter((s) => s.invalid)
  if (invalid.length > 0) {
    out.push({ id: 'invalid-steps', level: 'warn', text: `${plural(invalid.length, 'invalid step')} left out of the curves and fits: ${tally(invalid.flatMap((s) => s.invalidReasons))}.` })
  }
  if (h.invalidLimited) out.push({ id: 'invalid-limited', level: 'warn', text: 'The search stopped on invalid steps: true capacity may be higher than the headline.' })
  const capped = steps.filter((s) => s.settleCapped === true)
  if (capped.length > 0) {
    out.push({ id: 'settle-capped', level: 'warn', text: `Settle hit its cap in ${plural(capped.length, 'step')}: the server may not have reached steady state before the hold.` })
  }
  const views = steps.filter((s) => s.viewsIncomplete === true)
  if (views.length > 0) {
    out.push({ id: 'views-incomplete', level: 'warn', text: `Bots had not finished loading their view in ${plural(views.length, 'step')}: chunk sending was still part of the measured load.` })
  }
  const remote = topology.mode === 'remote'
  if (remote) {
    out.push(...remoteThreats(topology))
  } else {
    if (meta.colocated === true) {
      out.push({ id: 'colocated', level: 'warn', text: 'Load generator colocated with the server: bots compete for CPU, memory bandwidth and caches.' })
    }
    const network = obj(meta.network)
    if (network?.loopback === true || (network?.loopback === undefined && meta.colocated === true)) {
      out.push({ id: 'loopback', level: 'info', text: 'Bots connect over loopback: no real network latency, loss or NIC cost is measured.' })
    }
  }
  out.push(...serverThreats(server))
  const busiest = steps.filter((s) => s.tickThreadSource === 'busiest')
  if (busiest.length > 0) {
    out.push({ id: 'busiest-thread', level: 'info', text: `Tick thread identified as the busiest thread (not by name) in ${plural(busiest.length, 'step')}; tick CPU may belong to another thread.` })
  }
  if (p.configSha256 === undefined || p.harness === undefined || p.machineFingerprint === undefined) {
    out.push({ id: 'provenance', level: 'info', text: 'Provenance is incomplete (older run): config hash, machine fingerprint or harness version is not recorded.' })
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}

/** Disclosures about the server implementation: allocator, Wine, loader config. */
function serverThreats (s: ServerView): Threat[] {
  const out: Threat[] = []
  if (s.allocator !== undefined) {
    out.push({ id: 'allocator', level: 'warn', text: `The server ran with a replaced memory allocator (${s.allocator}${s.flavor === 'endstone' ? ', preloaded by Endstone' : ''}): a confound when comparing with other server flavors, which run the binary's own allocator. Differences may come from the allocator, not the loader.` })
  }
  if (s.runtime === 'wine') {
    out.push({ id: 'wine', level: 'warn', text: `The server ran under Wine: this measures Wine + ${s.flavor === 'levilamina' ? 'LeviLamina' : s.label}, not a native server. Wine translation and its wineserver are part of every number.` })
  }
  if (s.loaderOverrides.length > 0) {
    const user = s.loaderOverrides.filter((o) => o.source === 'user')
    const neutral = s.loaderOverrides.filter((o) => o.source === 'neutral')
    const list = (xs: typeof user): string => xs.map((o) => `${o.path} = ${o.value}`).join(', ')
    out.push({
      id: 'loader-config',
      level: user.length > 0 ? 'warn' : 'info',
      text: `Loader config differs from the upstream defaults${neutral.length > 0 ? `; bedperf's benchmark-neutral overrides: ${list(neutral)}` : ''}${user.length > 0 ? `; overridden by the config: ${list(user)}` : ''}.`
    })
  }
  return out
}

/** Disclosures for bots on remote agents: the network is measured, agent saturation, lost agents. */
function remoteThreats (t: TopologyView | undefined): Threat[] {
  const out: Threat[] = []
  const agents = t?.agents ?? []
  const rtt = agents.filter((a) => a.link !== undefined).map((a) => `${a.name} ${fmt(a.link!.rttMedianMs, 2)} ms [${fmt(a.link!.rttMinMs, 2)}, ${fmt(a.link!.rttMaxMs, 2)}]`)
  out.push({
    id: 'remote-network',
    level: 'info',
    text: `Bots ran on ${plural(agents.length, 'remote agent')}${t?.botTargetHost !== undefined ? ` and dialled ${t.botTargetHost}` : ''}: the network between bots and server (latency, loss, NIC and kernel cost) is part of the measurement. ${rtt.length > 0 ? `Control-link RTT baseline (median [min, max]): ${rtt.join('; ')}.` : 'No link RTT baseline was recorded.'}`
  })
  const saturated = new Set<string>()
  for (const a of agents) if (a.saturatedSamples > 0) saturated.add(a.name)
  for (const s of t?.steps ?? []) for (const a of s.agents) if (a.saturated) saturated.add(a.agent)
  if (saturated.size > 0) {
    const detail = [...saturated].map((n) => {
      const a = agents.find((x) => x.name === n)
      const steps = (t?.steps ?? []).filter((s) => s.agents.some((x) => x.agent === n && x.saturated)).length
      const reasons = a?.saturatedReasons ?? []
      const parts = [
        a !== undefined && a.saturatedSamples > 0 ? plural(a.saturatedSamples, 'saturated telemetry sample') : undefined,
        steps > 0 ? `saturated in ${plural(steps, 'step')}` : undefined
      ].filter((x) => x !== undefined)
      return `${n} (${parts.join(', ')}${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''})`
    })
    out.push({ id: 'agent-saturated', level: 'warn', text: `Agent saturated during the run: ${detail.join('; ')}. Bots on a saturated agent lag on their own; what they measure then says less about the server.` })
  }
  const lost = (t?.links ?? []).filter((l) => l.event === 'lost')
  if (lost.length > 0) {
    out.push({ id: 'agent-lost', level: 'warn', text: `Agent connection lost during the run: ${lost.map((l) => `${l.agent}${l.reason !== undefined ? ` (${l.reason})` : ''}`).join('; ')}. Its bots were cut off; failures around that time come from the harness, not the server.` })
  }
  const unverified = agents.filter((a) => a.placementVerified === false).map((a) => a.name)
  if (unverified.length > 0) out.push({ id: 'agent-placement', level: 'warn', text: `Bot CPU placement did not verify on ${unverified.join(', ')}.` })
  return out
}
