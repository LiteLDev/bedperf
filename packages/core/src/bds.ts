import type { ProbeRecord } from './probe.ts'
import type { GametimeReading } from './tickcounter.ts'

/** server.properties as key → value. Values are written verbatim. */
export type ServerProperties = Record<string, string | number | boolean>

/** Properties every benchmark instance needs so bedboo bots can join. */
export const REQUIRED_BOT_PROPERTIES: ServerProperties = {
  'online-mode': false,
  'allow-list': false,
  'allow-cheats': true,
  'enable-lan-visibility': false,
  transport: 'raknet',
  'player-idle-timeout': 0,
  'content-log-file-enabled': false,
  // Required: without it, Script API console.log output (the probe channel) never reaches stdout.
  'content-log-console-output-enabled': true
}

/** A prepared, runnable BDS directory. */
export interface BdsInstance {
  /** Absolute instance directory (contains bedrock_server[.exe], server.properties, worlds/). */
  dir: string
  version: string
  platform: 'win' | 'linux'
  port: number
  portV6: number
  levelName: string
}

export interface PlayerEvent { name: string, xuid?: string }

/** Events emitted by a running server (see packages/bds-process). */
export interface BdsServerEvents {
  /** Every stdout/stderr line, without trailing newline. */
  line: (line: string, stream: 'stdout' | 'stderr') => void
  ready: () => void
  playerJoin: (p: PlayerEvent) => void
  playerLeave: (p: PlayerEvent) => void
  probe: (rec: ProbeRecord) => void
  /** Process exited. `expected` is false for crashes / kills not requested via stop(). */
  exit: (info: { code: number | null, signal: string | null, expected: boolean }) => void
}

export interface BdsServer {
  readonly instance: BdsInstance
  readonly pid: number | undefined
  start (opts?: { readyTimeoutMs?: number }): Promise<void>
  /** Write a console command (no leading slash) to stdin. */
  send (command: string): void
  /**
   * Send a command and collect output lines until `until` matches or the timeout expires.
   * Resolves with the collected lines (including the matching one).
   */
  command (command: string, until: RegExp, timeoutMs?: number): Promise<string[]>
  /**
   * Optional: `time query gametime` round trip, the script-free tick counter. `priority` puts it
   * ahead of queued normal commands.
   */
  queryGametime? (opts?: { timeoutMs?: number, priority?: boolean }): Promise<GametimeReading>
  /** Graceful stop (`stop` + wait for exit), killing after the timeout. */
  stop (timeoutMs?: number): Promise<void>
  on<E extends keyof BdsServerEvents> (event: E, listener: BdsServerEvents[E]): this
  off<E extends keyof BdsServerEvents> (event: E, listener: BdsServerEvents[E]): this
}
