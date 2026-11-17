// The agent: a TCP server on a load-generator machine that runs loadgen bot workers for one orchestrator at a time
// and relays their IPC messages over the control link.
import { randomBytes } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { availableParallelism } from 'node:os'
import {
  AGENT_PROTOCOL_VERSION, harnessInfo, machineInfo,
  type AgentFrame, type AgentIdleCheckResult, type AgentInfo, type HarnessInfo, type InterferenceThresholds, type MachineInfo
} from '@bedperf/core'
import { forkWorker, type BotFleetOptions, type ControllerMessage, type WorkerFactory, type WorkerLink } from '@bedperf/loadgen'
import {
  checkInterference, createMachineSampler as defaultCreateMachineSampler, idleCheck as defaultIdleCheck, summarizeInterference,
  type IdleCheckOptions, type IdleCheckResult, type MachineSampler, type MachineSamplerOptions
} from '@bedperf/sysmon'
import pkg from '../package.json' with { type: 'json' }
import { frameLink, isLoopbackHost, macMatches, type FrameLink } from './frames.ts'
import { resolveScenarioModule, type ScenarioResolverDeps } from './scenario.ts'
import { resolveCpuScope, scopeSample } from './scope.ts'
import {
  DEFAULT_AGENT_SATURATION, defaultNetCounters, telemetryFromSample, type AgentSaturationThresholds, type NetCounterReader
} from './telemetry.ts'

/** Releases a lock taken by `AgentOptions.lock`. */
export type LockRelease = () => void | Promise<void>

export interface AgentOptions {
  listen: { host: string, port: number }
  /** Shared secret (normally from `AGENT_TOKEN_ENV`). Required unless `insecure` and listening on loopback. */
  token: string
  /** Allow an empty token; only accepted together with a loopback `listen.host`. */
  insecure?: boolean
  /** Name reported to the orchestrator. Default `agent-<first 8 of the machine fingerprint>` (never the host name). */
  name?: string
  /** Most concurrent workers; further spawns fail with a worker `fatal`. Default unlimited. */
  maxWorkers?: number
  /** Accept an orchestrator whose bedperf git commit differs from ours. Default false. */
  allowHarnessMismatch?: boolean
  /** Creates local workers. Default loadgen `forkWorker`. */
  workerFactory?: WorkerFactory
  /** Node flags for forked workers. */
  workerExecArgv?: string[]
  /** Machine sampler for telemetry. Default sysmon `createMachineSampler`. */
  createMachineSampler?: (opts: MachineSamplerOptions) => MachineSampler
  /** Default sysmon `idleCheck`. */
  idleCheck?: (opts: IdleCheckOptions) => Promise<IdleCheckResult>
  /** Default: /proc/net/dev on Linux, none elsewhere. */
  netCounters?: NetCounterReader
  saturation?: Partial<AgentSaturationThresholds>
  /**
   * CPUs the saturation and interference verdicts look at. `auto` (default): the CPUs this process may
   * run on when that is fewer than the machine's (a scheduler allocation or cpuset), else the whole
   * machine. `machine`: always the whole machine. A list: exactly those CPUs.
   */
  cpuScope?: 'auto' | 'machine' | number[]
  /** Taken when an orchestrator authenticates, released when its session ends; a throw denies the session. */
  lock?: () => Promise<LockRelease>
  scenarios?: ScenarioResolverDeps
  /** Default `machineInfo()`. */
  machine?: MachineInfo
  /** Default `harnessInfo({ version })` of this checkout. */
  harness?: HarnessInfo
  /** Time a connection gets to authenticate, ms. Default 10000. */
  authTimeoutMs?: number
  /** An authenticated controller silent this long is considered gone (its workers are killed), ms. Default 15000. */
  controllerTimeoutMs?: number
  log?: (line: string) => void
}

export interface AgentServer {
  readonly address: { host: string, port: number }
  readonly info: AgentInfo
  /** Stop listening, end the current session (killing its workers). */
  close (): Promise<void>
}

interface LocalWorker {
  link: WorkerLink
  alive: boolean
  /** Serializes delivery (init may need async scenario resolution before later messages go out). */
  chain: Promise<void>
}

type Frame = { type: string } & Record<string, unknown>

