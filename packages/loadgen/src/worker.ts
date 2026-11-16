// Worker process of the bot fleet: owns a group of bedboo bots, runs the scenario on each, and reports bot
// events and interval stats to the controller over IPC (see protocol.ts). Started by BotFleet via
// child_process.fork; never import this module from the controller.
import { createRequire } from 'node:module'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { Bot, BotOptions } from 'bedboo'
import type { Scenario, ScenarioContext } from '@bedperf/core'
import type { ControllerMessage, WorkerInit, WorkerMessage } from './protocol.ts'
import { botRandom, isSampled } from './rng.ts'
import { ViewTracker, type BotViewSample } from './view.ts'

const require = createRequire(import.meta.url)

/** bedboo internals used for metrics; every access is guarded since none of this is public API. */
interface BotInternals {
  _bedrock?: {
    physics?: { stats?: () => { corrections?: number } }
    commands?: { request?: (cmd: string, opts?: { timeout?: number }) => Promise<{ success_count?: number } | undefined> }
  }
  _client?: ClientInternals
  game?: { dimension?: string, serverViewDistance?: number }
}

interface ClientInternals {
  handle?: (buf: Buffer) => unknown
  on?: (event: string, listener: (...args: any[]) => void) => unknown
  queue?: (name: string, params: unknown) => unknown
  write?: (name: string, params: unknown) => unknown
}

interface BotState {
  index: number
  seq: number
  bot: Bot | null
  phase: 'joining' | 'spawned'
  endRequested: boolean
  done: boolean
  createdAt: number
  abort: AbortController
  timers: Set<NodeJS.Timeout>
  lastCorrections: number
  lastError?: string
  kickReason?: string
  view: ViewTracker
  /** start_game runtime_entity_id, as a string (varint64 vs varint in move_player). */
  runtimeId?: string
  /** Latest network_chunk_publisher_update radius, chunks (fallback when no chunk_radius_update came). */
  publisherRadius?: number
}

const ELD_RESOLUTION_MS = 10
const MAX_LOGS_PER_INTERVAL = 50

const send = (msg: WorkerMessage): void => {
  if (process.connected) process.send!(msg)
}

let init: WorkerInit | null = null
let workerId = -1
let scenario: Scenario | null = null
const bots = new Map<number, BotState>()
let createBot: ((opts: BotOptions) => Bot) | null = null
let stopping = false

// interval accumulators
let joinLatencies: number[] = []
let rtts: number[] = []
let correctionsAcc = 0 // corrections of bots that ended mid-interval
let rxBytes = 0
let logsThisInterval = 0
let logsDropped = 0
let chunkLoads = 0
let packets = new Map<string, number>()
let chunkCacheSeen = false
let blobMissReplies = 0

function log (msg: string): void {
  if (logsThisInterval >= MAX_LOGS_PER_INTERVAL) { logsDropped++; return }
  logsThisInterval++
  send({ type: 'log', workerId, msg })
}

function errText (err: unknown): string {
  if (err instanceof Error) return err.message
  try { return typeof err === 'string' ? err : JSON.stringify(err) } catch { return String(err) }
}

// One misbehaving bot (a throwing plugin listener, a rejected promise) must not take the other bots down.
process.on('uncaughtException', err => { log(`uncaught exception: ${err?.stack ?? errText(err)}`) })
process.on('unhandledRejection', err => { log(`unhandled rejection: ${errText(err)}`) })
// Parent gone (controller crashed or killed): never leave an orphan worker with live bots behind.
process.on('disconnect', () => { process.exit(1) })

function later (s: BotState, ms: number, fn: () => void): void {
  const t = setTimeout(() => { s.timers.delete(t); fn() }, ms)
  s.timers.add(t)
}

function readCorrections (s: BotState): number {
  try {
    const c = (s.bot as unknown as BotInternals | null)?._bedrock?.physics?.stats?.()?.corrections
    return typeof c === 'number' ? c : s.lastCorrections
  } catch { return s.lastCorrections }
}

/** End a bot's life in the worker: report exactly one final event and free its index. */
function finish (s: BotState, event: 'fail' | 'disconnect' | 'left', reason: string): void {
  if (s.done) return
  s.done = true
  const c = readCorrections(s)
  correctionsAcc += Math.max(0, c - s.lastCorrections)
  s.lastCorrections = c
  for (const t of s.timers) clearTimeout(t)
  s.timers.clear()
  s.abort.abort()
  if (bots.get(s.index) === s) bots.delete(s.index)
  if (event === 'left') send({ type: 'bot', event, index: s.index, seq: s.seq })
  else send({ type: 'bot', event, index: s.index, seq: s.seq, reason })
  try { s.bot?.end(event === 'left' ? 'leave' : event) } catch {}
}

