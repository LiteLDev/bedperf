import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { encodeProbeLine, type BdsInstance, type GametimeSample, type LaunchSpec, type PlayerEvent, type ProbeRecord } from '@bedperf/core'
import { BdsProcess, BdsStartError, BdsCommandError, affinityCommand, vanillaLaunchSpec, wineserverBin, type BdsProcessOptions } from './bds-process.ts'
import { GametimeSampler } from './gametime-sampler.ts'
import type { ProcessHost, ProcInfo } from './proctree.ts'

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

// ---- Launchers (LaunchSpec): game-process resolution, tree kill, Wine cleanup ----

class FakeHost implements ProcessHost {
  readonly platform: NodeJS.Platform
  procs: ProcInfo[] = []
  live = new Set<number>()
  signals: Array<[number, string]> = []
  execs: Array<{ file: string, args: string[], env?: Record<string, string> }> = []
  listCalls = 0
  onExec: (file: string, args: string[]) => void = () => {}
  constructor (platform: NodeJS.Platform) { this.platform = platform }
  async list (): Promise<ProcInfo[]> { this.listCalls++; return this.procs }
  async envVar (): Promise<string | undefined> { return undefined }
  uid (): number { return 1000 }
  alive (pid: number): boolean { return this.live.has(pid) }
  signal (pid: number, sig: NodeJS.Signals): void { this.signals.push([pid, sig]); this.live.delete(pid) }
  async exec (file: string, args: string[], env?: Record<string, string>): Promise<void> {
    const e: { file: string, args: string[], env?: Record<string, string> } = { file, args }
    if (env !== undefined) e.env = env
    this.execs.push(e)
    this.onExec(file, args)
  }
}

const ES_SPEC: LaunchSpec = {
  command: '/srv/es/venv/bin/endstone',
  args: ['-y', '-s', '/srv/es/server', '--no-interactive'],
  cwd: '/srv/es',
  env: { FOO: '1' },
  serverProcess: { namePattern: '^bedrock_server(\\.exe)?$' },
  killTree: true,
  stopCommand: 'stop'
}

function launcherSetup (platform: NodeJS.Platform, launch: LaunchSpec, opts: BdsProcessOptions = {}): { bds: BdsProcess, child: FakeChild, host: FakeHost, spawned: Array<{ cmd: string, args: readonly string[], opts: SpawnOptions }> } {
  const child = new FakeChild()
  const host = new FakeHost(platform)
  host.procs = [{ pid: 4242, ppid: 1, name: 'endstone', start: 100 }]
  host.live.add(4242)
  const spawned: Array<{ cmd: string, args: readonly string[], opts: SpawnOptions }> = []
  const bds = new BdsProcess(instance, {
    serverPidPollMs: 2,
    ...opts,
    launch,
    processHost: host,
    spawn: (cmd, args, o) => { spawned.push({ cmd, args, opts: o }); return child as unknown as ChildProcess }
  })
  child.on('exit', () => { host.live.delete(4242) })
  return { bds, child, host, spawned }
}

/** The launcher's grandchild (the game) appears. */
function spawnGame (host: FakeHost, pid = 4300, name = 'bedrock_server'): void {
  host.procs = [...host.procs, { pid: 4250, ppid: 4242, name: 'python3', start: 101 }, { pid, ppid: 4250, name, start: 102 }]
  host.live.add(pid)
}

test('vanilla default: the spawned process is the game process, no process-table lookups', async () => {
  const host = new FakeHost('linux')
  const child = new FakeChild()
  const pids: number[] = []
  const bds = new BdsProcess(instance, { processHost: host, spawn: () => child as unknown as ChildProcess })
  bds.on('serverPid', pid => { pids.push(pid) })
  const p = bds.start()
  assert.equal(bds.serverPid, 4242)
  assert.equal(bds.launcherPid, 4242)
  child.out(`${TS} Server started.`)
  await p
  assert.deepEqual(pids, [4242])
  assert.equal(host.listCalls, 0)
  assert.deepEqual(vanillaLaunchSpec(instance, {}), {
    command: join('/srv/bds', 'bedrock_server'),
    args: [],
    cwd: '/srv/bds',
    env: { LD_LIBRARY_PATH: '/srv/bds' },
    serverProcess: { namePattern: '^bedrock_server(\\.exe)?$' },
    killTree: false
  })
  await bds.stop()
  assert.equal(bds.serverPid, undefined)
  assert.deepEqual(host.signals, [])
})

