// End-to-end check against a real BDS (BEDPERF_E2E=1): every scenario runs 30 s with 3 bots.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot } from 'bedboo'
import { createTestBot, startTestBds, type TestBds } from '../../testkit/src/index.ts'
import { loadScenario, type ScenarioName } from './index.ts'
import { command, ABORTED } from './common.ts'
import { defaults as walkDefaults } from './scenarios/walk.ts'
import { seeded } from './fake-bot.test-util.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const PORT = 19260
const RUN_MS = Number(process.env.BEDPERF_E2E_RUN_MS ?? 30_000)
const BOTS = 3

function dirSize (dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return n
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface Outcome { bots: Bot[], ended: boolean[], logs: string[], start: Array<{ x: number, y: number, z: number }> }

async function runScenario (bds: TestBds, name: ScenarioName, params: Record<string, unknown>, label: string,
  before?: (bots: Bot[]) => void): Promise<Outcome> {
  const s = await loadScenario(name)
  for (const c of s.serverSetup?.(params) ?? []) bds.send(c)
  await sleep(1000)
  const bots: Bot[] = []
  const ended: boolean[] = []
  const logs: string[] = []
  for (let i = 0; i < BOTS; i++) {
    const { version: _ignored, ...botOpts } = s.botOptions?.(params) ?? {}
    const bot = await createTestBot({ ...botOpts, port: PORT, username: `u6${label}${i}` })
    ended[i] = false
    bot.on('end', () => { ended[i] = true })
    bots.push(bot)
  }
  const start = bots.map(b => ({ x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z }))
  before?.(bots)
  const ac = new AbortController()
  const runs = bots.map((bot, i) => s.run(bot, {
    index: i,
    params,
    random: seeded(42 + i),
    log: m => { logs.push(`[${i}] ${m}`) }
  }, ac.signal))
  await sleep(RUN_MS)
  const t0 = Date.now()
  ac.abort()
  await Promise.all(runs)
  const stopMs = Date.now() - t0
  assert.ok(stopMs < 2000, `${label}: run took ${stopMs} ms to return after abort`)
  return { bots, ended, logs, start }
}

function finish (label: string, o: Outcome, results: string[], extra: string): void {
  assert.deepEqual(o.ended, o.bots.map(() => false), `${label}: a bot disconnected during the run`)
  for (const b of o.bots) b.end()
  results.push(`| ${label} | ${o.bots.length} | ${extra} |`)
  console.log(`--- ${label} logs\n${o.logs.join('\n')}`)
}

test('e2e: every scenario runs 30 s with 3 bots on real BDS', { skip: !e2e, timeout: 20 * 60_000 }, async () => {
  const bds = await startTestBds({ port: PORT, properties: { 'default-player-permission-level': 'operator' } })
  const results: string[] = ['| scenario | bots | result |', '|---|---|---|']
  try {
    // idle
    {
      const o = await runScenario(bds, 'idle', {}, 'idle')
      const moved = o.bots.map((b, i) => Math.hypot(b.entity.position.x - o.start[i]!.x, b.entity.position.z - o.start[i]!.z))
      finish('idle', o, results, `connected throughout; max drift ${Math.max(...moved).toFixed(2)} blocks`)
    }
    // walk
    {
      const path = [0, 0, 0]
      const o = await runScenario(bds, 'walk', {}, 'walk', bots => {
        bots.forEach((b, i) => {
          let last = { x: b.entity.position.x, z: b.entity.position.z }
          b.on('move', () => {
            const p = b.entity.position
            path[i]! += Math.hypot(p.x - last.x, p.z - last.z)
            last = { x: p.x, z: p.z }
          })
        })
      })
      const moved = o.bots.map((b, i) => Math.hypot(b.entity.position.x - o.start[i]!.x, b.entity.position.z - o.start[i]!.z))
      for (const d of path) assert.ok(d > 20, `walk: a bot walked only ${d.toFixed(1)} blocks`)
      for (const m of moved) assert.ok(m <= walkDefaults.radius + 8, `walk: a bot left the radius (${m.toFixed(1)})`)
      finish('walk', o, results, `path walked ${path.map(d => d.toFixed(0)).join(', ')} blocks; final distance from spawn ${moved.map(m => m.toFixed(1)).join(', ')} (radius ${walkDefaults.radius})`)
    }
    // explore
    {
      const db = join(bds.dir, 'worlds', 'bedperf', 'db')
      const before = dirSize(db)
      const o = await runScenario(bds, 'explore', {}, 'explore')
      await sleep(2000)
      const after = dirSize(db)
      const dist = o.bots.map((b, i) => Math.hypot(b.entity.position.x - o.start[i]!.x, b.entity.position.z - o.start[i]!.z))
      for (const d of dist) assert.ok(d > 64, `explore: a bot is only ${d.toFixed(0)} blocks from its start`)
      finish('explore', o, results, `distance from start ${dist.map(d => d.toFixed(0)).join(', ')} blocks; world db ${(before / 1e6).toFixed(1)} → ${(after / 1e6).toFixed(1)} MB`)
    }
    // build (client packets, then commands)
    for (const mode of ['client', 'command'] as const) {
      const updates = [0, 0, 0]
      const o = await runScenario(bds, 'build', { mode }, `build${mode}`, bots => {
        bots.forEach((b, i) => b.on('blockUpdate', (_old, nw) => { if (nw && nw.position.y === 200) updates[i]!++ }))
      })
      const summaries = o.logs.filter(l => /build: \d+ placed/.test(l))
      for (const u of updates) assert.ok(u > 10, `build ${mode}: only ${u} block updates seen`)
      finish(`build (${mode})`, o, results, `block updates seen per bot: ${updates.join(', ')}; ${summaries.map(s => s.replace(/^\[\d\] build: /, '')).join(' / ')}`)
    }
    // chat
    {
      const received = [0, 0, 0]
      const o = await runScenario(bds, 'chat', { intervalSec: 2 }, 'chat', bots => {
        bots.forEach((b, i) => b.on('chat', (username) => { if (username !== b.username) received[i]!++ }))
      })
      for (const r of received) assert.ok(r > 5, `chat: a bot received only ${r} messages from others`)
      finish('chat', o, results, `messages received from other bots: ${received.join(', ')}`)
    }
    // mobs
    {
      const o = await runScenario(bds, 'mobs', {}, 'mobs')
      const r = await command(o.bots[0]!, 'testfor @e[type=zombie]', new AbortController().signal)
      const n = r === ABORTED ? 0 : r.successCount
      assert.ok(n > 0, 'mobs: no zombies')
      const attacks = o.logs.filter(l => /mobs: \d+ attacks/.test(l)).map(l => l.replace(/^\[\d\] mobs: /, ''))
      finish('mobs', o, results, `${n} zombies alive at the end; ${attacks.join(', ')}; health ${o.bots.map(b => b.health).join(', ')}`)
    }
    // entity-stress
    {
      const o = await runScenario(bds, 'entity-stress', { count: 30, maintainSec: 5 }, 'estress')
      const r = await command(o.bots[0]!, 'testfor @e[name=bpstress]', new AbortController().signal)
      const n = r === ABORTED ? 0 : r.successCount
      assert.ok(n >= 25, `entity-stress: only ${n} entities`)
      finish('entity-stress', o, results, `${n}/30 tagged zombies in the pen`)
    }
  } finally {
    console.log(results.join('\n'))
    await bds.stop()
  }
})
