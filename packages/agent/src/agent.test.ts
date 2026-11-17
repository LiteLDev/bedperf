import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, createServer, type AddressInfo, type Socket } from 'node:net'
import type { AgentTelemetry, HarnessInfo, InterferenceSample, MachineInfo } from '@bedperf/core'
import { BotFleet, type BotFleetOptions, type ControllerMessage, type WorkerLink, type WorkerMessage } from '@bedperf/loadgen'
import type { MachineSampler, MachineSamplerOptions } from '@bedperf/sysmon'
import { startAgent, type AgentOptions, type AgentServer } from './agent.ts'
import { connectAgents } from './client.ts'
import { authMac, frameLink, parseAddress, isLoopbackHost } from './frames.ts'
import { builtinScenarioName, resolveScenarioModule } from './scenario.ts'
import { telemetryFromSample } from './telemetry.ts'

const TOKEN = 'test-secret'
const MACHINE: MachineInfo = { fingerprint: '0123456789abcdef', os: 'Test 1', cpuModel: 'cpu', logical: 8, ramGiB: 16 }
const HARNESS: HarnessInfo = { version: '0.0.0', git: 'a'.repeat(40), node: process.version }

/** In-process stand-in for a loadgen worker process. */
class FakeWorker implements WorkerLink {
  static all: FakeWorker[] = []
  readonly id: number
  readonly sent: ControllerMessage[] = []
  killed = false
  exited = false
  pid: number
  private msgCb: ((m: WorkerMessage) => void) | undefined
  private exitCb: ((c: number | null) => void) | undefined
  private wid = -1
  private bots = 0
  constructor (id: number) {
    this.id = id
    this.pid = 50_000 + FakeWorker.all.length
    FakeWorker.all.push(this)
  }

  send (msg: ControllerMessage): void {
    this.sent.push(msg)
    setImmediate(() => {
      switch (msg.type) {
        case 'init': this.wid = msg.init.workerId; this.emit({ type: 'ready', workerId: this.wid }); break
        case 'join':
          this.emit({ type: 'bot', event: 'connect', index: msg.index, seq: msg.seq })
          this.emit({ type: 'bot', event: 'spawn', index: msg.index, seq: msg.seq, joinLatencyMs: 5 })
          this.emit({
            type: 'stats', workerId: this.wid, intervalMs: 100, bots: ++this.bots, joinLatencyMs: [5], rttMs: [], corrections: 0,
            rxBytes: 0, eventLoopP99Ms: 3, mainThreadCpuPct: 10, cpuPct: 20, rssBytes: 1
          })
          break
        case 'leave': this.emit({ type: 'bot', event: 'left', index: msg.index, seq: msg.seq }); break
        case 'stop': this.emit({ type: 'stopped', workerId: this.wid }); this.exit(0); break
      }
    })
  }

  onMessage (cb: (m: WorkerMessage) => void): void { this.msgCb = cb }
  onExit (cb: (c: number | null) => void): void { this.exitCb = cb }
  kill (): void { this.killed = true; this.exit(null) }
  emit (m: WorkerMessage): void { if (!this.exited) this.msgCb?.(m) }
  exit (code: number | null): void {
    if (this.exited) return
    this.exited = true
    setImmediate(() => this.exitCb?.(code))
  }
}

function fakeSampler (sample: Partial<InterferenceSample> = {}): { factory: (o: MachineSamplerOptions) => MachineSampler, groups: number[][] } {
  const groups: number[][] = []
  return {
    groups,
    factory: o => {
      let timer: NodeJS.Timeout | undefined
      if (o.groups?.bots) groups.push(o.groups.bots)
      return {
        async start (cb) {
          timer = setInterval(() => cb({
            t: 0, intervalMs: o.intervalMs ?? 1000, cpuBusy: [1, 1, 1, 1], busyCores: 3.9,
            groups: { server: 0, bots: 2.5, harness: 0.1 }, foreignCores: 1.3, ...sample
          }), o.intervalMs ?? 1000)
        },
        async stop () { clearInterval(timer) },
        setGroup (g, pids) { if (g === 'bots') groups.push(pids) },
        refresh () {},
        async top () { return [] }
      }
    }
  }
}

async function agent (extra: Partial<AgentOptions> = {}): Promise<AgentServer> {
  return startAgent({
    listen: { host: '127.0.0.1', port: 0 },
    token: TOKEN,
    machine: MACHINE,
    harness: HARNESS,
    workerFactory: id => new FakeWorker(id),
    createMachineSampler: fakeSampler().factory,
    idleCheck: async () => ({ ok: true, reasons: [], summary: { samples: 3, foreignMean: 0.1, foreignPeak10s: 0.2 }, top: [], samples: [] }),
    scenarios: { registry: async n => n === 'walk' || n === 'idle' ? `file:///local/scenarios/${n}.ts` : undefined, exists: () => false },
    log: () => {},
    ...extra
  })
}