export async function startAgent (opts: AgentOptions): Promise<AgentServer> {
  const log = opts.log ?? ((l: string) => { process.stderr.write(`[agent] ${l}\n`) })
  if (!opts.token) {
    if (!opts.insecure) throw new Error('agent token is empty: set the shared secret (BEDPERF_AGENT_TOKEN) or pass insecure for a loopback-only agent')
    if (!isLoopbackHost(opts.listen.host)) throw new Error(`refusing an insecure (empty-token) agent on non-loopback address ${opts.listen.host}`)
  }
  const machine = opts.machine ?? await machineInfo()
  const harness = opts.harness ?? await harnessInfo({ version: pkg.version })
  const info: AgentInfo = {
    name: opts.name ?? `agent-${machine.fingerprint.slice(0, 8)}`,
    protocol: AGENT_PROTOCOL_VERSION,
    machine,
    harness,
    cpus: availableParallelism()
  }
  const scope = resolveCpuScope(opts.cpuScope ?? 'auto')
  if (scope !== undefined) info.cpuScope = scope
  const spawnWorker = opts.workerFactory ?? forkWorker
  const makeSampler = opts.createMachineSampler ?? defaultCreateMachineSampler
  const runIdleCheck = opts.idleCheck ?? defaultIdleCheck
  const netCounters = opts.netCounters ?? defaultNetCounters
  const thresholds = { ...DEFAULT_AGENT_SATURATION, ...opts.saturation }
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000
  const silenceMs = opts.controllerTimeoutMs ?? 15_000

  /** The authenticated session (one at a time). */
  let active: { close (reason: string): void, done: Promise<void> } | null = null
  /** Connections still authenticating. */
  const pending = new Set<{ close (reason: string): void, done: Promise<void> }>()
  const sockets = new Set<Socket>()

  function session (socket: Socket): void {
    const workers = new Map<number, LocalWorker>()
    const nonce = randomBytes(32).toString('hex')
    let authed = false
    let authing = false
    let release: LockRelease | undefined
    let sampler: MachineSampler | undefined
    let silence: NodeJS.Timeout | undefined
    let onDone!: () => void
    const done = new Promise<void>(resolve => { onDone = resolve })
    const peer = `${socket.remoteAddress}:${socket.remotePort}`

    const authTimer = setTimeout(() => link.close('authentication timeout'), authTimeoutMs)
    const send = (f: AgentFrame): boolean => link.send(f)
    const deny = (reason: string): void => {
      log(`denied ${peer}: ${reason}`)
      send({ type: 'denied', reason })
      socket.end()
      setTimeout(() => link.close(`denied: ${reason}`), 1000).unref()
    }
    const armSilence = (): void => {
      if (!authed) return
      if (silence) clearTimeout(silence)
      silence = setTimeout(() => link.close(`controller silent for ${silenceMs} ms`), silenceMs)
    }
    const botPids = (): number[] => [...workers.values()].flatMap(w => w.alive && w.link.pid !== undefined ? [w.link.pid] : [])

    const link: FrameLink = frameLink(socket, {
      onFrame: f => {
        armSilence()
        if (!authed) { if (!authing) onAuth(f); return }
        onAuthedFrame(f)
      },
      onClose: reason => {
        clearTimeout(authTimer)
        if (silence) clearTimeout(silence)
        const n = [...workers.values()].filter(w => w.alive).length
        for (const w of workers.values()) if (w.alive) { try { w.link.kill() } catch {} }
        workers.clear()
        if (authed) log(`controller ${peer} gone (${reason})${n > 0 ? `; killed ${n} worker(s)` : ''}`)
        const s = sampler
        sampler = undefined
        const r = release
        release = undefined
        void (async () => {
          try { await s?.stop() } catch {}
          try { await r?.() } catch (err) { log(`lock release failed: ${(err as Error).message}`) }
          onDone()
        })()
        if (active === me) active = null
        pending.delete(me)
      }
    })
    const me = { close: (reason: string) => link.close(reason), done }
    pending.add(me)
    send({ type: 'challenge', nonce, protocol: AGENT_PROTOCOL_VERSION })

    function onAuth (f: Frame): void {
      if (f.type !== 'auth') { deny('expected auth'); return }
      if (f.protocol !== AGENT_PROTOCOL_VERSION) { deny(`protocol mismatch: agent ${AGENT_PROTOCOL_VERSION}, controller ${String(f.protocol)}`); return }
      if (!macMatches(opts.token, nonce, f.mac)) { deny('bad token'); return }
      const theirGit = typeof f.harnessGit === 'string' ? f.harnessGit : undefined
      if (!opts.allowHarnessMismatch && theirGit !== harness.git) {
        deny(`harness mismatch: agent runs bedperf ${harness.git?.slice(0, 12) ?? '(unknown commit)'}, controller ${theirGit?.slice(0, 12) ?? '(unknown commit)'} (use the same commit or allowHarnessMismatch)`)
        return
      }
      authing = true
      void (async () => {
        if (opts.lock) {
          try {
            const r = await opts.lock()
            if (link.closed) { await r(); return }
            release = r
          } catch (err) {
            deny(`machine busy: ${(err as Error)?.message ?? String(err)}`)
            return
          }
        }
        if (link.closed) return
        if (active !== null) {
          // another controller authenticated first
          const r = release
          release = undefined
          try { await r?.() } catch {}
          deny('busy')
          return
        }
        clearTimeout(authTimer)
        active = me
        pending.delete(me)
        authed = true
        authing = false
        armSilence()
        log(`controller ${peer} connected`)
        send({ type: 'hello', info })
      })()
    }

    function onAuthedFrame (f: Frame): void {
      switch (f.type) {
        case 'ping':
          send({ type: 'pong', id: Number(f.id), agentTime: Date.now() })
          break
        case 'spawn': onSpawn(Number(f.workerId)); break
        case 'worker': onWorkerMsg(Number(f.workerId), f.msg); break
        case 'kill': {
          const w = workers.get(Number(f.workerId))
          if (w?.alive) w.link.kill()
          break
        }
        case 'telemetry': onTelemetry(Number(f.intervalMs)); break
        case 'idleCheck': void onIdleCheck(Number(f.id), Number(f.durationSec), f.thresholds); break
        case 'bye': link.close('controller said bye'); break
        default: break // unknown frame kinds are ignored (forward compatibility)
      }
    }

    function onSpawn (id: number): void {
      if (!Number.isInteger(id)) return
      if (workers.get(id)?.alive) { log(`spawn for live worker ${id} ignored`); return }
      const alive = [...workers.values()].filter(w => w.alive).length
      if (opts.maxWorkers !== undefined && alive >= opts.maxWorkers) {
        send({ type: 'worker', workerId: id, msg: { type: 'fatal', workerId: -1, error: `agent ${info.name} is at its limit of ${opts.maxWorkers} workers` } })
        send({ type: 'exit', workerId: id, code: null })
        return
      }
      let wl: WorkerLink
      try {
        const lopts = {
          workerExecArgv: opts.workerExecArgv ?? [],
          onLog: (_wid: number, line: string) => { send({ type: 'log', workerId: id, line }) }
        } as Partial<BotFleetOptions> as BotFleetOptions
        wl = spawnWorker(id, lopts)
      } catch (err) {
        send({ type: 'worker', workerId: id, msg: { type: 'fatal', workerId: -1, error: `agent could not start a worker: ${(err as Error)?.message}` } })
        send({ type: 'exit', workerId: id, code: null })
        return
      }
      const rec: LocalWorker = { link: wl, alive: true, chain: Promise.resolve() }
      workers.set(id, rec)
      wl.onMessage(m => { send({ type: 'worker', workerId: id, msg: m }) })
      wl.onExit(code => {
        rec.alive = false
        if (workers.get(id) === rec) workers.delete(id)
        sampler?.setGroup('bots', botPids())
        send({ type: 'exit', workerId: id, code })
      })
      sampler?.setGroup('bots', botPids())
      send({ type: 'spawned', workerId: id })
    }

    function onWorkerMsg (id: number, msg: unknown): void {
      const rec = workers.get(id)
      if (!rec || msg === null || typeof msg !== 'object') return
      rec.chain = rec.chain.then(async () => {
        if (!rec.alive) return
        let out = msg as ControllerMessage
        if (out.type === 'init') {
          try {
            const scenarioModule = await resolveScenarioModule(out.init, opts.scenarios)
            out = { type: 'init', init: { ...out.init, scenarioModule } }
          } catch (err) {
            const error = (err as Error)?.message ?? String(err)
            log(`worker ${id}: ${error}`)
            send({ type: 'worker', workerId: id, msg: { type: 'fatal', workerId: out.init.workerId, error } })
            rec.link.kill()
            return
          }
        }
        if (!rec.alive) return
        rec.link.send(out)
      }).catch(err => { log(`worker ${id}: relay failed: ${(err as Error)?.message}`) })
    }

    function onTelemetry (intervalMs: number): void {
      const old = sampler
      sampler = undefined
      old?.stop().catch(err => { log(`telemetry sampler stop failed: ${(err as Error)?.message}`) })
      if (!(intervalMs > 0)) return
      let prevNet = netCounters()
      let prevAt = performance.now()
      const s = makeSampler({
        intervalMs,
        groups: { bots: botPids(), harness: [process.pid] },
        onEnd: (_r, err) => { log(`telemetry sampler stopped: ${err.message}`) }
      })
      sampler = s
      s.start(sample => {
        if (sampler !== s) return
        const cur = netCounters()
        const at = performance.now()
        let net: { rxBytesPerSec: number, txBytesPerSec: number } | undefined
        if (cur && prevNet && at > prevAt) {
          const sec = (at - prevAt) / 1000
          net = { rxBytesPerSec: Math.max(0, cur.rxBytes - prevNet.rxBytes) / sec, txBytesPerSec: Math.max(0, cur.txBytes - prevNet.txBytes) / sec }
        }
        prevNet = cur
        prevAt = at
        send({ type: 'telemetry', sample: telemetryFromSample(scope ? scopeSample(sample, scope) : sample, thresholds, net) })
      }).catch(err => {
        log(`telemetry sampler failed to start: ${(err as Error)?.message}`)
        if (sampler === s) sampler = undefined
      })
    }

    async function onIdleCheck (id: number, durationSec: number, th: unknown): Promise<void> {
      const o: IdleCheckOptions = { harnessRoot: process.pid }
      if (durationSec > 0) o.durationSec = durationSec
      if (th && typeof th === 'object') {
        const t: Partial<InterferenceThresholds> = {}
        for (const k of ['foreignMean', 'foreignPeak10s', 'serverSetForeignMean'] as const) {
          const v = (th as Record<string, unknown>)[k]
          if (typeof v === 'number' && Number.isFinite(v)) t[k] = v
        }
        o.thresholds = t
      }
      let result: AgentIdleCheckResult
      try {
        const r = await runIdleCheck(o)
        if (scope !== undefined) {
          // Only the scoped CPUs count; floored at 0 like sysmon's own idle summary.
          const raw = summarizeInterference(r.samples.map(x => scopeSample(x, scope)))
          const summary = { samples: raw.samples, foreignMean: Math.max(0, raw.foreignMean), foreignPeak10s: Math.max(0, raw.foreignPeak10s) }
          const { serverSetForeignMean: _ignored, ...lim } = o.thresholds ?? {}
          const c = checkInterference(summary, lim)
          result = { ok: c.ok, reasons: c.reasons, summary, top: r.top }
        } else {
          result = { ok: r.ok, reasons: r.reasons, summary: r.summary, top: r.top }
        }
      } catch (err) {
        result = {
          ok: false,
          reasons: [`idle check failed: ${(err as Error)?.message ?? String(err)}`],
          summary: { samples: 0, foreignMean: 0, foreignPeak10s: 0 },
          top: []
        }
      }
      send({ type: 'idleCheck', id, result })
    }
  }

  const server: Server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (active) {
      socket.end(JSON.stringify({ type: 'denied', reason: 'busy' } satisfies AgentFrame) + '\n')
      setTimeout(() => socket.destroy(), 1000).unref()
      return
    }
    session(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.listen.port, opts.listen.host, () => { server.off('error', reject); resolve() })
  })
  const a = server.address() as AddressInfo
  log(`${info.name} listening on ${a.address}:${a.port}`)
  return {
    address: { host: a.address, port: a.port },
    info,
    async close () {
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      const cur = [...(active ? [active] : []), ...pending]
      for (const c of cur) c.close('agent closing')
      for (const s of sockets) s.destroy()
      await Promise.all(cur.map(c => c.done))
      await closed
    }
  }
}
