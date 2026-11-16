/**
 * Contract between the in-game Script API probe (packages/probe-addon) and the host.
 * The probe writes `console.log(PROBE_LINE_PREFIX + JSON.stringify(record))`; BDS forwards
 * script console output to its stdout, possibly with a timestamp / "[Scripting]" prefix,
 * so parsers look for the marker anywhere in the line.
 */
export const PROBE_LINE_PREFIX = 'BEDPERF|'

/** Stats over one reporting window (nominally 1 s = ~20 ticks) measured inside the server tick. */
export interface ProbeSample {
  type: 'sample'
  /** Probe protocol version; bump on breaking change. */
  v: 1
  /** `system.currentTick` at the end of the window. */
  tick: number
  /** Server wall-clock (Date.now()) at the end of the window. */
  t: number
  /** Wall-clock duration of the window in ms. */
  windowMs: number
  /** Ticks observed in the window. */
  ticks: number
  /** ticks / (windowMs / 1000). */
  tps: number
  /** Distribution of wall-clock intervals between consecutive ticks in the window (ms). */
  interval: { mean: number, max: number, p50: number, p95: number, p99: number }
  /** Ticks whose interval exceeded 50 ms / 100 ms (lag indicators). */
  over50: number
  over100: number
  players: number
  /**
   * Entity counts; only present on windows where the probe sampled them
   * (entity enumeration is not free, so it is done every N windows).
   */
  entities?: {
    total: number
    byDimension: Record<string, number>
    /** Top entity type ids by count. */
    topTypes: Record<string, number>
  }
}

/** A labelled marker echoed by the probe (via `/scriptevent bedperf:mark <label>`). */
export interface ProbeMark {
  type: 'mark'
  v: 1
  tick: number
  t: number
  label: string
}

/** Reply to `/scriptevent bedperf:ping <id>`; lets the host measure tick-bound latency. */
export interface ProbePong {
  type: 'pong'
  v: 1
  tick: number
  t: number
  id: string
}

export type ProbeRecord = ProbeSample | ProbeMark | ProbePong

export function encodeProbeLine (rec: ProbeRecord): string {
  return PROBE_LINE_PREFIX + JSON.stringify(rec)
}

/** Returns the record if `line` contains a probe record, else undefined. Never throws. */
export function parseProbeLine (line: string): ProbeRecord | undefined {
  const i = line.indexOf(PROBE_LINE_PREFIX)
  if (i < 0) return undefined
  const json = line.slice(i + PROBE_LINE_PREFIX.length).trim()
  try {
    const rec = JSON.parse(json) as ProbeRecord
    if (rec === null || typeof rec !== 'object') return undefined
    if (rec.type !== 'sample' && rec.type !== 'mark' && rec.type !== 'pong') return undefined
    return rec
  } catch {
    return undefined
  }
}
