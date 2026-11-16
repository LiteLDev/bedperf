import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { GametimeSample } from '@bedperf/core'
import { GametimeSampler, type GametimeSource } from './gametime-sampler.ts'

const TS = '[2026-11-16 16:15:28:495 INFO]'

/** A source whose sends are written immediately (or fail) and whose output the test drives. */
class FakeSource implements GametimeSource {
  readonly lines = new EventEmitter()
  sends: Array<{ command: string, priority: boolean }> = []
  clock = 1000
  fail = false
  /** When set, sends stay queued until `flush()`. */
  hold = false
  private held: Array<() => void> = []

  sendQueued (command: string, opts: { priority?: boolean, onSent?: (sentAt: number) => void } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const write = (): void => {
        if (this.fail) { reject(new Error('BDS is not running')); return }
        this.sends.push({ command, priority: opts.priority === true })
        opts.onSent?.(this.clock)
        resolve(this.clock)
      }
      if (this.hold) this.held.push(write)
      else write()
    })
  }

  flush (): void {
    const h = this.held
    this.held = []
    for (const w of h) w()
  }

  on (event: 'line', l: (line: string, stream: 'stdout' | 'stderr') => void): this { this.lines.on(event, l); return this }
  off (event: 'line', l: (line: string, stream: 'stdout' | 'stderr') => void): this { this.lines.off(event, l); return this }

  out (line: string): void { this.lines.emit('line', line, 'stdout') }
}

const flushMicrotasks = (): Promise<void> => new Promise(r => setImmediate(r))

test('sends on the priority lane immediately and every interval', async () => {
  const src = new FakeSource()
  const s = new GametimeSampler(src, { intervalMs: 20, now: () => src.clock }).start()
  assert.deepEqual(src.sends, [{ command: 'time query gametime', priority: true }])
  await new Promise(r => setTimeout(r, 70))
  await s.stop({ drainMs: 0 })
  assert.ok(src.sends.length >= 3, `sent ${src.sends.length}`)
  assert.equal(s.sent, src.sends.length)
  const n = src.sends.length
  await new Promise(r => setTimeout(r, 50))
  assert.equal(src.sends.length, n, 'no sends after stop')
})

test('pairs replies FIFO and emits samples with receive time and latency', () => {
  const src = new FakeSource()
  const s = new GametimeSampler(src, { intervalMs: 60_000, now: () => src.clock })
  const got: GametimeSample[] = []
  s.on('sample', x => { got.push(x) })
  s.start() // send #1 at 1000
  src.clock = 1003
  src.out(`${TS} Gametime is 500`)
  src.out(`${TS} Daytime is 500`) // ignored
  assert.deepEqual(got, [{ t: 1003, sentAt: 1000, gametime: 500, latencyMs: 3 }])
  assert.equal(s.outstanding, 0)
  // A reply with no send outstanding is unmatched, not a sample.
  src.out(`${TS} Gametime is 501`)
  assert.equal(s.unmatched, 1)
  assert.equal(got.length, 1)
  void s.stop({ drainMs: 0 })
})

test('a send without a reply within timeoutMs is lost and does not shift later pairings', async () => {
  const src = new FakeSource()
  const s = new GametimeSampler(src, { intervalMs: 10, timeoutMs: 100, now: () => src.clock })
  const got: GametimeSample[] = []
  const lost: number[] = []
  s.on('sample', x => { got.push(x) })
  s.on('lost', x => { lost.push(x.sentAt) })
  s.start() // send at 1000, never answered
  src.clock = 1150
  await new Promise(r => setTimeout(r, 25)) // next send(s) at 1150; the 1000 one expires on that tick
  assert.deepEqual(lost, [1000])
  src.clock = 1160
  src.out(`${TS} Gametime is 77`)
  assert.equal(got[0]!.sentAt, 1150)
  assert.equal(got[0]!.gametime, 77)
  await s.stop({ drainMs: 0 })
  assert.equal(s.lost, 1 + (s.sent - 1 - got.length))
})

test('expiry also happens when a reply arrives', () => {
  const src = new FakeSource()
  const s = new GametimeSampler(src, { intervalMs: 60_000, timeoutMs: 100, now: () => src.clock })
  const got: GametimeSample[] = []
  s.on('sample', x => { got.push(x) })
  s.start() // 1000
  src.clock = 1200
  src.out('Gametime is 9') // 1000 is stale: dropped, reply is unmatched
  assert.equal(s.lost, 1)
  assert.equal(s.unmatched, 1)
  assert.equal(got.length, 0)
  void s.stop({ drainMs: 0 })
})

test('does not stack sends while one is still queued behind other commands', async () => {
  const src = new FakeSource()
  src.hold = true
  const s = new GametimeSampler(src, { intervalMs: 5, now: () => src.clock }).start()
  await new Promise(r => setTimeout(r, 40))
  src.flush()
  assert.equal(src.sends.length, 1)
  await s.stop({ drainMs: 0 })
})

test('send failures are reported and sampling continues', async () => {
  const src = new FakeSource()
  src.fail = true
  const errors: string[] = []
  const s = new GametimeSampler(src, { intervalMs: 10, now: () => src.clock })
  s.on('sendError', e => { errors.push(e.message) })
  s.start()
  await flushMicrotasks()
  assert.deepEqual(errors, ['BDS is not running'])
  src.fail = false
  await new Promise(r => setTimeout(r, 30))
  await s.stop({ drainMs: 0 })
  assert.ok(src.sends.length >= 1)
})

test('stop drains outstanding replies, then counts the rest as lost and stops listening', async () => {
  const src = new FakeSource()
  const s = new GametimeSampler(src, { intervalMs: 60_000, now: () => src.clock }).start()
  setTimeout(() => src.out('Gametime is 1'), 10)
  await s.stop({ drainMs: 500 })
  assert.equal(s.samples.length, 1)
  assert.equal(s.lost, 0)
  assert.equal(src.lines.listenerCount('line'), 0)

  const s2 = new GametimeSampler(src, { intervalMs: 60_000, now: () => src.clock }).start()
  const lost: number[] = []
  s2.on('lost', x => { lost.push(x.sentAt) })
  await s2.stop({ drainMs: 20 })
  assert.deepEqual(lost, [1000])
  assert.equal(s2.outstanding, 0)
})

test('concurrent stop() calls share one drain; restart is not blocked by a send left queued', async () => {
  const src = new FakeSource()
  src.hold = true
  const s = new GametimeSampler(src, { intervalMs: 60_000, now: () => src.clock }).start()
  const a = s.stop({ drainMs: 30 })
  const b = s.stop({ drainMs: 0 })
  assert.equal(a, b)
  await a
  assert.equal(src.lines.listenerCount('line'), 0)
  // The send queued by the first run is still waiting; the new run sends anyway.
  s.start()
  const draining = s.stop({ drainMs: 20 })
  assert.throws(() => s.start(), /still draining/)
  await draining
  s.start()
  src.flush() // every run's send is written now; the current run pairs all their replies
  assert.equal(src.sends.length, 3)
  assert.equal(s.outstanding, 3)
  src.out('Gametime is 1')
  src.out('Gametime is 2')
  src.out('Gametime is 3')
  assert.deepEqual(s.samples.map(x => x.gametime), [1, 2, 3])
  await s.stop({ drainMs: 0 })
})

test('rejects invalid options', () => {
  const src = new FakeSource()
  assert.throws(() => new GametimeSampler(src, { intervalMs: 0 }), /intervalMs/)
  assert.throws(() => new GametimeSampler(src, { timeoutMs: -1 }), /timeoutMs/)
})
