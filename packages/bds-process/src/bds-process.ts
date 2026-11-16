// Production BDS process controller implementing the core `BdsServer` contract.
import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { constants as osConstants, setPriority } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { BdsInstance, BdsServer, BdsServerEvents } from '@bedperf/core'
import { isBlankLine, parseBdsLine, parseListHeader, parseListNames, type ParsedBdsLine } from './parse.ts'

/** Events of `BdsProcess`: the core `BdsServerEvents` plus non-fatal warnings. */
export interface BdsProcessEvents extends BdsServerEvents {
  /** Best-effort operation failed (affinity, priority, log file). The server keeps running. */
  warning: (message: string) => void
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export type ProcessPriority = 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high' | 'highest'

const PRIORITY: Record<ProcessPriority, number> = {
  low: osConstants.priority.PRIORITY_LOW,
  below_normal: osConstants.priority.PRIORITY_BELOW_NORMAL,
  normal: osConstants.priority.PRIORITY_NORMAL,
  above_normal: osConstants.priority.PRIORITY_ABOVE_NORMAL,
  high: osConstants.priority.PRIORITY_HIGH,
  highest: osConstants.priority.PRIORITY_HIGHEST
}

export interface BdsProcessOptions {
  /** Append every output line (stdout and stderr) to this file, e.g. `runs/<id>/bds.log`. */
  logFile?: string
  /** Logical CPU indices to pin BDS to. Best-effort; failures are reported as `warning`. */
  affinity?: readonly number[]
  /** Scheduling priority via `os.setPriority`. Best-effort. `high`/`highest` may need admin/root. */
  priority?: ProcessPriority
  /** Default for `start()`. Default 120 s. */
  readyTimeoutMs?: number
  /** Default for `command()`. Default 10 s. */
  commandTimeoutMs?: number
  /** Default for `stop()`. Default 30 s. */
  stopTimeoutMs?: number
  /** Number of recent non-blank lines kept for error messages. Default 30. */
  tailLines?: number
  /** Extra environment variables for the server process. */
  env?: Record<string, string>
  /** Process spawner, for tests. Default `child_process.spawn`. */
  spawn?: SpawnFn
}

export type BdsStartFailure = 'spawn' | 'timeout' | 'exit' | 'portInUse' | 'stopped'

/** `start()` rejection. `tail` holds the last output lines. */
export class BdsStartError extends Error {
  readonly reason: BdsStartFailure
  readonly tail: string[]
  constructor (reason: BdsStartFailure, message: string, tail: string[]) {
    super(tail.length > 0 ? `${message}\n--- last BDS output ---\n${tail.join('\n')}` : message)
    this.name = 'BdsStartError'
    this.reason = reason
    this.tail = tail
  }
}

/** `command()` rejection. `lines` holds what was collected before the failure. */
export class BdsCommandError extends Error {
  readonly command: string
  readonly lines: string[]
  constructor (command: string, message: string, lines: string[]) {
    super(`${message} (command: ${command})${lines.length > 0 ? '\n' + lines.join('\n') : ''}`)
    this.name = 'BdsCommandError'
    this.command = command
    this.lines = lines
  }
}

/**
 * Command line that pins `pid` to `cpus`. Windows: PowerShell `ProcessorAffinity` (single
 * processor group, CPUs 0..62). Linux: `taskset -a -p -c` (all existing threads; new threads inherit).
 */
export function affinityCommand (pid: number, cpus: readonly number[], platform: 'win' | 'linux'): [string, string[]] {
  if (cpus.length === 0) throw new Error('affinity: empty CPU list')
  for (const c of cpus) {
    if (!Number.isInteger(c) || c < 0) throw new Error(`affinity: invalid CPU index ${c}`)
  }
  if (platform === 'win') {
    let mask = 0n
    for (const c of cpus) {
      if (c > 62) throw new Error(`affinity: CPU ${c} is outside the supported range 0..62 on Windows`)
      mask |= 1n << BigInt(c)
    }
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr][long]${mask}`]]
  }
  return ['taskset', ['-a', '-p', '-c', [...new Set(cpus)].join(','), String(pid)]]
}

function execFileP (file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${file} failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ''}`))
      else resolve()
    })
  })
}

