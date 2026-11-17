// Orchestrator side: connect to agents, authenticate, measure the links and hand BotFleet a WorkerFactory whose
// workers run on the agents.
import { connect as netConnect, type Socket } from 'node:net'
import {
  AGENT_PROTOCOL_VERSION, DEFAULT_AGENT_PORT, harnessInfo,
  type AgentIdleCheckResult, type AgentInfo, type AgentLinkEvent, type AgentLinkStats, type AgentSpec, type AgentTelemetry,
  type ControllerFrame
} from '@bedperf/core'
import type { BotFleetOptions, ControllerMessage, WorkerFactory, WorkerLink, WorkerMessage } from '@bedperf/loadgen'
import pkg from '../package.json' with { type: 'json' }
import { authMac, frameLink, parseAddress, type FrameLink } from './frames.ts'

export interface ConnectAgentsOptions {
  /** Shared secret (normally from `AGENT_TOKEN_ENV`). */
  token: string
  /** Connect + authenticate deadline per agent; also the ping timeout of `measureLink`, ms. Default 10000. */
  timeoutMs?: number
  /** Our bedperf git commit, checked by agents. Default `harnessInfo().git` of this checkout. */
  harnessGit?: string
  /** Heartbeat ping period, ms. Default 2000. */
  heartbeatMs?: number
  /** An agent silent this long is declared lost (its workers exit), ms. Default 10000. */
  lostAfterMs?: number
  log?: (line: string) => void
  onTelemetry?: (t: AgentTelemetry) => void
  onLink?: (e: AgentLinkEvent) => void
  /** Socket factory (tests). Default `net.connect`. */
  connect?: (host: string, port: number) => Socket
}

/** One connected agent. */
export interface AgentHandle {
  /** Unique within the pool: spec name, else the agent's own name (suffixed `-2`, `-3` on collision). */
  readonly name: string
  readonly spec: AgentSpec
  readonly info: AgentInfo
  readonly weight: number
  readonly maxBots: number | undefined
  /** False once the control link is gone. */
  readonly alive: boolean
  readonly lostReason: string | undefined
  /** Live workers this pool runs on the agent. */
  readonly workers: number
}

export interface AgentPool {
  readonly agents: readonly AgentHandle[]
  /** Agent info by pool name. */
  info (): Record<string, AgentInfo>
  /** `n` sequential pings per agent (in parallel across agents): RTT and clock offset. Emits `onLink` `stats`. */
  measureLink (n?: number): Promise<Record<string, AgentLinkStats>>
  /** Run the idle check on every live agent's machine. */
  idleCheckAll (o?: { durationSec?: number, thresholds?: Record<string, number> }): Promise<Record<string, AgentIdleCheckResult>>
  /** Ask every live agent for telemetry every `intervalMs` (0 stops); samples arrive via `onTelemetry`. */
  startTelemetry (intervalMs: number): void
  /**
   * A loadgen WorkerFactory placing each new worker on the live agent with the lowest (workers + 1) / weight that
   * still has capacity (floor(maxBots / botsPerWorker) workers). Links carry `agent` and no `pid`. With no agent
   * available the link exits at once (the fleet counts its bots as join failures).
   */
  workerFactory (): WorkerFactory
  /** Send `bye` to every agent and close the links (remaining workers exit with code null). */
  close (): Promise<void>
}

class RemoteWorker implements WorkerLink {
  readonly agent: string
  private readonly conn: AgentConn | undefined
  readonly wire: number
  private msgCbs: Array<(m: WorkerMessage) => void> = []
  private exitCbs: Array<(code: number | null) => void> = []
  private buffered: WorkerMessage[] = []
  exited = false
  private exitCode: number | null = null

  constructor (agent: string, conn: AgentConn | undefined, wire: number) {
    this.agent = agent
    this.conn = conn
    this.wire = wire
  }

  send (msg: ControllerMessage): void {
    if (this.exited || !this.conn?.alive) throw new Error(`agent ${this.agent}: worker link down`)
    if (!this.conn.send({ type: 'worker', workerId: this.wire, msg })) throw new Error(`agent ${this.agent}: send failed`)
  }

  onMessage (cb: (m: WorkerMessage) => void): void {
    this.msgCbs.push(cb)
    const b = this.buffered
    this.buffered = []
    for (const m of b) cb(m)
  }

