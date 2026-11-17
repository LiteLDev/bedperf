// Pure parsing of server console output lines (vanilla BDS, LeviLamina, Endstone). No I/O; safe
// to use on saved logs.
import { parseProbeLine, type PlayerEvent, type ProbeRecord } from '@bedperf/core'

/** Which console format a prefix was recognised as. */
export type LogFormat = 'bds' | 'levilamina' | 'endstone'

/**
 * The timestamp / level prefix of a log line. Recognised formats:
 * - `bds` (vanilla): `[2026-11-16 16:15:28:495 INFO] msg` (date optional: `[INFO] msg`).
 * - `levilamina`: `10:34:37.034 IFO [Server] msg` (LeviLamina's `{3:.3%T.} {2} {1} {0}`;
 *   levels `TRC DBG IFO WRN ERR FTL`, the PreLoader prints `INFO`), colored with ANSI escapes.
 * - `endstone`: `[10:36:53 INFO]: msg` (spdlog `[%H:%M:%S %L]: [%n] %v`; the server logger has no
 *   `[name]`, other loggers keep `[name]` in `message`).
 */
export interface BdsLinePrefix {
  /** Timestamp as epoch ms, local time zone. Only for formats that print the date (vanilla). */
  ts?: number
  /** Timestamp exactly as printed, e.g. `2026-11-16 16:15:28:495` or `10:34:37.034`. */
  tsText?: string
  /** Log level as printed, e.g. `INFO`, `WARN`, `IFO`, `ERR`, `WARNING`. See `normalizeLevel`. */
  level?: string
  /** LeviLamina logger name, e.g. `Server`, `LeviLamina`, a mod name. */
  logger?: string
  /** Which prefix format matched. Absent when there is no prefix. */
  format?: LogFormat
  /** Text after the prefix (or the whole line when there is none), trailing whitespace removed. */
  message: string
}

// Only known level names count, so unprefixed tags like `[Scripting]` are not taken for a level.
const LEVELS = 'TRACE|DEBUG|VERBOSE|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL'
const PREFIX_RE = new RegExp(`^\\[(?:(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})(?:[:.](\\d{1,3}))?\\s+)?(${LEVELS})\\]\\s?`)
const LL_PREFIX_RE = new RegExp(`^(\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?) +(${LEVELS}|TRC|DBG|IFO|INF|WRN|ERR|FTL|CRT) +\\[([^\\]]*)\\] ?`)
const ENDSTONE_PREFIX_RE = new RegExp(`^\\[(\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,3})?) (${LEVELS})\\]: ?`)

const LEVEL_NORM: Record<string, 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'> = {
  TRACE: 'TRACE',
  TRC: 'TRACE',
  VERBOSE: 'TRACE',
  DEBUG: 'DEBUG',
  DBG: 'DEBUG',
  INFO: 'INFO',
  IFO: 'INFO',
  INF: 'INFO',
  WARN: 'WARN',
  WARNING: 'WARN',
  WRN: 'WARN',
  ERROR: 'ERROR',
  ERR: 'ERROR',
  FATAL: 'FATAL',
  FTL: 'FATAL',
  CRITICAL: 'FATAL',
  CRT: 'FATAL'
}

/** Map a printed level of any format to `TRACE | DEBUG | INFO | WARN | ERROR | FATAL`. */
export function normalizeLevel (level: string | undefined): 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | undefined {
  return level === undefined ? undefined : LEVEL_NORM[level.toUpperCase()]
}

// CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL|ST`) and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Remove ANSI escape sequences (colors, OSC titles). LeviLamina colors its console output. */
export function stripAnsi (s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s
}

/** Remove trailing CR/LF characters (Windows output is `\r\n`-terminated). */
export function stripEol (line: string): string {
  return line.replace(/[\r\n]+$/, '')
}

/** Split off the timestamp / log-level prefix of any known format. Lines without one get only `message`. */
export function parseLinePrefix (line: string): BdsLinePrefix {
  return prefixOf(stripAnsi(stripEol(line)))
}

