// Scenario module resolution on the agent: the orchestrator's `WorkerInit.scenarioModule` is a file URL of its
// own machine. Builtin scenarios are mapped to this machine's copy; custom modules must exist here too.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { IDLE_SCENARIO } from '@bedperf/loadgen'

export interface ScenarioResolverDeps {
  /** Local module URL of registry scenario `name`, or undefined if unknown. Default: `@bedperf/scenarios`. */
  registry?: (name: string) => Promise<string | undefined>
  /** Default `fs.existsSync`. */
  exists?: (path: string) => boolean
}

async function defaultRegistry (name: string): Promise<string | undefined> {
  const s = await import('@bedperf/scenarios')
  return s.isScenarioName(name) ? s.SCENARIOS[name].module : undefined
}

/** Registry name of a builtin scenario module URL (any machine's checkout), or undefined. */
export function builtinScenarioName (moduleUrl: string): string | undefined {
  const m = /\/packages\/scenarios\/src\/scenarios\/([A-Za-z0-9_-]+)\.ts$/.exec(moduleUrl)
  return m?.[1]
}

/** True for loadgen's builtin idle scenario module URL from any machine's checkout. */
export function isLoadgenIdle (moduleUrl: string): boolean {
  return /\/packages\/loadgen\/src\/scenarios\/idle\.ts$/.test(moduleUrl)
}

/**
 * The module specifier a worker on this machine should import. Throws (with a message meant for the operator)
 * when the scenario cannot be found locally.
 */
export async function resolveScenarioModule (
  init: { scenarioModule: string, scenarioName?: string }, deps: ScenarioResolverDeps = {}
): Promise<string> {
  const registry = deps.registry ?? defaultRegistry
  const exists = deps.exists ?? existsSync
  if (init.scenarioName !== undefined) {
    const local = await registry(init.scenarioName)
    if (local === undefined) throw new Error(`scenario "${init.scenarioName}" is not a builtin scenario of this agent's bedperf`)
    return local
  }
  const mod = init.scenarioModule
  if (!mod.startsWith('file:')) return mod // package specifier: resolved by the worker
  if (isLoadgenIdle(mod)) return IDLE_SCENARIO
  const builtin = builtinScenarioName(mod)
  if (builtin !== undefined) {
    const local = await registry(builtin)
    if (local !== undefined) return local
  }
  let path: string | undefined
  try { path = fileURLToPath(mod) } catch {}
  if (path !== undefined && exists(path)) return mod
  throw new Error(`custom scenario module ${mod} is not present on this agent; copy it to the same path on the agent machine or use a builtin scenario`)
}
