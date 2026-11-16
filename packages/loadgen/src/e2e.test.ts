// End-to-end check against a real BDS (Windows dev box). Run with BEDPERF_E2E=1.
// testkit is not a declared dependency of this package, so it is imported by relative path (tests only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BotFleet, forkWorker, IDLE_SCENARIO, type FleetStats } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const PORT = 19250

function alive (pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function fmt (s: FleetStats): string {
  const sum = (x?: { n: number, p50: number, p95: number, max: number }): string =>
    x ? `n=${x.n} p50=${x.p50.toFixed(0)} p95=${x.p95.toFixed(0)} max=${x.max.toFixed(0)}` : '-'
  const l = s.loadgen
  return `target=${s.target} conn=${s.connected} spawned=${s.spawned} fail=${s.joinFailures} disc=${s.unexpectedDisconnects}` +
    ` join[${sum(s.joinLatencyMs)}] rtt[${sum(s.rttMs)}] corr/s=${s.correctionsPerSec?.toFixed(2) ?? '-'}` +
    ` rxKB/s=${s.rxBytesPerSec !== undefined ? (s.rxBytesPerSec / 1024).toFixed(1) : '-'}` +
    ` | workers=${l.workers} bots=${l.bots} cpu(js max/proc max/total)=${l.maxWorkerCpuPct.toFixed(0)}/${l.maxWorkerProcessCpuPct.toFixed(0)}/${l.totalCpuPct.toFixed(0)}%` +
    ` lagP99=${l.eventLoopLagP99Ms.toFixed(1)}ms rss=${(l.rssBytes / 2 ** 20).toFixed(0)}MB sat=${l.saturated}`
}

test('fleet scales a real BDS up to 30 bots and back down to 10', { skip: !e2e, timeout: 300_000 }, async () => {
  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({
    port: PORT,
    properties: { 'default-player-permission-level': 'operator', 'max-players': 100 }
  })
  const pids: number[] = []
  const fleet = new BotFleet({
    spawnWorker: (id, o) => {
      const link = forkWorker(id, o)
      if (link.pid !== undefined) pids.push(link.pid)
      return link
    }
  })
  const stats: FleetStats[] = []
  fleet.onStats(s => { stats.push(s); console.log(fmt(s)) })
  try {
    await fleet.start({
      host: '127.0.0.1',
      port: PORT,
      version: '1.26.60',
      scenarioModule: IDLE_SCENARIO,
      botsPerWorker: 10,
      joinIntervalMs: 100,
      usernamePrefix: 'lg',
      seed: 1,
      statsIntervalMs: 2000,
      rtt: { intervalMs: 2000 }
    })

    await fleet.scaleTo(30, 90_000)
    let snap = fleet.snapshot()
    assert.equal(snap.spawned, 30, JSON.stringify(snap))
    assert.equal(snap.workers, 3)
    assert.equal(snap.joinFailures, 0)

    // steady state: let the RTT probes and per-bot CPU settle
    const steadyFrom = stats.length
    await new Promise(r => setTimeout(r, 20_000))
    const steady = stats.slice(steadyFrom + 1)
    assert.ok(steady.length >= 3)
    assert.ok(stats.some(s => s.joinLatencyMs && s.joinLatencyMs.n > 0), 'join latency summary')
    assert.ok(steady.some(s => s.rttMs && s.rttMs.n > 0), 'rtt summary')
    const cpuPerBot = steady.reduce((a, s) => a + s.loadgen.totalCpuPct / s.loadgen.bots, 0) / steady.length
    const jsCpuPerBot = steady.reduce((a, s) => a + s.loadgen.maxWorkerCpuPct / 10, 0) / steady.length
    const rssPerWorker = steady.reduce((a, s) => a + s.loadgen.rssBytes / s.loadgen.workers, 0) / steady.length
    console.log(`steady @30 bots: process cpu/bot=${cpuPerBot.toFixed(1)}% of a core, max js-thread cpu/bot=${jsCpuPerBot.toFixed(1)}%, rss/worker(10 bots)=${(rssPerWorker / 2 ** 20).toFixed(0)}MB`)

    const before = bds.lines.filter(l => /Player disconnected: lg\d+/.test(l)).length
    await fleet.scaleTo(10, 30_000)
    snap = fleet.snapshot()
    assert.equal(snap.spawned, 10, JSON.stringify(snap))
    assert.deepEqual(fleet.indices('spawned'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(snap.unexpectedDisconnects, 0)
    await new Promise(r => setTimeout(r, 3000))
    const gone = bds.lines.filter(l => /Player disconnected: lg\d+/.test(l)).slice(before)
    assert.equal(gone.length, 20, gone.join('\n'))
    assert.ok(gone.every(l => Number(/lg(\d+)/.exec(l)![1]) >= 10))
  } finally {
    await fleet.stop()
    await bds.stop()
  }
  assert.equal(pids.length, 3)
  await new Promise(r => setTimeout(r, 500))
  assert.deepEqual(pids.filter(alive), [], 'orphan worker processes')
})
