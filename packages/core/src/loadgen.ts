import type { BotFleetStats } from './bots.ts'

export interface LoadGenOptions {
  host: string
  port: number
  /** bedboo protocol family or BDS build, e.g. '1.26.60'. */
  version: string
  /**
   * Module specifier (package name or file URL) whose `default` export implements `Scenario`.
   * Resolved inside worker processes.
   */
  scenarioModule: string
  scenarioParams?: Record<string, unknown>
  /** Bots per worker process. */
  botsPerWorker: number
  /** Delay between successive joins, ms. */
  joinIntervalMs: number
  /** Username prefix; bot i is `${prefix}${i}`. */
  usernamePrefix: string
  /** Seed for scenario RNG. */
  seed: number
  /** Stats emission period, ms. */
  statsIntervalMs: number
}

export interface LoadGenerator {
  /** Launch the fleet controller (no bots yet). */
  start (opts: LoadGenOptions): Promise<void>
  /**
   * Adjust the number of online bots. Resolves when the fleet reached `n` spawned bots
   * (or the timeout elapsed — check stats for failures).
   */
  scaleTo (n: number, timeoutMs?: number): Promise<void>
  onStats (listener: (s: BotFleetStats) => void): void
  /** Disconnect all bots and terminate workers. */
  stop (): Promise<void>
}
