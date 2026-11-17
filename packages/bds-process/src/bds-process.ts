// Production BDS process controller implementing the core `BdsServer` contract.
import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { constants as osConstants, setPriority } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { BdsInstance, BdsServer, BdsServerEvents, GametimeReading, LaunchSpec } from '@bedperf/core'
import { GAMETIME_COMMAND, isBlankLine, parseBdsLine, parseGametime, parseListHeader, parseListNames, type ParsedBdsLine } from './parse.ts'
import { baseName, createProcessHost, findAuxProcesses, findServerProcess, namePatternRe, type ProcessHost } from './proctree.ts'

/** Events of `BdsProcess`: the core `BdsServerEvents` plus non-fatal warnings. */
export interface BdsProcessEvents extends BdsServerEvents {
  /** Best-effort operation failed (affinity, priority, log file). The server keeps running. */
  warning: (message: string) => void
  /** The game process was identified (the spawned process itself, or a descendant of a launcher). */
  serverPid: (pid: number) => void
}

/** Image name of the vanilla server executable, as a `LaunchSpec.serverProcess.namePattern`. */
export const VANILLA_SERVER_NAME_PATTERN = '^bedrock_server(\\.exe)?$'

/**
 * The LaunchSpec `BdsProcess` uses when none is given: the vanilla executable in the instance
 * dir, with `LD_LIBRARY_PATH=<dir>[:$LD_LIBRARY_PATH]` on Linux (taken from `baseEnv`).
 */
export function vanillaLaunchSpec (instance: BdsInstance, baseEnv: NodeJS.ProcessEnv = process.env): LaunchSpec {
  const isWin = instance.platform === 'win'
  const spec: LaunchSpec = {
    command: join(instance.dir, isWin ? 'bedrock_server.exe' : 'bedrock_server'),
    args: [],
    cwd: instance.dir,
    serverProcess: { namePattern: VANILLA_SERVER_NAME_PATTERN },
    killTree: false
  }
  if (!isWin) spec.env = { LD_LIBRARY_PATH: [instance.dir, baseEnv.LD_LIBRARY_PATH].filter(Boolean).join(':') }
  return spec
}

/** `wineserver` next to the wine binary unless the spec names one. */
export function wineserverBin (wine: NonNullable<LaunchSpec['wine']>): string {
  return wine.wineserverBin ?? wine.wineBin.replace(/[^/\\]*$/, '') + 'wineserver'
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
  /** Extra environment variables for the server process (the LaunchSpec's `env` wins on conflicts). */
  env?: Record<string, string>
  /** Process spawner, for tests. Default `child_process.spawn`. */
  spawn?: SpawnFn
  /**
   * How to start the server (from @bedperf/bds-install). Default: `vanillaLaunchSpec(instance)`,
   * the vanilla executable in the instance dir.
   */
  launch?: LaunchSpec
  /** Process table / kill / helper-command operations. Default: the real host. For tests. */
  processHost?: ProcessHost
  /** Poll interval while looking for the game process under a launcher. Default 250 ms. */
  serverPidPollMs?: number
  /** How long `start()` keeps looking for the game process after `Server started`. Default 10 s. */
  serverPidGraceMs?: number
  /** A launcher whose game process has been gone this long is killed (crash detection). Default 5 s. */
  orphanLauncherMs?: number
}

export type BdsStartFailure = 'spawn' | 'timeout' | 'exit' | 'portInUse' | 'stopped' | 'noServerProcess'

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

/** Host clock: epoch ms with sub-ms resolution, monotonic within the process. */
export function hostNow (): number {
  return performance.timeOrigin + performance.now()
}

/** Queue lane: `priority` jobs run before every queued `normal` job. */
export type CommandLane = 'normal' | 'priority'

const GAMETIME_CMD_RE = /^\s*time\s+query\s+gametime\b/i
const COMMAND_FAILURE_RE = /^(Syntax error|Unknown command|No targets matched|Incorrect argument|Invalid|Could not)/

