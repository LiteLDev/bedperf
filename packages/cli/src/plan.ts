// Pure run planning: turns a validated BenchmarkConfig into the concrete pieces the wiring needs.
import { REQUIRED_BOT_PROPERTIES, type BenchmarkConfig, type ServerProperties } from '@bedperf/core'
import { isScenarioName, SCENARIOS, type ScenarioName } from '@bedperf/scenarios'

const SCENARIO_PKG_PREFIX = '@bedperf/scenarios/'

export interface ScenarioRef {
  /** Registry name, when the config names a built-in scenario. */
  name?: ScenarioName
  /** Module specifier handed to the load generator workers (file URL for built-ins). */
  module: string
  needsOperator: boolean
}

/**
 * `scenario.module` may be a registry name (`walk`), the package-style alias `@bedperf/scenarios/walk`
 * used by the presets, or any module specifier / file URL whose default export is a Scenario.
 */
export function resolveScenario (spec: string): ScenarioRef {
  const name = spec.startsWith(SCENARIO_PKG_PREFIX) ? spec.slice(SCENARIO_PKG_PREFIX.length) : spec
  if (isScenarioName(name)) {
    const e = SCENARIOS[name]
    return { name, module: e.module, needsOperator: e.needsOperator }
  }
  if (spec.startsWith(SCENARIO_PKG_PREFIX)) {
    throw new Error(`unknown scenario '${name}' (known: ${Object.keys(SCENARIOS).join(', ')})`)
  }
  // Custom module: assume it may send commands as the bot.
  return { module: spec, needsOperator: true }
}

const same = (a: unknown, b: unknown): boolean => String(a) === String(b)

/**
 * The server.properties overrides for an instance: config properties plus the world settings, with
 * operator permission added for scenarios that need it. Throws when the config overrides a property bots
 * depend on (REQUIRED_BOT_PROPERTIES) or denies operator to a scenario that needs it.
 */
export function instanceProperties (config: BenchmarkConfig, scenario: ScenarioRef): ServerProperties {
  const props: ServerProperties = { ...config.serverProperties }
  const issues: string[] = []
  for (const [k, v] of Object.entries(REQUIRED_BOT_PROPERTIES)) {
    if (k in props && !same(props[k], v)) issues.push(`serverProperties.${k}=${String(props[k])} breaks bot joins or the probe channel (required: ${String(v)})`)
  }
  for (const k of ['server-port', 'server-portv6', 'level-name']) {
    if (k in props) issues.push(`serverProperties.${k} is set by bedperf per instance; remove it`)
  }
  if (config.world.seed !== undefined) props['level-seed'] = config.world.seed
  if (config.world.levelType !== undefined) props['level-type'] = config.world.levelType
  const perm = 'default-player-permission-level'
  if (scenario.needsOperator) {
    if (perm in props && !same(props[perm], 'operator')) {
      issues.push(`scenario ${scenario.name ?? scenario.module} sends commands as bots and needs ${perm}=operator (config has ${String(props[perm])})`)
    }
    props[perm] = 'operator'
  }
  if (issues.length > 0) throw new Error(`config cannot run:\n  - ${issues.join('\n  - ')}`)
  return props
}

function parts (v: string): number[] {
  return v.split('.').map(Number)
}

function cmp (a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * bedboo protocol family for a BDS build: the newest tested family not newer than the build's x.y.z
 * (BDS 1.26.63.1 → 1.26.60). Returns undefined when the build predates every tested family or is newer
 * than the next minor (a protocol bump bedboo cannot know about).
 */
export function botFamily (bdsVersion: string, tested: readonly string[]): string | undefined {
  if (tested.includes(bdsVersion)) return bdsVersion
  const v = parts(bdsVersion).slice(0, 3)
  const sorted = [...tested].sort((a, b) => cmp(parts(a), parts(b)))
  let best: string | undefined
  for (const f of sorted) if (cmp(parts(f), v) <= 0) best = f
  if (best === undefined) return undefined
  const b = parts(best)
  // Same major.minor and within the same patch decade (1.26.60 covers 1.26.60–1.26.69).
  if (b[0] !== v[0] || b[1] !== v[1] || Math.floor((v[2] ?? 0) / 10) !== Math.floor((b[2] ?? 0) / 10)) return undefined
  return best
}

/** A sortable, filesystem-safe run id. */
export function makeRunId (t: number, name: string): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${name}`
}
