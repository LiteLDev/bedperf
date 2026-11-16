// Shared helpers for scenarios: parameter parsing, abortable waits, command requests, layout math and the
// server setup every scenario starts from.
import type { Bot, BotOptions } from 'bedboo'
import type { ScenarioContext } from '@bedperf/core'

// ---------------------------------------------------------------------------------------------------------------
// Parameters

/** Thrown for an invalid scenario parameter (wrong type, out of range, unknown enum value). */
export class ScenarioParamError extends Error {
  override name = 'ScenarioParamError'
}

type Params = Record<string, unknown>

/** A number param: `def` when absent; must be finite and within [min, max], and an integer when `int`. */
export function numParam (params: Params, key: string, def: number, opts: { min?: number, max?: number, int?: boolean } = {}): number {
  const raw = params[key]
  if (raw === undefined || raw === null) return def
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ScenarioParamError(`param ${key}: expected a number, got ${JSON.stringify(raw)}`)
  if (opts.int && !Number.isInteger(v)) throw new ScenarioParamError(`param ${key}: expected an integer, got ${v}`)
  if (opts.min !== undefined && v < opts.min) throw new ScenarioParamError(`param ${key}: ${v} < min ${opts.min}`)
  if (opts.max !== undefined && v > opts.max) throw new ScenarioParamError(`param ${key}: ${v} > max ${opts.max}`)
  return v
}

/** A boolean param (also accepts 'true'/'false'). */
export function boolParam (params: Params, key: string, def: boolean): boolean {
  const raw = params[key]
  if (raw === undefined || raw === null) return def
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new ScenarioParamError(`param ${key}: expected a boolean, got ${JSON.stringify(raw)}`)
}

/** A string param restricted to `allowed`. */
export function enumParam<T extends string> (params: Params, key: string, def: T, allowed: readonly T[]): T {
  const raw = params[key]
  if (raw === undefined || raw === null) return def
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new ScenarioParamError(`param ${key}: expected one of ${allowed.join('|')}, got ${JSON.stringify(raw)}`)
  }
  return raw as T
}

/** A Minecraft identifier param (entity/block type), `minecraft:` prefix optional. */
export function idParam (params: Params, key: string, def: string): string {
  const raw = params[key]
  if (raw === undefined || raw === null) return def
  if (typeof raw !== 'string' || !/^(minecraft:)?[a-z0-9_]+$/.test(raw)) {
    throw new ScenarioParamError(`param ${key}: expected an identifier like "zombie", got ${JSON.stringify(raw)}`)
  }
  return raw.replace(/^minecraft:/, '')
}

/** A string array param (e.g. extra console commands). */
export function stringArrayParam (params: Params, key: string, def: string[]): string[] {
  const raw = params[key]
  if (raw === undefined || raw === null) return def
  if (!Array.isArray(raw) || !raw.every(s => typeof s === 'string')) {
    throw new ScenarioParamError(`param ${key}: expected an array of strings, got ${JSON.stringify(raw)}`)
  }
  return raw as string[]
}

// ---------------------------------------------------------------------------------------------------------------
// Common server setup and bot options

export type TimeOfDay = 'noon' | 'midnight' | 'day' | 'night' | 'sunrise' | 'sunset'
const TIMES: readonly TimeOfDay[] = ['noon', 'midnight', 'day', 'night', 'sunrise', 'sunset']
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
const DIFFICULTIES: readonly Difficulty[] = ['peaceful', 'easy', 'normal', 'hard']

export interface CommonSetup {
  daylightCycle: boolean
  weatherCycle: boolean
  mobSpawning: boolean
  randomTickSpeed: number
  time: TimeOfDay
  /** Leave the difficulty untouched when undefined. */
  difficulty: Difficulty | undefined
  /** Extra console commands appended after the generated ones. */
  extraSetup: string[]
}

export const COMMON_SETUP_DEFAULTS: CommonSetup = {
  daylightCycle: false,
  weatherCycle: false,
  mobSpawning: false,
  randomTickSpeed: 1,
  time: 'noon',
  difficulty: undefined,
  extraSetup: []
}

/** Parse the common setup params, with per-scenario defaults overriding the global ones. */
export function parseCommonSetup (params: Params, defaults: Partial<CommonSetup> = {}): CommonSetup {
  const d = { ...COMMON_SETUP_DEFAULTS, ...defaults }
  const difficulty = params.difficulty === undefined || params.difficulty === null
    ? d.difficulty
    : enumParam(params, 'difficulty', 'normal', DIFFICULTIES)
  return {
    daylightCycle: boolParam(params, 'daylightCycle', d.daylightCycle),
    weatherCycle: boolParam(params, 'weatherCycle', d.weatherCycle),
    mobSpawning: boolParam(params, 'mobSpawning', d.mobSpawning),
    randomTickSpeed: numParam(params, 'randomTickSpeed', d.randomTickSpeed, { min: 0, max: 4096, int: true }),
    time: enumParam(params, 'time', d.time, TIMES),
    difficulty,
    extraSetup: stringArrayParam(params, 'extraSetup', d.extraSetup)
  }
}

