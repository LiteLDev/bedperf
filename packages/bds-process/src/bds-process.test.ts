import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { encodeProbeLine, type BdsInstance, type GametimeSample, type PlayerEvent, type ProbeRecord } from '@bedperf/core'
import { BdsProcess, BdsStartError, BdsCommandError, affinityCommand, type BdsProcessOptions } from './bds-process.ts'
import { GametimeSampler } from './gametime-sampler.ts'

const TS = '[2026-11-16 16:15:28:495 INFO]'

/** Minimal stand-in for a ChildProcess running BDS. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 4242
  received: string[] = []
  killedWith: string[] = []
  dead = false
  /** Reply to console input; default handles `stop`. */
  onCommand: (cmd: string) => void = cmd => { if (cmd === 'stop') this.quit() }

  constructor () {
    super()
    this.stdin.setEncoding('utf8')
    let buf = ''
    this.stdin.on('data', (c: string) => {
      buf += c
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i)
        buf = buf.slice(i + 1)
        this.received.push(cmd)
        this.onCommand(cmd)
      }
    })
  }

  out (...lines: string[]): void {
    for (const l of lines) this.stdout.write(l + '\r\n')
  }

  quit (code: number | null = 0, signal: string | null = null): void {
    if (this.dead) return
    this.dead = true
    setImmediate(() => {
      this.out('Quit correctly')
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', code, signal)
      setImmediate(() => this.emit('close', code, signal))
    })
  }

  kill (signal = 'SIGTERM'): boolean {
    this.killedWith.push(signal)
    this.quit(null, signal)
    return true
  }
}

const instance: BdsInstance = { dir: '/srv/bds', version: '1.26.63.1', platform: 'linux', port: 19132, portV6: 19133, levelName: 'w' }

function setup (opts: BdsProcessOptions = {}): { bds: BdsProcess, child: FakeChild, spawned: Array<{ cmd: string, opts: SpawnOptions }> } {
  const child = new FakeChild()
  const spawned: Array<{ cmd: string, opts: SpawnOptions }> = []
  const bds = new BdsProcess(instance, {
    ...opts,
    spawn: (cmd, _args, o) => { spawned.push({ cmd, opts: o }); return child as unknown as ChildProcess }
  })
  return { bds, child, spawned }
}

async function started (opts: BdsProcessOptions = {}): Promise<ReturnType<typeof setup>> {
  const s = setup(opts)
  const p = s.bds.start()
  s.child.out(`${TS} Starting Server`, `${TS} Server started.`)
  await p
  return s
}

const tick = (): Promise<void> => new Promise(r => setImmediate(r))

test('start resolves on "Server started." and spawns with cwd/env/windowsHide', async () => {
  const { bds, child, spawned } = setup()
  let ready = 0
  bds.on('ready', () => { ready++ })
  const p = bds.start({ readyTimeoutMs: 1000 })
  assert.equal(bds.pid, 4242)
  child.out(`${TS} Starting Server`)
  // Split a line across chunks to exercise buffering.
  child.stdout.write(`${TS} Server sta`)
  child.stdout.write('rted.\r\n')
  await p
  assert.equal(ready, 1)
  assert.ok(bds.ready)
  assert.equal(spawned[0]!.cmd, join('/srv/bds', 'bedrock_server'))
  assert.equal(spawned[0]!.opts.cwd, '/srv/bds')
  assert.equal(spawned[0]!.opts.windowsHide, true)
  assert.equal((spawned[0]!.opts.env as NodeJS.ProcessEnv).LD_LIBRARY_PATH, '/srv/bds')
  await bds.stop()
})

test('Windows instance spawns bedrock_server.exe without LD_LIBRARY_PATH override', async () => {
  const child = new FakeChild()
  let cmd = ''
  const bds = new BdsProcess({ ...instance, platform: 'win', dir: 'C:\\bds' }, {
    spawn: (c) => { cmd = c; return child as unknown as ChildProcess }
  })
  const p = bds.start()
  child.out(`${TS} Server started.`)
  await p
  assert.equal(cmd, join('C:\\bds', 'bedrock_server.exe'))
  await bds.stop()
})

