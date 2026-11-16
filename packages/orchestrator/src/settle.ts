import { DEFAULT_SETTLE, type BotFleetStats, type RampConfig, type SettleConfig } from '@bedperf/core'

/** One convergence check (see `settleCheck`). */
export interface SettleCheck {
  /** New unique chunk columns per bot per second over the window; undefined when the window is not covered yet. */
  ratePerBot?: number
  /** The newest fleet stats are at most `maxDataAgeSec` old and carry `uniqChunks`. */
  fresh: boolean
  /** fresh, rate known and at most `ratePerBot`. */
  converged: boolean
}

/** Share of bots that must have at least half the median in-view count, else `viewsIncomplete`. */
export const VIEW_COMPLETE_FRAC = 0.95

/**
 * Has the fleet stopped loading new chunks? Pure. The rate is the growth of the fleet's total unique
 * chunk columns between the last stats at or before `now - windowSec` (or the oldest one inside the
 * window) and the newest stats, per second and per spawned bot. The window must be at least 80% covered.
 */
export function settleCheck (stats: readonly BotFleetStats[], now: number, rules: Pick<SettleConfig, 'windowSec' | 'ratePerBot' | 'maxDataAgeSec'>): SettleCheck {
  const pts = stats.filter(s => typeof s.uniqChunks === 'number' && Number.isFinite(s.uniqChunks) && s.t <= now)
  const last = pts.at(-1)
  if (last === undefined) return { fresh: false, converged: false }
  const fresh = now - last.t <= rules.maxDataAgeSec * 1000
  const windowMs = rules.windowSec * 1000
  const from = now - windowMs
  let first: BotFleetStats | undefined
  for (const s of pts) {
    if (s.t <= from) first = s
    else break
  }
  first ??= pts[0]!
  const span = last.t - first.t
  if (!(span > 0) || span < 0.8 * windowMs) return { fresh, converged: false }
  const rate = (last.uniqChunks! - first.uniqChunks!) / (span / 1000) / Math.max(1, last.spawned)
  return { ratePerBot: rate, fresh, converged: fresh && rate <= rules.ratePerBot }
}

/**
 * `true` when fewer than 95% of the bots have at least half the median in-view count, `false` when at
 * least 95% do, undefined when the stats cannot tell (no view data; or, for loadgens that do not report
 * `halfMedianFrac`, when the minimum is below half the median).
 */
export function viewsIncomplete (last: BotFleetStats | undefined): boolean | undefined {
  const iv = last?.inView
  if (iv === undefined || !Number.isFinite(iv.median)) return undefined
  if (iv.halfMedianFrac !== undefined) return iv.halfMedianFrac < VIEW_COMPLETE_FRAC
  return iv.min >= 0.5 * iv.median ? false : undefined
}

export interface SettleOutcome {
  mode: SettleConfig['mode']
  /** Seconds actually waited. */
  settleSec: number
  /** Converge mode stopped at `maxSec` without converging. */
  settleCapped: boolean
  /** Rate at the last check, when known. */
  ratePerBot?: number
}

/** The settle rule of a ramp: `ramp.settle`, or fixed `settleSec` for configs without one. */
export function settleRules (ramp: Pick<RampConfig, 'settleSec' | 'settle'>): SettleConfig {
  return ramp.settle ?? { ...DEFAULT_SETTLE, mode: 'fixed', minSec: ramp.settleSec, maxSec: ramp.settleSec }
}

/**
 * Wait after scaling until the views converged (see `settleCheck`) or for a fixed time. Checks every
 * `evalSec` once `minSec` passed; gives up at `maxSec` with `settleCapped`.
 */
export async function settle (
  ramp: Pick<RampConfig, 'settleSec' | 'settle'>,
  io: { now: () => number, sleep: (ms: number) => Promise<void>, stats: () => readonly BotFleetStats[], signal?: AbortSignal, stop?: () => boolean }
): Promise<SettleOutcome> {
  const rules = settleRules(ramp)
  const start = io.now()
  if (rules.mode === 'fixed') {
    await io.sleep(ramp.settleSec * 1000)
    return { mode: 'fixed', settleSec: (io.now() - start) / 1000, settleCapped: false }
  }
  const minMs = rules.minSec * 1000
  const maxMs = rules.maxSec * 1000
  let rate: number | undefined
  for (;;) {
    io.signal?.throwIfAborted()
    const elapsed = io.now() - start
    // Pointless to wait for views of a dead server: the caller checks why.
    if (io.stop?.() === true) return { mode: 'converge', settleSec: elapsed / 1000, settleCapped: false }
    if (elapsed >= minMs) {
      const chk = settleCheck(io.stats(), io.now(), rules)
      rate = chk.ratePerBot
      if (chk.converged) return { mode: 'converge', settleSec: elapsed / 1000, settleCapped: false, ...(rate !== undefined ? { ratePerBot: rate } : {}) }
      if (elapsed >= maxMs) return { mode: 'converge', settleSec: elapsed / 1000, settleCapped: true, ...(rate !== undefined ? { ratePerBot: rate } : {}) }
    }
    const step = elapsed < minMs ? Math.min(minMs - elapsed, rules.evalSec * 1000) : rules.evalSec * 1000
    await io.sleep(Math.max(1, Math.min(step, Math.max(maxMs - elapsed, minMs - elapsed))))
  }
}
