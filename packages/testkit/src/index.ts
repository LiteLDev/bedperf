// @bedperf/testkit — minimal, dependency-light helpers for tests and e2e checks:
// start a throwaway BDS instance from the pristine cache, and join bedboo bots.
// Production code should use @bedperf/bds-install / @bedperf/bds-process instead.
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { REQUIRED_BOT_PROPERTIES, type ServerProperties } from '@bedperf/core'
import type { Bot, BotOptions } from 'bedboo'

const require = createRequire(import.meta.url)

/** BDS build the step-0 scaffold downloaded; bedboo family 1.26.60 supports it. */
export const DEFAULT_BDS_VERSION = '1.26.63.1'
export const DEFAULT_BOT_VERSION = '1.26.60'

/** Root of the shared BDS download cache (never modify files inside it). */
export function bdsCacheRoot (): string {
  if (process.env.BEDPERF_CACHE_DIR) return join(process.env.BEDPERF_CACHE_DIR, 'bds')
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'bedperf', 'cache', 'bds')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'bedperf', 'bds')
}

/** Directory of an extracted, pristine BDS build. Throws if it is not in the cache. */
export function pristineBdsDir (version: string = DEFAULT_BDS_VERSION): string {
  const dir = join(bdsCacheRoot(), version)
  const exe = join(dir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server')
  if (!existsSync(exe)) {
    throw new Error(`BDS ${version} not found at ${dir}. Download+extract it there first (see repo README).`)
  }
  return dir
}

// Large read-only parts are hard-linked to save ~300 MB and seconds per instance; anything the
// server or tests may write (properties, config, worlds, json lists) is copied.
const LINKABLE = new Set(['bedrock_server.exe', 'bedrock_server', 'behavior_packs', 'resource_packs', 'definitions', 'data'])

function linkTree (src: string, dst: string): void {
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const e of readdirSync(src)) linkTree(join(src, e), join(dst, e))
    return
  }
  try { linkSync(src, dst) } catch { cpSync(src, dst) }
}

/** Copy the pristine build into a fresh temp directory and return its path. */
export function makeInstanceDir (version: string = DEFAULT_BDS_VERSION, parent: string = tmpdir()): string {
  const src = pristineBdsDir(version)
  const dir = mkdtempSync(join(parent, 'bedperf-bds-'))
  for (const e of readdirSync(src)) {
    if (LINKABLE.has(e)) linkTree(join(src, e), join(dir, e))
    else cpSync(join(src, e), join(dir, e), { recursive: true })
  }
  return dir
}

/** Rewrite server.properties keeping the original order/comments and appending unknown keys. */
export function writeServerProperties (dir: string, props: ServerProperties): void {
  const file = join(dir, 'server.properties')
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const pending = new Map(Object.entries(props).map(([k, v]) => [k, String(v)]))
  const out = lines.map(l => {
    const m = /^([a-z0-9-]+)=/.exec(l)
    if (m && pending.has(m[1]!)) {
      const v = pending.get(m[1]!)!
      pending.delete(m[1]!)
      return `${m[1]}=${v}`
    }
    return l
  })
  for (const [k, v] of pending) out.push(`${k}=${v}`)
  rmSync(file) // never write through a link
  writeFileSync(file, out.join('\n'))
}

/**
 * Install a behavior pack directory (containing manifest.json) into the instance and enable it
 * on `levelName` via worlds/<level>/world_behavior_packs.json. Works before the world exists.
 */
export function installBehaviorPack (dir: string, packDir: string, levelName: string): void {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as {
    header: { uuid: string, version: number[] | string }
  }
  const name = `bedperf_${manifest.header.uuid.slice(0, 8)}`
  cpSync(packDir, join(dir, 'behavior_packs', name), { recursive: true })
  const worldDir = join(dir, 'worlds', levelName)
  mkdirSync(worldDir, { recursive: true })
  const listFile = join(worldDir, 'world_behavior_packs.json')
  const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, 'utf8')) as unknown[] : []
  const version = typeof manifest.header.version === 'string'
    ? manifest.header.version.split('.').map(Number)
    : manifest.header.version
  list.push({ pack_id: manifest.header.uuid, version })
  writeFileSync(listFile, JSON.stringify(list, null, 2))
}

export interface TestBdsOptions {
  /** IPv4 port; IPv6 port is port+1. */
  port: number
  version?: string
  properties?: ServerProperties
  /** Behavior pack directories to install and enable. */
  behaviorPacks?: string[]
  levelName?: string
  readyTimeoutMs?: number
  /** Mirror server output to this process' stdout. */
  echo?: boolean
}