  onExit (cb: (code: number | null) => void): void {
    if (this.exited) { const c = this.exitCode; setImmediate(() => cb(c)); return }
    this.exitCbs.push(cb)
  }

  kill (): void {
    if (this.exited) return
    if (this.conn?.alive) this.conn.send({ type: 'kill', workerId: this.wire })
  }

  deliver (m: WorkerMessage): void {
    if (this.exited) return
    if (this.msgCbs.length === 0) { this.buffered.push(m); return }
    for (const cb of this.msgCbs) cb(m)
  }

  fireExit (code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const cb of this.exitCbs) {
      try { cb(code) } catch {}
    }
  }
}

interface Pending<T> { resolve (v: T): void, reject (e: Error): void, timer: NodeJS.Timeout }

class AgentConn implements AgentHandle {
  name: string
  readonly spec: AgentSpec
  readonly info: AgentInfo
  readonly weight: number
  readonly maxBots: number | undefined
  alive = true
  lostReason: string | undefined
  lastRx = performance.now()
  readonly link: FrameLink
  readonly remote = new Map<number, RemoteWorker>()
  readonly pings = new Map<number, Pending<number>>()
  readonly idles = new Map<number, Pending<AgentIdleCheckResult>>()
  closing = false

  constructor (spec: AgentSpec, info: AgentInfo, link: FrameLink) {
    this.spec = spec
    this.info = info
    this.name = spec.name ?? info.name
    this.weight = spec.weight !== undefined && spec.weight > 0 ? spec.weight : 1
    this.maxBots = spec.maxBots
    this.link = link
  }

  get workers (): number { return [...this.remote.values()].filter(w => !w.exited).length }

  send (f: ControllerFrame): boolean { return this.alive && this.link.send(f) }
}

type Frame = { type: string } & Record<string, unknown>

/** Connect + authenticate one agent; resolves with its info and a link whose frames go to `onFrame` afterwards. */
function handshake (
  spec: AgentSpec, o: Required<Pick<ConnectAgentsOptions, 'token' | 'timeoutMs'>> & { harnessGit: string | undefined, connect: (h: string, p: number) => Socket }
): Promise<{ info: AgentInfo, link: FrameLink, setHandlers (onFrame: (f: Frame) => void, onClose: (r: string) => void): void }> {
  const { host, port } = parseAddress(spec.address, DEFAULT_AGENT_PORT)
  return new Promise((resolve, reject) => {
    let frameHandler: ((f: Frame) => void) | undefined
    let closeHandler: ((r: string) => void) | undefined
    let settled = false
    const fail = (msg: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      link.close(msg)
      reject(new Error(`agent ${spec.address}: ${msg}`))
    }
    const socket = o.connect(host, port)
    const timer = setTimeout(() => fail(`no hello within ${o.timeoutMs} ms`), o.timeoutMs)
    const link = frameLink(socket, {
      onFrame: f => {
        if (frameHandler) { frameHandler(f); return }
        if (settled) return
        if (f.type === 'challenge') {
          if (f.protocol !== AGENT_PROTOCOL_VERSION) { fail(`protocol mismatch: agent ${String(f.protocol)}, controller ${AGENT_PROTOCOL_VERSION}`); return }
          if (typeof f.nonce !== 'string' || f.nonce.length < 16) { fail('bad challenge'); return }
          const auth: ControllerFrame = { type: 'auth', mac: authMac(o.token, f.nonce), protocol: AGENT_PROTOCOL_VERSION }
          if (o.harnessGit !== undefined) auth.harnessGit = o.harnessGit
          link.send(auth)
        } else if (f.type === 'denied') {
          fail(`denied: ${String(f.reason)}`)
        } else if (f.type === 'hello') {
          const info = f.info as AgentInfo | undefined
          if (!info || typeof info.name !== 'string') { fail('malformed hello'); return }
          settled = true
          clearTimeout(timer)
          resolve({
            info,
            link,
            setHandlers (onFrame, onClose) { frameHandler = onFrame; closeHandler = onClose }
          })
        }
      },
      onClose: reason => {
        if (closeHandler) closeHandler(reason)
        else fail(reason)
      }
    })
  })
}

