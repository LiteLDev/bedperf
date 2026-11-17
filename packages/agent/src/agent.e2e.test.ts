// Two agents (real loadgen worker processes) against a real BDS. Run with BEDPERF_E2E=1.
// testkit is not a declared dependency of this package, so it is imported by relative path (tests only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BotFleet, IDLE_SCENARIO, type FleetStats } from '@bedperf/loadgen'
import { startAgent } from './agent.ts'
import { connectAgents } from './client.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const BDS_PORT = 19310
const TOKEN = 'e2e-secret'

test('fleet on two agents against a real BDS; losing one agent keeps the fleet running on the other', { skip: !e2e, timeout: 300_000 }, async () => {
  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: BDS_PORT, properties: { 'max-players': 50 } })
  const log = (l: string): void => { if (process.env.BEDPERF_E2E_VERBOSE) console.log(l) }
  const alpha = await startAgent({ listen: { host: '127.0.0.1', port: 19312 }, token: TOKEN, name: 'alpha', log })
  const beta = await startAgent({ listen: { host: '127.0.0.1', port: 19313 }, token: TOKEN, name: 'beta', log })
  const pool = await connectAgents([{ address: '127.0.0.1:19312' }, { address: '127.0.0.1:19313' }], { token: TOKEN, log })
  const factory = pool.workerFactory()
  const fleet = new BotFleet({
    spawnWorker: (id, o) => {
      const l = factory(id, o)
      l.onMessage(m => { if (m.type === 'bot' && (m.event === 'fail' || m.event === 'disconnect')) console.log(`[${l.agent}] bot ${m.index} ${m.event}: ${m.reason}`) })
      return l
    }
  })
  const online = async (): Promise<number> => {
    const p = bds.waitForLine(/There are \d+\/\d+ players online/, 5000)
    bds.send('list')
    return Number(/There are (\d+)\//.exec(await p)![1])
  }
  const stats: FleetStats[] = []
  fleet.onStats(s => { stats.push(s); console.log(`spawned=${s.spawned} disc=${s.unexpectedDisconnects} fail=${s.joinFailures} agents=${JSON.stringify(s.loadgen.agents)}`) })
  try {
    const link = await pool.measureLink(5)
    console.log('link', JSON.stringify(link))
    assert.ok(link['alpha']!.rttMs.median < 50)
    await fleet.start({
      host: '127.0.0.1', port: BDS_PORT, version: '1.26.60', scenarioModule: IDLE_SCENARIO, scenarioName: 'idle',
      botsPerWorker: 2, joinIntervalMs: 100, usernamePrefix: 'ag', seed: 1, statsIntervalMs: 2000, onLog: (w, l) => log(`w${w} ${l}`)
    })
    await fleet.scaleTo(10, 120_000)
    assert.equal(fleet.snapshot().spawned, 10, JSON.stringify(fleet.snapshot()))
    assert.deepEqual(fleet.pids(), [])
    await new Promise(r => setTimeout(r, 4500))
    const s = fleet.emitStats()
    const slices = Object.fromEntries((s.loadgen.agents ?? []).map(a => [a.agent, a]))
    assert.ok(slices['alpha']!.workers >= 2 && slices['beta']!.workers >= 2, JSON.stringify(s.loadgen.agents))
    assert.equal(slices['alpha']!.bots + slices['beta']!.bots, 10)
    const alphaBots = slices['alpha']!.bots

    // abrupt loss of alpha
    await alpha.close()
    const t0 = Date.now()
    while (fleet.snapshot().spawned > 10 - alphaBots && Date.now() - t0 < 15_000) await new Promise(r => setTimeout(r, 100))
    const snap = fleet.snapshot()
    assert.equal(snap.spawned, 10 - alphaBots)
    assert.equal(snap.unexpectedDisconnects + snap.joinFailures, alphaBots)
    assert.equal(pool.agents.find(a => a.name === 'alpha')!.alive, false)

    // the killed bots linger on the server until it times them out; rejoining under the same names before that fails
    const t1 = Date.now()
    while (await online() > 10 - alphaBots && Date.now() - t1 < 90_000) await new Promise(r => setTimeout(r, 2000))
    console.log(`server dropped the lost agent's bots after ${Date.now() - t1} ms`)
    // the fleet keeps working on beta
    await fleet.scaleTo(10, 120_000)
    assert.equal(fleet.snapshot().spawned, 10, JSON.stringify(fleet.snapshot()))
    const after = fleet.emitStats()
    assert.deepEqual(after.loadgen.agents?.map(a => a.agent), ['beta'])
    // the server sees 10 players again
    assert.equal(await online(), 10)
  } finally {
    await fleet.stop()
    await pool.close()
    await alpha.close()
    await beta.close()
    await bds.stop()
  }
})