const addr = (a: AgentServer): string => `127.0.0.1:${a.address.port}`

function fleetOpts (extra: Partial<BotFleetOptions> = {}): BotFleetOptions {
  return {
    host: '127.0.0.1', port: 1, version: '1.26.60',
    scenarioModule: 'file:///orchestrator/checkout/packages/scenarios/src/scenarios/walk.ts',
    botsPerWorker: 2, joinIntervalMs: 1, usernamePrefix: 'b', seed: 1, statsIntervalMs: 60_000, onLog: () => {},
    ...extra
  }
}

async function until (cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 10))
  }
}

test('frames: parseAddress and loopback detection', () => {
  assert.deepEqual(parseAddress('10.0.0.2:19261'), { host: '10.0.0.2', port: 19261 })
  assert.deepEqual(parseAddress('[::1]:5'), { host: '::1', port: 5 })
  assert.deepEqual(parseAddress('box', 19260), { host: 'box', port: 19260 })
  assert.throws(() => parseAddress('box'))
  assert.throws(() => parseAddress('box:99999'))
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && !isLoopbackHost('0.0.0.0'))
})

test('frames: malformed JSON and over-long lines close the link with a reason', async () => {
  const reasons: string[] = []
  const server = createServer(s => { frameLink(s, { maxFrameBytes: 64, onFrame: () => {}, onClose: r => reasons.push(r) }) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const send = async (data: string): Promise<void> => {
    const c = connect(port, '127.0.0.1')
    c.on('error', () => {})
    await new Promise<void>(r => c.once('connect', () => r()))
    c.write(data)
    await new Promise<void>(r => c.once('close', () => r()))
  }
  await send('{nope\n')
  await send('x'.repeat(200))
  await send('[1,2]\n')
  server.close()
  assert.deepEqual(reasons, ['malformed JSON frame', 'frame longer than 64 bytes', 'frame is not an object with a string type'])
})

test('scenario resolution: registry names, builtin URLs from another machine, local files, missing custom modules', async () => {
  const deps = { registry: async (n: string) => n === 'walk' ? 'file:///here/walk.ts' : undefined, exists: (p: string) => p.includes('present') }
  assert.equal(builtinScenarioName('file:///C:/x/packages/scenarios/src/scenarios/entity-stress.ts'), 'entity-stress')
  assert.equal(await resolveScenarioModule({ scenarioModule: 'file:///whatever', scenarioName: 'walk' }, deps), 'file:///here/walk.ts')
  await assert.rejects(resolveScenarioModule({ scenarioModule: 'x', scenarioName: 'nope' }, deps), /not a builtin/)
  assert.equal(await resolveScenarioModule({ scenarioModule: 'file:///C:/a/packages/scenarios/src/scenarios/walk.ts' }, deps), 'file:///here/walk.ts')
  assert.match(await resolveScenarioModule({ scenarioModule: 'file:///home/u/packages/loadgen/src/scenarios/idle.ts' }, deps), /loadgen\/src\/scenarios\/idle\.ts$/)
  assert.equal(await resolveScenarioModule({ scenarioModule: 'my-scenario-pkg' }, deps), 'my-scenario-pkg')
  const present = process.platform === 'win32' ? 'file:///C:/present/s.ts' : 'file:///present/s.ts'
  assert.equal(await resolveScenarioModule({ scenarioModule: present }, deps), present)
  await assert.rejects(resolveScenarioModule({ scenarioModule: 'file:///C:/gone/s.ts' }, deps), /not present on this agent/)
})

test('telemetry: saturation reasons from busy and foreign load', () => {
  const t = telemetryFromSample({ t: 1, intervalMs: 1000, cpuBusy: [1, 1, 1, 1], busyCores: 3.9, groups: { server: 0, bots: 2.5, harness: 0.1 }, foreignCores: 1.3 })
  assert.equal(t.saturated, true)
  assert.equal(t.reasons.length, 2)
  assert.equal(t.botCores, 2.5)
  assert.equal(t.logicalCpus, 4)
  assert.equal((t as { t?: number }).t, undefined)
  const ok = telemetryFromSample({ t: 1, intervalMs: 1000, cpuBusy: [0.1, 0.1], busyCores: 0.2, groups: { server: 0, bots: 0.1, harness: 0 }, foreignCores: 0.1 }, undefined, { rxBytesPerSec: 10.4, txBytesPerSec: 3 })
  assert.equal(ok.saturated, false)
  assert.equal(ok.netRxBytesPerSec, 10)
})

test('startAgent refuses an empty token unless insecure on loopback', async () => {
  await assert.rejects(agent({ token: '' }), /token is empty/)
  await assert.rejects(agent({ token: '', insecure: true, listen: { host: '0.0.0.0', port: 0 } }), /non-loopback/)
  const a = await agent({ token: '', insecure: true })
  const pool = await connectAgents([{ address: addr(a) }], { token: '', harnessGit: HARNESS.git!, log: () => {} })
  await pool.close()
  await a.close()
})

test('auth: wrong token, protocol and harness mismatch are denied; second controller gets busy', async () => {
  const a = await agent()
  await assert.rejects(connectAgents([{ address: addr(a) }], { token: 'wrong', harnessGit: HARNESS.git!, log: () => {} }), /denied: bad token/)
  await assert.rejects(connectAgents([{ address: addr(a) }], { token: TOKEN, harnessGit: 'b'.repeat(40), log: () => {} }), /harness mismatch/)

  // raw protocol mismatch
  const raw = connect(a.address.port, '127.0.0.1')
  const frames: Array<Record<string, unknown>> = []
  await new Promise<void>(resolve => {
    frameLink(raw, {
      onFrame: f => {
        frames.push(f)
        if (f.type === 'challenge') raw.write(JSON.stringify({ type: 'auth', mac: authMac(TOKEN, String(f.nonce)), protocol: 999 }) + '\n')
      },
      onClose: () => resolve()
    })
  })
  assert.match(String(frames.find(f => f.type === 'denied')?.reason), /protocol mismatch/)

  const pool = await connectAgents([{ address: addr(a), name: 'one' }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} })
  assert.equal(pool.agents[0]!.name, 'one')
  assert.equal(pool.info()['one']!.name, 'agent-01234567')
  await assert.rejects(connectAgents([{ address: addr(a) }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} }), /denied: busy/)
  await pool.close()
  await a.close()

  const lax = await agent({ allowHarnessMismatch: true })
  const p2 = await connectAgents([{ address: addr(lax) }], { token: TOKEN, harnessGit: 'b'.repeat(40), log: () => {} })
  await p2.close()
  await lax.close()
})