/** Console commands (no leading slash) for the common setup. */
export function commonSetupCommands (s: CommonSetup): string[] {
  const cmds = [
    `gamerule doDaylightCycle ${s.daylightCycle}`,
    `gamerule doWeatherCycle ${s.weatherCycle}`,
    `gamerule doMobSpawning ${s.mobSpawning}`,
    `gamerule randomTickSpeed ${s.randomTickSpeed}`,
    `time set ${s.time}`
  ]
  if (!s.weatherCycle) cmds.push('weather clear')
  if (s.difficulty !== undefined) cmds.push(`difficulty ${s.difficulty}`)
  return [...cmds, ...s.extraSetup]
}

/**
 * Bot options every scenario accepts: `viewDistance` ('far'|'normal'|'short'|'tiny' or chunks). Nothing is overridden
 * when the param is absent, so the load generator's defaults apply.
 */
export function commonBotOptions (params: Params): Partial<BotOptions> {
  const raw = params.viewDistance
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) return { viewDistance: numParam(params, 'viewDistance', 6, { min: 1, max: 96, int: true }) }
  return { viewDistance: enumParam(params, 'viewDistance', 'tiny', ['far', 'normal', 'short', 'tiny'] as const) }
}

// ---------------------------------------------------------------------------------------------------------------
// Abort-aware waiting