export interface TestBds {
  dir: string
  port: number
  proc: ChildProcess
  /** All output lines so far. */
  lines: string[]
  onLine (cb: (line: string) => void): () => void
  send (command: string): void
  /** Resolve with the first line (from now on, or already seen if `includePast`) matching `re`. */
  waitForLine (re: RegExp, timeoutMs?: number, includePast?: boolean): Promise<string>
  /** Graceful stop, kill after timeout, then delete the instance dir (unless keepDir). */
  stop (opts?: { timeoutMs?: number, keepDir?: boolean }): Promise<void>
}

export async function startTestBds (opts: TestBdsOptions): Promise<TestBds> {
  const levelName = opts.levelName ?? 'bedperf'
  const dir = makeInstanceDir(opts.version)
  writeServerProperties(dir, {
    ...REQUIRED_BOT_PROPERTIES,
    'server-port': opts.port,
    'server-portv6': opts.port + 1,
    'level-name': levelName,
    ...opts.properties
  })
  for (const p of opts.behaviorPacks ?? []) installBehaviorPack(dir, p, levelName)

  const isWin = process.platform === 'win32'
  const exe = join(dir, isWin ? 'bedrock_server.exe' : 'bedrock_server')
  const proc = spawn(exe, [], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: isWin ? process.env : { ...process.env, LD_LIBRARY_PATH: dir },
    windowsHide: true
  })
  const lines: string[] = []
  const listeners = new Set<(l: string) => void>()
  const onRaw = (l: string): void => {
    lines.push(l)
    if (opts.echo) process.stdout.write(`[bds:${opts.port}] ${l}\n`)
    for (const cb of listeners) cb(l)
  }
  createInterface({ input: proc.stdout! }).on('line', onRaw)
  createInterface({ input: proc.stderr! }).on('line', onRaw)
  let exited = false
  const exitP = new Promise<void>(resolve => proc.once('exit', () => { exited = true; resolve() }))

  const onLine = (cb: (l: string) => void): (() => void) => { listeners.add(cb); return () => listeners.delete(cb) }
  const waitForLine = (re: RegExp, timeoutMs = 30_000, includePast = false): Promise<string> =>
    new Promise((resolve, reject) => {
      if (includePast) {
        const hit = lines.find(l => re.test(l))
        if (hit !== undefined) { resolve(hit); return }
      }
      const off = onLine(l => { if (re.test(l)) { cleanup(); resolve(l) } })
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${re} on BDS :${opts.port}`)) }, timeoutMs)
      const onExit = (): void => { cleanup(); reject(new Error(`BDS :${opts.port} exited while waiting for ${re}`)) }
      proc.once('exit', onExit)
      function cleanup (): void { off(); clearTimeout(timer); proc.off('exit', onExit) }
    })
  const send = (command: string): void => { proc.stdin!.write(command + '\n') }
  const stop = async ({ timeoutMs = 20_000, keepDir = false } = {}): Promise<void> => {
    if (!exited) {
      try { send('stop') } catch {}
      const t = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
      await exitP
      clearTimeout(t)
    }
    if (!keepDir) {
      for (let i = 0; i < 10; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break } catch { await new Promise(r => setTimeout(r, 500)) }
      }
    }
  }

  try {
    await waitForLine(/Server started\./, opts.readyTimeoutMs ?? 120_000, true)
  } catch (err) {
    await stop()
    throw new Error(`${(err as Error).message}\n--- last BDS output ---\n${lines.slice(-30).join('\n')}`)
  }
  return { dir, port: opts.port, proc, lines, onLine, send, waitForLine, stop }
}

/** Create a bedboo bot and resolve once it has spawned. */
export function createTestBot (opts: { port: number, username: string, host?: string, version?: string, timeoutMs?: number } & Partial<BotOptions>): Promise<Bot> {
  const { createBot } = require('bedboo') as typeof import('bedboo')
  const { timeoutMs = 30_000, ...rest } = opts
  const bot = createBot({
    host: '127.0.0.1',
    version: DEFAULT_BOT_VERSION,
    auth: 'offline',
    viewDistance: 'tiny',
    ...rest
  } as BotOptions)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bot.end(); reject(new Error(`bot ${opts.username} did not spawn within ${timeoutMs} ms`)) }, timeoutMs)
    bot.once('spawn', () => { clearTimeout(timer); resolve(bot) })
    bot.once('error', (e: Error) => { clearTimeout(timer); reject(e) })
    bot.once('kicked', (reason: unknown) => { clearTimeout(timer); reject(new Error(`bot ${opts.username} kicked: ${JSON.stringify(reason)}`)) })
  })
}