/**
 * One server process (any flavor). `start()` may be called again after the previous process exited.
 * The spawned process may be a launcher (wine, Endstone's Python, lip); the game process is then
 * found among its descendants (`serverPid`) and `pid` reports it once known. The run ends when the
 * spawned process exits.
 * Console output is not correlated with commands, so `command()` calls are serialised and
 * each collects every non-blank, non-probe line printed after its command was written.
 * The queue has two lanes: a queued `priority` job runs before any queued `normal` job (the
 * job already running is never interrupted).
 */
export class BdsProcess implements BdsServer {
  readonly instance: BdsInstance
  private readonly opts: BdsProcessOptions
  private readonly events = new EventEmitter()
  private readonly collectors = new Set<Collector>()
  private readonly lanes: Record<CommandLane, Array<() => void>> = { priority: [], normal: [] }
  private busy = false

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
  private readonly host: ProcessHost
  /** LaunchSpec of the current (or last) run. */
  private spec: LaunchSpec | undefined
  private launcher: number | undefined
  private server: number | undefined
  /** Affinity / priority application on the game process. */
  private tuned: Promise<void> = Promise.resolve()
  private watchdog: NodeJS.Timeout | undefined
  /** Post-exit cleanup (waiting for / killing the game, wineserver -k) is running; `exit` follows. */
  private finalizing = false
  /** Cleanup of what the exited launcher left behind (see `reapAfterLauncher`). */
  private reaping: Promise<void> | undefined
  /** `expected` of the run's exit, fixed when the spawned process exited. */
  private exitExpected: boolean | undefined
  /** Timeout of the stop in progress (bounds how long a game may outlive its launcher). */
  private stopTimeoutMs = 30_000
  private harnessExitHook: (() => void) | undefined

  constructor (instance: BdsInstance, opts: BdsProcessOptions = {}) {
    this.instance = instance
    this.opts = opts
    this.host = opts.processHost ?? createProcessHost()
  }

  /**
   * The game process' pid while running: `serverPid` once resolved, the spawned (launcher) pid
   * before that. Placement, sysmon and verification should use this after `start()` resolved,
   * when it is always the game process.
   */
  get pid (): number | undefined {
    return this.exited || this.procExited ? undefined : this.server ?? this.proc?.pid
  }

  /** The game process' pid; undefined until it is identified and after the run ended. */
  get serverPid (): number | undefined {
    return this.exited || this.procExited ? undefined : this.server
  }

  /** The spawned process' pid (a launcher, or the game process itself for vanilla/direct launches). */
  get launcherPid (): number | undefined {
    return this.exited || this.procExited ? undefined : this.launcher
  }

  /** The LaunchSpec of the current or last run (the default vanilla one when none was given). */
  get launchSpec (): LaunchSpec | undefined {
    return this.spec
  }

