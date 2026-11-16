import { readFile } from 'node:fs/promises'
import { DEFAULT_CRITERIA, type BenchmarkConfig, type PassCriteria, type RampConfig } from '@bedperf/core'

/** Defaults applied to `ramp` fields that are omitted. */
export const DEFAULT_RAMP: RampConfig = {
  start: 10,
  step: 10,
  max: 500,
  settleSec: 20,
  holdSec: 60,
  resolution: 2
}

export const DEFAULT_LOADGEN: BenchmarkConfig['loadgen'] = {
  botsPerWorker: 50,
  joinIntervalMs: 200
}

export const DEFAULT_REPEATS = 3
export const DEFAULT_WARMUP_SEC = 60

/** Thrown by `loadConfig` / `parseConfig`. `issues` lists every problem found, one per line of `message`. */
export class ConfigError extends Error {
  readonly issues: string[]
  constructor (issues: string[], source?: string) {
    super(`invalid benchmark config${source === undefined ? '' : ` (${source})`}:\n  - ${issues.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

type Obj = Record<string, unknown>

function isObj (v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function describe (v: unknown): string {
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

class Validator {
  readonly issues: string[] = []

  fail (path: string, msg: string, got?: unknown): void {
    this.issues.push(`${path}: ${msg}${arguments.length > 2 ? `, got ${describe(got)}` : ''}`)
  }

  unknownKeys (o: Obj, path: string, known: readonly string[]): void {
    for (const k of Object.keys(o)) {
      if (!known.includes(k)) this.issues.push(`${path}.${k}: unknown key (expected one of: ${known.join(', ')})`)
    }
  }

  obj (o: Obj, key: string, path: string): Obj | undefined {
    const v = o[key]
    if (v === undefined) return undefined
    if (!isObj(v)) {
      this.fail(`${path}.${key}`, 'expected an object', v)
      return undefined
    }
    return v
  }

  str (o: Obj, key: string, path: string, opts: { required?: boolean, def?: string } = {}): string | undefined {
    const v = o[key]
    if (v === undefined) {
      if (opts.required === true) this.fail(`${path}.${key}`, 'required string is missing')
      return opts.def
    }
    if (typeof v !== 'string' || v.trim() === '') {
      this.fail(`${path}.${key}`, 'expected a non-empty string', v)
      return opts.def
    }
    return v
  }

  num (o: Obj, key: string, path: string, opts: { def?: number, int?: boolean, min?: number, max?: number, minExclusive?: boolean } = {}): number | undefined {
    const v = o[key]
    if (v === undefined) return opts.def
    const p = `${path}.${key}`
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(p, 'expected a finite number', v)
      return opts.def
    }
    if (opts.int === true && !Number.isInteger(v)) {
      this.fail(p, 'expected an integer', v)
      return opts.def
    }
    if (opts.min !== undefined && (opts.minExclusive === true ? v <= opts.min : v < opts.min)) {
      this.fail(p, `must be ${opts.minExclusive === true ? '>' : '>='} ${opts.min}`, v)
      return opts.def
    }
    if (opts.max !== undefined && v > opts.max) {
      this.fail(p, `must be <= ${opts.max}`, v)
      return opts.def
    }
    return v
  }
}

const TOP_KEYS = ['$schema', 'name', 'bdsVersion', 'botVersion', 'serverProperties', 'world', 'scenario', 'loadgen', 'ramp', 'criteria', 'repeats', 'warmupSec', 'seed'] as const
const RAMP_KEYS = ['start', 'step', 'max', 'settleSec', 'holdSec', 'resolution'] as const
const CRITERIA_KEYS = ['minAvgTps', 'minWorstWindowTps', 'worstWindowDiscardPct', 'maxTickIntervalP99Ms', 'maxMainThreadUtil', 'maxBotFailures'] as const
const WORLD_KEYS = ['snapshot', 'seed', 'levelType'] as const
const SCENARIO_KEYS = ['module', 'params'] as const
const LOADGEN_KEYS = ['botsPerWorker', 'joinIntervalMs'] as const

/**
 * Validate a raw config object and fill defaults. Pure (no I/O). Throws `ConfigError`
 * listing every problem found. The input is not mutated.
 */
export function parseConfig (raw: unknown, source?: string): BenchmarkConfig {
  const v = new Validator()
  if (!isObj(raw)) throw new ConfigError([`config: expected a JSON object, got ${describe(raw)}`], source)
  const P = 'config'
  v.unknownKeys(raw, P, TOP_KEYS)

  const name = v.str(raw, 'name', P, { required: true }) ?? ''
  if (name !== '' && !/^[A-Za-z0-9._-]+$/.test(name)) v.fail(`${P}.name`, 'may only contain letters, digits, ".", "_" and "-"', name)
  const bdsVersion = v.str(raw, 'bdsVersion', P, { def: 'latest' }) ?? 'latest'
  const botVersion = v.str(raw, 'botVersion', P)

  // serverProperties
  const serverProperties: BenchmarkConfig['serverProperties'] = {}
  const sp = v.obj(raw, 'serverProperties', P)
  if (sp !== undefined) {
    for (const [k, val] of Object.entries(sp)) {
      if (typeof val === 'string' || typeof val === 'boolean' || (typeof val === 'number' && Number.isFinite(val))) serverProperties[k] = val
      else v.fail(`${P}.serverProperties.${k}`, 'expected a string, number or boolean', val)
    }
  }

  // world
  const world: BenchmarkConfig['world'] = {}
  const w = v.obj(raw, 'world', P)
  if (w !== undefined) {
    v.unknownKeys(w, `${P}.world`, WORLD_KEYS)
    const snapshot = v.str(w, 'snapshot', `${P}.world`)
    const seed = w['seed']
    if (snapshot !== undefined) world.snapshot = snapshot
    if (seed !== undefined) {
      if (typeof seed === 'string' || (typeof seed === 'number' && Number.isInteger(seed))) world.seed = String(seed)
      else v.fail(`${P}.world.seed`, 'expected a string or integer', seed)
    }
    const lt = w['levelType']
    if (lt !== undefined) {
      if (lt === 'DEFAULT' || lt === 'FLAT') world.levelType = lt
      else v.fail(`${P}.world.levelType`, 'expected "DEFAULT" or "FLAT"', lt)
    }
  }

  // scenario
  let scenario: BenchmarkConfig['scenario'] = { module: '' }
  const sc = raw['scenario']
  if (sc === undefined) v.fail(`${P}.scenario`, 'required object is missing')
  else if (!isObj(sc)) v.fail(`${P}.scenario`, 'expected an object', sc)
  else {
    v.unknownKeys(sc, `${P}.scenario`, SCENARIO_KEYS)
    const module = v.str(sc, 'module', `${P}.scenario`, { required: true }) ?? ''
    scenario = { module }
    const params = sc['params']
    if (params !== undefined) {
      if (isObj(params)) scenario.params = structuredClone(params)
      else v.fail(`${P}.scenario.params`, 'expected an object', params)
    }
  }

  // loadgen
  const lg = v.obj(raw, 'loadgen', P) ?? {}
  v.unknownKeys(lg, `${P}.loadgen`, LOADGEN_KEYS)
  const loadgen = {
    botsPerWorker: v.num(lg, 'botsPerWorker', `${P}.loadgen`, { def: DEFAULT_LOADGEN.botsPerWorker, int: true, min: 1 })!,
    joinIntervalMs: v.num(lg, 'joinIntervalMs', `${P}.loadgen`, { def: DEFAULT_LOADGEN.joinIntervalMs, min: 0 })!
  }

  // ramp
  const r = v.obj(raw, 'ramp', P) ?? {}
  const RP = `${P}.ramp`
  v.unknownKeys(r, RP, RAMP_KEYS)
  const ramp: RampConfig = {
    start: v.num(r, 'start', RP, { def: DEFAULT_RAMP.start, int: true, min: 1 })!,
    step: v.num(r, 'step', RP, { def: DEFAULT_RAMP.step, int: true, min: 1 })!,
    max: v.num(r, 'max', RP, { def: DEFAULT_RAMP.max, int: true, min: 1 })!,
    settleSec: v.num(r, 'settleSec', RP, { def: DEFAULT_RAMP.settleSec, min: 0 })!,
    holdSec: v.num(r, 'holdSec', RP, { def: DEFAULT_RAMP.holdSec, min: 0, minExclusive: true })!,
    resolution: v.num(r, 'resolution', RP, { def: DEFAULT_RAMP.resolution, int: true, min: 0 })!
  }
  const startOk = r['start'] === undefined || ramp.start === r['start']
  const maxOk = r['max'] === undefined || ramp.max === r['max']
  if (startOk && maxOk && ramp.start > ramp.max) v.fail(`${RP}.start`, `must be <= ramp.max (${ramp.max})`, ramp.start)

  // criteria
  const c = v.obj(raw, 'criteria', P) ?? {}
  const CP = `${P}.criteria`
  v.unknownKeys(c, CP, CRITERIA_KEYS)
  const criteria: PassCriteria = {
    minAvgTps: v.num(c, 'minAvgTps', CP, { def: DEFAULT_CRITERIA.minAvgTps, min: 0, max: 20 })!,
    minWorstWindowTps: v.num(c, 'minWorstWindowTps', CP, { def: DEFAULT_CRITERIA.minWorstWindowTps, min: 0, max: 20 })!,
    worstWindowDiscardPct: v.num(c, 'worstWindowDiscardPct', CP, { def: DEFAULT_CRITERIA.worstWindowDiscardPct, min: 0, max: 99 })!,
    maxTickIntervalP99Ms: v.num(c, 'maxTickIntervalP99Ms', CP, { def: DEFAULT_CRITERIA.maxTickIntervalP99Ms, min: 0, minExclusive: true })!,
    maxBotFailures: v.num(c, 'maxBotFailures', CP, { def: DEFAULT_CRITERIA.maxBotFailures, int: true, min: 0 })!
  }
  const mtu = v.num(c, 'maxMainThreadUtil', CP, { min: 0, minExclusive: true, max: 1 })
  const defMtu = c['maxMainThreadUtil'] === undefined ? DEFAULT_CRITERIA.maxMainThreadUtil : undefined
  if ((mtu ?? defMtu) !== undefined) criteria.maxMainThreadUtil = mtu ?? defMtu

  const repeats = v.num(raw, 'repeats', P, { def: DEFAULT_REPEATS, int: true, min: 1 })!
  const warmupSec = v.num(raw, 'warmupSec', P, { def: DEFAULT_WARMUP_SEC, min: 0 })!
  const seed = v.num(raw, 'seed', P, { def: 1, int: true })!

  if (v.issues.length > 0) throw new ConfigError(v.issues, source)

  const cfg: BenchmarkConfig = { name, bdsVersion, serverProperties, world, scenario, loadgen, ramp, criteria, repeats, warmupSec, seed }
  if (botVersion !== undefined) cfg.botVersion = botVersion
  return cfg
}

/**
 * Load a benchmark config from a JSON file path (or `file:` URL) or a plain object,
 * validate it and fill defaults.
 */
export async function loadConfig (src: string | URL | object): Promise<BenchmarkConfig> {
  if (typeof src === 'string' || src instanceof URL) {
    const where = String(src)
    let text: string
    try {
      text = await readFile(src, 'utf8')
    } catch (err) {
      throw new ConfigError([`cannot read config file: ${(err as Error).message}`], where)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new ConfigError([`not valid JSON: ${(err as Error).message}`], where)
    }
    return parseConfig(raw, where)
  }
  return parseConfig(src)
}