test('launcher: spawns the spec, start waits for the game process, pid reports it', async () => {
  const { bds, child, host, spawned } = launcherSetup('linux', ES_SPEC)
  const events: number[] = []
  bds.on('serverPid', pid => { events.push(pid) })
  let done = false
  const p = bds.start().then(() => { done = true })
  assert.equal(bds.pid, 4242) // the launcher until the game process is known
  assert.equal(bds.serverPid, undefined)
  child.out('[10:36:53 INFO]: Server started.')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(done, false, 'start must wait for the game process')
  spawnGame(host)
  await p
  assert.deepEqual(events, [4300])
  assert.equal(bds.pid, 4300)
  assert.equal(bds.serverPid, 4300)
  assert.equal(bds.launcherPid, 4242)
  assert.equal(spawned[0]!.cmd, ES_SPEC.command)
  assert.deepEqual(spawned[0]!.args, ES_SPEC.args)
  assert.equal(spawned[0]!.opts.cwd, '/srv/es')
  assert.equal(spawned[0]!.opts.detached, true)
  assert.equal((spawned[0]!.opts.env as NodeJS.ProcessEnv).FOO, '1')

  // Graceful stop: the game exits, then the launcher; only the (empty) process group is signalled.
  child.onCommand = cmd => { if (cmd === 'stop') { host.live.delete(4300); child.quit() } }
  const exits: boolean[] = []
  bds.on('exit', x => { exits.push(x.expected) })
  await bds.stop()
  assert.deepEqual(exits, [true])
  assert.deepEqual(child.received, ['stop'])
  assert.deepEqual(host.signals, [[-4242, 'SIGKILL']])
  assert.equal(bds.pid, undefined)
})

test('launcher: custom stopCommand; a Windows spawn is not detached', async () => {
  const { bds, child, host, spawned } = launcherSetup('win32', { ...ES_SPEC, stopCommand: 'quit' })
  const p = bds.start()
  spawnGame(host, 4300, 'bedrock_server.exe')
  child.out('[10:36:53 INFO]: Server started.')
  await p
  assert.equal(spawned[0]!.opts.detached, undefined)
  child.onCommand = cmd => { if (cmd === 'quit') { host.live.delete(4300); child.quit() } }
  await bds.stop()
  assert.deepEqual(child.received, ['quit'])
  assert.deepEqual(host.execs, [])
})

test('launcher: "Server started" but no matching process fails with noServerProcess and kills the tree', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC, { serverPidGraceMs: 30 })
  const p = bds.start()
  child.out('[10:36:53 INFO]: Server started.')
  await assert.rejects(p, (err: unknown) => err instanceof BdsStartError && err.reason === 'noServerProcess' && /bedrock_server/.test(err.message))
  assert.ok(host.signals.some(([pid]) => pid === -4242))
  assert.deepEqual(child.killedWith, ['SIGKILL'])
  assert.equal(bds.running, false)
})

test('launcher on Windows: kill() runs taskkill /T on the launcher and kills the game pid', async () => {
  const { bds, child, host } = launcherSetup('win32', ES_SPEC)
  host.onExec = (file) => { if (file === 'taskkill') child.quit(null, 'SIGKILL') }
  const p = bds.start()
  spawnGame(host, 4300, 'bedrock_server.exe')
  child.out('[10:36:53 INFO]: Server started.')
  await p
  await bds.kill()
  assert.deepEqual(host.execs, [{ file: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }])
  assert.deepEqual(host.signals, [[4300, 'SIGKILL']])
})

test('launcher exits while the game process still runs: the game is killed, exit is unexpected', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC)
  const warnings: string[] = []
  bds.on('warning', w => { warnings.push(w) })
  const p = bds.start()
  spawnGame(host)
  child.out('[10:36:53 INFO]: Server started.')
  await p
  const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
  child.quit(1)
  assert.equal((await exit).expected, false)
  assert.ok(host.signals.some(([pid, sig]) => pid === 4300 && sig === 'SIGKILL'))
  assert.ok(warnings.some(w => /game process 4300 was still running/.test(w)), warnings.join('\n'))
})

test('graceful stop: a launcher exiting first does not kill the game while it saves', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC)
  const p = bds.start()
  spawnGame(host)
  child.out('[10:36:53 INFO]: Server started.')
  await p
  child.onCommand = cmd => {
    if (cmd !== 'stop') return
    child.quit() // the launcher exits right away; the game needs a moment longer
    setTimeout(() => { host.live.delete(4300) }, 300)
  }
  const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
  await bds.stop()
  assert.equal((await exit).expected, true)
  assert.ok(!host.signals.some(([pid]) => pid === 4300), JSON.stringify(host.signals))
  assert.ok(host.signals.some(([pid]) => pid === -4242))
})

