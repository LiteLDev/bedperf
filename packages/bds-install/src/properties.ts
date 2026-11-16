import { REQUIRED_BOT_PROPERTIES, type ServerProperties } from '@bedperf/core'

const BENCH_DEFAULT = {
  'view-distance': 10,
  'tick-distance': 4,
  'max-players': 1000,
  'max-threads': 0,
  'player-idle-timeout': 0,
  'default-player-permission-level': 'operator'
} as const

/**
 * Named server.properties presets. They are layered between REQUIRED_BOT_PROPERTIES and the
 * caller's overrides (see `createInstance`).
 */
export const PRESETS = {
  /** Nothing beyond the pristine file + REQUIRED_BOT_PROPERTIES: what a stock server does. */
  'vanilla-default': {},
  /**
   * Default benchmark settings: a fixed, moderately sized simulation area so results are
   * comparable, enough slots for any ramp, no idle kicks, all cores for BDS worker threads,
   * and operator permission so bots can issue the tick-bound commands used for RTT.
   */
  'bench-default': BENCH_DEFAULT,
  /** bench-default on a superflat world (cheaper world generation, mostly isolates players/entities). */
  'bench-flat': {
    ...BENCH_DEFAULT,
    'level-type': 'FLAT'
  }
} as const satisfies Record<string, ServerProperties>

export type PresetName = keyof typeof PRESETS

export function isPresetName (name: string): name is PresetName {
  return Object.hasOwn(PRESETS, name)
}

/** Look up a preset by name, or pass a property object through. */
export function presetProperties (p: PresetName | ServerProperties): ServerProperties {
  if (typeof p !== 'string') return p
  if (!isPresetName(p)) throw new Error(`unknown preset '${String(p)}' (have: ${Object.keys(PRESETS).join(', ')})`)
  return PRESETS[p]
}

const LINE_RE = /^\s*([A-Za-z0-9_.-]+)\s*=(.*)$/

/** Parse server.properties text (comments and blank lines ignored, values are raw strings). */
export function parseServerProperties (text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*[#!]/.test(line)) continue
    const m = LINE_RE.exec(line)
    if (m) out[m[1]!] = m[2]!.trim()
  }
  return out
}

function formatValue (v: string | number | boolean): string {
  const s = String(v)
  if (/[\r\n]/.test(s)) throw new Error(`server.properties value must not contain newlines: ${JSON.stringify(s)}`)
  return s
}

/**
 * Merge property layers into server.properties text. Later layers win. Keys already in the
 * text are rewritten in place (order and comments kept); new keys are appended in layer order.
 */
export function mergeServerProperties (text: string, ...layers: ServerProperties[]): string {
  const merged = new Map<string, string>()
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      merged.delete(k) // re-insert so append order follows the last layer that set it
      merged.set(k, formatValue(v))
    }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const seen = new Set<string>()
  const out = lines.map(l => {
    if (/^\s*[#!]/.test(l)) return l
    const m = LINE_RE.exec(l)
    if (!m || !merged.has(m[1]!)) return l
    seen.add(m[1]!) // rewrite every occurrence of a duplicated key
    return `${m[1]}=${merged.get(m[1]!)!}`
  })
  for (const [k, v] of merged) if (!seen.has(k)) out.push(`${k}=${v}`)
  return out.join(eol) + eol
}

/**
 * The property layers `createInstance` applies, in order: REQUIRED_BOT_PROPERTIES < presets <
 * overrides < instance identity (ports, level name).
 */
export function instancePropertyLayers (opts: {
  presets?: Array<PresetName | ServerProperties>
  properties?: ServerProperties
  port: number
  portV6: number
  levelName: string
}): ServerProperties[] {
  return [
    REQUIRED_BOT_PROPERTIES,
    ...(opts.presets ?? []).map(presetProperties),
    opts.properties ?? {},
    { 'server-port': opts.port, 'server-portv6': opts.portV6, 'level-name': opts.levelName }
  ]
}
