// Periodic `time query gametime` sampler: a script-free tick counter source.
import { EventEmitter } from 'node:events'
import type { GametimeSample } from '@bedperf/core'
import { hostNow } from './bds-process.ts'
import { GAMETIME_COMMAND, parseGametime } from './parse.ts'

/** What the sampler needs from a server; `BdsProcess` implements it. */
export interface GametimeSource {
  /**
   * Write `command` in queue order. `onSent` must be called synchronously right after the write
   * with the host time taken right before it; the promise rejects when nothing was written.
   */
  sendQueued (command: string, opts?: { priority?: boolean, onSent?: (sentAt: number) => void }): Promise<number>
  on (event: 'line', listener: (line: string, stream: 'stdout' | 'stderr') => void): unknown
  off (event: 'line', listener: (line: string, stream: 'stdout' | 'stderr') => void): unknown
}

export interface GametimeSamplerOptions {
  /** Time between sends. Default 5000 ms. */
  intervalMs?: number
  /** A send with no reply after this long is counted as lost and dropped. Default 60000 ms. */
  timeoutMs?: number
  /** Host clock (epoch ms). Default `hostNow`. Must match the clock `sendQueued` stamps with. */
  now?: () => number
}

export interface GametimeSamplerEvents {
  sample: (s: GametimeSample) => void
  /** A send got no reply within `timeoutMs` (or before `stop()` finished draining). */
  lost: (info: { sentAt: number }) => void
  /** A send could not be written (typically: BDS is not running). Sampling continues. */
  sendError: (err: Error) => void
}

/**
 * Sends `time query gametime` every `intervalMs` through the priority lane of the command
 * queue, without waiting for the reply, and pairs `Gametime is <n>` lines with the sends first
 * in, first out. A send without a reply within `timeoutMs` is dropped and reported as `lost`,
 * so one swallowed command cannot shift every later pairing. Replies with no send outstanding
 * (for example from someone else's `queryGametime()`) are counted in `unmatched` and ignored.
 */
export class GametimeSampler {
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly samples: GametimeSample[] = []
  sent = 0
  lost = 0
  unmatched = 0

  private readonly source: GametimeSource
  private readonly now: () => number
  private readonly events = new EventEmitter()
  /** `sentAt` of written sends awaiting a reply, oldest first. */
  private pending: number[] = []
  /** A send of this run is queued but not yet written; ticks skip instead of stacking another. */
  private queued = false
  /** Bumped by start(), so a send still queued from an earlier run does not block this one. */
  private generation = 0
  private stopping: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false
  /** Subscribed to `line`: from start() until stop() finished draining. */
  private listening = false
  private nextAt = 0
  private readonly onLine = (line: string): void => { this.feed(line, this.now()) }

  constructor (source: GametimeSource, opts: GametimeSamplerOptions = {}) {
    this.source = source
    this.intervalMs = opts.intervalMs ?? 5000
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.now = opts.now ?? hostNow
    if (!(this.intervalMs > 0)) throw new Error('GametimeSampler: intervalMs must be > 0')
    if (!(this.timeoutMs > 0)) throw new Error('GametimeSampler: timeoutMs must be > 0')
  }

  on<E extends keyof GametimeSamplerEvents> (event: E, listener: GametimeSamplerEvents[E]): this {
    this.events.on(event, listener)
    return this
  }

  off<E extends keyof GametimeSamplerEvents> (event: E, listener: GametimeSamplerEvents[E]): this {
    this.events.off(event, listener)
    return this
  }

  /** Number of written sends still waiting for a reply. */
  get outstanding (): number {
    return this.pending.length
  }

  /** Start listening and send the first query now. No-op when already started. */
  start (): this {
    if (this.running) return this
    if (this.listening) throw new Error('GametimeSampler: stop() is still draining')
    this.running = true
    this.generation++
    this.queued = false
    this.source.on('line', this.onLine)
    this.listening = true
    this.nextAt = performance.now()
    this.tick()
    return this
  }

  /**
   * Stop sending, wait up to `drainMs` (default 2000) for outstanding replies, then count the
   * rest as lost and stop listening.
   */
  stop (opts: { drainMs?: number } = {}): Promise<void> {
    if (this.stopping) return this.stopping
    if (!this.running) return Promise.resolve()
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.stopping = (async () => {
      const deadline = performance.now() + (opts.drainMs ?? 2000)
      while ((this.pending.length > 0 || this.queued) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      this.source.off('line', this.onLine)
      this.listening = false
      this.queued = false
      for (const sentAt of this.pending) this.drop(sentAt)
      this.pending = []
      this.stopping = undefined
    })()
    return this.stopping
  }

  /** Offer one console line received at `recvAt`. Returns true if it was a gametime reply. */
  feed (line: string, recvAt: number): boolean {
    const gametime = parseGametime(line)
    if (gametime === undefined) return false
    this.expire(recvAt)
    const sentAt = this.pending.shift()
    if (sentAt === undefined) {
      this.unmatched++
      return true
    }
    const s: GametimeSample = { t: recvAt, sentAt, gametime, latencyMs: recvAt - sentAt }
    this.samples.push(s)
    this.events.emit('sample', s)
    return true
  }

  private tick (): void {
    if (!this.running) return
    this.expire(this.now())
    this.send()
    // Scheduling uses the real monotonic clock; `now` is only for stamps and expiry.
    this.nextAt += this.intervalMs
    const now = performance.now()
    // Fell behind (event loop blocked): keep the spacing from now on instead of bursting.
    if (this.nextAt < now) this.nextAt = now + this.intervalMs
    this.timer = setTimeout(() => this.tick(), this.nextAt - now)
  }

  private send (): void {
    if (this.queued) return
    this.queued = true
    const gen = this.generation
    const onSent = (sentAt: number): void => {
      if (gen === this.generation) this.queued = false
      this.sent++
      // A send from an earlier run written now still gets a reply, so it is paired like any other.
      if (this.listening) this.pending.push(sentAt)
      else this.drop(sentAt) // written after stop() gave up waiting: nobody reads the reply
    }
    this.source.sendQueued(GAMETIME_COMMAND, { priority: true, onSent }).then(() => {}, (err: unknown) => {
      if (gen === this.generation) this.queued = false
      this.events.emit('sendError', err instanceof Error ? err : new Error(String(err)))
    })
  }

  private expire (now: number): void {
    while (this.pending.length > 0 && now - this.pending[0]! > this.timeoutMs) this.drop(this.pending.shift()!)
  }

  private drop (sentAt: number): void {
    this.lost++
    this.events.emit('lost', { sentAt })
  }
}