test('start rejects on timeout with the output tail and kills the process', async () => {
  const { bds, child } = setup({ tailLines: 2 })
  const p = bds.start({ readyTimeoutMs: 50 })
  child.out('a', '', 'b', 'c')
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BdsStartError)
    assert.equal(err.reason, 'timeout')
    assert.deepEqual(err.tail, ['b', 'c'])
    assert.match(err.message, /last BDS output[\s\S]*b\nc/)
    return true
  })
  assert.deepEqual(child.killedWith, ['SIGKILL'])
  assert.equal(bds.running, false)
})

test('start rejects promptly on port in use', async () => {
  const { bds, child } = setup()
  const exits: boolean[] = []
  bds.on('exit', i => { exits.push(i.expected) })
  const p = bds.start({ readyTimeoutMs: 60_000 })
  child.out(`[2026-11-16 16:20:12:699 ERROR] Port [19132] may be in use by another process.`)
  await assert.rejects(p, (err: unknown) => err instanceof BdsStartError && err.reason === 'portInUse')
  assert.deepEqual(exits, [true])
})

test('start rejects on early exit', async () => {
  const { bds, child } = setup()
  const p = bds.start({ readyTimeoutMs: 60_000 })
  child.out('crash!')
  child.quit(3)
  await assert.rejects(p, (err: unknown) => err instanceof BdsStartError && err.reason === 'exit' && /code 3/.test(err.message))
})

test('start rejects on spawn error', async () => {
  const { bds, child } = setup()
  child.pid = undefined
  const p = bds.start()
  child.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(p, (err: unknown) => err instanceof BdsStartError && err.reason === 'spawn' && /ENOENT/.test(err.message))
  assert.equal(bds.running, false)
})

test('start twice while running throws', async () => {
  const { bds } = await started()
  await assert.rejects(bds.start(), /already running/)
  await bds.stop()
})

test('events: line (incl. blank), playerJoin, playerLeave, probe', async () => {
  const { bds, child } = await started()
  const lines: string[] = []
  const joins: PlayerEvent[] = []
  const leaves: PlayerEvent[] = []
  const probes: ProbeRecord[] = []
  bds.on('line', (l, s) => { lines.push(`${s}:${l}`) })
  bds.on('playerJoin', p => joins.push(p))
  bds.on('playerLeave', p => leaves.push(p))
  bds.on('probe', r => probes.push(r))
  const mark: ProbeRecord = { type: 'mark', v: 1, tick: 1, t: 2, label: 'x' }
  child.out(
    `${TS} Player connected: bot1, xuid: 123`,
    `${TS} [Scripting] ${encodeProbeLine(mark)}`,
    '',
    `${TS} Player disconnected: bot1, xuid: 123, pfid: abc`
  )
  child.stderr.write('oops\n')
  await tick()
  assert.deepEqual(joins, [{ name: 'bot1', xuid: '123' }])
  assert.deepEqual(leaves, [{ name: 'bot1', xuid: '123' }])
  assert.deepEqual(probes, [mark])
  assert.ok(lines.includes('stdout:'))
  assert.ok(lines.includes('stderr:oops'))
  assert.ok(lines.every(l => !l.includes('\r')))
  await bds.stop()
})

test('command collects until match, skipping blank and probe lines', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'list') {
      child.out(`${TS} ${encodeProbeLine({ type: 'pong', v: 1, tick: 1, t: 1, id: 'p' })}`, '', `${TS} There are 0/10 players online:`, '')
    } else if (cmd === 'stop') child.quit()
  }
  const lines = await bds.command('list', /players online/)
  assert.deepEqual(lines, [`${TS} There are 0/10 players online:`])
  await bds.stop()
})

test('concurrent commands are serialised', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    // Reply asynchronously; the second command must not be written before the first completes.
    setTimeout(() => child.out(`reply ${cmd}`), 20)
  }
  const a = bds.command('a', /reply a/)
  const b = bds.command('b', /reply b/)
  await tick()
  assert.deepEqual(child.received, ['a'])
  assert.deepEqual(await a, ['reply a'])
  assert.deepEqual(await b, ['reply b'])
  assert.deepEqual(child.received, ['a', 'b'])
  await bds.stop()
})

