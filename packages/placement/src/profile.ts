import { createHash } from 'node:crypto'
import type { CpuSpec, PlacementPriority, PlacementProfile } from '@bedperf/core'
import { formatCpuList, normalizeCpus, parseCpuList } from './cpus.ts'

const PRIORITIES: readonly PlacementPriority[] = ['normal', 'above_normal']

/** JSON with object keys sorted recursively and no whitespace. */
export function canonicalJson (value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`)
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** Explicit CPU sets in canonical list form, so `"0-3"`, `"3,2,1,0"` and `[0,1,2,3]` hash alike. */
function canonicalSpec (spec: CpuSpec): CpuSpec {
  if (spec === 'auto' || spec === 'bot') return spec
  return formatCpuList(typeof spec === 'string' ? parseCpuList(spec) : normalizeCpus(spec))
}

/**
 * sha256 (hex) of the canonical JSON (sorted keys, no whitespace) of a profile's
 * `{placement, gates}`. The label is left out, missing gates hash like `{}`, and explicit CPU
 * sets are hashed in canonical list form.
 */
export function profileSha256 (profile: PlacementProfile): string {
  const p = profile.placement
  const placement = {
    ...p,
    serverCpus: canonicalSpec(p.serverCpus),
    botCpus: canonicalSpec(p.botCpus),
    harnessCpus: canonicalSpec(p.harnessCpus)
  }
  const body = { placement, gates: profile.gates ?? {} }
  return createHash('sha256').update(canonicalJson(body)).digest('hex')
}

function checkSpec (name: string, v: unknown, keywords: readonly string[]): CpuSpec {
  if (typeof v === 'string') {
    if (keywords.includes(v)) return v
    if (parseCpuList(v).length === 0) throw new Error(`profile: placement.${name} is empty`) // also throws on bad syntax
    return v
  }
  if (Array.isArray(v)) {
    if (v.length === 0) throw new Error(`profile: placement.${name} is empty`)
    normalizeCpus(v as number[])
    return v as number[]
  }
  throw new Error(`profile: placement.${name} must be ${keywords.map(k => `"${k}"`).join(' | ')}, a CPU list string or an array of CPU indices`)
}

/**
 * Validate a profile (e.g. parsed JSON) and fill defaults: CPU sets `auto`, harness `bot`,
 * priority `normal`. Throws with a readable message on anything malformed.
 */
export function parseProfile (input: unknown): PlacementProfile {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('profile: expected an object')
  const o = input as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!['label', 'placement', 'gates'].includes(k)) throw new Error(`profile: unknown key ${JSON.stringify(k)}`)
  }
  if (o.label !== undefined && typeof o.label !== 'string') throw new Error('profile: label must be a string')
  const p = (o.placement ?? {}) as Record<string, unknown>
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error('profile: placement must be an object')
  for (const k of Object.keys(p)) {
    if (!['serverCpus', 'botCpus', 'harnessCpus', 'priority'].includes(k)) throw new Error(`profile: unknown key placement.${k}`)
  }
  const priority = p.priority ?? 'normal'
  if (!PRIORITIES.includes(priority as PlacementPriority)) {
    throw new Error(`profile: placement.priority must be one of ${PRIORITIES.join(', ')}`)
  }
  let gates: Record<string, number> | undefined
  if (o.gates !== undefined) {
    if (o.gates === null || typeof o.gates !== 'object' || Array.isArray(o.gates)) throw new Error('profile: gates must be an object')
    gates = {}
    for (const [k, v] of Object.entries(o.gates as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`profile: gates.${k} must be a finite number`)
      gates[k] = v
    }
  }
  const profile: PlacementProfile = {
    placement: {
      serverCpus: checkSpec('serverCpus', p.serverCpus ?? 'auto', ['auto']),
      botCpus: checkSpec('botCpus', p.botCpus ?? 'auto', ['auto']),
      harnessCpus: checkSpec('harnessCpus', p.harnessCpus ?? 'bot', ['bot']) as 'bot' | string | number[],
      priority: priority as PlacementPriority
    }
  }
  if (o.label !== undefined) profile.label = o.label as string
  if (gates !== undefined) profile.gates = gates
  return profile
}

/** The default profile: everything `auto`, harness with the bots, normal priority. */
export function defaultProfile (): PlacementProfile {
  return { placement: { serverCpus: 'auto', botCpus: 'auto', harnessCpus: 'bot', priority: 'normal' } }
}
