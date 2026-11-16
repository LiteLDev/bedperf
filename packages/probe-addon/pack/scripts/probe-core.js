// @ts-check
// Pure probe logic: no `@minecraft/*` imports, so it is unit-tested under Node.
// The record shapes and prefix MUST match packages/core/src/probe.ts (the pack cannot import
// core at runtime); src/probe-core.test.ts checks the output with core's parseProbeLine.

export const PROBE_LINE_PREFIX = 'BEDPERF|'
/** Plain (non-record) diagnostic lines start with this; it does not contain the record prefix. */
export const PROBE_INFO_PREFIX = 'bedperf-probe '

/** @typedef {{ mean: number, max: number, p50: number, p95: number, p99: number }} IntervalStats */
/** @typedef {{ total: number, byDimension: Record<string, number>, topTypes: Record<string, number> }} EntityStats */
/**
 * @typedef {object} ProbeSample
 * @property {'sample'} type
 * @property {1} v
 * @property {number} tick
 * @property {number} t
 * @property {number} windowMs
 * @property {number} ticks
 * @property {number} tps
 * @property {IntervalStats} interval
 * @property {number} over50
 * @property {number} over100
 * @property {number} players
 * @property {EntityStats} [entities]
 */
/** @typedef {{ type: 'mark', v: 1, tick: number, t: number, label: string }} ProbeMark */
/** @typedef {{ type: 'pong', v: 1, tick: number, t: number, id: string }} ProbePong */
/** @typedef {ProbeSample | ProbeMark | ProbePong} ProbeRecord */

/**
 * @typedef {object} ProbeConfig
 * @property {number} windowMs Reporting window (wall-clock ms).
 * @property {number} entityEvery Sample entities every N windows (0 = never).
 * @property {number} entityBudgetMs If one entity scan takes longer, the effective period doubles (up to 64x); it halves again after scans under half the budget.
 */

/** @type {Readonly<ProbeConfig>} */
export const DEFAULT_CONFIG = Object.freeze({ windowMs: 1000, entityEvery: 5, entityBudgetMs: 10 })

/** Dimensions sampled for entity counts (ids accepted by `world.getDimension`). */
export const DIMENSION_IDS = Object.freeze(['overworld', 'nether', 'the_end'])

/** @param {ProbeRecord} rec */
export function encodeProbeLine (rec) {
  return PROBE_LINE_PREFIX + JSON.stringify(rec)
}

/**
 * @param {number} x
 * @param {number} f power of ten
 */
function round (x, f) {
  return Math.round(x * f) / f
}

/**
 * Linear-interpolated percentile of an ascending typed array (same method as core's percentileSorted).
 * @param {Float64Array} s
 * @param {number} p
 */