/** Sleep `ms`, resolving early (never rejecting) when `signal` aborts. */
export function sleep (ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Sentinel returned by `raceAbort` when the signal aborted first. */
export const ABORTED: unique symbol = Symbol('aborted')

/**
 * Await `p`, or return `ABORTED` as soon as `signal` aborts. A rejection of `p` after the abort is swallowed, so an
 * abandoned in-flight request never becomes an unhandled rejection.
 */
export function raceAbort<T> (p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  p.catch(() => {})
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
}

/** Reject after `ms` unless `p` settles first. */
export function withTimeout<T> (p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

export function errMsg (err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * A logger for repeated per-action errors: logs the first `burst` occurrences, then every `every`-th, so a bot
 * stuck failing does not flood the worker's log. Returns the running count.
 */
export function errorLogger (ctx: ScenarioContext, label: string, burst = 5, every = 100): (err: unknown) => number {
  let n = 0
  return err => {
    n++
    if (n <= burst || n % every === 0) ctx.log(`${label}: ${errMsg(err)} (error #${n})`)
    return n
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands sent by the bot (tick-bound; need operator permission)

export interface CommandResult {
  ok: boolean
  successCount: number
  /** First output message id, e.g. 'commands.fill.success' or 'commands.generic.noTargetMatch'. */
  messageId: string
}

/** The bedboo internal command channel (`bot._bedrock.commands`), not part of the public typings. */
interface CommandChannel {
  request: (command: string, opts?: { timeout?: number }) => Promise<{
    success_count?: number
    output?: Array<{ message_id?: string, success?: boolean }>
  }>
}

function commandChannel (bot: Bot): CommandChannel {
  const ch = (bot as unknown as { _bedrock?: { commands?: CommandChannel } })._bedrock?.commands
  if (!ch) throw new Error('bot has no command channel (bot._bedrock.commands); is the chat plugin loaded?')
  return ch
}

/**
 * Run a command as the bot and resolve with its outcome (`ABORTED` when `signal` aborts first). Rejects on timeout or
 * a missing command channel; a command the server refused resolves with `ok: false`.
 */
export async function command (bot: Bot, cmd: string, signal: AbortSignal, timeoutMs = 10_000): Promise<CommandResult | typeof ABORTED> {
  const out = await raceAbort(commandChannel(bot).request(cmd, { timeout: timeoutMs }), signal)
  if (out === ABORTED) return ABORTED
  const first = out.output?.[0]
  const successCount = out.success_count ?? 0
  return { ok: successCount > 0 || first?.success === true, successCount, messageId: first?.message_id ?? '' }
}

/**
 * Entity count from a `/testfor <selector>` result: its success count when the selector was evaluated (including
 * "no targets"), undefined when the command was refused for another reason.
 */
export function testforCount (r: CommandResult | undefined): number | undefined {
  if (!r) return undefined
  if (r.ok) return r.successCount
  return r.messageId === 'commands.generic.noTargetMatch' ? 0 : undefined
}

/**
 * Run a command, logging (not throwing) on failure. Returns the result, or undefined on error/abort.
 */
export async function tryCommand (bot: Bot, ctx: ScenarioContext, cmd: string, signal: AbortSignal, timeoutMs = 10_000): Promise<CommandResult | undefined> {
  try {
    const r = await command(bot, cmd, signal, timeoutMs)
    if (r === ABORTED) return undefined
    // an empty selector match (e.g. /testfor with no mobs yet) is an expected answer, not an error
    if (!r.ok && r.messageId !== 'commands.generic.noTargetMatch') ctx.log(`command refused: /${cmd} (${r.messageId})`)
    return r
  } catch (err) {
    if (!signal.aborted) ctx.log(`command failed: /${cmd}: ${errMsg(err)}`)
    return undefined
  }
}

/** A refusal because the target area is not loaded (yet), e.g. 'commands.fill.outOfWorld'. */
export function isOutOfWorld (r: CommandResult): boolean {
  return /outOfWorld/i.test(r.messageId)
}

/** A /fill that was accepted, including one that changed nothing (`commands.fill.success` with 0 blocks). */
export function fillDone (r: CommandResult): boolean {
  return r.ok || r.messageId === 'commands.fill.success'
}

/**
 * Retry `cmd` until `done(result)` (default: the server accepted it), e.g. a `fill` in a chunk that is still
 * loading. A refusal for which `retryIf` is false (default: always retry) is logged and ends the attempts. Returns
 * whether it got there before `attempts` ran out or `signal` aborted.
 */
export async function commandUntilOk (
  bot: Bot, ctx: ScenarioContext, cmd: string, signal: AbortSignal,
  { attempts = 30, delayMs = 1000, done = (r: CommandResult) => r.ok, retryIf = () => true }:
  { attempts?: number, delayMs?: number, done?: (r: CommandResult) => boolean, retryIf?: (r: CommandResult) => boolean } = {}
): Promise<boolean> {
  for (let i = 0; i < attempts && !signal.aborted; i++) {
    try {
      const r = await command(bot, cmd, signal)
      if (r === ABORTED) return false
      if (done(r)) return true
      if (!retryIf(r)) {
        ctx.log(`command refused: /${cmd} (${r.messageId})`)
        return false
      }
      if (i === attempts - 1) ctx.log(`command refused: /${cmd} (${r.messageId})`)
    } catch (err) {
      if (i === attempts - 1 && !signal.aborted) ctx.log(`command failed: /${cmd}: ${errMsg(err)}`)
    }
    await sleep(delayMs, signal)
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry and deterministic layout

/** The golden angle in radians (π(3 − √5)): successive multiples spread directions evenly around a circle. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** Heading (radians, [0, 2π)) of bot `index` for outward movement. */
export function directionAngle (index: number): number {
  const a = (index * GOLDEN_ANGLE) % (2 * Math.PI)
  return a < 0 ? a + 2 * Math.PI : a
}

/**
 * Cell of a square spiral around (0, 0): index 0 → (0,0), 1 → (1,0), 2 → (1,1), 3 → (0,1), 4 → (-1,1), … Every
 * cell is visited exactly once, and the first n indexes stay within a ⌈√n⌉-sized square.
 */
export function spiralCell (index: number): { x: number, z: number } {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`spiralCell: bad index ${index}`)
  if (index === 0) return { x: 0, z: 0 }
  // ring k holds the 8k cells with max(|x|, |z|) = k, starting just after (k-1, -(k-1)) … at (k, -k+1)
  const k = Math.ceil((Math.sqrt(index + 1) - 1) / 2)
  const side = 2 * k
  const start = (2 * k - 1) ** 2 // first index of ring k
  const off = index - start // 0 … 8k-1
  const leg = Math.floor(off / side)
  const along = off % side
  switch (leg) {
    case 0: return { x: k, z: -k + 1 + along }
    case 1: return { x: k - 1 - along, z: k }
    case 2: return { x: -k, z: k - 1 - along }
    default: return { x: -k + 1 + along, z: -k }
  }
}

/** Yaw (bedboo/mineflayer radians: 0 faces −Z, π/2 faces −X) looking from (x, z) towards (tx, tz). */
export function yawTowards (x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z))
}

/** A Vec3 of the same class as the bot's position (avoids depending on `vec3` directly). */
export function vec (bot: Bot, x: number, y: number, z: number): Bot['entity']['position'] {
  const P = bot.entity.position.constructor as new (x: number, y: number, z: number) => Bot['entity']['position']
  return new P(x, y, z)
}

/** Deterministic random integer in [lo, hi]. */
export function randInt (random: () => number, lo: number, hi: number): number {
  return lo + Math.floor(random() * (hi - lo + 1))
}

/** Format a coordinate for a command (integers stay integers, others get 2 decimals). */
export function coord (n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
