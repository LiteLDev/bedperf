// Pure parsing of BDS console output lines. No I/O; safe to use on saved logs.
import { parseProbeLine, type PlayerEvent, type ProbeRecord } from '@bedperf/core'

/** The `[2026-11-16 16:15:28:495 INFO] ` prefix BDS puts on most log lines. */
export interface BdsLinePrefix {
  /** Timestamp as epoch ms, interpreted in the local time zone (BDS logs local time). */
  ts?: number
  /** Timestamp exactly as printed, e.g. `2026-11-16 16:15:28:495`. */
  tsText?: string
  /** Log level as printed, e.g. `INFO`, `WARN`, `ERROR`. */
  level?: string
  /** Text after the prefix (or the whole line when there is none), trailing whitespace removed. */
  message: string
}

// Only known level names count, so unprefixed tags like `[Scripting]` are not taken for a level.
const PREFIX_RE = /^\[(?:(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[:.](\d{1,3}))?\s+)?(TRACE|DEBUG|VERBOSE|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\]\s?/

/** Remove trailing CR/LF characters (Windows output is `\r\n`-terminated). */
export function stripEol (line: string): string {
  return line.replace(/[\r\n]+$/, '')
}

/** Split off the timestamp / log-level prefix. Lines without one get only `message`. */
export function parseLinePrefix (line: string): BdsLinePrefix {
  const text = stripEol(line)
  const m = PREFIX_RE.exec(text)
  if (!m) return { message: text.trimEnd() }
  const out: BdsLinePrefix = { level: m[8]!, message: text.slice(m[0].length).trimEnd() }
  if (m[1] !== undefined) {
    const ms = m[7] === undefined ? 0 : Number(m[7])
    out.ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime()
    out.tsText = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}${m[7] === undefined ? '' : ':' + m[7]}`
  }
  return out
}

interface ParsedBase extends BdsLinePrefix {
  /** The line with trailing CR/LF removed. */
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

/** Classify one BDS output line. Never throws. */
export function parseBdsLine (line: string): ParsedBdsLine {
  const text = stripEol(line)
  const prefix = parseLinePrefix(text)
  const base: ParsedBase = { text, ...prefix }
  const msg = prefix.message

  // Probe records may appear anywhere (behind `[Scripting]` etc.), so check them first.
  const record = parseProbeLine(text)
  if (record) return { ...base, kind: 'probe', record }

  if (msg === 'Server started.') return { ...base, kind: 'ready' }

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

  if (prefix.level === 'ERROR' || prefix.level === 'FATAL') return { ...base, kind: 'error' }
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
