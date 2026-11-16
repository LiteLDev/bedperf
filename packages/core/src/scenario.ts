import type { Bot, BotOptions } from 'bedboo'

/** Context handed to each bot's scenario loop. */
export interface ScenarioContext {
  /** 0-based index of this bot within the fleet (stable across scale up/down). */
  index: number
  /** Scenario parameters from the benchmark config. */
  params: Record<string, unknown>
  /** Deterministic RNG seeded per (run seed, bot index). Returns [0, 1). */
  random: () => number
  log: (msg: string) => void
}

/**
 * A workload. Scenarios are plain modules: the load generator imports them by module
 * specifier inside each worker process, so they must not capture host-process state.
 * A scenario module exports the Scenario as `default`.
 */
export interface Scenario {
  name: string
  description: string
  /** Console commands (no leading slash) the orchestrator runs on the server once before load. */
  serverSetup?: (params: Record<string, unknown>) => string[]
  /** Extra/overriding bedboo createBot options (e.g. viewDistance, plugins). */
  botOptions?: (params: Record<string, unknown>) => Partial<BotOptions>
  /**
   * Called after the bot spawns. Should loop until `signal` aborts, then return.
   * Throwing counts as a bot failure.
   */
  run: (bot: Bot, ctx: ScenarioContext, signal: AbortSignal) => Promise<void>
}
