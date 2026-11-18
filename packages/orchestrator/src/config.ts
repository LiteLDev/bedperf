import { readFile } from 'node:fs/promises'
import {
  DEFAULT_COOLDOWN_SEC, DEFAULT_CRITERIA, DEFAULT_GATES, DEFAULT_PLACEMENT, DEFAULT_SAMPLING, DEFAULT_SETTLE, DEFAULT_TPS_DIVERGENCE,
  resolveServerSpec, SERVER_FLAVORS, SERVER_MODS, SERVER_RUNTIMES,
  type BenchmarkConfig, type CpuSpec, type GatesConfig, type PassCriteria, type PlacementConfig, type RampConfig, type ServerFlavor, type ServerMod,
  type ServerSpec, type ServerVersions, type SettleConfig
} from '@bedperf/core'

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

const TOP_KEYS = [
  '$schema', 'name', 'bdsVersion', 'botVersion', 'server', 'serverProperties', 'world', 'scenario', 'loadgen', 'ramp', 'criteria', 'repeats', 'warmupSec', 'seed',
  'placement', 'gates', 'sampling', 'cooldownSec'
] as const
const RAMP_KEYS = ['start', 'step', 'max', 'settleSec', 'holdSec', 'resolution', 'settle'] as const
const SETTLE_KEYS = ['mode', 'minSec', 'maxSec', 'windowSec', 'ratePerBot', 'maxDataAgeSec', 'evalSec'] as const
const CRITERIA_KEYS = [
  'minAvgTps', 'minWorstWindowTps', 'worstWindowDiscardPct', 'maxTickIntervalP99Ms', 'maxMainThreadUtil', 'maxBotFailures',
  'minCounterTps', 'maxProbeCounterTpsDivergence'
] as const
const PLACEMENT_KEYS = ['enabled', 'label', 'serverCpus', 'botCpus', 'harnessCpus', 'priority'] as const
export const GATES_KEYS = Object.keys(DEFAULT_GATES) as ReadonlyArray<keyof GatesConfig>
const SAMPLING_KEYS = ['gametimeIntervalSec'] as const

/** `auto` (or `bot` where allowed), a kernel-style CPU list such as `"0-7,16"`, or an array of CPU indices. */
function cpuSpec (v: Validator, o: Obj, key: string, path: string, def: CpuSpec, keyword: string): CpuSpec {
  const val = o[key]
  if (val === undefined) return def
  const p = `${path}.${key}`
  if (typeof val === 'string') {
    if (val === keyword || /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(val)) return val
    v.fail(p, `expected "${keyword}" or a CPU list like "0-7,16"`, val)
    return def
  }
  if (Array.isArray(val) && val.length > 0 && val.every(x => Number.isInteger(x) && (x as number) >= 0)) return [...val] as number[]
  v.fail(p, `expected "${keyword}", a CPU list string or a non-empty array of CPU indices`, val)
  return def
}
const SERVER_KEYS = ['flavor', 'mods', 'runtime', 'versions', 'loaderConfig'] as const
const SERVER_VERSION_KEYS = ['levilamina', 'levioptimize', 'endstone'] as const
/** The flavor a pinned component version applies to (`levioptimize`: a mod, so LeviLamina). */
const VERSION_FLAVOR: Record<typeof SERVER_VERSION_KEYS[number], ServerFlavor> = { levilamina: 'levilamina', levioptimize: 'levilamina', endstone: 'endstone' }

/**
 * `server`: which implementation runs (absent: vanilla BDS). Checks what can be checked without the
 * host: mods and Wine are LeviLamina-only, versions are non-empty strings, `loaderConfig` is an
 * object (LeviLamina only). Whether the runtime fits the host is checked at run time.
 */
