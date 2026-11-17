// Agent machine telemetry: turn sysmon interference samples into `AgentTelemetry` with a saturation verdict.
import { readFileSync } from 'node:fs'
import type { AgentTelemetry, InterferenceSample } from '@bedperf/core'
import { parseNetDev } from '@bedperf/sysmon'

export interface AgentSaturationThresholds {
  /** Whole-machine busy CPU above this fraction of the logical CPUs marks the agent saturated. Default 0.9. */
  busyFraction: number
  /** Foreign (not agent, not bot) load above this many cores marks the agent saturated. Default 1. */
  foreignCores: number
}

export const DEFAULT_AGENT_SATURATION: AgentSaturationThresholds = { busyFraction: 0.9, foreignCores: 1 }

/** Machine-wide network byte counters (non-loopback interfaces), or undefined when not cheaply readable. */
export type NetCounterReader = () => { rxBytes: number, txBytes: number } | undefined

/** Linux: sum of /proc/net/dev over non-loopback interfaces. Elsewhere: undefined. */
export function defaultNetCounters (): { rxBytes: number, txBytes: number } | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const c = parseNetDev(readFileSync('/proc/net/dev', 'utf8'))
    return c.reduce((a, x) => ({ rxBytes: a.rxBytes + x.rxBytes, txBytes: a.txBytes + x.txBytes }), { rxBytes: 0, txBytes: 0 })
  } catch {
    return undefined
  }
}

/** One telemetry sample (without `agent`, which the orchestrator sets) from a machine-sampler sample. */
export function telemetryFromSample (
  s: InterferenceSample,
  thresholds: AgentSaturationThresholds = DEFAULT_AGENT_SATURATION,
  net?: { rxBytesPerSec: number, txBytesPerSec: number }
): Omit<AgentTelemetry, 'agent'> {
  const logical = s.cpuBusy.length
  const reasons: string[] = []
  if (logical > 0 && s.busyCores > thresholds.busyFraction * logical) {
    reasons.push(`machine CPU busy ${s.busyCores.toFixed(1)} of ${logical} cores (> ${Math.round(thresholds.busyFraction * 100)}%)`)
  }
  if (s.foreignCores > thresholds.foreignCores) {
    reasons.push(`foreign load ${s.foreignCores.toFixed(2)} cores (> ${thresholds.foreignCores})`)
  }
  const out: Omit<AgentTelemetry, 'agent'> = {
    intervalMs: s.intervalMs,
    busyCores: round3(s.busyCores),
    botCores: round3(s.groups.bots),
    foreignCores: round3(s.foreignCores),
    logicalCpus: logical,
    saturated: reasons.length > 0,
    reasons
  }
  if (net) {
    out.netRxBytesPerSec = Math.round(net.rxBytesPerSec)
    out.netTxBytesPerSec = Math.round(net.txBytesPerSec)
  }
  return out
}

function round3 (x: number): number {
  return Math.round(x * 1000) / 1000
}