function join (index: number, seq: number): void {
  const cfg = init!
  if (stopping) { send({ type: 'bot', event: 'fail', index, seq, reason: 'worker stopping' }); return }
  const existing = bots.get(index)
  if (existing) finish(existing, 'left', 'replaced') // controller never does this; keep the map consistent anyway

  const s: BotState = {
    index,
    seq,
    bot: null,
    phase: 'joining',
    endRequested: false,
    done: false,
    createdAt: performance.now(),
    abort: new AbortController(),
    timers: new Set(),
    lastCorrections: 0,
    view: new ViewTracker()
  }
  bots.set(index, s)

  let bot: Bot
  try {
    bot = createBot!({
      host: cfg.host,
      port: cfg.port,
      username: `${cfg.usernamePrefix}${index}`,
      version: cfg.version,
      auth: 'offline',
      viewDistance: 'tiny',
      logErrors: false,
      ...scenario!.botOptions?.(cfg.scenarioParams)
    } as BotOptions)
  } catch (err) {
    finish(s, 'fail', `createBot threw: ${errText(err)}`)
    return
  }
  s.bot = bot

  // rx bytes: count the game-layer payload (post-RakNet, still compressed/encrypted) of every batch received.
  const client = (bot as unknown as BotInternals)._client
  if (client && typeof client.handle === 'function') {
    const orig = client.handle
    client.handle = function (this: unknown, buf: Buffer) {
      rxBytes += buf?.length ?? 0
      return orig.call(this, buf)
    }
  }
  if (client) hookView(s, bot, client, cfg.forceFullChunks === true)

  later(s, cfg.joinTimeoutMs, () => {
    if (s.phase === 'joining') finish(s, s.endRequested ? 'left' : 'fail', `no spawn within ${cfg.joinTimeoutMs} ms`)
  })

  // bedboo emits 'connect' (transport up, login sent) but its typings do not declare it
  ;(bot as unknown as NodeJS.EventEmitter).once('connect', () => {
    if (!s.done) send({ type: 'bot', event: 'connect', index, seq })
  })
  bot.on('error', (err: Error) => {
    if (s.done) return
    s.lastError = errText(err)
    // Before spawn any error is a failed join; after spawn bedboo also reports recoverable errors (decode of a
    // packet, a plugin) — the connection's `end` decides whether the bot is lost.
    if (s.phase === 'joining' && !s.endRequested) finish(s, 'fail', `error: ${s.lastError}`)
  })
  bot.once('kicked', (reason: unknown) => { s.kickReason = errText(reason) })
  bot.once('end', (reason: string) => {
    if (s.done) return
    if (s.endRequested) finish(s, 'left', 'requested')
    else {
      const why = s.kickReason !== undefined ? `kicked: ${s.kickReason}` : s.lastError ?? `end: ${reason}`
      finish(s, s.phase === 'joining' ? 'fail' : 'disconnect', why)
    }
  })
  bot.once('spawn', () => {
    if (s.done || s.phase !== 'joining') return
    s.phase = 'spawned'
    const latency = performance.now() - s.createdAt
    joinLatencies.push(latency)
    s.lastCorrections = readCorrections(s)
    send({ type: 'bot', event: 'spawn', index, seq, joinLatencyMs: latency })
    runScenario(s, bot)
    if (isSampled(index, cfg.rtt.sampleRatio) && cfg.rtt.intervalMs > 0) startRttProbe(s, bot)
  })
}

