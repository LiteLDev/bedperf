// @bedperf/scenarios: bot workload scenarios (idle, walk, explore, build, chat, mobs, entity-stress).
// Each scenario is its own module (src/scenarios/<name>.ts) whose default export is a core `Scenario`; the load
// generator imports it by file URL inside its worker processes.
import type { Scenario } from '@bedperf/core'
import { COMMON_SETUP_DEFAULTS } from './common.ts'
import idle, { defaults as idleDefaults } from './scenarios/idle.ts'
import walk, { defaults as walkDefaults } from './scenarios/walk.ts'
import explore, { defaults as exploreDefaults } from './scenarios/explore.ts'
import build, { defaults as buildDefaults } from './scenarios/build.ts'
import chat, { defaults as chatDefaults } from './scenarios/chat.ts'
import mobs, { defaults as mobsDefaults } from './scenarios/mobs.ts'
import entityStress, { defaults as entityStressDefaults } from './scenarios/entity-stress.ts'

export interface ScenarioEntry {
  /** File URL of the module whose default export is the Scenario (pass as LoadGenOptions.scenarioModule). */
  module: string
  description: string
  /** Scenario-specific parameters and their defaults (common params are listed in COMMON_PARAMS). */
  defaults: Record<string, unknown>
  /** True when `run`/setup sends commands as the bot: needs `default-player-permission-level=operator` (or op). */
  needsOperator: boolean
}

const entry = (s: Scenario, defaults: Record<string, unknown>, needsOperator: boolean): ScenarioEntry => ({
  module: new URL(`./scenarios/${s.name}.ts`, import.meta.url).href,
  description: s.description,
  defaults,
  needsOperator
})

export const SCENARIOS = {
  idle: entry(idle, idleDefaults, false),
  walk: entry(walk, walkDefaults, false),
  explore: entry(explore, exploreDefaults, true),
  build: entry(build, buildDefaults, true),
  chat: entry(chat, chatDefaults, false),
  mobs: entry(mobs, mobsDefaults, true),
  'entity-stress': entry(entityStress, entityStressDefaults, true)
} satisfies Record<string, ScenarioEntry>

export type ScenarioName = keyof typeof SCENARIOS

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[]

/**
 * Params every scenario accepts, with their defaults (a scenario may change a default, e.g. mobs: time=midnight).
 * `difficulty` unset leaves the server's; `extraSetup` is appended to serverSetup; `viewDistance`
 * ('far' | 'normal' | 'short' | 'tiny' | chunks) unset keeps the load generator's default.
 */
export const COMMON_PARAMS: Record<string, unknown> = { ...COMMON_SETUP_DEFAULTS, viewDistance: undefined }

export function isScenarioName (name: string): name is ScenarioName {
  return Object.hasOwn(SCENARIOS, name)
}

/** File URL of scenario `name`'s module. Throws for an unknown name. */
export function scenarioModule (name: string): string {
  if (!isScenarioName(name)) throw new Error(`unknown scenario "${name}" (known: ${SCENARIO_NAMES.join(', ')})`)
  return SCENARIOS[name].module
}

/** Import scenario `name` (or any module specifier whose default export is a Scenario). */
export async function loadScenario (nameOrModule: string): Promise<Scenario> {
  const spec = isScenarioName(nameOrModule) ? SCENARIOS[nameOrModule].module : nameOrModule
  const m = await import(spec) as { default?: Scenario }
  const s = m.default
  if (!s || typeof s.run !== 'function' || typeof s.name !== 'string') {
    throw new Error(`module ${spec} does not default-export a Scenario`)
  }
  return s
}

export {
  ScenarioParamError, GOLDEN_ANGLE, directionAngle, spiralCell, commonSetupCommands, parseCommonSetup
} from './common.ts'