  /**
   * Helper processes of the server matching `auxProcessPatterns` (e.g. wineserver), wherever they
   * are in the process tree. On Linux only processes of this uid count, and for Wine only those
   * whose WINEPREFIX is the spec's prefix (processes whose environment cannot be read are kept).
   * Elsewhere the match is by name only. Excludes the launcher and game pids.
   */
  async auxPids (): Promise<number[]> {
    const spec = this.spec ?? this.opts.launch
    const patterns = (spec?.auxProcessPatterns ?? []).map(namePatternRe)
    if (spec === undefined || patterns.length === 0) return []
    const procs = await this.host.list()
    const exclude = new Set<number>()
    if (this.launcherPid !== undefined) exclude.add(this.launcherPid)
    if (this.serverPid !== undefined) exclude.add(this.serverPid)
    const filter: Parameters<typeof findAuxProcesses>[2] = { patterns, exclude }
    const uid = this.host.uid()
    if (uid !== undefined) filter.uid = uid
    if (spec.wine !== undefined) filter.winePrefix = spec.wine.prefix
    return findAuxProcesses(this.host, procs, filter)
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
    this.launcher = undefined
    this.server = undefined
    this.finalizing = false
    this.reaping = undefined
    this.exitExpected = undefined
    this.stopTimeoutMs = this.opts.stopTimeoutMs ?? 30_000
    this.tuned = Promise.resolve()
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve })
    this.openLog()

    const spec = this.opts.launch ?? vanillaLaunchSpec(this.instance, { ...process.env, ...this.opts.env })
    this.spec = spec
    const exe = spec.command
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env, ...spec.env }
    const spawnFn = this.opts.spawn ?? nodeSpawn
    const nameRe = namePatternRe(spec.serverProcess.namePattern)
    // Linux: a process group of its own, so the whole tree can be killed at once.
    const detached = spec.killTree && this.host.platform !== 'win32'

    let child: ChildProcess
    try {
      const o: SpawnOptions = { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true }
      if (detached) o.detached = true
      child = spawnFn(exe, spec.args, o)
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
      this.stopWatchdog()
      this.exitExpected = this.stopRequested
      this.reaping = this.reapAfterLauncher(child)
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

    this.launcher = child.pid
    if (spec.killTree && child.pid !== undefined) this.guardHarnessExit(child, detached)
    const searchDeadline = Date.now() + readyTimeoutMs + (this.opts.serverPidGraceMs ?? 10_000)
    if (child.pid !== undefined) {
      // A direct launch (the command is the game executable): no process-table lookup needed.
      if (nameRe.test(baseName(exe))) this.setServerPid(child, child.pid)
      else void this.searchServerPid(child, nameRe, searchDeadline)
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let grace: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        settled = true
        clearTimeout(timer)
        clearTimeout(grace)
        this.events.off('ready', onReady)
        this.events.off('exit', onExit)
        this.events.off('_portInUse', onPort)
        this.events.off('serverPid', onServerPid)
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
      const succeed = (): void => { if (!settled) { cleanup(); resolve() } }
      const onReady = (): void => {
        if (settled) return
        if (this.server !== undefined) { succeed(); return }
        if (grace !== undefined) return
        // The ready line was seen: from now on only the game-process grace period applies.
        clearTimeout(timer)
        const graceMs = this.opts.serverPidGraceMs ?? 10_000
        grace = setTimeout(() => fail('noServerProcess',
          `server printed "Server started" but no process matching /${spec.serverProcess.namePattern}/i was found under launcher pid ${child.pid} within ${graceMs} ms`), graceMs)
      }
      const onServerPid = (): void => { if (this.isReady) succeed() }
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
      this.events.on('serverPid', onServerPid)
      if (this.exited) onExit({ code: this.exitCode, signal: this.exitSignal, expected: false })
      else if (this.isReady) onReady()
    })
    await this.tuned
  }

  /** Record the game process, apply affinity/priority to it, and watch it when it is not the launcher. */
  private setServerPid (child: ChildProcess, pid: number): void {
    if (this.proc !== child || this.server !== undefined) return
    this.server = pid
    this.tuned = this.tune(pid)
    if (pid !== child.pid) this.startWatchdog(child, pid)
    this.emit('serverPid', pid)
  }

  /** Poll the process table for the first process in the launcher's tree whose name matches. */
  private async searchServerPid (child: ChildProcess, re: RegExp, deadline: number): Promise<void> {
    const pollMs = this.opts.serverPidPollMs ?? 250
    let warned = false
    while (this.proc === child && !this.procExited && this.server === undefined && Date.now() < deadline) {
      try {
        const procs = await this.host.list()
        if (this.proc !== child || this.procExited) return
        const found = findServerProcess(procs, child.pid!, re)
        if (found !== undefined) {
          this.setServerPid(child, found.pid)
          return
        }
      } catch (err) {
        if (!warned) this.emit('warning', `could not read the process table: ${(err as Error).message}`)
        warned = true
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Crash detection when the game process is not the spawned one: if it has been gone for
   * `orphanLauncherMs` while the launcher still runs (and no stop is in progress), kill the launcher
   * tree so the run ends with an unexpected exit.
   */
  private startWatchdog (child: ChildProcess, pid: number): void {
    this.stopWatchdog()
    const limit = this.opts.orphanLauncherMs ?? 5_000
    const every = Math.min(1_000, limit)
    let goneSince: number | undefined
    this.watchdog = setInterval(() => {
      if (this.proc !== child || this.procExited) { this.stopWatchdog(); return }
      if (this.host.alive(pid)) { goneSince = undefined; return }
      goneSince ??= Date.now()
      if (this.stopRequested || Date.now() - goneSince < limit) return
      this.stopWatchdog()
      this.emit('warning', `game process ${pid} exited but launcher pid ${child.pid} is still running; killing the launcher`)
      void this.killProcesses()
    }, every)
    this.watchdog.unref()
  }

  private stopWatchdog (): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  /**
   * Kill the current run's processes. Without `killTree`: the spawned process (and the game
   * process if different). With `killTree`: Windows `taskkill /T /F` on the launcher; Linux SIGKILL
   * to the launcher's process group; then the game process if still alive and, for Wine,
   * `wineserver -k`. The synchronous part (signals) runs before the first await.
   */
  /**
   * A launcher in its own process group no longer gets the terminal's SIGINT/SIGHUP with the
   * harness, so if the harness exits while the run is active (uncaught error, `process.exit`),
   * kill the group and the game process synchronously from `process.on('exit')`. A harness killed
   * by a signal it does not handle runs no exit handlers: the CLI must stop the server on SIGINT.
   */
  private guardHarnessExit (child: ChildProcess, group: boolean): void {
    this.unguardHarnessExit()
    const hook = (): void => {
      if (this.proc !== child || this.procExited) return
      if (group) this.host.signal(-child.pid!, 'SIGKILL')
      this.host.signal(child.pid!, 'SIGKILL')
      if (this.server !== undefined && this.server !== child.pid) this.host.signal(this.server, 'SIGKILL')
    }
    this.harnessExitHook = hook
    process.once('exit', hook)
  }

  private unguardHarnessExit (): void {
    if (this.harnessExitHook !== undefined) process.off('exit', this.harnessExitHook)
    this.harnessExitHook = undefined
  }

  /**
   * The spawned process exited. A game process that outlives it is killed: right away when the
   * exit was not requested (a crashed launcher), or after the stop timeout during a graceful stop
   * (a launcher may exit before the game has finished saving). On Linux the rest of the launcher's
   * process group is killed afterwards. Returns undefined when nothing needs waiting for.
   */
  private reapAfterLauncher (child: ChildProcess): Promise<void> | undefined {
    const host = this.host
    const launcher = child.pid
    const server = this.server
    const groupKill = (): void => {
      if (this.spec?.killTree === true && host.platform !== 'win32' && launcher !== undefined) host.signal(-launcher, 'SIGKILL')
    }
    if (server === undefined || server === launcher || !host.alive(server)) {
      groupKill()
      return undefined
    }
    if (!this.stopRequested) {
      this.emit('warning', `launcher pid ${launcher} exited while game process ${server} was still running; killed it`)
      groupKill()
      return this.killGame(server)
    }
    return (async () => {
      const deadline = Date.now() + this.stopTimeoutMs
      while (host.alive(server) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
      if (host.alive(server)) {
        this.emit('warning', `game process ${server} did not exit within ${this.stopTimeoutMs} ms after its launcher; killed it`)
        await this.killGame(server)
      }
      groupKill()
    })()
  }

  /** Kill the game process (Windows with `killTree`: with its descendants). */
  private async killGame (pid: number): Promise<void> {
    if (this.spec?.killTree === true && this.host.platform === 'win32') {
      try {
        await this.host.exec('taskkill', ['/PID', String(pid), '/T', '/F'])
        return
      } catch {}
    }
    this.host.signal(pid, 'SIGKILL')
  }

  private async killProcesses (): Promise<void> {
    const spec = this.spec
    const child = this.proc
    const launcher = this.launcher
    const server = this.server
    const host = this.host
    const winTree = spec?.killTree === true && host.platform === 'win32'
    const treeOnWindows = winTree && launcher !== undefined && !this.procExited
    if (spec?.killTree === true && host.platform !== 'win32' && launcher !== undefined) host.signal(-launcher, 'SIGKILL')
    if (!treeOnWindows) child?.kill('SIGKILL')
    const gameAlive = server !== undefined && server !== launcher && host.alive(server)
    // Windows, launcher already gone: the rest of the tree hangs off the game process.
    if (gameAlive && winTree && !treeOnWindows) await this.killGame(server)
    else if (gameAlive) host.signal(server, 'SIGKILL')
    if (treeOnWindows) {
      try {
        await host.exec('taskkill', ['/PID', String(launcher), '/T', '/F'])
      } catch (err) {
        this.emit('warning', `taskkill of launcher pid ${launcher}: ${(err as Error).message}`)
      }
      child?.kill('SIGKILL')
    }
    // Wine: `wineserver -k` follows in finalize(), once the launcher has exited.
  }

  private async wineserverKill (wine: NonNullable<LaunchSpec['wine']>): Promise<void> {
    try {
      await this.host.exec(wineserverBin(wine), ['-k'], { WINEPREFIX: wine.prefix })
    } catch (err) {
      this.emit('warning', `wineserver -k: ${(err as Error).message}`)
    }
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
        // The host OS decides the tool (a Windows build under Wine is pinned with taskset).
        const [file, args] = affinityCommand(pid, this.opts.affinity, this.host.platform === 'win32' ? 'win' : 'linux')
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

  /**
   * The spawned process exited and its stdio drained. Clean up what a launcher may leave behind
   * (Linux: the rest of its process group; Wine: `wineserver -k`), then end the run.
   */
  private finalize (child: ChildProcess | undefined, code: number | null, signal: string | null): void {
    if (this.exited || this.finalizing || this.proc !== child) return
    this.procExited = true
    this.stopWatchdog()
    // Decided when the launcher exited: a stop() during cleanup must not turn a crash into an expected exit.
    const expected = this.exitExpected ?? this.stopRequested
    const reaping = this.reaping
    const wine = child !== undefined ? this.spec?.wine : undefined
    if (reaping === undefined && wine === undefined) {
      this.endRun(code, signal, expected)
      return
    }
    this.finalizing = true
    void (async () => {
      try { await reaping } catch {}
      if (wine !== undefined) await this.wineserverKill(wine)
    })().finally(() => this.endRun(code, signal, expected))
  }

  private endRun (code: number | null, signal: string | null, expected: boolean): void {
    this.finalizing = false
    this.reaping = undefined
    this.unguardHarnessExit()
    this.exited = true
    this.procExited = true
    this.log?.end()
    this.log = undefined
    const info: ExitInfo = { code, signal, expected }
    this.resolveExit(info)
    this.emit('exit', info)
  }

  send (command: string): void {
    if (/[\r\n]/.test(command)) throw new Error('BDS command must be a single line')
    const stdin = this.proc?.stdin
    if (this.exited || this.procExited || !stdin || !stdin.writable) throw new Error('BDS is not running')
    stdin.write(command + '\n')
  }

  /**
   * Run `fn` once the queue is free: after the running job, every queued `priority` job and,
   * for the `normal` lane, every previously queued `normal` job finished (successfully or not).
   */
  private enqueue<T> (fn: () => Promise<T>, lane: CommandLane = 'normal'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push(() => {
        let p: Promise<T>
        try { p = fn() } catch (err) { p = Promise.reject(err) }
        p.then(resolve, reject).finally(() => {
          this.busy = false
          this.pump()
        })
      })
      this.pump()
    })
  }

  private pump (): void {
    if (this.busy) return
    const job = this.lanes.priority.shift() ?? this.lanes.normal.shift()
    if (job === undefined) return
    this.busy = true
    // Run asynchronously, like a promise continuation, so callers never see a synchronous send.
    queueMicrotask(job)
  }

  /**
   * Write `command` in queue order without waiting for output. Resolves with the host time
   * (`hostNow()`) taken right before the bytes were written; rejects when BDS is not running.
   * `onSent` gets the same time synchronously right after the write, before any output of the
   * command can be processed.
   */
  sendQueued (command: string, opts: { priority?: boolean, onSent?: (sentAt: number) => void } = {}): Promise<number> {
    return this.enqueue(async () => {
      const sentAt = hostNow()
      this.send(command)
      opts.onSent?.(sentAt)
      return sentAt
    }, opts.priority === true ? 'priority' : 'normal')
  }

  /**
   * Write `command` and feed every following non-blank, non-probe line (and, unless the command
   * is itself a gametime query, non-`Gametime is` line) to `done` until it
   * returns true. Not queued; callers go through `enqueue`.
   */
  private collect (command: string, done: (p: ParsedBdsLine) => boolean, timeoutMs?: number, onSent?: (at: number) => void): Promise<string[]> {
    const t = timeoutMs ?? this.opts.commandTimeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      const lines: string[] = []
      // Replies to fire-and-forget gametime queries (GametimeSampler) are not this command's output.
      const skipGametime = !GAMETIME_CMD_RE.test(command)
      const finish = (err?: Error): void => {
        clearTimeout(timer)
        this.collectors.delete(collector)
        this.events.off('exit', onExit)
        if (err) reject(err)
        else resolve(lines)
      }
      const collector: Collector = p => {
        if (p.kind === 'probe') return
        if (skipGametime && parseGametime(p.message) !== undefined) return
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
        const at = hostNow()
        this.send(command)
        onSent?.(at)
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
      // The names line lists exactly `online` names; skip unrelated output. Vanilla prints it
      // without a prefix; loaders (LeviLamina, Endstone) put their logger prefix on every line.
      if (p.format === 'bds') return false
      const candidate = parseListNames(p.message)
      if (candidate.length !== header.online) return false
      names = candidate
      return true
    }, timeoutMs))
    return { online: header!.online, max: header!.max, names }
  }

  /**
   * `time query gametime`: the tick counter, independent of the Script API. `sentAt` is taken
   * right before the command is written, `recvAt` when the `Gametime is <n>` line is read (both
   * `hostNow()`). `priority` puts the query ahead of queued normal commands.
   */
  async queryGametime (opts: { timeoutMs?: number, priority?: boolean } = {}): Promise<GametimeReading> {
    let sentAt = Number.NaN
    let recvAt = Number.NaN
    let gametime: number | undefined
    await this.enqueue(() => this.collect(GAMETIME_COMMAND, p => {
      const g = parseGametime(p.message)
      if (g !== undefined) {
        recvAt = hostNow()
        gametime = g
        return true
      }
      if (p.kind === 'error' && COMMAND_FAILURE_RE.test(p.message)) throw new BdsCommandError(GAMETIME_COMMAND, p.message, [p.text])
      return false
    }, opts.timeoutMs, at => { sentAt = at }), opts.priority === true ? 'priority' : 'normal')
    return { gametime: gametime!, sentAt, recvAt }
  }

  /** `gamerule <rule> <value>`; rejects on a syntax error or unknown rule. */
  async setGamerule (rule: string, value: string | number | boolean, timeoutMs?: number): Promise<void> {
    await this.exec(`gamerule ${rule} ${String(value)}`, /^Game rule \S+ has been updated to/, timeoutMs)
  }

  /** `say <msg>`. BDS prints nothing for it, so this only queues the write behind pending commands. */
  say (message: string): Promise<void> {
    return this.sendQueued(`say ${message}`).then(() => {})
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

  /**
   * Graceful stop: write the LaunchSpec's `stopCommand` (default `stop`) and wait for the run to
   * end; after `timeoutMs` kill (the whole tree with `killTree`). Idempotent.
   */
  stop (timeoutMs?: number): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (this.exited) return Promise.resolve()
    const t = timeoutMs ?? this.opts.stopTimeoutMs ?? 30_000
    this.stopTimeoutMs = t
    this.stopRequested = true
    this.stopPromise = (async () => {
      let delivered = true
      try { this.send(this.spec?.stopCommand ?? 'stop') } catch { delivered = false }
      // No graceful stop was delivered (stdin closed / process already dead): kill right away.
      const timer = setTimeout(() => { void this.killProcesses() }, delivered ? t : 0)
      await this.exitPromise
      clearTimeout(timer)
    })()
    return this.stopPromise
  }

  /** Kill immediately, the whole tree with `killTree` (counts as an expected exit). Resolves when the run ended. */
  async kill (): Promise<void> {
    if (this.exited) return
    this.stopRequested = true
    void this.killProcesses()
    await this.exitPromise
  }
}