/** `parseLinePrefix` of a line already stripped of EOL and ANSI sequences. */
function prefixOf (text: string): BdsLinePrefix {
  const m = PREFIX_RE.exec(text)
  if (m) {
    const out: BdsLinePrefix = { level: m[8]!, format: 'bds', message: text.slice(m[0].length).trimEnd() }
    if (m[1] !== undefined) {
      const ms = m[7] === undefined ? 0 : Number(m[7])
      out.ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime()
      out.tsText = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${m[7] === undefined ? '' : ':' + m[7]}`
    }
    return out
  }
  const ll = LL_PREFIX_RE.exec(text)
  if (ll) return { tsText: ll[1]!, level: ll[2]!, logger: ll[3]!, format: 'levilamina', message: text.slice(ll[0].length).trimEnd() }
  const es = ENDSTONE_PREFIX_RE.exec(text)
  if (es) return { tsText: es[1]!, level: es[2]!, format: 'endstone', message: text.slice(es[0].length).trimEnd() }
  return { message: text.trimEnd() }
}

interface ParsedBase extends BdsLinePrefix {
  /** The line with trailing CR/LF and ANSI escape sequences removed. */
  text: string
}

export type ParsedBdsLine = ParsedBase & (
  | { kind: 'ready' }
  | { kind: 'join', player: PlayerEvent }
  | { kind: 'leave', player: PlayerEvent }
  | { kind: 'probe', record: ProbeRecord }
  | { kind: 'portInUse', port?: number }
  | { kind: 'error' }
  | { kind: 'other' }
)

export type BdsLineKind = ParsedBdsLine['kind']

// `Player connected: name, xuid: 123` / `Player disconnected: name, xuid: 123, pfid: abc`.
// Offline-mode servers print an empty xuid.
const PLAYER_RE = /^Player (connected|disconnected): (.+?), xuid: ?([^,\s]*)/
const PORT_RE = /Port (?:\[(\d*)[^\]]*\] )?may be in use/i

const READY_RE = /^Server started\b/

/** Classify one console output line (any known format). Never throws. */
export function parseBdsLine (line: string): ParsedBdsLine {
  const text = stripAnsi(stripEol(line))
  const prefix = prefixOf(text)
  const base: ParsedBase = { text, ...prefix }
  const msg = prefix.message

  // Probe records may appear anywhere (behind `[Scripting]` etc.), so check them first.
  const record = parseProbeLine(text)
  if (record) return { ...base, kind: 'probe', record }

  // Vanilla prints Server started.; LeviLamina rewrites it to Server started in (1.6s)! For help, ....
  if (READY_RE.test(msg)) return { ...base, kind: 'ready' }

  const pm = PLAYER_RE.exec(msg)
  if (pm) {
    const player: PlayerEvent = { name: pm[2]! }
    if (pm[3]) player.xuid = pm[3]
    return { ...base, kind: pm[1] === 'connected' ? 'join' : 'leave', player }
  }

  const portM = PORT_RE.exec(msg)
  if (portM) {
    return portM[1] === undefined || portM[1] === ''
      ? { ...base, kind: 'portInUse' }
      : { ...base, kind: 'portInUse', port: Number(portM[1]) }
  }

  const level = normalizeLevel(prefix.level)
  if (level === 'ERROR' || level === 'FATAL') return { ...base, kind: 'error' }
  return { ...base, kind: 'other' }
}

/** True for lines with no content (empty, whitespace, or a prefix followed by nothing). */
export function isBlankLine (p: BdsLinePrefix): boolean {
  return p.message.trim() === ''
}

/** Parse the `There are n/max players online:` header of `list`. */
export function parseListHeader (message: string): { online: number, max: number } | undefined {
  const m = /There are (\d+)\/(\d+) players online/.exec(message)
  return m ? { online: Number(m[1]), max: Number(m[2]) } : undefined
}

/** Parse the names line that follows the `list` header (`a, b, c`). */
export function parseListNames (line: string): string[] {
  return stripEol(line).split(',').map(s => s.trim()).filter(s => s !== '')
}

/** Console command that prints the tick counter. */
export const GAMETIME_COMMAND = 'time query gametime'

export const GAMETIME_RE = /^Gametime is (\d+)/i

/**
 * Parse the reply to `time query gametime` (`Gametime is 12345`). Accepts a full log line or a
 * message whose `[timestamp LEVEL]` prefix is already stripped. Returns undefined otherwise.
 */
export function parseGametime (line: string): number | undefined {
  const m = GAMETIME_RE.exec(parseLinePrefix(line).message)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : undefined
}

