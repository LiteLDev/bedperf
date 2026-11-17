import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BotFleet, type BotFleetOptions, type WorkerLink } from './index.ts'
import { aggregateStats, DEFAULT_SATURATION, type FleetStats } from './aggregate.ts'
import type { ControllerMessage, WorkerMessage, WorkerStats } from './protocol.ts'

type Behavior = (w: FakeWorker, msg: ControllerMessage) => void

let order = 0

class FakeWorker implements WorkerLink {
  id: number
  sent: Array<{ at: number, order: number, msg: ControllerMessage }> = []
  behavior: Behavior
  private msgCb: ((m: WorkerMessage) => void) | null = null
  private exitCb: ((code: number | null) => void) | null = null
  exited = false
  constructor (id: number, behavior: Behavior) {
    this.id = id
    this.behavior = behavior
  }

  send (msg: ControllerMessage): void {
    if (this.exited) throw new Error('channel closed')
    this.sent.push({ at: Date.now(), order: order++, msg })
    setImmediate(() => this.behavior(this, msg))
  }

  onMessage (cb: (m: WorkerMessage) => void): void { this.msgCb = cb }
  onExit (cb: (code: number | null) => void): void { this.exitCb = cb }
  kill (): void { this.exit(null) }
  emit (m: WorkerMessage): void { if (!this.exited) this.msgCb?.(m) }
  exit (code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCb?.(code)
  }

  joins (): number[] { return this.sent.flatMap(s => s.msg.type === 'join' ? [s.msg.index] : []) }
  leaves (): number[] { return this.sent.flatMap(s => s.msg.type === 'leave' ? [s.msg.index] : []) }
}

/** Well-behaved worker: ready on init, spawns every join, leaves on request, exits on stop. */
const happy: Behavior = (w, msg) => {
  switch (msg.type) {
    case 'init': w.emit({ type: 'ready', workerId: w.id }); break
    case 'join':
      w.emit({ type: 'bot', event: 'connect', index: msg.index, seq: msg.seq })
      w.emit({ type: 'bot', event: 'spawn', index: msg.index, seq: msg.seq, joinLatencyMs: 100 })
      break
    case 'leave': w.emit({ type: 'bot', event: 'left', index: msg.index, seq: msg.seq }); break
    case 'stop': w.emit({ type: 'stopped', workerId: w.id }); w.exit(0); break
  }
}

function setup (behavior: Behavior = happy, extra: Partial<BotFleetOptions> = {}): { fleet: BotFleet, workers: FakeWorker[], opts: BotFleetOptions } {
  const workers: FakeWorker[] = []
  const fleet = new BotFleet({
    spawnWorker: id => {
      const w = new FakeWorker(id, behavior)
      workers.push(w)
      return w
    }
  })
  const opts: BotFleetOptions = {
    host: '127.0.0.1',
    port: 1,
    version: '1.26.60',
    scenarioModule: 'fake',
    botsPerWorker: 10,
    joinIntervalMs: 2,
    usernamePrefix: 'b',
    seed: 1,
    statsIntervalMs: 60_000,
    onLog: () => {},
    ...extra
  }
  return { fleet, workers, opts }
}

test('start waits for worker 0 and rejects on fatal', async () => {
  const ok = setup()
  await ok.fleet.start(ok.opts)
  assert.equal(ok.workers.length, 1)
  assert.equal(ok.workers[0]!.sent[0]!.msg.type, 'init')
  await ok.fleet.stop()

  const bad = setup((w, msg) => {
    if (msg.type === 'init') { w.emit({ type: 'fatal', workerId: w.id, error: 'no scenario' }); w.exit(2) }
  })
  await assert.rejects(bad.fleet.start(bad.opts), /no scenario/)
})