test('lock hook: taken on auth, released at session end; a failing lock denies', async () => {
  const events: string[] = []
  const a = await agent({ lock: async () => { events.push('lock'); return () => { events.push('release') } } })
  const pool = await connectAgents([{ address: addr(a) }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} })
  assert.deepEqual(events, ['lock'])
  await pool.close()
  await until(() => events.length === 2)
  assert.deepEqual(events, ['lock', 'release'])
  await a.close()

  const b = await agent({ lock: async () => { throw new Error('another run holds the lock') } })
  await assert.rejects(connectAgents([{ address: addr(b) }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} }), /machine busy: another run/)
  await b.close()
})

test('fleet over two agents: weighted placement, scenario rewrite, per-agent slices, agent loss', async () => {
  FakeWorker.all = []
  const a1 = await agent({ name: 'alpha' })
  const a2 = await agent({ name: 'beta' })
  const links: string[] = []
  const pool = await connectAgents([{ address: addr(a1), weight: 2 }, { address: addr(a2) }], {
    token: TOKEN, harnessGit: HARNESS.git!, log: () => {}, onLink: e => links.push(`${e.agent}:${e.event}`)
  })
  assert.deepEqual(pool.agents.map(x => x.name), ['alpha', 'beta'])
  const fleet = new BotFleet({ spawnWorker: pool.workerFactory() })
  await fleet.start(fleetOpts())
  await fleet.scaleTo(12, 10_000)
  assert.equal(fleet.snapshot().spawned, 12)
  assert.deepEqual(fleet.pids(), [])
  const s = fleet.emitStats()
  const slices = Object.fromEntries((s.loadgen.agents ?? []).map(x => [x.agent, x]))
  assert.equal(slices['alpha']!.workers, 4)
  assert.equal(slices['beta']!.workers, 2)
  assert.equal(slices['alpha']!.bots + slices['beta']!.bots, 12)
  // init reached the local workers with the agent-local scenario module
  const init = FakeWorker.all[0]!.sent[0]!
  assert.ok(init.type === 'init' && init.init.scenarioModule === 'file:///local/scenarios/walk.ts')

  const link = await pool.measureLink(3)
  assert.equal(link['alpha']!.rttMs.n, 3)
  assert.ok(Math.abs(link['beta']!.clockOffsetMs) < 1000)

  // abrupt loss of alpha: its workers are killed agent-side and its bots count as unexpected disconnects
  const alphaWorkers = FakeWorker.all.filter(w => !w.exited).slice(0) // all live at this point
  await a1.close()
  await until(() => fleet.snapshot().spawned === 4)
  assert.equal(fleet.snapshot().unexpectedDisconnects, 8)
  assert.ok(alphaWorkers.filter(w => w.killed).length === 4)
  assert.ok(links.includes('alpha:lost'))
  assert.equal(pool.agents[0]!.alive, false)
  // the fleet keeps working on beta
  await fleet.scaleTo(12, 10_000)
  assert.equal(fleet.snapshot().spawned, 12)
  assert.deepEqual(fleet.emitStats().loadgen.agents?.map(x => [x.agent, x.workers]), [['beta', 6]])
  await fleet.stop()
  await pool.close()
  await a2.close()
  assert.ok(links.includes('beta:closed'))
})