function serverSpec (v: Validator, raw: Obj, P: string): ServerSpec | undefined {
  const s = v.obj(raw, 'server', P)
  if (s === undefined) return undefined
  const SP = `${P}.server`
  v.unknownKeys(s, SP, SERVER_KEYS)
  const flavor = s['flavor']
  if (flavor === undefined) v.fail(`${SP}.flavor`, `required, one of: ${SERVER_FLAVORS.join(', ')}`)
  else if (!(SERVER_FLAVORS as readonly unknown[]).includes(flavor)) v.fail(`${SP}.flavor`, `expected one of: ${SERVER_FLAVORS.join(', ')}`, flavor)
  const f = (SERVER_FLAVORS as readonly unknown[]).includes(flavor) ? flavor as ServerFlavor : undefined

  const runtime = s['runtime'] ?? 'native'
  if (!(SERVER_RUNTIMES as readonly unknown[]).includes(runtime)) v.fail(`${SP}.runtime`, `expected one of: ${SERVER_RUNTIMES.join(', ')}`, runtime)
  else if (runtime === 'wine' && f === 'endstone') v.fail(`${SP}.runtime`, `"wine" runs a Windows build of BDS or LeviLamina (flavor ${f} runs natively)`)

  const mods: ServerMod[] = []
  const m = s['mods']
  if (m !== undefined) {
    if (!Array.isArray(m)) v.fail(`${SP}.mods`, 'expected an array of mod names', m)
    else {
      for (const x of m) {
        if ((SERVER_MODS as readonly unknown[]).includes(x)) mods.push(x as ServerMod)
        else v.fail(`${SP}.mods`, `unknown mod (known: ${SERVER_MODS.join(', ')})`, x)
      }
      if (m.length > 0 && f !== undefined && f !== 'levilamina') v.fail(`${SP}.mods`, `mods need flavor levilamina (got ${f})`)
    }
  }

  const versions: ServerVersions = {}
  const vs = v.obj(s, 'versions', SP)
  if (vs !== undefined) {
    v.unknownKeys(vs, `${SP}.versions`, SERVER_VERSION_KEYS)
    for (const k of SERVER_VERSION_KEYS) {
      const val = v.str(vs, k, `${SP}.versions`)
      if (val === undefined) continue
      if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(val)) v.fail(`${SP}.versions.${k}`, 'expected a version like 1.2.3', val)
      else if (f !== undefined && VERSION_FLAVOR[k] !== f) v.fail(`${SP}.versions.${k}`, `applies to flavor ${VERSION_FLAVOR[k]}, not ${f}`)
      else if (k === 'levioptimize' && !mods.includes('levioptimize')) v.fail(`${SP}.versions.${k}`, 'set, but mods does not include levioptimize')
      else versions[k] = val
    }
  }

  let loaderConfig: Record<string, unknown> | undefined
  const lc = s['loaderConfig']
  if (lc !== undefined) {
    if (!isObj(lc)) v.fail(`${SP}.loaderConfig`, 'expected an object', lc)
    else if (f !== undefined && f !== 'levilamina') v.fail(`${SP}.loaderConfig`, `only LeviLamina takes a loader config (flavor ${f})`)
    else loaderConfig = structuredClone(lc)
  }
  if (f === undefined) return undefined
  return resolveServerSpec({ flavor: f, mods, runtime: runtime === 'wine' ? 'wine' : 'native', versions, ...(loaderConfig !== undefined ? { loaderConfig } : {}) })
}