test('graceful stop: a game outliving its launcher past the stop timeout is killed', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC)
  const p = bds.start()
  spawnGame(host)
  child.out('[10:36:53 INFO]: Server started.')
  await p
  child.onCommand = cmd => { if (cmd === 'stop') child.quit() }
  const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
  await bds.stop(50)
  assert.equal((await exit).expected, true)
  assert.ok(host.signals.some(([pid, sig]) => pid === 4300 && sig === 'SIGKILL'))
  assert.equal(host.live.has(4300), false)
})

test('launcher: the ready timeout stops counting once "Server started" was printed', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC, { readyTimeoutMs: 40, serverPidGraceMs: 500 })
  const p = bds.start()
  child.out('[10:36:53 INFO]: Server started.')
  await new Promise(r => setTimeout(r, 80))
  spawnGame(host)
  await p
  assert.equal(bds.serverPid, 4300)
  child.onCommand = cmd => { if (cmd === 'stop') { host.live.delete(4300); child.quit() } }
  await bds.stop()
})

test('listPlayers: loaders put their prefix on the names line too', async () => {
  const { bds, child, host } = launcherSetup('win32', { ...ES_SPEC, command: 'C:\\ll\\bedrock_server_mod.exe', serverProcess: { namePattern: '^bedrock_server_mod\\.exe$' } })
  const p = bds.start()
  child.out('10:34:37.034 IFO [Server] Server started in (1.6s)! For help, type "help" or "?"')
  await p
  assert.equal(host.listCalls, 0)
  child.onCommand = cmd => {
    if (cmd === 'stop') child.quit()
    else if (cmd === 'list') child.out('10:34:38.574 IFO [Server] There are 2/10 players online:', '10:34:38.574 IFO [Server] bot1, bot2')
  }
  assert.deepEqual(await bds.listPlayers(), { online: 2, max: 10, names: ['bot1', 'bot2'] })
  await bds.stop()
})

test('game process dies while the launcher lives: the launcher is killed (crash detection)', async () => {
  const { bds, child, host } = launcherSetup('linux', ES_SPEC, { orphanLauncherMs: 20 })
  const p = bds.start()
  spawnGame(host)
  child.out('[10:36:53 INFO]: Server started.')
  await p
  const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
  host.live.delete(4300)
  assert.equal((await exit).expected, false)
  assert.deepEqual(child.killedWith, ['SIGKILL'])
  assert.ok(host.signals.some(([pid]) => pid === -4242))
})

test('wine: the game is the spawned process itself (argv0 match), wineserver -k on exit, auxPids', async () => {
  const wine: LaunchSpec = {
    command: '/opt/wine/bin/wine',
    args: ['bedrock_server_mod.exe'],
    cwd: '/srv/ll',
    env: { WINEPREFIX: '/srv/ll/.lip/wine', WINEDEBUG: '-all' },
    serverProcess: { namePattern: '^bedrock_server_mod\\.exe$' },
    auxProcessPatterns: ['^wineserver$'],
    killTree: true,
    wine: { prefix: '/srv/ll/.lip/wine', wineBin: '/opt/wine/bin/wine' }
  }
  const { bds, child, host } = launcherSetup('linux', wine)
  host.procs = [
    { pid: 4242, ppid: 1, name: 'bedrock_server_', argv0: 'bedrock_server_mod.exe', start: 100, uid: 1000 },
    { pid: 60, ppid: 1, name: 'wineserver', start: 101, uid: 1000 }
  ]
  const p = bds.start()
  child.out('10:34:37.034 IFO [Server] Server started in (1.6s)! For help, type "help" or "?"')
  await p
  assert.equal(bds.serverPid, 4242)
  assert.equal(bds.launcherPid, 4242)
  assert.deepEqual(await bds.auxPids(), [60])
  await bds.stop()
  assert.deepEqual(host.execs, [{ file: '/opt/wine/bin/wineserver', args: ['-k'], env: { WINEPREFIX: '/srv/ll/.lip/wine' } }])
  assert.equal(wineserverBin({ prefix: '/p', wineBin: 'wine' }), 'wineserver')
  assert.equal(wineserverBin({ prefix: '/p', wineBin: '/w/wine', wineserverBin: '/x/ws' }), '/x/ws')
})