type Collector = (p: ParsedBdsLine) => void
type ExitInfo = Parameters<BdsServerEvents['exit']>[0]

const COMMAND_FAILURE_RE = /^(Syntax error|Unknown command|No targets matched|Incorrect argument|Invalid|Could not)/

/**
 * One BDS server process. `start()` may be called again after the previous process exited.
 * Console output is not correlated with commands, so `command()` calls are serialised and
 * each collects every non-blank, non-probe line printed after its command was written.
 */
export class BdsProcess implements BdsServer {
  readonly instance: BdsInstance
  private readonly opts: BdsProcessOptions
  private readonly events = new EventEmitter()
  private readonly collectors = new Set<Collector>()
  private queue: Promise<unknown> = Promise.resolve()

  private proc: ChildProcess | undefined
  /** The current run is over ('close' seen, or fallback after 'exit'); `exit` was emitted. */
  private exited = true
  /** The OS process has exited ('exit' seen); stdio may still be draining. */
  private procExited = true
  private isReady = false
  private stopRequested = false
  private stopPromise: Promise<void> | undefined
  private exitPromise: Promise<ExitInfo> = Promise.resolve({ code: null, signal: null, expected: true })
  private resolveExit: (info: ExitInfo) => void = () => {}
  private exitCode: number | null = null
  private exitSignal: string | null = null
  private spawnError: Error | undefined
  private tail: string[] = []
  private log: WriteStream | undefined
  private portInUse = false

  constructor (instance: BdsInstance, opts: BdsProcessOptions = {}) {
    this.instance = instance
    this.opts = opts
  }

  get pid (): number | undefined {
    return this.exited || this.procExited ? undefined : this.proc?.pid
  }

  /** True between spawn and exit. */
  get running (): boolean {
    return !this.exited
  }

  /** True once `Server started.` was seen for the current process. */
  get ready (): boolean {
    return this.isReady && !this.exited
  }

  /** Last non-blank output lines (up to `tailLines`). */
  recentLines (): string[] {
    return [...this.tail]
  }

  on<E extends keyof BdsProcessEvents> (event: E, listener: BdsProcessEvents[E]): this {
    this.events.on(event, listener)
    return this
  }

  once<E extends keyof BdsProcessEvents> (event: E, listener: BdsProcessEvents[E]): this {
    this.events.once(event, listener)
    return this
  }

  off<E extends keyof BdsProcessEvents> (event: E, listener: BdsProcessEvents[E]): this {
    this.events.off(event, listener)
    return this
  }

  private emit<E extends keyof BdsProcessEvents> (event: E, ...args: Parameters<BdsProcessEvents[E]>): void {
    this.events.emit(event, ...args)
  }

