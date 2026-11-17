// Remote bot agents as the engine sees them (distributed runs): a pool of `bedperf agent`s that is
// reconnected between repeats when one was lost, its topology for meta.json, and a fan-out of agent
// telemetry / link events to whichever run is measuring. The real pool is @bedperf/agent `connectAgents`;
// the simulation provides its own.
import { createHash } from 'node:crypto'
import {
  DEFAULT_AGENT_PORT, topologySha256,
  type AgentIdleCheckResult, type AgentInfo, type AgentLinkEvent, type AgentLinkStats, type AgentSpec, type AgentTelemetry, type TopologyMeta
} from '@bedperf/core'

/** One connected agent (structurally @bedperf/agent `AgentHandle`). */
export interface AgentHandleLike {
  readonly name: string
  readonly spec: AgentSpec
  readonly info: AgentInfo
  readonly weight: number
  readonly maxBots: number | undefined
  readonly alive: boolean
  readonly lostReason: string | undefined
}

/** What the engine needs from an agent pool (structurally @bedperf/agent `AgentPool`). */
export interface AgentPoolLike {
  readonly agents: readonly AgentHandleLike[]
  measureLink (n?: number): Promise<Record<string, AgentLinkStats>>
  idleCheckAll (o?: { durationSec?: number, thresholds?: Record<string, number> }): Promise<Record<string, AgentIdleCheckResult>>
  startTelemetry (intervalMs: number): void
  close (): Promise<void>
}

/** Telemetry and link events of a pool (`connectAgents` `onTelemetry` / `onLink`). */
export interface AgentEvents {
  telemetry (t: AgentTelemetry): void
  link (e: AgentLinkEvent): void
}

export interface EngineAgentsOptions<P extends AgentPoolLike> {
  specs: readonly AgentSpec[]
  /** Address the agents' bots dial to reach the server. */
  botTargetHost: string
  /** Connect and authenticate every agent; events of the pool go to `events`. Rejects when any agent fails. */
  connect (events: AgentEvents): Promise<P>
  /** Pings per agent for the link baseline after each (re)connect. Default 10. */
  linkPings?: number
  /** Run the idle check on every agent with the server machine's idle gate. Default true. */
  idleCheck?: boolean
}

/** Link events kept while no run listens (e.g. between repeats), replayed into the next repeat. */
const MAX_PENDING_LINK_EVENTS = 200

/** sha256(address) prefix recorded instead of the agent's address. */
export function agentAddressId (address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 16)
}

/** `meta.topology` of a run whose bots ran on the server machine. */
export function localTopology (): TopologyMeta {
  return { mode: 'local', agents: [], sha256: topologySha256({ mode: 'local', agents: [] }) }
}

/** Host part of `host:port`, `[v6]:port` or a bare host. */
export function addressHost (address: string): string {
  const a = address.trim()
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(a)
  if (v6 !== null) return v6[1]!
  const colons = a.split(':').length - 1
  if (colons === 1) return a.slice(0, a.lastIndexOf(':'))
  return a
}

/** Loopback host name or address (no DNS lookup). */
export function isLoopbackHost (host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /^::ffff:127\./.test(h)
}

/**
 * The address remote bots dial. Without `botTargetHost` it is derivable only when every agent runs on
 * this machine (loopback addresses): `127.0.0.1`. A loopback target with agents on other machines is an
 * error, since their bots could not reach the server.
 */
export function resolveBotTargetHost (specs: readonly AgentSpec[], botTargetHost: string | undefined): string {
  const remote = specs.filter(s => !isLoopbackHost(addressHost(s.address)))
  if (botTargetHost === undefined || botTargetHost.trim() === '') {
    if (remote.length === 0) return '127.0.0.1'
    throw new Error(`--bot-target-host is required with agents on other machines (${remote.map(s => s.address).join(', ')}): the address of this machine their bots dial to reach the server`)
  }
  const h = botTargetHost.trim()
  if (isLoopbackHost(h) && remote.length > 0) {
    throw new Error(`--bot-target-host ${h} is a loopback address, but agent(s) ${remote.map(s => s.address).join(', ')} run on other machines and their bots could not reach the server; pass an address of this machine they can reach`)
  }
  return h
}

/**
 * Agent specs from `--agents host:port,...` or a machine profile's `agents` (strings or `AgentSpec`
 * objects). Throws on malformed entries and duplicate addresses.
 */
export function parseAgentSpecs (input: unknown, source = 'agents'): AgentSpec[] {
  const items: unknown[] = typeof input === 'string'
    ? input.split(',').map(s => s.trim()).filter(s => s !== '')
    : Array.isArray(input) ? input : (() => { throw new Error(`${source}: expected a list of agents`) })()
  const out: AgentSpec[] = []
  const seen = new Set<string>()
  for (const [i, it] of items.entries()) {
    const where = `${source}[${i}]`
    const spec: AgentSpec = typeof it === 'string' ? { address: it.trim() } : parseSpecObject(it, where)
    if (!/^(\[[0-9a-fA-F:.]+\]|[^\s:[\]]+):\d{1,5}$/.test(spec.address) && !/^[^\s:[\]]+$/.test(spec.address)) {
      throw new Error(`${where}: '${spec.address}' is not host:port`)
    }
    const port = /:(\d+)$/.exec(spec.address)?.[1]
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new Error(`${where}: port ${port} out of range`)
    const key = `${addressHost(spec.address).toLowerCase()}|${port ?? DEFAULT_AGENT_PORT}`
    if (seen.has(key)) throw new Error(`${where}: agent ${spec.address} listed twice`)
    seen.add(key)
    out.push(spec)
  }
  return out
}