export function percentileSorted (s, p) {
  const n = s.length
  if (n === 0) return Number.NaN
  if (n === 1) return /** @type {number} */ (s[0])
  const rank = (p / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const a = /** @type {number} */ (s[lo])
  const b = /** @type {number} */ (s[hi])
  return a + (b - a) * (rank - lo)
}

/**
 * Per-tick interval accumulator over one window. `tick()` does no allocation: intervals go into a
 * preallocated Float64Array; aggregates are kept incrementally.
 */
export class TickWindow {
  /** @param {number} [capacity] max intervals kept for percentiles (aggregates still count all) */
  constructor (capacity = 4096) {
    this.capacity = capacity
    this.intervals = new Float64Array(capacity)
    /** Time of the tick that opened the window; -1 before the first tick. */
    this.start = -1
    /** Time of the previous tick; -1 before the first tick. */
    this.last = -1
    this.n = 0
    this.ticks = 0
    this.sum = 0
    this.max = 0
    this.over50 = 0
    this.over100 = 0
  }

  /**
   * Record a tick observed at wall time `now` (ms).
   * @param {number} now
   * @returns {number} ms elapsed since the window opened
   */
  tick (now) {
    if (this.last < 0) {
      this.start = this.last = now
      return 0
    }
    let dt = now - this.last
    if (dt < 0) { // wall clock stepped backwards: shift the window so its span stays consistent
      this.start += dt
      dt = 0
    }
    this.last = now
    if (this.n < this.capacity) this.intervals[this.n++] = dt
    this.ticks++
    this.sum += dt
    if (dt > this.max) this.max = dt
    if (dt > 50) this.over50++
    if (dt > 100) this.over100++
    return now - this.start
  }

  /**
   * Build the window's sample fields and open a new window at the last tick.
   * Sorts the stored intervals in place (one subarray view per window, nothing per tick).
   * @param {number} tick `system.currentTick`
   * @param {number} players
   * @param {EntityStats} [entities]
   * @returns {ProbeSample}
   */
  flush (tick, players, entities) {
    const windowMs = this.last - this.start
    const sorted = this.intervals.subarray(0, this.n).sort()
    const ticks = this.ticks
    /** @type {ProbeSample} */
    const s = {
      type: 'sample',
      v: 1,
      tick,
      t: this.last,
      windowMs,
      ticks,
      tps: windowMs > 0 ? round(ticks / (windowMs / 1000), 1000) : 0,
      interval: {
        mean: ticks > 0 ? round(this.sum / ticks, 100) : 0,
        max: this.max,
        p50: ticks > 0 ? round(percentileSorted(sorted, 50), 100) : 0,
        p95: ticks > 0 ? round(percentileSorted(sorted, 95), 100) : 0,
        p99: ticks > 0 ? round(percentileSorted(sorted, 99), 100) : 0
      },
      over50: this.over50,
      over100: this.over100,
      players
    }
    if (entities) s.entities = entities
    this.start = this.last
    this.n = this.ticks = this.sum = this.max = this.over50 = this.over100 = 0
    return s
  }
}

/**
 * @typedef {object} DimensionLike
 * @property {() => ArrayLike<{ readonly typeId: string }>} getEntities
 */

/**
 * Count entities per dimension and per type (top `topN` types).
 * @param {ReadonlyArray<{ id: string, dimension: DimensionLike }>} dims
 * @param {number} [topN]
 * @returns {EntityStats}
 */
export function countEntities (dims, topN = 10) {
  /** @type {Record<string, number>} */
  const byDimension = {}
  /** @type {Map<string, number>} */
  const counts = new Map()
  let total = 0
  for (const { id, dimension } of dims) {
    let list
    try { list = dimension.getEntities() } catch { continue }
    let n = 0
    for (let i = 0; i < list.length; i++) {
      let type
      try { type = /** @type {{ readonly typeId: string }} */ (list[i]).typeId } catch { continue } // entity removed meanwhile
      counts.set(type, (counts.get(type) ?? 0) + 1)
      n++
    }
    byDimension[id] = n
    total += n
  }
  /** @type {Record<string, number>} */
  const topTypes = {}
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, topN)
  for (const [k, v] of top) topTypes[k] = v
  return { total, byDimension, topTypes }
}

/**
 * Validate a partial config (from `/scriptevent bedperf:config <json>`) against `base`.
 * @param {string} json
 * @param {Readonly<ProbeConfig>} base
 * @returns {ProbeConfig}
 */