export async function connectAgents (specs: readonly AgentSpec[], opts: ConnectAgentsOptions): Promise<AgentPool> {
  if (specs.length === 0) throw new Error('connectAgents: no agents given')
  const log = opts.log ?? ((l: string) => { process.stderr.write(`[agents] ${l}\n`) })
  const timeoutMs = opts.timeoutMs ?? 10_000
  const heartbeatMs = opts.heartbeatMs ?? 2000
  const lostAfterMs = opts.lostAfterMs ?? 10_000
  const harnessGit = opts.harnessGit ?? (await harnessInfo({ version: pkg.version })).git
  const connect = opts.connect ?? ((host: string, port: number) => netConnect({ host, port }))
  const emitLink = (e: AgentLinkEvent): void => {
    try { opts.onLink?.(e) } catch (err) { log(`onLink threw: ${(err as Error)?.message}`) }
  }

  const results = await Promise.allSettled(specs.map(s => handshake(s, { token: opts.token, timeoutMs, harnessGit, connect })))
  const failed = results.flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : [])
  if (failed.length > 0) {
    for (const r of results) if (r.status === 'fulfilled') { r.value.link.send({ type: 'bye' }); r.value.link.close('connectAgents failed') }
    throw new Error(`could not connect to ${failed.length} of ${specs.length} agent(s):\n  ${failed.join('\n  ')}`)
  }

  const conns: AgentConn[] = []
  const used = new Set<string>()
  let nextId = 1
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const c = new AgentConn(specs[i]!, r.value.info, r.value.link)
    let name = c.name
    for (let k = 2; used.has(name); k++) name = `${c.name}-${k}`
    c.name = name
    used.add(name)
    conns.push(c)
    r.value.setHandlers(f => onFrame(c, f), reason => onClose(c, reason))
  })

  function onFrame (c: AgentConn, f: Frame): void {
    c.lastRx = performance.now()
    switch (f.type) {
      case 'pong': {
        const p = c.pings.get(Number(f.id))
        if (p) { c.pings.delete(Number(f.id)); clearTimeout(p.timer); p.resolve(Number(f.agentTime)) }
        break
      }
      case 'worker': c.remote.get(Number(f.workerId))?.deliver(f.msg as WorkerMessage); break
      case 'exit': {
        const w = c.remote.get(Number(f.workerId))
        if (w) { c.remote.delete(w.wire); w.fireExit(typeof f.code === 'number' ? f.code : null) }
        break
      }
      case 'log': log(`${c.name}${f.workerId !== undefined ? ` w${String(f.workerId)}` : ''}: ${String(f.line)}`); break
      case 'idleCheck': {
        const p = c.idles.get(Number(f.id))
        if (p) { c.idles.delete(Number(f.id)); clearTimeout(p.timer); p.resolve(f.result as AgentIdleCheckResult) }
        break
      }
      case 'telemetry': {
        const s = f.sample as Omit<AgentTelemetry, 'agent'> | undefined
        if (s && typeof s === 'object') {
          try { opts.onTelemetry?.({ ...s, agent: c.name }) } catch (err) { log(`onTelemetry threw: ${(err as Error)?.message}`) }
        }
        break
      }
      default: break // spawned, unknown kinds
    }
  }

  function onClose (c: AgentConn, reason: string): void {
    if (!c.alive) return
    c.alive = false
    c.lostReason = reason
    const err = new Error(`agent ${c.name} link ${c.closing ? 'closed' : 'lost'}: ${reason}`)
    for (const p of c.pings.values()) { clearTimeout(p.timer); p.reject(err) }
    c.pings.clear()
    for (const p of c.idles.values()) { clearTimeout(p.timer); p.reject(err) }
    c.idles.clear()
    const ws = [...c.remote.values()]
    c.remote.clear()
    if (!c.closing) log(`agent ${c.name} lost (${reason})${ws.length > 0 ? `; ${ws.length} worker(s) gone` : ''}`)
    for (const w of ws) w.fireExit(null)
    emitLink({ agent: c.name, event: c.closing ? 'closed' : 'lost', reason })
  }

  for (const c of conns) emitLink({ agent: c.name, event: 'connected' })

  const heartbeat = setInterval(() => {
    const now = performance.now()
    for (const c of conns) {
      if (!c.alive) continue
      if (now - c.lastRx > lostAfterMs) { c.link.close(`no frames for ${Math.round(now - c.lastRx)} ms`); continue }
      c.send({ type: 'ping', id: nextId++ })
    }
  }, heartbeatMs)
  heartbeat.unref()

  function request<T> (c: AgentConn, map: Map<number, Pending<T>>, frame: (id: number) => ControllerFrame, ms: number, what: string): Promise<T> {
    if (!c.alive) return Promise.reject(new Error(`agent ${c.name} is not connected`))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { map.delete(id); reject(new Error(`agent ${c.name}: ${what} timed out after ${ms} ms`)) }, ms)
      map.set(id, { resolve, reject, timer })
      if (!c.send(frame(id))) { map.delete(id); clearTimeout(timer); reject(new Error(`agent ${c.name}: send failed`)) }
    })
  }

  async function measureOne (c: AgentConn, n: number): Promise<AgentLinkStats> {
    const rtts: number[] = []
    let best = Number.POSITIVE_INFINITY
    let offset = 0
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      const wall0 = Date.now()
      const agentTime = await request(c, c.pings, id => ({ type: 'ping', id }), timeoutMs, 'ping')
      const rtt = performance.now() - t0
      rtts.push(rtt)
      if (rtt < best) { best = rtt; offset = agentTime - (wall0 + rtt / 2) }
    }
    const sorted = [...rtts].sort((a, b) => a - b)
    const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
    const r = (x: number): number => Math.round(x * 1000) / 1000
    return { rttMs: { min: r(sorted[0]!), median: r(mid), max: r(sorted.at(-1)!), n: sorted.length }, clockOffsetMs: Math.round(offset) }
  }

  let closed = false
  return {
    agents: conns,
    info () { return Object.fromEntries(conns.map(c => [c.name, c.info])) },
    async measureLink (n = 10) {
      const live = conns.filter(c => c.alive)
      const stats = await Promise.all(live.map(c => measureOne(c, Math.max(1, n))))
      const out: Record<string, AgentLinkStats> = {}
      live.forEach((c, i) => {
        out[c.name] = stats[i]!
        emitLink({ agent: c.name, event: 'stats', stats: stats[i]! })
      })
      return out
    },
    async idleCheckAll (o = {}) {
      const durationSec = o.durationSec ?? 15
      const live = conns.filter(c => c.alive)
      const res = await Promise.all(live.map(c => request(c, c.idles,
        id => ({ type: 'idleCheck', id, durationSec, thresholds: o.thresholds ?? {} }), durationSec * 2000 + 30_000, 'idle check')))
      return Object.fromEntries(live.map((c, i) => [c.name, res[i]!]))
    },
    startTelemetry (intervalMs) {
      for (const c of conns) c.send({ type: 'telemetry', intervalMs })
    },
    workerFactory () {
      let wire = 1
      return (workerId: number, fo: BotFleetOptions): WorkerLink => {
        const bpw = Math.max(1, fo.botsPerWorker)
        let pick: AgentConn | undefined
        let score = Number.POSITIVE_INFINITY
        for (const c of conns) {
          if (!c.alive || closed) continue
          const cap = c.maxBots === undefined ? Number.POSITIVE_INFINITY : Math.floor(c.maxBots / bpw)
          const n = c.workers
          if (n >= cap) continue
          const s = (n + 1) / c.weight
          if (s < score) { score = s; pick = c }
        }
        if (!pick) {
          log(`no agent available for worker ${workerId} (all lost or at capacity)`)
          const dead = new RemoteWorker('none', undefined, 0)
          dead.fireExit(null)
          return dead
        }
        const w = new RemoteWorker(pick.name, pick, wire++)
        pick.remote.set(w.wire, w)
        if (!pick.send({ type: 'spawn', workerId: w.wire })) {
          pick.remote.delete(w.wire)
          w.fireExit(null)
        }
        return w
      }
    },
    async close () {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      for (const c of conns) {
        if (!c.alive) continue
        c.closing = true
        c.send({ type: 'bye' })
      }
      // give the byes a moment to flush, then close
      await new Promise(resolve => setTimeout(resolve, 50))
      for (const c of conns) c.link.close('pool closed')
    }
  }
}