/** Packet counters, view-load tracking and the forceFullChunks blob-cache answers of one bot. */
function hookView (s: BotState, bot: Bot, client: ClientInternals, forceFullChunks: boolean): void {
  if (typeof client.on !== 'function') return
  const on = (event: string, fn: (p: any) => void): void => {
    client.on!(event, (p: any) => { try { fn(p) } catch (err) { log(`bot ${s.index}: ${event} hook: ${errText(err)}`) } })
  }
  on('packet', (des: any) => {
    const name = des?.data?.name
    if (typeof name === 'string') packets.set(name, (packets.get(name) ?? 0) + 1)
  })
  on('start_game', p => {
    s.runtimeId = String(p?.runtime_entity_id)
    s.view.startGame(performance.now())
  })
  on('move_player', p => {
    if (s.phase === 'spawned' && p?.mode === 'teleport' && s.runtimeId !== undefined && String(p.runtime_id) === s.runtimeId) {
      s.view.teleport(performance.now())
    }
  })
  on('network_chunk_publisher_update', p => {
    const r = Number(p?.radius)
    if (r > 0) s.publisherRadius = Math.ceil(r / 16)
  })
  // bedboo keeps the world of the current dimension only and unloads every column on a dimension change, so the
  // dimension is only needed for `uniq` (best effort: bot.game.dimension at load time)
  const emitter = bot as unknown as NodeJS.EventEmitter
  emitter.on('chunkColumnLoad', (pos: { x: number, z: number } | undefined) => {
    if (!pos) return
    chunkLoads++
    const dim = (bot as unknown as BotInternals).game?.dimension ?? 'overworld'
    s.view.load(dim, Math.floor(pos.x / 16), Math.floor(pos.z / 16), performance.now())
  })
  emitter.on('chunkColumnUnload', (pos: { x: number, z: number } | undefined) => {
    if (pos) s.view.unload(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
  })

  const missing = (hashes: unknown[]): void => {
    if (!forceFullChunks || hashes.length === 0 || typeof client.queue !== 'function') return
    client.queue('client_cache_blob_status', { missing: hashes, have: [] })
    blobMissReplies++
  }
  on('level_chunk', p => {
    const blobs: unknown[] = Array.isArray(p?.blobs) ? p.blobs : []
    if (p?.cache_enabled || blobs.length > 0) chunkCacheSeen = true
    missing(blobs)
  })
  on('subchunk', p => {
    const blobs: unknown[] = []
    for (const e of p?.entries ?? []) if (e?.blob_id !== undefined && e.blob_id !== null) blobs.push(e.blob_id)
    if (p?.cache_enabled || blobs.length > 0) chunkCacheSeen = true
    missing(blobs)
  })

  if (forceFullChunks) {
    // bedrock-protocol already sends client_cache_status { enabled: false }; make sure nothing turns it on, since
    // bedboo decodes chunk payloads inline and cannot resolve blob-cache answers.
    for (const m of ['queue', 'write'] as const) {
      const orig = client[m]
      if (typeof orig !== 'function') continue
      client[m] = function (this: unknown, name: string, params: unknown) {
        return orig.call(this, name, name === 'client_cache_status' ? { enabled: false } : params)
      }
    }
  }
}

/** Server view radius of a bot, chunks: chunk_radius_update, else the chunk publisher radius, else unbounded. */
function viewRadius (s: BotState): number {
  const r = Number((s.bot as unknown as BotInternals | null)?.game?.serverViewDistance)
  if (r > 0) return r
  return s.publisherRadius ?? Number.POSITIVE_INFINITY
}

function sampleView (s: BotState, now: number): BotViewSample {
  const bot = s.bot as unknown as { entity?: { position?: { x: number, z: number } } } | null
  const pos = bot?.entity?.position
  // no usable position (should not happen after spawn): count every loaded column
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return s.view.sample(0, 0, Number.POSITIVE_INFINITY, now)
  return s.view.sample(Math.floor(pos.x / 16), Math.floor(pos.z / 16), viewRadius(s), now)
}

function runScenario (s: BotState, bot: Bot): void {
  const cfg = init!
  const ctx: ScenarioContext = {
    index: s.index,
    params: cfg.scenarioParams,
    random: botRandom(cfg.seed, s.index),
    log: (msg: string) => log(`bot ${s.index}: ${msg}`)
  }
  let p: Promise<void>
  try {
    p = Promise.resolve(scenario!.run(bot, ctx, s.abort.signal))
  } catch (err) {
    p = Promise.reject(err)
  }
  p.then(
    () => {
      // A scenario that returns early leaves the bot connected and idle; that is not a failure.
    },
    (err: unknown) => {
      if (s.done || s.abort.signal.aborted) return
      log(`bot ${s.index}: scenario threw: ${err instanceof Error ? err.stack ?? err.message : errText(err)}`)
      finish(s, 'disconnect', `scenario threw: ${errText(err)}`)
    }
  )
}

function startRttProbe (s: BotState, bot: Bot): void {
  const cfg = init!
  const request = (bot as unknown as BotInternals)._bedrock?.commands?.request
  if (typeof request !== 'function') { log(`bot ${s.index}: no commands.request, RTT probe disabled`); return }
  let mode: 'scriptevent' | 'testfor' = 'scriptevent'
  let n = 0
  const probe = async (): Promise<void> => {
    if (s.done) return
    const cmd = mode === 'scriptevent' ? `scriptevent bedperf:ping ${s.index}-${n++}` : 'testfor @s'
    const t0 = performance.now()
    try {
      const out = await request(cmd, { timeout: cfg.rtt.timeoutMs })
      const rtt = performance.now() - t0
      if (s.done) return
      // Any answer went through the server's tick-bound command handling, so it is a valid sample.
      rtts.push(rtt)
      if (!(out?.success_count !== undefined && out.success_count > 0)) {
        if (mode === 'scriptevent') {
          mode = 'testfor'
          log(`bot ${s.index}: scriptevent ping unsuccessful, falling back to "testfor @s" (is the bot operator?)`)
        }
      }
    } catch (err) {
      if (!s.done) log(`bot ${s.index}: RTT probe failed: ${errText(err)}`)
    }
    if (!s.done) later(s, cfg.rtt.intervalMs, () => { void probe() })
  }
  // spread the probes of different bots over the interval
  later(s, (s.index * 7919) % Math.max(1, cfg.rtt.intervalMs), () => { void probe() })
}

function leave (index: number, seq: number): void {
  const s = bots.get(index)
  if (!s) { send({ type: 'bot', event: 'left', index, seq }); return }
  if (s.endRequested) return
  s.endRequested = true
  s.abort.abort()
  later(s, init!.leaveTimeoutMs, () => finish(s, 'left', 'leave timeout'))
  try { s.bot?.end('leave') } catch (err) { finish(s, 'left', `end threw: ${errText(err)}`) }
}

async function stop (graceMs: number): Promise<void> {
  stopping = true
  for (const s of [...bots.values()]) leave(s.index, s.seq)
  const deadline = Date.now() + graceMs
  while (bots.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  for (const s of [...bots.values()]) finish(s, 'left', 'stop')
  if (process.connected) process.send!({ type: 'stopped', workerId } satisfies WorkerMessage, () => process.exit(0))
  else process.exit(0)
}

function startStats (): void {
  const cfg = init!
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS })
  eld.enable()
  let lastT = performance.now()
  let lastCpu = process.cpuUsage()
  let lastThreadCpu = process.threadCpuUsage()
  setInterval(() => {
    const now = performance.now()
    const intervalMs = now - lastT
    lastT = now
    const cpu = process.cpuUsage(lastCpu)
    lastCpu = process.cpuUsage()
    const tcpu = process.threadCpuUsage(lastThreadCpu)
    lastThreadCpu = process.threadCpuUsage()
    const pct = (c: NodeJS.CpuUsage): number => intervalMs > 0 ? ((c.user + c.system) / 1000) / intervalMs * 100 : 0
    let corrections = correctionsAcc
    correctionsAcc = 0
    for (const s of bots.values()) {
      if (s.phase !== 'spawned') continue
      const c = readCorrections(s)
      corrections += Math.max(0, c - s.lastCorrections)
      s.lastCorrections = c
    }
    // the histogram measures timer delay including its own period
    const p99 = eld.count > 0 ? Math.max(0, eld.percentile(99) / 1e6 - ELD_RESOLUTION_MS) : 0
    eld.reset()
    const view: BotViewSample[] = []
    for (const s of bots.values()) {
      if (s.phase !== 'spawned' || s.done) continue
      try { view.push(sampleView(s, now)) } catch (err) { log(`bot ${s.index}: view sample failed: ${errText(err)}`) }
    }
    if (logsDropped > 0) send({ type: 'log', workerId, msg: `(${logsDropped} log lines dropped)` })
    logsThisInterval = 0
    logsDropped = 0
    send({
      type: 'stats',
      workerId,
      intervalMs,
      bots: bots.size,
      joinLatencyMs: joinLatencies,
      rttMs: rtts,
      corrections,
      rxBytes,
      eventLoopP99Ms: p99,
      mainThreadCpuPct: pct(tcpu),
      cpuPct: pct(cpu),
      rssBytes: process.memoryUsage.rss(),
      chunkLoads,
      packets: Object.fromEntries(packets),
      view,
      chunkCacheSeen,
      blobMissReplies
    })
    chunkLoads = 0
    packets = new Map()
    blobMissReplies = 0
    joinLatencies = []
    rtts = []
    rxBytes = 0
  }, cfg.statsIntervalMs)
}

let ready: Promise<void> | null = null

async function handleInit (msg: WorkerInit): Promise<void> {
  init = msg
  workerId = msg.workerId
  try {
    createBot = (require('bedboo') as typeof import('bedboo')).createBot
    const mod = await import(msg.scenarioModule) as { default?: Scenario }
    if (!mod.default || typeof mod.default.run !== 'function') {
      throw new Error(`${msg.scenarioModule} has no default export implementing Scenario`)
    }
    scenario = mod.default
  } catch (err) {
    send({ type: 'fatal', workerId, error: err instanceof Error ? err.stack ?? err.message : errText(err) })
    setTimeout(() => process.exit(2), 100)
    throw err
  }
  startStats()
  send({ type: 'ready', workerId })
}

process.on('message', (msg: ControllerMessage) => {
  if (msg.type === 'init') {
    ready = handleInit(msg.init)
    ready.catch(() => {})
    return
  }
  if (!ready) return
  ready.then(() => {
    switch (msg.type) {
      case 'join': join(msg.index, msg.seq); break
      case 'leave': leave(msg.index, msg.seq); break
      case 'stop': void stop(msg.graceMs); break
    }
  }, () => {})
})
