/** Origin of a time-series record. */
export type Source = 'probe' | 'sys' | 'bot' | 'bds' | 'orch' | 'agent'

/**
 * One line of `samples.jsonl` in a run directory. Every collector wraps its
 * payload in an envelope so all streams can be merged and replayed in time order.
 */
export interface Envelope<K extends string = string, D = unknown> {
  /** Wall-clock time in epoch milliseconds when the record was produced/received. */
  t: number
  src: Source
  /** Record kind, e.g. 'probe.sample', 'sys.sample', 'bot.stats', 'orch.step.start'. */
  kind: K
  data: D
}

export function envelope<K extends string, D> (src: Source, kind: K, data: D, t: number = Date.now()): Envelope<K, D> {
  return { t, src, kind, data }
}

/** Well-known envelope kinds. Producers may add more; consumers must ignore unknown kinds. */
export const Kinds = {
  probeSample: 'probe.sample',
  probeMark: 'probe.mark',
  probePong: 'probe.pong',
  sysSample: 'sys.sample',
  sysInterference: 'sys.interference',
  botStats: 'bot.stats',
  bdsLog: 'bds.log',
  bdsEvent: 'bds.event',
  /** `GametimeSample` from the `time query gametime` tick-counter sampler. */
  bdsGametime: 'bds.gametime',
  /** `AgentTelemetry` from a remote bot agent's machine. */
  agentTelemetry: 'agent.telemetry',
  /** `AgentLinkEvent`: agent connected / lost / link stats. */
  agentLink: 'agent.link',
  stepStart: 'orch.step.start',
  stepEnd: 'orch.step.end',
  runStart: 'orch.run.start',
  runEnd: 'orch.run.end'
} as const