const WORLD_KEYS = ['snapshot', 'seed', 'levelType'] as const
const SCENARIO_KEYS = ['module', 'params'] as const
const LOADGEN_KEYS = ['botsPerWorker', 'joinIntervalMs', 'connectRetries', 'saturation'] as const

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
  const server = serverSpec(v, raw, P)

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
  const loadgen: BenchmarkConfig['loadgen'] = {
    botsPerWorker: v.num(lg, 'botsPerWorker', `${P}.loadgen`, { def: DEFAULT_LOADGEN.botsPerWorker, int: true, min: 1 })!,
    joinIntervalMs: v.num(lg, 'joinIntervalMs', `${P}.loadgen`, { def: DEFAULT_LOADGEN.joinIntervalMs, min: 0 })!
  }
  // optional and not filled in, so configs without it keep their hash
  const connectRetries = v.num(lg, 'connectRetries', `${P}.loadgen`, { int: true, min: 0, max: 10 })
  if (connectRetries !== undefined) loadgen.connectRetries = connectRetries
  // optional and not filled in either
  const sat = v.obj(lg, 'saturation', `${P}.loadgen`)
  if (sat !== undefined) {
    const SP = `${P}.loadgen.saturation`
    v.unknownKeys(sat, SP, ['eventLoopP99Ms', 'cpuPct'] as const)
    const lag = v.num(sat, 'eventLoopP99Ms', SP, { min: 0, minExclusive: true })
    const cpu = v.num(sat, 'cpuPct', SP, { min: 0, minExclusive: true, max: 100 })
    loadgen.saturation = { ...(lag !== undefined ? { eventLoopP99Ms: lag } : {}), ...(cpu !== undefined ? { cpuPct: cpu } : {}) }
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
  const st = v.obj(r, 'settle', RP) ?? {}
  const SP = `${RP}.settle`
  v.unknownKeys(st, SP, SETTLE_KEYS)
  const mode = st['mode']
  if (mode !== undefined && mode !== 'converge' && mode !== 'fixed') v.fail(`${SP}.mode`, 'expected "converge" or "fixed"', mode)
  const settle: SettleConfig = {
    mode: mode === 'fixed' ? 'fixed' : 'converge',
    minSec: v.num(st, 'minSec', SP, { def: DEFAULT_SETTLE.minSec, min: 0 })!,
    maxSec: v.num(st, 'maxSec', SP, { def: DEFAULT_SETTLE.maxSec, min: 0 })!,
    windowSec: v.num(st, 'windowSec', SP, { def: DEFAULT_SETTLE.windowSec, min: 0, minExclusive: true })!,
    ratePerBot: v.num(st, 'ratePerBot', SP, { def: DEFAULT_SETTLE.ratePerBot, min: 0 })!,
    maxDataAgeSec: v.num(st, 'maxDataAgeSec', SP, { def: DEFAULT_SETTLE.maxDataAgeSec, min: 0, minExclusive: true })!,
    evalSec: v.num(st, 'evalSec', SP, { def: DEFAULT_SETTLE.evalSec, min: 0, minExclusive: true })!
  }
  if (settle.maxSec < settle.minSec) v.fail(`${SP}.maxSec`, `must be >= settle.minSec (${settle.minSec})`, settle.maxSec)
  ramp.settle = settle
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
  const mct = v.num(c, 'minCounterTps', CP, { min: 0, max: 20 })
  if (mct !== undefined) criteria.minCounterTps = mct
  criteria.maxProbeCounterTpsDivergence = v.num(c, 'maxProbeCounterTpsDivergence', CP, { def: DEFAULT_TPS_DIVERGENCE, min: 0, minExclusive: true })!
  const mtu = v.num(c, 'maxMainThreadUtil', CP, { min: 0, minExclusive: true, max: 1 })
  const defMtu = c['maxMainThreadUtil'] === undefined ? DEFAULT_CRITERIA.maxMainThreadUtil : undefined
  if ((mtu ?? defMtu) !== undefined) criteria.maxMainThreadUtil = mtu ?? defMtu

  const repeats = v.num(raw, 'repeats', P, { def: DEFAULT_REPEATS, int: true, min: 1 })!
  const warmupSec = v.num(raw, 'warmupSec', P, { def: DEFAULT_WARMUP_SEC, min: 0 })!
  const seed = v.num(raw, 'seed', P, { def: 1, int: true })!
  const cooldownSec = v.num(raw, 'cooldownSec', P, { def: DEFAULT_COOLDOWN_SEC, min: 0 })!

  // placement
  const pl = v.obj(raw, 'placement', P) ?? {}
  const PP = `${P}.placement`
  v.unknownKeys(pl, PP, PLACEMENT_KEYS)
  const enabled = pl['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') v.fail(`${PP}.enabled`, 'expected a boolean', enabled)
  const priority = pl['priority']
  if (priority !== undefined && priority !== 'normal' && priority !== 'above_normal') v.fail(`${PP}.priority`, 'expected "normal" or "above_normal"', priority)
  const placement: PlacementConfig = {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_PLACEMENT.enabled,
    serverCpus: cpuSpec(v, pl, 'serverCpus', PP, DEFAULT_PLACEMENT.serverCpus, 'auto'),
    botCpus: cpuSpec(v, pl, 'botCpus', PP, DEFAULT_PLACEMENT.botCpus, 'auto'),
    harnessCpus: cpuSpec(v, pl, 'harnessCpus', PP, DEFAULT_PLACEMENT.harnessCpus, 'bot') as PlacementConfig['harnessCpus'],
    priority: priority === 'above_normal' ? 'above_normal' : 'normal'
  }
  const label = v.str(pl, 'label', PP)
  if (label !== undefined) placement.label = label

  // gates
  const g = v.obj(raw, 'gates', P) ?? {}
  const GP = `${P}.gates`
  v.unknownKeys(g, GP, GATES_KEYS)
  const gates = { ...DEFAULT_GATES }
  for (const k of GATES_KEYS) gates[k] = v.num(g, k, GP, { def: DEFAULT_GATES[k], min: 0 })!

  // sampling
  const sm = v.obj(raw, 'sampling', P) ?? {}
  v.unknownKeys(sm, `${P}.sampling`, SAMPLING_KEYS)
  const sampling = {
    gametimeIntervalSec: v.num(sm, 'gametimeIntervalSec', `${P}.sampling`, { def: DEFAULT_SAMPLING.gametimeIntervalSec, min: 0, minExclusive: true })!
  }

  if (v.issues.length > 0) throw new ConfigError(v.issues, source)

  const cfg: BenchmarkConfig = {
    name, bdsVersion, serverProperties, world, scenario, loadgen, ramp, criteria, repeats, warmupSec, seed, placement, gates, sampling, cooldownSec
  }
  if (botVersion !== undefined) cfg.botVersion = botVersion
  if (server !== undefined) cfg.server = server
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