  async start (opts: { readyTimeoutMs?: number } = {}): Promise<void> {
    // The previous process is dead but its stdio is still draining: wait for the run to finish.
    if (!this.exited && this.procExited) await this.exitPromise
    if (!this.exited) throw new Error('BDS is already running')
    const readyTimeoutMs = opts.readyTimeoutMs ?? this.opts.readyTimeoutMs ?? 120_000

    this.exited = false
    this.procExited = false
    this.isReady = false
    this.stopRequested = false
    this.stopPromise = undefined
    this.exitCode = null
    this.exitSignal = null
    this.spawnError = undefined
    this.tail = []
    this.portInUse = false
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.openLog()

    const isWin = this.instance.platform === 'win'
    const exe = join(this.instance.dir, isWin ? 'bedrock_server.exe' : 'bedrock_server')
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env }
    if (!isWin) env.LD_LIBRARY_PATH = [this.instance.dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
    const spawnFn = this.opts.spawn ?? nodeSpawn

    let child: ChildProcess
    try {
      child = spawnFn(exe, [], { cwd: this.instance.dir, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
    } catch (err) {
      this.spawnError = err as Error
      this.proc = undefined
      this.finalize(undefined, null, null)
      throw new BdsStartError('spawn', `failed to spawn ${exe}: ${(err as Error).message}`, [])
    }
    this.proc = child
    // Every handler below ignores events of a child that is no longer the current one, so a
    // late 'close' or output of a previous run cannot affect a restarted server.
    child.stdin?.on('error', () => {}) // EPIPE after the process died; surfaced via exit instead
    this.attach(child, child.stdout, 'stdout')
    this.attach(child, child.stderr, 'stderr')

    let closeFallback: NodeJS.Timeout | undefined
    child.once('exit', (code, signal) => {
      if (this.proc !== child) return
      this.procExited = true
      this.exitCode = code
      this.exitSignal = signal
      // 'close' normally follows once stdio is drained; don't hang if something keeps a pipe open.
      closeFallback = setTimeout(() => this.finalize(child, code, signal), 5_000)
      closeFallback.unref()
    })
    child.once('close', (code, signal) => {
      if (closeFallback) clearTimeout(closeFallback)
      this.finalize(child, code ?? this.exitCode, signal ?? this.exitSignal)
    })
    child.on('error', err => {
      if (this.proc !== child) return
      this.spawnError ??= err
      if (child.pid === undefined) this.finalize(child, null, null)
    })

    const tuned = child.pid === undefined ? Promise.resolve() : this.tune(child.pid)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        settled = true
        clearTimeout(timer)
        this.events.off('ready', onReady)
        this.events.off('exit', onExit)
        this.events.off('_portInUse', onPort)
      }
      const fail = (reason: BdsStartFailure, message: string): void => {
        if (settled) return
        cleanup()
        const tail = this.recentLines()
        this.kill().then(
          () => reject(new BdsStartError(reason, message, tail)),
          () => reject(new BdsStartError(reason, message, tail))
        )
      }
      const onReady = (): void => { if (!settled) { cleanup(); resolve() } }
      const onExit = (info: ExitInfo): void => {
        if (this.spawnError) fail('spawn', `failed to start ${exe}: ${this.spawnError.message}`)
        else if (this.portInUse) fail('portInUse', `BDS port ${this.instance.port}/${this.instance.portV6} is in use`)
        else if (this.stopRequested) fail('stopped', 'BDS was stopped before it became ready')
        else fail('exit', `BDS exited before it was ready (code ${info.code}, signal ${info.signal})`)
      }
      const onPort = (): void => fail('portInUse', `BDS port ${this.instance.port}/${this.instance.portV6} is in use`)
      const timer = setTimeout(() => fail('timeout', `BDS did not print "Server started." within ${readyTimeoutMs} ms`), readyTimeoutMs)
      this.events.on('ready', onReady)
      this.events.on('exit', onExit)
      this.events.on('_portInUse', onPort)
      if (this.isReady) onReady()
      else if (this.exited) onExit({ code: this.exitCode, signal: this.exitSignal, expected: false })
    })
    await tuned
  }

  /** Apply affinity / priority. Never throws; failures become `warning` events. */
  private async tune (pid: number): Promise<void> {
    if (this.opts.priority !== undefined) {
      try {
        setPriority(pid, PRIORITY[this.opts.priority])
      } catch (err) {
        this.emit('warning', `could not set priority ${this.opts.priority} on pid ${pid}: ${(err as Error).message}`)
      }
    }
    if (this.opts.affinity !== undefined) {
      try {
        const [file, args] = affinityCommand(pid, this.opts.affinity, this.instance.platform)
        await execFileP(file, args)
      } catch (err) {
        this.emit('warning', `could not set CPU affinity on pid ${pid}: ${(err as Error).message}`)
      }
    }
  }

  private openLog (): void {
    this.log = undefined
    const file = this.opts.logFile
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const log = createWriteStream(file, { flags: 'a' })
      log.on('error', err => {
        this.emit('warning', `log file ${file}: ${err.message}`)
        if (this.log === log) this.log = undefined
      })
      this.log = log
    } catch (err) {
      this.emit('warning', `log file ${file}: ${(err as Error).message}`)
    }
  }

  private attach (child: ChildProcess, stream: Readable | null | undefined, name: 'stdout' | 'stderr'): void {
    if (!stream) return
    stream.setEncoding('utf8')
    let buf = ''
    stream.on('data', (chunk: string) => {
      if (this.proc !== child) return
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        this.handleLine(line, name)
      }
    })
    stream.on('end', () => {
      if (buf !== '' && this.proc === child) {
        const line = buf
        buf = ''
        this.handleLine(line, name)
      }
    })
  }

  private handleLine (raw: string, stream: 'stdout' | 'stderr'): void {
    const p = parseBdsLine(raw)
    const blank = isBlankLine(p)
    if (!blank) {
      this.tail.push(p.text)
      const max = this.opts.tailLines ?? 30
      if (this.tail.length > max) this.tail.splice(0, this.tail.length - max)
    }
    this.log?.write(p.text + '\n')
    this.emit('line', p.text, stream)
    if (blank) return
    for (const c of [...this.collectors]) c(p)
    switch (p.kind) {
      case 'ready':
        if (!this.isReady) {
          this.isReady = true
          this.emit('ready')
        }
        break
      case 'join': this.emit('playerJoin', p.player); break
      case 'leave': this.emit('playerLeave', p.player); break
      case 'probe': this.emit('probe', p.record); break
      case 'portInUse':
        this.portInUse = true
        this.events.emit('_portInUse')
        break
    }
  }

  private finalize (child: ChildProcess | undefined, code: number | null, signal: string | null): void {
    if (this.exited || this.proc !== child) return
    this.exited = true
    this.procExited = true
    this.log?.end()
    this.log = undefined
    const info: ExitInfo = { code, signal, expected: this.stopRequested }
    this.resolveExit(info)
    this.emit('exit', info)
  }

  send (command: string): void {
    if (/[\r\n]/.test(command)) throw new Error('BDS command must be a single line')
    const stdin = this.proc?.stdin
    if (this.exited || this.procExited || !stdin || !stdin.writable) throw new Error('BDS is not running')
    stdin.write(command + '\n')
  }

  /** Run `fn` after every previously queued command finished (successfully or not). */
  private enqueue<T> (fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn)
    this.queue = p.catch(() => {})
    return p
  }

  /**
   * Write `command` and feed every following non-blank, non-probe line to `done` until it
   * returns true. Not queued; callers go through `enqueue`.
   */
  private collect (command: string, done: (p: ParsedBdsLine) => boolean, timeoutMs?: number): Promise<string[]> {
    const t = timeoutMs ?? this.opts.commandTimeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      const lines: string[] = []
      const finish = (err?: Error): void => {
        clearTimeout(timer)
        this.collectors.delete(collector)
        this.events.off('exit', onExit)
        if (err) reject(err)
        else resolve(lines)
      }
      const collector: Collector = p => {
        if (p.kind === 'probe') return
        lines.push(p.text)
        let hit: boolean
        try { hit = done(p) } catch (err) { finish(err as Error); return }
        if (hit) finish()
      }
      const onExit = (): void => finish(new BdsCommandError(command, 'BDS exited before the command completed', lines))
      const timer = setTimeout(() => finish(new BdsCommandError(command, `no matching output within ${t} ms`, lines)), t)
      this.collectors.add(collector)
      this.events.on('exit', onExit)
      try {
        this.send(command)
      } catch (err) {
        finish(new BdsCommandError(command, (err as Error).message, lines))
      }
    })
  }

  /**
   * `until` is tested against both the full line and the message without the
   * `[timestamp LEVEL]` prefix, so anchored patterns like /^There are/ work.
   */
  command (command: string, until: RegExp, timeoutMs?: number): Promise<string[]> {
    const test = (s: string): boolean => {
      until.lastIndex = 0
      return until.test(s)
    }
    return this.enqueue(() => this.collect(command, p => test(p.text) || test(p.message), timeoutMs))
  }

  /**
   * Resolves with the first message matching `success`; rejects with `BdsCommandError` on a
   * recognised command error (`Syntax error`, `Unknown command`, ...).
   */
  private async exec (command: string, success: RegExp, timeoutMs?: number): Promise<string> {
    let matched = ''
    await this.enqueue(() => this.collect(command, p => {
      if (success.test(p.message)) {
        matched = p.message
        return true
      }
      if (p.kind === 'error' && COMMAND_FAILURE_RE.test(p.message)) throw new BdsCommandError(command, p.message, [p.text])
      return false
    }, timeoutMs))
    return matched
  }

  /** `list`: online/max counts and player names. */
  async listPlayers (timeoutMs?: number): Promise<{ online: number, max: number, names: string[] }> {
    let header: { online: number, max: number } | undefined
    let names: string[] = []
    await this.enqueue(() => this.collect('list', p => {
      if (header === undefined) {
        header = parseListHeader(p.message)
        // With 0 players the names line is empty, and blank lines are not collected.
        return header !== undefined && header.online === 0
      }
      // The names line has no prefix and lists exactly `online` names; skip unrelated output.
      if (p.level !== undefined) return false
      const candidate = parseListNames(p.text)
      if (candidate.length !== header.online) return false
      names = candidate
      return true
    }, timeoutMs))
    return { online: header!.online, max: header!.max, names }
  }

  /** `gamerule <rule> <value>`; rejects on a syntax error or unknown rule. */
  async setGamerule (rule: string, value: string | number | boolean, timeoutMs?: number): Promise<void> {
    await this.exec(`gamerule ${rule} ${String(value)}`, /^Game rule \S+ has been updated to/, timeoutMs)
  }

  /** `say <msg>`. BDS prints nothing for it, so this only queues the write behind pending commands. */
  say (message: string): Promise<void> {
    return this.enqueue(async () => { this.send(`say ${message}`) })
  }

  /**
   * `op <name>`. Resolves true when newly opped, false when BDS says it could not op the
   * player (typically: already an operator). Rejects when no such player is online.
   */
  async op (name: string, timeoutMs?: number): Promise<boolean> {
    const target = /[\s"]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name
    const msg = await this.exec(`op ${target}`, /^(Opped:|Could not op)/, timeoutMs)
    return msg.startsWith('Opped:')
  }

  /**
   * `op @a`. Resolves with the collected lines once BDS answers (first `Opped:` / `Could not op`
   * / `No targets matched` line). With several players, later answer lines may still arrive.
   */
  opAll (timeoutMs?: number): Promise<string[]> {
    return this.enqueue(() => this.collect('op @a', p => /^(Opped:|Could not op|No targets matched)/.test(p.message), timeoutMs))
  }

  stop (timeoutMs?: number): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (this.exited) return Promise.resolve()
    const t = timeoutMs ?? this.opts.stopTimeoutMs ?? 30_000
    this.stopRequested = true
    this.stopPromise = (async () => {
      let delivered = true
      try { this.send('stop') } catch { delivered = false }
      // No graceful stop was delivered (stdin closed / process already dead): kill right away.
      const timer = setTimeout(() => { this.proc?.kill('SIGKILL') }, delivered ? t : 0)
      await this.exitPromise
      clearTimeout(timer)
    })()
    return this.stopPromise
  }

  /** Kill immediately (counts as an expected exit). Resolves when the process is gone. */
  async kill (): Promise<void> {
    if (this.exited) return
    this.stopRequested = true
    this.proc?.kill('SIGKILL')
    await this.exitPromise
  }
}