test('command timeout rejects and does not block the queue', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'slow') child.out('partial')
    else if (cmd === 'fast') child.out('done')
    else if (cmd === 'stop') child.quit()
  }
  const slow = bds.command('slow', /never/, 30)
  const fast = bds.command('fast', /done/, 1000)
  await assert.rejects(slow, (err: unknown) => err instanceof BdsCommandError && err.lines[0] === 'partial')
  assert.deepEqual(await fast, ['done'])
  await bds.stop()
})

test('command when not running rejects', async () => {
  const { bds } = setup()
  await assert.rejects(bds.command('list', /x/), /not running/)
})

test('command rejects when the process exits mid-command', async () => {
  const { bds, child } = await started()
  child.onCommand = () => { child.quit(1) }
  await assert.rejects(bds.command('boom', /never/), /exited before the command completed/)
})

test('stop is graceful, idempotent and emits exit{expected:true}', async () => {
  const { bds, child } = await started()
  const exits: Array<{ expected: boolean, code: number | null }> = []
  bds.on('exit', i => exits.push(i))
  const a = bds.stop()
  const b = bds.stop()
  assert.equal(a, b)
  await a
  await bds.stop()
  assert.deepEqual(child.received, ['stop'])
  assert.deepEqual(child.killedWith, [])
  assert.equal(exits.length, 1)
  assert.equal(exits[0]!.expected, true)
  assert.equal(exits[0]!.code, 0)
  assert.equal(bds.pid, undefined)
})

test('stop kills after timeout', async () => {
  const { bds, child } = await started()
  child.onCommand = () => {} // ignore `stop`
  await bds.stop(30)
  assert.deepEqual(child.killedWith, ['SIGKILL'])
})

test('unrequested exit emits exit{expected:false}', async () => {
  const { bds, child } = await started()
  const done = new Promise<{ expected: boolean, signal: string | null }>(resolve => bds.once('exit', resolve))
  child.quit(null, 'SIGKILL')
  const info = await done
  assert.equal(info.expected, false)
  assert.equal(info.signal, 'SIGKILL')
  assert.equal(bds.running, false)
})

test('restart after stop works', async () => {
  const children = [new FakeChild(), new FakeChild()]
  let n = 0
  const bds = new BdsProcess(instance, { spawn: () => children[n++] as unknown as ChildProcess })
  for (const c of children) {
    const p = bds.start()
    c.out('Server started.')
    await p
    await bds.stop()
  }
  assert.equal(n, 2)
})

test('listPlayers parses header and names line', async () => {
  const { bds, child } = await started()
  let online = 2
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    if (online === 0) child.out(`${TS} There are 0/10 players online:`, '')
    else child.out(`${TS} There are 2/10 players online:`, `${TS} Player Spawned: x xuid: , pfid: `, 'stray output', 'alice, bob smith')
  }
  assert.deepEqual(await bds.listPlayers(), { online: 2, max: 10, names: ['alice', 'bob smith'] })
  online = 0
  assert.deepEqual(await bds.listPlayers(), { online: 0, max: 10, names: [] })
  await bds.stop()
})

test('setGamerule resolves on success, rejects on syntax error', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    if (cmd === 'gamerule randomtickspeed 3') child.out(`${TS} Game rule randomtickspeed has been updated to 3`)
    else child.out('[2026-11-16 16:19:38:764 ERROR] Syntax error: Unexpected "bogus": at "/gamerule >>bogus<< 1"')
  }
  await bds.setGamerule('randomtickspeed', 3)
  await assert.rejects(bds.setGamerule('bogus', 1), /Syntax error/)
  await bds.stop()
})

test('op / opAll / say', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    if (cmd === 'op alice') child.out(`[2026-11-16 16:19:49:057 ERROR] Missing id, won't persist permissions on disk.`, `${TS} Opped: alice`)
    else if (cmd === 'op "bob smith"') child.out('[2026-11-16 16:19:49:863 ERROR] Could not op: bob smith')
    else if (cmd === 'op nobody') child.out('[2026-11-16 16:19:40:377 ERROR] No targets matched selector')
    else if (cmd === 'op @a') child.out(`${TS} Opped: alice`)
  }
  assert.equal(await bds.op('alice'), true)
  assert.equal(await bds.op('bob smith'), false)
  await assert.rejects(bds.op('nobody'), /No targets matched/)
  assert.deepEqual(await bds.opAll(), [`${TS} Opped: alice`])
  await bds.say('hello world')
  assert.equal(child.received.at(-1), 'say hello world')
  await bds.stop()
})

