/** Origin of a time-series record. */
export type Source = 'probe' | 'sys' | 'bot' | 'bds' | 'orch'

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
  botStats: 'bot.stats',
  bdsLog: 'bds.log',
  bdsEvent: 'bds.event',
  stepStart: 'orch.step.start',
  stepEnd: 'orch.step.end',
  runStart: 'orch.run.start',
  runEnd: 'orch.run.end'
} as const
