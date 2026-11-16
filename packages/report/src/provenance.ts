import { firstAt } from './format.ts'
import { num } from './math.ts'
import { COMPARABILITY_FIELDS } from './types.ts'
import type { Headline, Provenance, RunData, StepRow, Threat } from './types.ts'

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
export function threatsOf (run: RunData, h: Headline, steps: readonly StepRow[], p: Provenance): Threat[] {
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
  if (meta.colocated === true) {
    out.push({ id: 'colocated', level: 'warn', text: 'Load generator colocated with the server: bots compete for CPU, memory bandwidth and caches.' })
  }
  const network = obj(meta.network)
  if (network?.loopback === true || (network?.loopback === undefined && meta.colocated === true)) {
    out.push({ id: 'loopback', level: 'info', text: 'Bots connect over loopback: no real network latency, loss or NIC cost is measured.' })
  }
  const busiest = steps.filter((s) => s.tickThreadSource === 'busiest')
  if (busiest.length > 0) {
    out.push({ id: 'busiest-thread', level: 'info', text: `Tick thread identified as the busiest thread (not by name) in ${plural(busiest.length, 'step')}; tick CPU may belong to another thread.` })
  }
  if (p.configSha256 === undefined || p.harness === undefined || p.machineFingerprint === undefined) {
    out.push({ id: 'provenance', level: 'info', text: 'Provenance is incomplete (older run): config hash, machine fingerprint or harness version is not recorded.' })
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
}
