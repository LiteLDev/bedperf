import type { RampConfig } from '@bedperf/core'
import { LOADGEN_SATURATED_REASON, type StepOutcome } from './criteria.ts'

export type SearchPhase = 'ramp' | 'bisect'

/** One evaluated step, as far as the search is concerned. */
export interface SearchStep {
  players: number
  outcome: StepOutcome
  /** Why an invalid step was invalid (`StepResult.invalidReasons`). Absent means loadgen saturation. */
  reasons?: readonly string[]
}

export interface SearchState {
  ramp: Pick<RampConfig, 'start' | 'step' | 'max' | 'resolution'>
  /** Steps evaluated so far in this repeat, in order. */
  history: readonly SearchStep[]
}

export interface SearchContinue {
  done: false
  players: number
  phase: SearchPhase
  /** True when this step re-measures a load level whose previous measurement was invalid. */
  retry: boolean
}

export interface SearchDone {
  done: true
  /** Highest passing player count (0 if nothing passed). */
  maxPlayers: number
  /** ramp.max passed: the true capacity is at least `maxPlayers`, possibly higher. */
  capped: boolean
  /** Stopped because a load level was invalid twice in a row and both times the loadgen was saturated. `maxPlayers` is a lower bound. */
  loadgenLimited: boolean
  /** Stopped because a load level was invalid twice in a row (any reason). `maxPlayers` is a lower bound. */
  invalidLimited: boolean
  /** With `invalidLimited`: the reasons of the two invalid steps, de-duplicated. */
  invalidReasons?: string[]
  /** Lowest failing player count, when one was found. */
  firstFail?: number
}

export type SearchDecision = SearchContinue | SearchDone

/**
 * Next step of a coarse-ramp → bisect search. Pure: the decision depends only on `state`.
 *
 * - Ramp: `start`, then last pass + `step` (clamped to `max`), until the first fail. If `max`
 *   passes, stop with `capped`.
 * - Bisect between the highest pass below the lowest fail (`lo`) and that fail (`hi`) at
 *   `floor((lo + hi) / 2)` until `hi - lo <= resolution`. `resolution = 0` disables bisection.
 * - A fail at the very first step bisects between 0 and `start` (0 = "nothing passes"), so the
 *   result can be anything in `[0, start - 1]`; 0 means even the smallest probed load failed.
 * - An invalid step (loadgen saturated, interference, placement, ...) is retried once at the same
 *   player count; a second consecutive invalid result stops the search with `invalidLimited` (and
 *   `loadgenLimited` when both were loadgen saturation) and the highest pass so far.
 * - Result: highest passing player count below the lowest fail.
 */
/**
 * `hi`: lowest failing player count (undefined if nothing failed). `lo`: highest passing count
 * below `hi` (0 if none). Invalid steps are ignored.
 */
export function searchBounds (history: readonly SearchStep[]): { lo: number, hi: number | undefined } {
  let hi: number | undefined
  for (const h of history) {
    if (h.outcome === 'fail' && (hi === undefined || h.players < hi)) hi = h.players
  }
  let lo = 0
  for (const h of history) {
    if (h.outcome === 'pass' && h.players > lo && (hi === undefined || h.players < hi)) lo = h.players
  }
  return { lo, hi }
}

export function planNext (state: SearchState): SearchDecision {
  const { ramp, history } = state
  if (!(ramp.start >= 1 && ramp.step >= 1 && ramp.max >= ramp.start && ramp.resolution >= 0)) {
    throw new Error(`invalid ramp: ${JSON.stringify(ramp)}`)
  }

  const { lo, hi } = searchBounds(history)
  const phase: SearchPhase = hi === undefined ? 'ramp' : 'bisect'

  // Invalid handling: retry once, then stop.
  const last = history.at(-1)
  if (last !== undefined && last.outcome === 'invalid') {
    const prev = history.at(-2)
    if (prev !== undefined && prev.outcome === 'invalid' && prev.players === last.players) {
      const rs = (h: SearchStep): readonly string[] => h.reasons ?? [LOADGEN_SATURATED_REASON]
      const sat = (h: SearchStep): boolean => rs(h).includes(LOADGEN_SATURATED_REASON)
      const d: SearchDone = {
        done: true,
        maxPlayers: lo,
        capped: false,
        loadgenLimited: sat(prev) && sat(last),
        invalidLimited: true,
        invalidReasons: [...new Set([...rs(prev), ...rs(last)])]
      }
      if (hi !== undefined) d.firstFail = hi
      return d
    }
    return { done: false, players: last.players, phase, retry: true }
  }

  if (hi === undefined) {
    // Ramp phase.
    const passes = history.filter(h => h.outcome === 'pass')
    if (passes.length === 0) return { done: false, players: ramp.start, phase: 'ramp', retry: false }
    const lastPass = passes.at(-1)!.players
    if (lastPass >= ramp.max) return { done: true, maxPlayers: lo, capped: true, loadgenLimited: false, invalidLimited: false }
    return { done: false, players: Math.min(lastPass + ramp.step, ramp.max), phase: 'ramp', retry: false }
  }

  if (ramp.resolution === 0 || hi - lo <= Math.max(ramp.resolution, 1)) {
    return { done: true, maxPlayers: lo, capped: false, loadgenLimited: false, invalidLimited: false, firstFail: hi }
  }
  return { done: false, players: Math.floor((lo + hi) / 2), phase: 'bisect', retry: false }
}