test('maxBots caps workers per agent; with no capacity left joins fail', async () => {
  FakeWorker.all = []
  const a = await agent()
  const pool = await connectAgents([{ address: addr(a), maxBots: 4 }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} })
  const fleet = new BotFleet({ spawnWorker: pool.workerFactory() })
  await fleet.start(fleetOpts())
  await fleet.scaleTo(6, 3000)
  const snap = fleet.snapshot()
  assert.equal(snap.spawned, 4)
  assert.equal(snap.joinFailures, 2)
  await fleet.stop()
  await pool.close()
  await a.close()
})

test('a custom scenario module missing on the agent fails fleet start with a clear fatal', async () => {
  const a = await agent()
  const pool = await connectAgents([{ address: addr(a) }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {} })
  const fleet = new BotFleet({ spawnWorker: pool.workerFactory() })
  await assert.rejects(fleet.start(fleetOpts({ scenarioModule: 'file:///C:/my/custom.ts' })), /not present on this agent/)
  await pool.close()
  await a.close()
})

test('telemetry, idle check and controller silence', async () => {
  const sampler = fakeSampler()
  const a = await agent({ createMachineSampler: sampler.factory, controllerTimeoutMs: 300 })
  const tele: AgentTelemetry[] = []
  const pool = await connectAgents([{ address: addr(a), name: 'x' }], {
    token: TOKEN, harnessGit: HARNESS.git!, log: () => {}, onTelemetry: t => tele.push(t), heartbeatMs: 100
  })
  pool.startTelemetry(20)
  await until(() => tele.length >= 2)
  assert.equal(tele[0]!.agent, 'x')
  assert.equal(tele[0]!.saturated, true)
  pool.startTelemetry(0)
  const idle = await pool.idleCheckAll({ durationSec: 1 })
  assert.equal(idle['x']!.ok, true)
  assert.equal((idle['x'] as { samples?: unknown }).samples, undefined)
  // heartbeats (100 ms) keep a 300 ms controller timeout from firing
  await new Promise(r => setTimeout(r, 600))
  assert.equal(pool.agents[0]!.alive, true)
  await pool.close()
  await a.close()

  // a controller that authenticates and then goes quiet is dropped
  const b = await agent({ controllerTimeoutMs: 200 })
  const lost: string[] = []
  const quiet = await connectAgents([{ address: addr(b) }], { token: TOKEN, harnessGit: HARNESS.git!, log: () => {}, heartbeatMs: 60_000, onLink: e => lost.push(e.event) })
  await until(() => lost.includes('lost'), 3000)
  await quiet.close()
  await b.close()
})

test('agent ignores unknown frames and kills workers on link loss', async () => {
  FakeWorker.all = []
  const a = await agent()
  const sock: Socket = connect(a.address.port, '127.0.0.1')
  const got: Array<Record<string, unknown>> = []
  const link = frameLink(sock, {
    onFrame: f => {
      got.push(f)
      if (f.type === 'challenge') link.send({ type: 'auth', mac: authMac(TOKEN, String(f.nonce)), protocol: 1, harnessGit: HARNESS.git })
      if (f.type === 'hello') {
        link.send({ type: 'future-thing', x: 1 })
        link.send({ type: 'spawn', workerId: 7 })
      }
    },
    onClose: () => {}
  })
  await until(() => got.some(f => f.type === 'spawned'))
  assert.equal(FakeWorker.all.length, 1)
  link.close('test')
  await until(() => FakeWorker.all[0]!.killed)
  await a.close()
})