test('scale up assigns indices to workers in order and spawns lazily', async () => {
  const { fleet, workers, opts } = setup()
  await fleet.start(opts)
  await fleet.scaleTo(25, 5000)
  assert.equal(workers.length, 3)
  assert.deepEqual(workers[0]!.joins(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(workers[1]!.joins(), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  assert.deepEqual(workers[2]!.joins(), [20, 21, 22, 23, 24])
  const s = fleet.snapshot()
  assert.equal(s.spawned, 25)
  assert.equal(s.connected, 25)
  assert.equal(s.workers, 3)
  await fleet.stop()
})

test('joins are staggered globally by joinIntervalMs', async () => {
  const { fleet, workers, opts } = setup(happy, { joinIntervalMs: 25 })
  await fleet.start(opts)
  await fleet.scaleTo(6, 5000)
  const times = workers.flatMap(w => w.sent.filter(s => s.msg.type === 'join').map(s => s.at)).sort((a, b) => a - b)
  assert.equal(times.length, 6)
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 20, `gap ${times[i]! - times[i - 1]!}`)
  await fleet.stop()
})

test('scale down leaves highest indices first, then scale up re-joins', async () => {
  const { fleet, workers, opts } = setup()
  await fleet.start(opts)
  await fleet.scaleTo(25, 5000)
  await fleet.scaleTo(12, 5000)
  const leaves = workers
    .flatMap(w => w.sent.filter(s => s.msg.type === 'leave').map(s => ({ i: (s.msg as { index: number }).index, order: s.order })))
    .sort((a, b) => a.order - b.order)
  assert.deepEqual(leaves.map(l => l.i), [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12])
  let s = fleet.snapshot()
  assert.equal(s.spawned, 12)
  assert.equal(s.unexpectedDisconnects, 0)
  assert.equal(s.joinFailures, 0)
  assert.deepEqual(fleet.indices('spawned'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(s.workers, 2) // worker 2 has no bots left and is retired
  await new Promise(r => setImmediate(r))
  assert.ok(workers[2]!.exited)

  await fleet.scaleTo(14, 5000)
  s = fleet.snapshot()
  assert.equal(s.spawned, 14)
  assert.deepEqual(workers[1]!.joins().slice(-2), [12, 13])
  await fleet.stop()
})

test('failures, unexpected disconnects and stale events', async () => {
  // bots with odd index fail to join
  const behavior: Behavior = (w, msg) => {
    if (msg.type === 'join' && msg.index % 2 === 1) {
      w.emit({ type: 'bot', event: 'fail', index: msg.index, seq: msg.seq, reason: 'kicked' })
      return
    }
    happy(w, msg)
  }
  const { fleet, workers, opts } = setup(behavior)
  await fleet.start(opts)
  await fleet.scaleTo(6, 5000) // resolves once every bot settled, even though some failed
  let s = fleet.snapshot()
  assert.equal(s.spawned, 3)
  assert.equal(s.joinFailures, 3)

  // stale seq is ignored
  workers[0]!.emit({ type: 'bot', event: 'disconnect', index: 0, seq: 9999, reason: 'old' })
  assert.equal(fleet.snapshot().unexpectedDisconnects, 0)
  // a real disconnect counts
  const seq0 = (workers[0]!.sent.find(x => x.msg.type === 'join' && x.msg.index === 0)!.msg as { seq: number }).seq
  workers[0]!.emit({ type: 'bot', event: 'disconnect', index: 0, seq: seq0, reason: 'kicked' })
  s = fleet.snapshot()
  assert.equal(s.unexpectedDisconnects, 1)
  assert.equal(s.spawned, 2)

  // scaleTo retries free indices below the target
  workers[0]!.behavior = happy
  await fleet.scaleTo(6, 5000)
  assert.equal(fleet.snapshot().spawned, 6)
  await fleet.stop()
})

test('worker crash is reported as failures, not a controller crash; the worker is re-forked on demand', async () => {
  // worker 1 never spawns its bots (until healed)
  let healed = false
  const behavior: Behavior = (w, msg) => {
    if (!healed && w.id === 1 && msg.type === 'join') {
      w.emit({ type: 'bot', event: 'connect', index: msg.index, seq: msg.seq })
      return
    }
    happy(w, msg)
  }
  const { fleet, workers, opts } = setup(behavior, { botsPerWorker: 2 })
  await fleet.start(opts)
  await fleet.scaleTo(4, 200) // times out: bots 2, 3 never spawn
  let s = fleet.snapshot()
  assert.equal(s.spawned, 2)
  assert.equal(s.joining, 2)
  assert.equal(s.connected, 4)

  workers[0]!.exit(1) // two spawned bots lost
  workers[1]!.exit(1) // two joining bots lost
  s = fleet.snapshot()
  assert.equal(s.spawned, 0)
  assert.equal(s.unexpectedDisconnects, 2)
  assert.equal(s.joinFailures, 2)
  assert.equal(s.workers, 0)

  healed = true
  await fleet.scaleTo(4, 5000)
  s = fleet.snapshot()
  assert.equal(s.spawned, 4)
  assert.equal(s.workers, 2)
  assert.equal(workers.length, 4) // two crashed + two replacements
  await fleet.stop()
})

test('stats: aggregation from worker reports and saturation flag', async () => {
  const { fleet, workers, opts } = setup()
  await fleet.start(opts)
  await fleet.scaleTo(15, 5000)
  const got: FleetStats[] = []
  fleet.onStats(s => got.push(s))
  const rep = (workerId: number, over: Partial<WorkerStats>): WorkerStats => ({
    type: 'stats', workerId, intervalMs: 1000, bots: 0, joinLatencyMs: [], rttMs: [], corrections: 0, rxBytes: 0, eventLoopP99Ms: 1, mainThreadCpuPct: 10, cpuPct: 10, rssBytes: 1e8, ...over
  })
  workers[0]!.emit(rep(0, { bots: 10, joinLatencyMs: [100, 200], rttMs: [10, 20, 30], corrections: 4, rxBytes: 1000, mainThreadCpuPct: 40, cpuPct: 120 }))
  workers[1]!.emit(rep(1, { bots: 5, joinLatencyMs: [300], rttMs: [40], corrections: 2, rxBytes: 500, mainThreadCpuPct: 20, cpuPct: 60, eventLoopP99Ms: 12 }))
  const s = fleet.emitStats()
  assert.equal(got.length, 1)
  assert.equal(s.target, 15)
  assert.equal(s.spawned, 15)
  assert.equal(s.loadgen.workers, 2)
  assert.equal(s.loadgen.bots, 15)
  assert.equal(s.loadgen.maxWorkerCpuPct, 40)
  assert.equal(s.loadgen.maxWorkerProcessCpuPct, 120) // GC threads do not count towards saturation
  assert.equal(s.loadgen.totalCpuPct, 180)
  assert.equal(s.loadgen.eventLoopLagP99Ms, 12)
  assert.equal(s.loadgen.saturated, false)
  assert.equal(s.joinLatencyMs?.n, 3)
  assert.equal(s.joinLatencyMs?.p50, 200)
  assert.equal(s.rttMs?.n, 4)
  assert.equal(s.rttMs?.max, 40)
  assert.equal(s.rttMs?.mean, 25)
  assert.ok(s.correctionsPerSec !== undefined && s.correctionsPerSec > 0)

  // next interval: no samples → no summaries; latest reports still drive the self-check
  workers[1]!.emit(rep(1, { mainThreadCpuPct: 95 }))
  const s2 = fleet.emitStats()
  assert.equal(s2.joinLatencyMs, undefined)
  assert.equal(s2.rttMs, undefined)
  assert.equal(s2.loadgen.saturated, true)
  await fleet.stop()
})

test('aggregateStats merges samples across workers and flags saturation', () => {
  const r = (over: Partial<WorkerStats>): WorkerStats => ({
    type: 'stats', workerId: 0, intervalMs: 1000, bots: 1, joinLatencyMs: [], rttMs: [], corrections: 0, rxBytes: 0, eventLoopP99Ms: 0, mainThreadCpuPct: 0, cpuPct: 0, rssBytes: 0, ...over
  })
  const base = {
    t: 1, target: 2, connected: 2, spawned: 2, joinFailures: 0, unexpectedDisconnects: 0,
    elapsedMs: 2000, thresholds: DEFAULT_SATURATION, staleMs: 10_000
  }
  const a = r({ rttMs: [1, 2, 3, 4], corrections: 10, rxBytes: 4000 })
  const b = r({ workerId: 1, rttMs: [5, 6, 7, 8, 9, 10], corrections: 2, rxBytes: 2000, eventLoopP99Ms: 51 })
  const s = aggregateStats({ ...base, reports: [a, b], workers: [{ latest: a, sinceMs: 0 }, { latest: b, sinceMs: 0 }] })
  assert.equal(s.rttMs?.n, 10)
  assert.equal(s.rttMs?.min, 1)
  assert.equal(s.rttMs?.max, 10)
  assert.equal(s.rttMs?.mean, 5.5)
  assert.equal(s.rttMs?.p50, 5.5)
  assert.ok(Math.abs(s.rttMs!.p95 - 9.55) < 1e-9)
  assert.equal(s.correctionsPerSec, 6)
  assert.equal(s.rxBytesPerSec, 3000)
  assert.equal(s.loadgen.saturated, true) // lag 51 > 50

  const ok = aggregateStats({ ...base, reports: [], workers: [{ latest: a, sinceMs: 0 }] })
  assert.equal(ok.loadgen.saturated, false)
  assert.equal(ok.correctionsPerSec, undefined)

  const stale = aggregateStats({ ...base, reports: [], workers: [{ sinceMs: 20_000 }] })
  assert.equal(stale.loadgen.staleWorkers, 1)
  assert.equal(stale.loadgen.saturated, true)
})

test('a bot that fails while leaving is re-queued when its index is wanted again', async () => {
  // joins hang; a leave answers with a late `fail` of the joining bot instead of `left`
  let hang = true
  const behavior: Behavior = (w, msg) => {
    if (msg.type === 'join' && hang) return
    if (msg.type === 'leave') { w.emit({ type: 'bot', event: 'fail', index: msg.index, seq: msg.seq, reason: 'timeout' }); return }
    happy(w, msg)
  }
  const { fleet, opts } = setup(behavior)
  await fleet.start(opts)
  await fleet.scaleTo(3, 50)
  hang = false
  const down = fleet.scaleTo(1, 100)
  const up = fleet.scaleTo(3, 100)
  await Promise.all([down, up])
  const s = fleet.snapshot()
  assert.deepEqual(fleet.indices('spawned'), [1, 2]) // re-joined after the failed leave
  assert.deepEqual(fleet.indices('joining'), [0]) // its first join still hangs
  assert.equal(s.joinFailures, 0) // failures of bots we asked to leave are not counted
  await fleet.stop()
})

test('scaleTo resolves on timeout when bots never spawn', async () => {
  const { fleet, opts } = setup((w, msg) => { if (msg.type !== 'join') happy(w, msg) })
  await fleet.start(opts)
  const t0 = Date.now()
  await fleet.scaleTo(3, 150)
  assert.ok(Date.now() - t0 >= 140)
  assert.equal(fleet.snapshot().joining, 3)
  await fleet.stop()
})

test('pids() lists live workers and onWorkerSpawn sees every fork; forceFullChunks reaches the worker init', async () => {
  const workers: FakeWorker[] = []
  const fleet = new BotFleet({
    spawnWorker: id => {
      const w = new FakeWorker(id, happy)
      ;(w as { pid?: number }).pid = 1000 + workers.length
      workers.push(w)
      return w
    }
  })
  const spawned: number[] = []
  fleet.onWorkerSpawn(pid => spawned.push(pid))
  const base = setup().opts
  await fleet.start({ ...base, scenarioParams: { forceFullChunks: true } })
  await fleet.scaleTo(15, 5000)
  assert.deepEqual(fleet.pids().sort(), [1000, 1001])
  assert.deepEqual(spawned, [1000, 1001])
  const init = workers[0]!.sent[0]!.msg
  assert.ok(init.type === 'init' && init.init.forceFullChunks === true)
  workers[1]!.exit(1)
  assert.deepEqual(fleet.pids(), [1000])
  await fleet.stop()
  assert.deepEqual(fleet.pids(), [])
})

function workerStats (workerId: number, extra: Partial<WorkerStats> = {}): WorkerStats {
  return {
    type: 'stats', workerId, intervalMs: 1000, bots: 5, joinLatencyMs: [], rttMs: [], corrections: 0, rxBytes: 0,
    eventLoopP99Ms: 10, mainThreadCpuPct: 20, cpuPct: 40, rssBytes: 1, ...extra
  }
}

test('aggregateStats: per-agent slices when workers carry an agent label; external saturation ORs in', () => {
  const base = {
    t: 0, target: 10, connected: 10, spawned: 10, joinFailures: 0, unexpectedDisconnects: 0, elapsedMs: 1000, reports: [],
    thresholds: DEFAULT_SATURATION, staleMs: 5000
  }
  const local = aggregateStats({ ...base, workers: [{ latest: workerStats(0), sinceMs: 0 }] })
  assert.equal(local.loadgen.agents, undefined)
  assert.equal(local.loadgen.saturated, false)

  const s = aggregateStats({
    ...base,
    workers: [
      { latest: workerStats(0), sinceMs: 0, agent: 'b' },
      { latest: workerStats(1, { eventLoopP99Ms: 30, cpuPct: 60 }), sinceMs: 0, agent: 'b' },
      { latest: workerStats(2, { mainThreadCpuPct: 95 }), sinceMs: 0, agent: 'a' }
    ]
  })
  assert.deepEqual(s.loadgen.agents, [
    { agent: 'a', workers: 1, bots: 5, totalCores: 0.4, eventLoopLagP99Ms: 10, maxWorkerCpuPct: 95, saturated: true },
    { agent: 'b', workers: 2, bots: 10, totalCores: 1, eventLoopLagP99Ms: 30, maxWorkerCpuPct: 20, saturated: false }
  ])
  assert.equal(s.loadgen.saturated, true)

  const ext = aggregateStats({
    ...base,
    workers: [{ latest: workerStats(0), sinceMs: 0, agent: 'b' }],
    externalSaturation: { b: ['busy 95% of 8 CPUs'] }
  })
  assert.equal(ext.loadgen.saturated, true)
  assert.equal(ext.loadgen.agents?.[0]?.saturated, true)
})

test('remote links: agent label reaches stats, no pid reported, setExternalSaturation marks and clears', async () => {
  const workers: FakeWorker[] = []
  const fleet = new BotFleet({
    spawnWorker: id => {
      const w = new FakeWorker(id, (wk, msg) => {
        happy(wk, msg)
        if (msg.type === 'join') wk.emit(workerStats(wk.id, { bots: 1 }))
      })
      ;(w as { agent?: string }).agent = id % 2 === 0 ? 'even' : 'odd'
      workers.push(w)
      return w
    }
  })
  const spawned: number[] = []
  fleet.onWorkerSpawn(pid => spawned.push(pid))
  const base = setup().opts
  await fleet.start({ ...base, botsPerWorker: 2, scenarioName: 'idle' })
  const init = workers[0]!.sent[0]!.msg
  assert.ok(init.type === 'init' && init.init.scenarioName === 'idle')
  await fleet.scaleTo(4, 5000)
  assert.deepEqual(fleet.pids(), [])
  assert.deepEqual(spawned, [])
  let s = fleet.emitStats()
  assert.deepEqual(s.loadgen.agents?.map(a => [a.agent, a.workers]), [['even', 1], ['odd', 1]])
  assert.equal(s.loadgen.saturated, false)
  fleet.setExternalSaturation('odd', ['foreign load 3 cores'])
  s = fleet.emitStats()
  assert.equal(s.loadgen.saturated, true)
  assert.equal(s.loadgen.agents?.find(a => a.agent === 'odd')?.saturated, true)
  fleet.setExternalSaturation('odd', [])
  assert.equal(fleet.emitStats().loadgen.saturated, false)
  await fleet.stop()
})

test('connectRetries: a join whose transport never connected is retried; one that connected is not', async () => {
  const attempts = new Map<number, number>()
  const behavior: Behavior = (w, msg) => {
    if (msg.type === 'join') {
      const n = (attempts.get(msg.index) ?? 0) + 1
      attempts.set(msg.index, n)
      // bot 1: two connect timeouts, then fine; bot 2: always times out; bot 3: connects, then fails before spawn
      if ((msg.index === 1 && n <= 2) || msg.index === 2) {
        w.emit({ type: 'bot', event: 'fail', index: msg.index, seq: msg.seq, reason: 'error: Connect timed out' })
        return
      }
      if (msg.index === 3) {
        w.emit({ type: 'bot', event: 'connect', index: msg.index, seq: msg.seq })
        w.emit({ type: 'bot', event: 'fail', index: msg.index, seq: msg.seq, reason: 'kicked' })
        return
      }
    }
    happy(w, msg)
  }
  const logs: string[] = []
  const { fleet, opts } = setup(behavior, { connectRetries: 2, onLog: (_w, l) => logs.push(l) })
  await fleet.start(opts)
  await fleet.scaleTo(4, 5000)
  const s = fleet.snapshot()
  assert.deepEqual(fleet.indices('spawned'), [0, 1])
  assert.equal(s.joinFailures, 2) // bot 2 after its retries, bot 3 at once
  assert.equal(attempts.get(1), 3)
  assert.equal(attempts.get(2), 3)
  assert.equal(attempts.get(3), 1)
  assert.equal(fleet.emitStats().connectRetries, 4)
  assert.ok(logs.some(l => /bot 2: connect failed \(error: Connect timed out\), retry 2\/2/.test(l)), logs.join('\n'))
  assert.ok(logs.some(l => /bot 3: join failed: kicked/.test(l)), logs.join('\n'))
  await fleet.stop()

  // without the option nothing is retried and stats carry no connectRetries
  attempts.clear()
  const plain = setup(behavior)
  await plain.fleet.start(plain.opts)
  await plain.fleet.scaleTo(4, 5000)
  assert.equal(plain.fleet.snapshot().joinFailures, 3)
  assert.equal(plain.fleet.emitStats().connectRetries, undefined)
  await plain.fleet.stop()
})