test('send rejects multi-line commands', async () => {
  const { bds } = await started()
  assert.throws(() => bds.send('a\nb'), /single line/)
  await bds.stop()
})

test('logFile tees every line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bedperf-bdsproc-'))
  try {
    const file = join(dir, 'runs', 'x', 'bds.log')
    const { bds, child } = await started({ logFile: file })
    child.out('hello', '')
    await bds.stop()
    await new Promise(r => setTimeout(r, 50))
    assert.equal(readFileSync(file, 'utf8'), `${TS} Starting Server\n${TS} Server started.\nhello\n\nQuit correctly\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('affinity / priority failures become warnings, not errors', async () => {
  const warnings: string[] = []
  const s = setup({ affinity: [], priority: 'normal' })
  s.bds.on('warning', w => warnings.push(w))
  const p = s.bds.start()
  s.child.out('Server started.')
  await p
  assert.ok(warnings.some(w => /affinity/.test(w)), warnings.join('\n'))
  await s.bds.stop()
})

test('command until may be anchored to the message', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    child.out(`${TS} There are 0/10 players online:`)
  }
  assert.equal((await bds.command('list', /^There are \d+/)).length, 1)
  await bds.stop()
})

test('events from a previous child do not affect the restarted server', async () => {
  const a = new FakeChild()
  const b = new FakeChild()
  const kids = [a, b]
  let n = 0
  const bds = new BdsProcess(instance, { spawn: () => kids[n++] as unknown as ChildProcess })
  const exits: boolean[] = []
  bds.on('exit', i => { exits.push(i.expected) })
  let p = bds.start()
  a.out('Server started.')
  await p
  a.quit(1)
  await new Promise<void>(resolve => bds.once('exit', () => resolve()))
  p = bds.start()
  b.out('Server started.')
  await p
  // Stale events of A (as after a 'close' fallback) must be ignored.
  a.emit('exit', 1, null)
  a.emit('close', 1, null)
  a.emit('error', new Error('stale'))
  await tick()
  assert.ok(bds.running)
  assert.equal(bds.pid, 4242)
  assert.deepEqual(exits, [false])
  await bds.stop()
  assert.deepEqual(exits, [false, true])
})

test('exit without close: pid is cleared and start() waits for the run to end', async () => {
  const a = new FakeChild()
  const b = new FakeChild()
  const kids = [a, b]
  let n = 0
  const bds = new BdsProcess(instance, { spawn: () => kids[n++] as unknown as ChildProcess })
  let p = bds.start()
  a.out('Server started.')
  await p
  a.dead = true
  a.emit('exit', 1, null)
  assert.equal(bds.pid, undefined)
  assert.throws(() => bds.send('list'), /not running/)
  p = bds.start()
  await tick()
  assert.equal(n, 1) // not spawned yet
  a.emit('close', 1, null)
  await tick()
  assert.equal(n, 2)
  b.out('Server started.')
  await p
  await bds.stop()
})

test('stop kills immediately when stdin is not writable', async () => {
  const { bds, child } = await started()
  child.onCommand = () => {}
  child.stdin.destroy()
  const t0 = Date.now()
  await bds.stop(60_000)
  assert.ok(Date.now() - t0 < 1000)
  assert.deepEqual(child.killedWith, ['SIGKILL'])
})

test('LD_LIBRARY_PATH is prepended, not replaced', async () => {
  const { bds, child, spawned } = setup({ env: { LD_LIBRARY_PATH: '/opt/lib' } })
  const p = bds.start()
  child.out('Server started.')
  await p
  assert.equal((spawned[0]!.opts.env as NodeJS.ProcessEnv).LD_LIBRARY_PATH, '/srv/bds:/opt/lib')
  await bds.stop()
})

test('affinityCommand', () => {
  assert.deepEqual(affinityCommand(10, [0, 2, 3], 'linux'), ['taskset', ['-a', '-p', '-c', '0,2,3', '10']])
  const [file, args] = affinityCommand(10, [0, 2, 3], 'win')
  assert.equal(file, 'powershell.exe')
  assert.match(args.at(-1)!, /\(Get-Process -Id 10\)\.ProcessorAffinity = \[IntPtr\]\[long\]13$/)
  assert.throws(() => affinityCommand(1, [], 'linux'), /empty/)
  assert.throws(() => affinityCommand(1, [63], 'win'), /outside/)
  assert.throws(() => affinityCommand(1, [-1], 'linux'), /invalid/)
})

test('priority lane: queued priority jobs run before queued normal ones, never preempting', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    setTimeout(() => child.out(`reply ${cmd}`), 10)
  }
  const a = bds.command('a', /reply a/)
  const b = bds.command('b', /reply b/)
  const p1 = bds.sendQueued('p1', { priority: true })
  const q = bds.queryGametime({ priority: true, timeoutMs: 50 }).catch(() => 'timeout')
  const c = bds.command('c', /reply c/)
  await Promise.all([a, b, p1, q, c])
  // `a` was already running; p1 and the gametime query jump ahead of b and c.
  assert.deepEqual(child.received, ['a', 'p1', 'time query gametime', 'b', 'c'])
  await bds.stop()
})

test('sendQueued resolves with the send time and rejects when not running', async () => {
  const { bds, child } = await started()
  const before = performance.timeOrigin + performance.now()
  let stamped = Number.NaN
  const at = await bds.sendQueued('say x', { onSent: t => { stamped = t } })
  assert.equal(at, stamped)
  assert.ok(at >= before && at <= performance.timeOrigin + performance.now())
  assert.deepEqual(child.received, ['say x'])
  await bds.stop()
  await assert.rejects(bds.sendQueued('say y', { priority: true }), /not running/)
})

test('queryGametime parses the reply and stamps sentAt <= recvAt', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    if (cmd === 'time query gametime') {
      setTimeout(() => child.out(`${TS} Player connected: x, xuid: `, `${TS} Gametime is 4711`), 15)
    }
  }
  const r = await bds.queryGametime()
  assert.equal(r.gametime, 4711)
  assert.ok(r.recvAt - r.sentAt >= 10, `latency ${r.recvAt - r.sentAt}`)
  child.onCommand = cmd => {
    if (cmd === 'stop') child.quit()
    else child.out('[2026-11-16 16:15:28:495 ERROR] Unknown command: time. Please check that the command exists and that you have permission to use it.')
  }
  await assert.rejects(bds.queryGametime(), (err: unknown) => err instanceof BdsCommandError && /Unknown command/.test(err.message))
  child.onCommand = cmd => { if (cmd === 'stop') child.quit() }
  await assert.rejects(bds.queryGametime({ timeoutMs: 20 }), /no matching output/)
  await bds.stop()
})

test('normal commands do not collect stray gametime replies', async () => {
  const { bds, child } = await started()
  child.onCommand = cmd => {
    if (cmd === 'stop') child.quit()
    else if (cmd === 'list') child.out(`${TS} Gametime is 77`, `${TS} There are 0/10 players online:`)
  }
  assert.deepEqual(await bds.command('list', /./), [`${TS} There are 0/10 players online:`])
  await bds.stop()
})

test('GametimeSampler over BdsProcess: replies pair with sends', async () => {
  const { bds, child } = await started()
  let g = 100
  child.onCommand = cmd => {
    if (cmd === 'stop') { child.quit(); return }
    if (cmd === 'time query gametime') { g += 20; setTimeout(() => child.out(`${TS} Gametime is ${g}`), 5) }
  }
  const sampler = new GametimeSampler(bds, { intervalMs: 30 })
  const samples: GametimeSample[] = []
  sampler.on('sample', s => { samples.push(s) })
  sampler.start()
  await new Promise(r => setTimeout(r, 200))
  await sampler.stop()
  assert.ok(samples.length >= 4, `got ${samples.length}`)
  assert.equal(sampler.lost, 0)
  assert.equal(sampler.unmatched, 0)
  assert.deepEqual(samples.map(s => s.gametime), samples.map((_, i) => 120 + 20 * i))
  for (const s of samples) assert.ok(s.latencyMs >= 0 && s.t === s.sentAt + s.latencyMs)
  await bds.stop()
})