function parseSpecObject (it: unknown, where: string): AgentSpec {
  if (it === null || typeof it !== 'object' || Array.isArray(it)) throw new Error(`${where}: expected "host:port" or {address, name?, weight?, maxBots?}`)
  const o = it as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['address', 'name', 'weight', 'maxBots'].includes(k)) throw new Error(`${where}: unknown key '${k}'`)
  if (typeof o['address'] !== 'string' || o['address'].trim() === '') throw new Error(`${where}: address must be "host:port"`)
  const spec: AgentSpec = { address: o['address'].trim() }
  if (o['name'] !== undefined) {
    if (typeof o['name'] !== 'string' || o['name'] === '') throw new Error(`${where}: name must be a non-empty string`)
    spec.name = o['name']
  }
  if (o['weight'] !== undefined) {
    if (typeof o['weight'] !== 'number' || !(o['weight'] > 0)) throw new Error(`${where}: weight must be a positive number`)
    spec.weight = o['weight']
  }
  if (o['maxBots'] !== undefined) {
    if (typeof o['maxBots'] !== 'number' || !Number.isInteger(o['maxBots']) || o['maxBots'] < 1) throw new Error(`${where}: maxBots must be a positive integer`)
    spec.maxBots = o['maxBots']
  }
  return spec
}

/**
 * The agents of a distributed run. `ensure()` connects (once, or again after an agent was lost) and
 * measures the links; runs `subscribe` to the pool's events while a repeat is measuring.
 */
export class EngineAgents<P extends AgentPoolLike = AgentPoolLike> {
  readonly specs: readonly AgentSpec[]
  readonly botTargetHost: string
  readonly idleCheck: boolean
  private readonly opts: EngineAgentsOptions<P>
  private current: P | undefined
  private connecting: Promise<P> | undefined
  private link: Record<string, AgentLinkStats> = {}
  private readonly subs = new Set<Partial<AgentEvents>>()
  private pending: AgentLinkEvent[] = []
  private closed = false

  constructor (opts: EngineAgentsOptions<P>) {
    if (opts.specs.length === 0) throw new Error('EngineAgents: no agents given')
    this.opts = opts
    this.specs = opts.specs
    this.botTargetHost = opts.botTargetHost
    this.idleCheck = opts.idleCheck ?? true
  }

  /** The connected pool, if any. */
  get pool (): P | undefined { return this.current }

  /** Agents of the current pool whose link is gone. */
  lost (): Array<{ name: string, reason: string | undefined }> {
    return (this.current?.agents ?? []).filter(a => !a.alive).map(a => ({ name: a.name, reason: a.lostReason }))
  }

  /** The live pool: connects on first use and reconnects every agent when one was lost. Rejects when any agent fails. */
  async ensure (): Promise<P> {
    if (this.closed) throw new Error('agents closed')
    const cur = this.current
    if (cur !== undefined && cur.agents.every(a => a.alive)) return cur
    if (this.connecting !== undefined) return await this.connecting
    this.connecting = (async () => {
      this.current = undefined
      if (cur !== undefined) await cur.close().catch(() => {})
      const events: AgentEvents = { telemetry: t => { this.emitTelemetry(t) }, link: e => { this.emitLink(e) } }
      const p = await this.opts.connect(events)
      try {
        this.link = await p.measureLink(this.opts.linkPings ?? 10)
      } catch (err) {
        await p.close().catch(() => {})
        throw err
      }
      this.current = p
      return p
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /** meta.json `topology` of the connected pool (call after `ensure`). */
  topology (): TopologyMeta {
    const p = this.current
    if (p === undefined) throw new Error('agents not connected')
    const agents: TopologyMeta['agents'] = p.agents.map(a => {
      const x: TopologyMeta['agents'][number] = {
        name: a.name,
        addressId: agentAddressId(a.spec.address),
        machine: a.info.machine,
        harness: a.info.harness,
        cpus: a.info.cpus,
        weight: a.weight
      }
      if (a.maxBots !== undefined) x.maxBots = a.maxBots
      const l = this.link[a.name]
      if (l !== undefined) x.link = l
      if (a.info.placement !== undefined) x.placement = a.info.placement
      return x
    })
    return { mode: 'remote', botTargetHost: this.botTargetHost, agents, sha256: topologySha256({ mode: 'remote', agents }) }
  }

  /** Link events that arrived while nobody listened (connects, link stats, losses between repeats); clears them. */
  takePending (): AgentLinkEvent[] {
    const out = this.pending
    this.pending = []
    return out
  }

  /** Receive the pool's events until the returned function is called. */
  subscribe (h: Partial<AgentEvents>): () => void {
    this.subs.add(h)
    return () => { this.subs.delete(h) }
  }

  /** Close the pool (agents kill their workers). */
  async close (): Promise<void> {
    this.closed = true
    // a connect in flight would otherwise leave its pool open
    if (this.connecting !== undefined) await this.connecting.catch(() => {})
    const p = this.current
    this.current = undefined
    await p?.close()
  }

  private emitTelemetry (t: AgentTelemetry): void {
    for (const s of [...this.subs]) s.telemetry?.(t)
  }

  private emitLink (e: AgentLinkEvent): void {
    const ls = [...this.subs].filter(s => s.link !== undefined)
    if (ls.length === 0) {
      this.pending.push(e)
      if (this.pending.length > MAX_PENDING_LINK_EVENTS) this.pending.splice(0, this.pending.length - MAX_PENDING_LINK_EVENTS)
      return
    }
    for (const s of ls) s.link!(e)
  }
}
