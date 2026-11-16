import type { StepResult } from '@bedperf/core'
import { stepOutcome } from './criteria.ts'

const num = (v: number | undefined, d: number): string => v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d)

/** Plain-text table of steps, one row per step, for logs and CLI output. */
export function formatStepsTable (steps: readonly StepResult[]): string {
  const header = ['rep', 'idx', 'phase', 'players', 'tps avg', 'tps min', 'ctr tps', 'int p99', 'mt util', 'cpu/tick', 'settle', 'fails', 'result', 'reasons']
  const rows = steps.map(s => [
    String(s.repeat),
    String(s.index),
    s.phase,
    String(s.players),
    num(s.tps.mean, 2),
    num(s.tps.min, 2),
    num(s.counterTps, 2),
    num(s.tickIntervalMs.p99, 1),
    num(s.mainThreadUtil?.mean, 2),
    num(s.tickCpuMsPerTick, 1),
    s.settleSec === undefined ? '-' : `${s.settleSec.toFixed(0)}s${s.settleCapped === true ? '!' : ''}`,
    String(s.botFailures),
    stepOutcome(s),
    [...s.failReasons, ...(s.invalidReasons ?? []).filter(r => !s.failReasons.includes(r))].join('; ')
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
  const line = (cells: string[]): string => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(header), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n')
}