export function parseConfig (json, base) {
  /** @type {unknown} */
  const raw = JSON.parse(json)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be a JSON object')
  const o = /** @type {Record<string, unknown>} */ (raw)
  const out = { ...base }
  /**
   * @param {'windowMs' | 'entityEvery' | 'entityBudgetMs'} k
   * @param {number} min
   * @param {number} max
   */
  const num = (k, min, max) => {
    if (!(k in o)) return
    const v = o[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${k} must be an integer in [${min}, ${max}]`)
    }
    out[k] = v
  }
  num('windowMs', 100, 60_000)
  num('entityEvery', 0, 3600)
  num('entityBudgetMs', 1, 10_000)
  for (const k of Object.keys(o)) {
    if (k !== 'windowMs' && k !== 'entityEvery' && k !== 'entityBudgetMs') throw new Error(`unknown config key ${k}`)
  }
  return out
}

/**
 * @typedef {object} ProbeEnv
 * @property {() => number} now wall clock (Date.now)
 * @property {() => number} currentTick
 * @property {() => number} playerCount
 * @property {() => ReadonlyArray<{ id: string, dimension: DimensionLike }>} dimensions
 * @property {(line: string) => void} log
 */

const MAX_BACKOFF = 64

/** The probe state machine, independent of the Script API (main.js wires it to `@minecraft/server`). */
export class Probe {
  /**
   * @param {ProbeEnv} env
   * @param {Partial<ProbeConfig>} [config]
   */
  constructor (env, config = {}) {
    this.env = env
    /** @type {ProbeConfig} */
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.win = new TickWindow()
    this.windows = 0
    this.untilEntities = this.config.entityEvery
    /** Multiplier on entityEvery after over-budget scans. */
    this.backoff = 1
    this.lastScanMs = 0
    this.maxScanMs = 0
    this.scans = 0
    /** Wall time spent building + logging the last sample, excluding the entity scan. */
    this.lastFlushMs = 0
  }

  /** Call once per server tick. */
  onTick () {
    const env = this.env
    if (this.win.tick(env.now()) >= this.config.windowMs) this.flush()
  }

  /** @returns {ProbeSample} */
  flush () {
    const env = this.env
    const t0 = env.now()
    /** @type {EntityStats | undefined} */
    let entities
    let scanMs = 0
    if (this.config.entityEvery > 0 && --this.untilEntities <= 0) {
      entities = countEntities(env.dimensions())
      const t1 = env.now()
      scanMs = t1 - t0
      this.lastScanMs = scanMs
      if (scanMs > this.maxScanMs) this.maxScanMs = scanMs
      this.scans++
      if (scanMs > this.config.entityBudgetMs) {
        if (this.backoff < MAX_BACKOFF) {
          this.backoff *= 2
          this.info('entity-backoff')
        }
      } else if (this.backoff > 1 && scanMs * 2 <= this.config.entityBudgetMs) {
        this.backoff /= 2 // recover once scans are cheap again
      }
      this.untilEntities = this.config.entityEvery * this.backoff
    }
    const s = this.win.flush(env.currentTick(), env.playerCount(), entities)
    env.log(encodeProbeLine(s))
    this.windows++
    this.lastFlushMs = env.now() - t0 - scanMs
    return s
  }

  /**
   * Handle a `/scriptevent` addressed to the probe.
   * @param {string} id e.g. 'bedperf:ping'
   * @param {string} message
   * @returns {string | undefined} for a ping, the id to echo to the sending player
   */
  onScriptEvent (id, message) {
    const env = this.env
    const msg = message.trim()
    switch (id) {
      case 'bedperf:mark':
        env.log(encodeProbeLine({ type: 'mark', v: 1, tick: env.currentTick(), t: env.now(), label: msg }))
        return undefined
      case 'bedperf:ping':
        env.log(encodeProbeLine({ type: 'pong', v: 1, tick: env.currentTick(), t: env.now(), id: msg }))
        return msg
      case 'bedperf:config':
        try {
          this.setConfig(parseConfig(msg, this.config))
          this.info('config')
        } catch (err) {
          this.info('config-error', String(err instanceof Error ? err.message : err))
        }
        return undefined
      case 'bedperf:info':
        this.info('info')
        return undefined
      default:
        return undefined
    }
  }

  /** @param {ProbeConfig} c */
  setConfig (c) {
    const entityChanged = c.entityEvery !== this.config.entityEvery || c.entityBudgetMs !== this.config.entityBudgetMs
    this.config = c
    if (entityChanged) {
      this.backoff = 1
      this.untilEntities = c.entityEvery
    }
  }

  /**
   * Log a plain diagnostic line (not a probe record).
   * @param {string} event
   * @param {string} [error]
   */
  info (event, error) {
    this.env.log(PROBE_INFO_PREFIX + JSON.stringify({
      event,
      error,
      config: this.config,
      windows: this.windows,
      entityEveryEffective: this.config.entityEvery * this.backoff,
      entityScans: this.scans,
      lastEntityScanMs: this.lastScanMs,
      maxEntityScanMs: this.maxScanMs,
      lastFlushMs: this.lastFlushMs
    }))
  }
}
