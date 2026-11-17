import type { AgentFleetSlice } from '@bedperf/core'
import { downsample, num } from './math.ts'
import { cpuList } from './provenance.ts'
import type { AgentSeries, AgentStepRow, AgentView, RunData, StepRow, TopologyView } from './types.ts'

/** Most points per agent telemetry series. */
const AGENT_SERIES_POINTS = 1200

function obj (v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function str (v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function linkOf (v: unknown): AgentView['link'] {
  const stats = obj(v)
  const rtt = obj(stats?.rttMs)
  const median = num(rtt?.median)
  if (stats === undefined || median === undefined) return undefined
  const out: NonNullable<AgentView['link']> = { rttMedianMs: median, rttMinMs: num(rtt?.min) ?? median, rttMaxMs: num(rtt?.max) ?? median, n: num(rtt?.n) ?? 0 }
  const off = num(stats.clockOffsetMs)
  if (off !== undefined) out.clockOffsetMs = off
  return out
}

function emptyAgent (name: string): AgentView {
  return { name, samples: 0, saturatedSamples: 0, saturatedReasons: [], lost: 0 }
}

/**
 * Reads meta.json `topology` and the agent envelopes. Runs without a topology (older runs) are
 * local. Series x values are seconds from `t0` (the timeline origin).
 */
export function topologyViewOf (run: RunData, rows: readonly StepRow[], t0: number): TopologyView {
  const t = obj(run.meta.topology)
  const mode = t?.mode === 'remote' ? 'remote' : 'local'
  const sec = (x: number): number => (x - t0) / 1000
  const agents: AgentView[] = []
  const byName = new Map<string, AgentView>()
  const agentOf = (name: string): AgentView => {
    let a = byName.get(name)
    if (a === undefined) {
      a = emptyAgent(name)
      agents.push(a)
      byName.set(name, a)
    }
    return a
  }
  for (const raw of Array.isArray(t?.agents) ? t.agents : []) {
    const o = obj(raw)
    const name = str(o?.name)
    if (o === undefined || name === undefined) continue
    const a = agentOf(name)
    const m = obj(o.machine)
    const set = <K extends keyof AgentView>(k: K, v: AgentView[K] | undefined): void => { if (v !== undefined) a[k] = v }
    set('addressId', str(o.addressId))
    set('fingerprint', str(m?.fingerprint))
    set('cpuModel', str(m?.cpuModel))
    set('logical', num(m?.logical))
    set('physical', num(m?.physical))
    set('ramGiB', num(m?.ramGiB))
    set('os', str(m?.os))
    set('cpus', num(o.cpus))
    set('weight', num(o.weight))
    set('maxBots', num(o.maxBots))
    set('link', linkOf(o.link))
    const pl = obj(o.placement)
    if (typeof pl?.verified === 'boolean') a.placementVerified = pl.verified
    set('botCpus', cpuList(pl?.botCpus))
  }

  // Telemetry: per-agent series and merged saturated intervals.
  const raw = new Map<string, { busy: Array<[number, number]>, bot: Array<[number, number]>, foreign: Array<[number, number]>, saturated: Array<[number, number]>, reasons: Set<string> }>()
  for (const { t: at, data } of run.agentTelemetry) {
    const a = agentOf(data.agent)
    let s = raw.get(data.agent)
    if (s === undefined) {
      s = { busy: [], bot: [], foreign: [], saturated: [], reasons: new Set() }
      raw.set(data.agent, s)
    }
    a.samples++
    const x = sec(at)
    s.busy.push([x, data.busyCores])
    const bot = num(data.botCores)
    if (bot !== undefined) s.bot.push([x, bot])
    const foreign = num(data.foreignCores)
    if (foreign !== undefined) s.foreign.push([x, foreign])
    if (data.saturated === true) {
      a.saturatedSamples++
      for (const r of Array.isArray(data.reasons) ? data.reasons : []) if (typeof r === 'string' && r !== '') s.reasons.add(r)
      const x0 = x - (num(data.intervalMs) ?? 1000) / 1000
      const last = s.saturated.at(-1)
      // Adjacent saturated samples (within half an interval) form one interval.
      if (last !== undefined && x0 <= last[1] + (x - x0) / 2) last[1] = x
      else s.saturated.push([x0, x])
    }
  }
  const series: AgentSeries[] = []
  for (const [agent, s] of raw) {
    byName.get(agent)!.saturatedReasons = [...s.reasons]
    series.push({
      agent,
      busy: downsample(s.busy, AGENT_SERIES_POINTS, 'max'),
      bot: downsample(s.bot, AGENT_SERIES_POINTS, 'max'),
      foreign: downsample(s.foreign, AGENT_SERIES_POINTS, 'max'),
      saturated: s.saturated
    })
  }

  // Link events; the last `stats` event fills in a link baseline meta.json does not have.
  const links: TopologyView['links'] = []
  for (const { t: at, data } of run.agentLink) {
    const a = agentOf(data.agent)
    if (data.event === 'stats') {
      if (a.link === undefined || !hasMetaLink(t, data.agent)) {
        const l = linkOf(data.stats)
        if (l !== undefined) a.link = l
      }
      continue
    }
    if (data.event === 'lost') a.lost++
    const mark: TopologyView['links'][number] = { x: sec(at), agent: data.agent, event: data.event }
    if (typeof data.reason === 'string' && data.reason !== '') mark.reason = data.reason
    links.push(mark)
  }

  // Per step: the hold window's per-agent fleet slices.
  const steps: AgentStepRow[] = []
  for (const r of rows) {
    const per = new Map<string, AgentStepRow['agents'][number]>()
    for (const b of run.bot) {
      if (b.t < r.startT || b.t > r.endT) continue
      const slices = b.data.loadgen?.agents
      if (!Array.isArray(slices)) continue
      for (const sl of slices as AgentFleetSlice[]) {
        if (obj(sl) === undefined || typeof sl.agent !== 'string') continue
        let cur = per.get(sl.agent)
        if (cur === undefined) {
          cur = { agent: sl.agent, bots: 0, saturated: false }
          per.set(sl.agent, cur)
        }
        cur.bots = Math.max(cur.bots, num(sl.bots) ?? 0)
        const cores = num(sl.totalCores)
        if (cores !== undefined) cur.maxTotalCores = Math.max(cur.maxTotalCores ?? 0, cores)
        const lag = num(sl.eventLoopLagP99Ms)
        if (lag !== undefined) cur.maxLagP99Ms = Math.max(cur.maxLagP99Ms ?? 0, lag)
        if (sl.saturated === true) cur.saturated = true
      }
    }
    if (per.size > 0) steps.push({ repeat: r.repeat, index: r.index, players: r.players, agents: [...per.values()].sort((a, b) => a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0) })
  }
  for (const s of steps) for (const a of s.agents) agentOf(a.agent)

  const view: TopologyView = { mode, recorded: t !== undefined, agents, series, links, steps }
  const sha = str(t?.sha256)
  if (sha !== undefined) view.sha256 = sha
  const host = str(t?.botTargetHost)
  if (host !== undefined) view.botTargetHost = host
  return view
}

/** The agent reported itself saturated (telemetry) or its fleet slice was saturated in a step's hold. */
export function agentSaturated (t: TopologyView, name: string): boolean {
  return t.agents.some((a) => a.name === name && a.saturatedSamples > 0) || t.steps.some((s) => s.agents.some((a) => a.agent === name && a.saturated))
}

/** Agents that were saturated or lost their connection during the run. */
export function troubledAgents (t: TopologyView | undefined): string[] {
  return (t?.agents ?? []).filter((a) => a.lost > 0 || agentSaturated(t!, a.name)).map((a) => a.name)
}

function hasMetaLink (t: Record<string, unknown> | undefined, name: string): boolean {
  const agents = Array.isArray(t?.agents) ? t.agents : []
  return agents.some((a) => obj(a)?.name === name && linkOf(obj(a)?.link) !== undefined)
}
