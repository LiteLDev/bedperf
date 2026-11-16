// Real-BDS test. Runs only when BEDPERF_E2E=1 (needs the BDS cache; see the repo README).
// testkit is imported by path: it is a test-only helper and not a declared dependency of this package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { REQUIRED_BOT_PROPERTIES, type BdsInstance, type PlayerEvent } from '@bedperf/core'
import { makeInstanceDir, writeServerProperties, createTestBot, DEFAULT_BDS_VERSION } from '../../testkit/src/index.ts'
import { BdsProcess, BdsStartError } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const PORT = 19220

function prepare (): BdsInstance {
  const dir = makeInstanceDir()
  writeServerProperties(dir, {
    ...REQUIRED_BOT_PROPERTIES,
    'server-port': PORT,
    'server-portv6': PORT + 1,
    'level-name': 'bedperf',
    'default-player-permission-level': 'operator'
  })
  return { dir, version: DEFAULT_BDS_VERSION, platform: process.platform === 'win32' ? 'win' : 'linux', port: PORT, portV6: PORT + 1, levelName: 'bedperf' }
}

async function removeDir (dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch { await new Promise(r => setTimeout(r, 500)) }
  }
}

function waitEvent<T> (bds: BdsProcess, event: 'playerJoin' | 'playerLeave', pred: (p: PlayerEvent) => boolean, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bds.off(event, on); reject(new Error(`no ${event} within ${timeoutMs} ms`)) }, timeoutMs)
    const on = (p: PlayerEvent): void => { if (pred(p)) { clearTimeout(timer); bds.off(event, on); resolve(p as T) } }
    bds.on(event, on)
  })
}

test('BdsProcess drives a real BDS', { skip: !e2e, timeout: 600_000 }, async () => {
  const inst = prepare()
  const second = prepare()
  const bds = new BdsProcess(inst, { logFile: `${inst.dir}/bds-e2e.log`, affinity: [0, 1], priority: 'below_normal' })
  const warnings: string[] = []
  bds.on('warning', w => { warnings.push(w) })
  const other = new BdsProcess(second)
  try {
    // start/stop 3 times on the same controller
    for (let i = 0; i < 3; i++) {
      const exits: boolean[] = []
      const onExit = (x: { expected: boolean }): void => { exits.push(x.expected) }
      bds.on('exit', onExit)
      await bds.start({ readyTimeoutMs: 120_000 })
      assert.ok(bds.pid)
      const lines = await bds.command('list', /players online/)
      assert.match(lines.at(-1)!, /There are 0\/\d+ players online/)
      await bds.stop()
      await bds.stop() // idempotent
      bds.off('exit', onExit)
      assert.deepEqual(exits, [true])
      assert.equal(bds.pid, undefined)
    }

    await bds.start()
    assert.deepEqual(warnings, [])

    // helpers
    await bds.setGamerule('randomtickspeed', 3)
    await assert.rejects(bds.setGamerule('bogus', 1), /Syntax error/)
    await bds.say('hello from e2e')

    // join / leave
    const joined = waitEvent<PlayerEvent>(bds, 'playerJoin', p => p.name === 'u2bot', 30_000)
    const bot = await createTestBot({ port: PORT, username: 'u2bot' })
    assert.equal((await joined).name, 'u2bot')
    const listed = await bds.listPlayers()
    assert.equal(listed.online, 1)
    assert.deepEqual(listed.names, ['u2bot'])
    assert.equal(typeof await bds.op('u2bot'), 'boolean')
    assert.ok((await bds.opAll()).length > 0)
    const left = waitEvent<PlayerEvent>(bds, 'playerLeave', p => p.name === 'u2bot', 30_000)
    bot.end()
    assert.equal((await left).name, 'u2bot')

    // port in use: a second instance on the same port must fail promptly
    const t0 = Date.now()
    await assert.rejects(other.start({ readyTimeoutMs: 60_000 }), (err: unknown) => err instanceof BdsStartError && err.reason === 'portInUse')
    assert.ok(Date.now() - t0 < 30_000, `port-in-use took ${Date.now() - t0} ms`)
    assert.equal(other.running, false)

    // crash detection: external kill
    const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
    process.kill(bds.pid!, 'SIGKILL')
    assert.equal((await exit).expected, false)
    assert.equal(bds.running, false)
  } finally {
    await bds.stop()
    await other.stop()
    await removeDir(inst.dir)
    await removeDir(second.dir)
  }
})
