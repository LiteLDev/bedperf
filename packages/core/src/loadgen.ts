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
  /** Registry name of the scenario, when it is a built-in one (lets remote agents use their own copy). */
  scenarioName?: string
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
  /** OS process ids of the live load-generator worker processes (optional). */
  pids? (): number[]
  /** Called with the pid of every worker process the generator starts, including re-forks (optional). */
  onWorkerSpawn? (listener: (pid: number) => void): void
  /**
   * Mark the fleet saturated because of `source` (e.g. a remote agent's machine) with `reasons`; an empty list
   * clears it (optional).
   */
  setExternalSaturation? (source: string, reasons: readonly string[]): void
}
