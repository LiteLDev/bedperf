// Provenance: content hashes, the machine fingerprint, harness identity and the path scrubber that keeps
// run metadata free of absolute paths, user and host names.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessInfo, MachineInfo } from './run.ts'

// ---------------------------------------------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------------------------------------------

/**
 * Compact JSON with object keys sorted recursively: the input to every content hash. Rejects NaN and
 * ±Infinity (JSON.stringify would silently write `null`). `undefined` follows JSON: dropped from objects,
 * `null` in arrays.
 */
export function canonicalJson (v: unknown): string {
  return canon(v, true) ?? 'null'
}

function canon (v: unknown, top: boolean): string | undefined {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'string': return JSON.stringify(v)
    case 'boolean': return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number ${String(v)}`)
      return JSON.stringify(v)
    case 'undefined': case 'function': case 'symbol': return top ? 'null' : undefined
    case 'bigint': throw new Error('canonicalJson: bigint is not JSON')
  }
  if (Array.isArray(v)) return `[${v.map(x => canon(x, false) ?? 'null').join(',')}]`
  const o = v as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(o).sort()) {
    const s = canon(o[k], false)
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`)
  }
  return `{${parts.join(',')}}`
}

export function sha256Hex (data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** sha256 of `canonicalJson(v)` (UTF-8), hex. */
export function sha256Json (v: unknown): string {
  return sha256Hex(canonicalJson(v))
}

/**
 * sha256Json of a config without its `server` section: two runs with the same value ran the same
 * benchmark, possibly on different server implementations.
 */
export function benchConfigSha256 (config: object): string {
  const { server: _server, ...rest } = config as Record<string, unknown>
  return sha256Json(rest)
}

// ---------------------------------------------------------------------------------------------------------------
// OS / git calls (injectable)
// ---------------------------------------------------------------------------------------------------------------

/** Runs a command and resolves with its stdout; rejects when it cannot start or exits non-zero. */
export type ExecFn = (cmd: string, args: readonly string[], opts?: { cwd?: string, timeoutMs?: number }) => Promise<string>

export const defaultExec: ExecFn = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
    if (err != null) reject(err)
    else resolve(stdout)
  })
})

/** The bedperf checkout this module runs from. */
export const BEDPERF_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// ---------------------------------------------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------------------------------------------

export interface MachineDeps {
  platform?: NodeJS.Platform
  cpus?: () => Array<{ model: string }>
  totalmem?: () => number
  osType?: () => string
  osRelease?: () => string
  exec?: ExecFn
  readFile?: (path: string) => string
}

export function osFamily (platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'windows' : platform
}

/** Count unique (physical id, core id) pairs in /proc/cpuinfo text. */
export function parseCpuinfoCores (text: string): number | undefined {
  const seen = new Set<string>()
  for (const block of text.split(/\n\s*\n/)) {
    const phys = /^physical id\s*:\s*(\S+)/m.exec(block)?.[1]
    const core = /^core id\s*:\s*(\S+)/m.exec(block)?.[1]
    if (core !== undefined) seen.add(`${phys ?? '0'}:${core}`)
  }
  return seen.size > 0 ? seen.size : undefined
}

/** Physical core count, best effort: undefined when it cannot be told. */
export async function physicalCores (deps: MachineDeps = {}): Promise<number | undefined> {
  const platform = deps.platform ?? process.platform
  try {
    if (platform === 'win32') {
      // The fingerprint includes this count, so a transient CIM failure must not change it: try twice.
      const exec = deps.exec ?? defaultExec
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'], { timeoutMs: 30000 })
          const n = Number(out.trim())
          if (Number.isInteger(n) && n > 0) return n
        } catch {}
      }
      return undefined
    }
    if (platform === 'linux') {
      const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
      return parseCpuinfoCores(read('/proc/cpuinfo'))
    }
  } catch {}
  return undefined
}

/**
 * Hardware description for meta.json. `fingerprint` hashes the OS family, CPU model, logical and physical
 * core counts and RAM in whole GiB: it survives OS updates and reboots but changes with the hardware, and it
 * contains no host or user name.
 */
export async function machineInfo (deps: MachineDeps = {}): Promise<MachineInfo> {
  const platform = deps.platform ?? process.platform
  const cpus = (deps.cpus ?? os.cpus)()
  const cpuModel = cpus[0]?.model.trim().replace(/\s+/g, ' ') || 'unknown'
  const logical = cpus.length
  const physical = await physicalCores(deps)
  const ramGiB = Math.round((deps.totalmem ?? os.totalmem)() / 2 ** 30 * 10) / 10
  const fingerprint = sha256Json({ osFamily: osFamily(platform), cpuModel, logical, physical: physical ?? null, ramGiB: Math.round(ramGiB) }).slice(0, 16)
  return {
    fingerprint,
    os: `${(deps.osType ?? os.type)()} ${(deps.osRelease ?? os.release)()}`,
    cpuModel,
    logical,
    ...(physical !== undefined ? { physical } : {}),
    ramGiB
  }
}

/** The 16-hex-digit machine fingerprint alone (see `machineInfo`). */
export async function machineFingerprint (deps: MachineDeps = {}): Promise<string> {
  return (await machineInfo(deps)).fingerprint
}

// ---------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------

export interface HarnessDeps {
  /** bedperf version (package.json). */
  version: string
  /** Checkout to describe. Default the repo this module lives in. */
  repo?: string
  exec?: ExecFn
  nodeVersion?: string
  /** Environment (for `HARNESS_GIT_ENV`). Default `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Commit of a checkout without git metadata (e.g. the `bedperf agent` container image, built with
 * `--build-arg BEDPERF_GIT=$(git rev-parse HEAD)`): used only when git cannot tell, and `dirty` is then unknown.
 */
export const HARNESS_GIT_ENV = 'BEDPERF_HARNESS_GIT'

/**
 * bedperf's own identity: version, git commit and whether tracked files under packages/ or scripts/ differ
 * from it (`dirty`), and the Node version. `git`/`dirty` are omitted when git is unavailable (unless
 * `HARNESS_GIT_ENV` names the commit).
 */
export async function harnessInfo (deps: HarnessDeps): Promise<HarnessInfo> {
  const exec = deps.exec ?? defaultExec
  const repo = deps.repo ?? BEDPERF_REPO_ROOT
  const out: HarnessInfo = { version: deps.version, node: deps.nodeVersion ?? process.version }
  try {
    const head = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim()
    if (/^[0-9a-f]{40,64}$/.test(head)) {
      out.git = head
      const status = await exec('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no', '--', 'packages', 'scripts'])
      out.dirty = status.trim() !== ''
    }
  } catch {}
  const pinned = (deps.env ?? process.env)[HARNESS_GIT_ENV]?.trim().toLowerCase()
  if (out.git === undefined && pinned !== undefined && /^[0-9a-f]{40,64}$/.test(pinned)) out.git = pinned
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Scrubber
// ---------------------------------------------------------------------------------------------------------------

/** Absolute Windows paths (drive or UNC). */
const WINDOWS_ABS = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'<>|]*/g
/** POSIX locations that identify a user or a machine; system paths such as /usr/lib are left alone. */
const POSIX_PRIVATE = /(?<![\w.~>-])\/(?:home|Users|root|tmp|mnt|media|var\/folders|var\/tmp|run\/user)(?![^\\/\s"'<>|])(?:\/[^\s"'<>|]*)?/g
/** Names too common to replace as words: they would mangle ordinary text. */
const COMMON_WORDS = new Set(['admin', 'administrator', 'user', 'users', 'root', 'runner', 'ubuntu', 'debian', 'guest', 'test', 'server', 'localhost'])
/** One absolute path (drive, UNC or POSIX) and nothing else; spaces allowed, no leading/trailing space. */
const WHOLE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/)[^\r\n\t"'<>|*?]*[^\r\n\t"'<>|*? ]$/
/** Private-use character standing in for a space inside a whole-path string. */
const SPACE = '\uE000'
const REST = String.raw`((?:[\\/][^\s"'<>|\\/]*)*)`
/** A root ends at a separator or where the path token ends, so `/w/abc` does not match inside `/w/abc1`. */
const ROOT_END = String.raw`(?![^\\/\s"'<>|])`

function escapeRe (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

function rootPattern (p: string): string | undefined {
  const parts = p.split(/[\\/]+/).filter(x => x !== '')
  // Never treat a bare drive or `/` as a root: it would swallow every path.
  const meaningful = parts.filter(x => !/^[A-Za-z]:$/.test(x))
  if (meaningful.length === 0) return undefined
  // A space in the root also matches SPACE, the stand-in used while scrubbing a whole-path string.
  const body = parts.map(x => escapeRe(x).replaceAll(' ', `[ ${SPACE}]`)).join(String.raw`[\\/]+`) + ROOT_END
  if (p.startsWith('\\\\') || p.startsWith('//')) return String.raw`[\\/]{2}` + body
  if (p.startsWith('/') || p.startsWith('\\')) return String.raw`(?<![\w.>])[\\/]` + body
  return String.raw`(?<![A-Za-z0-9])` + body
}

function absPlaceholder (match: string): string {
  const name = match.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  return name !== '' && !name.endsWith(':') ? `<abs>/${name}` : '<abs>'
}

function replaceableWord (w: string): boolean {
  return w.length >= 3 && !COMMON_WORDS.has(w.toLowerCase())
}

function safe<T> (f: () => T): T | undefined {
  try { return f() } catch { return undefined }
}

/**
 * Root of the bedperf cache (parent of `bds/`, `snapshots/` and `machine.lock`). `cacheBaseDir()` in
 * @bedperf/bds-install is this function.
 * - `BEDPERF_CACHE_DIR` if set
 * - Windows: `%LOCALAPPDATA%\bedperf\cache`
 * - Linux: `$XDG_CACHE_HOME/bedperf` or `~/.cache/bedperf`
 */
export function defaultCacheRoot (): string {
  if (process.env['BEDPERF_CACHE_DIR']) return process.env['BEDPERF_CACHE_DIR']
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] || join(os.homedir(), 'AppData', 'Local'), 'bedperf', 'cache')
  }
  return join(process.env['XDG_CACHE_HOME'] || join(os.homedir(), '.cache'), 'bedperf')
}

/** `<cache>`, `<repo>`, `<tmp>`, `<home>` and (Windows) `<localappdata>`. */
export function defaultScrubRoots (): Record<string, string> {
  const roots: Record<string, string> = {}
  const add = (k: string, v: string | undefined): void => { if (v) roots[k] = v }
  add('<cache>', safe(defaultCacheRoot))
  add('<repo>', BEDPERF_REPO_ROOT)
  add('<tmp>', safe(os.tmpdir))
  add('<home>', safe(os.homedir))
  if (process.platform === 'win32') add('<localappdata>', process.env['LOCALAPPDATA'])
  return roots
}

export interface ScrubberOptions {
  /** User name to replace with `<user>`. Default the current user; null disables. */
  user?: string | null
  /** Host name to replace with `<host>`. Default this host (first label); null disables. */
  host?: string | null
  /** Include `defaultScrubRoots()`. Default true. */
  defaultRoots?: boolean
  /** Case-insensitive root matching. Default: on Windows. */
  ignoreCase?: boolean
}

/**
 * Replaces machine-specific details in strings and nested JSON-like data.
 *
 * `roots` maps a placeholder to a directory, e.g. `{ '<run>': runDir }`. A path under a root becomes
 * `<placeholder>/rest/with/forward/slashes`; the most specific (longest) root wins. Any absolute path that is
 * left (Windows drive or UNC, or POSIX /home, /Users, /root, /tmp, /mnt, /media, /var/folders, /var/tmp,
 * /run/user) becomes `<abs>/<file name>`. The user and host names are replaced as case-insensitive words,
 * when they are at least 3 characters and not common words.
 */
export class Scrubber {
  private readonly roots: Array<{ placeholder: string, re: RegExp }>
  private readonly words: Array<{ placeholder: string, re: RegExp }> = []

  constructor (roots: Record<string, string> = {}, opts: ScrubberOptions = {}) {
    const known: Record<string, string> = { ...(opts.defaultRoots !== false ? defaultScrubRoots() : {}), ...roots }
    const flags = (opts.ignoreCase ?? process.platform === 'win32') ? 'gi' : 'g'
    this.roots = Object.entries(known)
      .filter(([, p]) => p !== '')
      .sort((a, b) => b[1].length - a[1].length)
      .flatMap(([placeholder, p]) => {
        const pat = rootPattern(p)
        return pat === undefined ? [] : [{ placeholder, re: new RegExp(pat + REST, flags) }]
      })
    const user = opts.user === undefined ? safe(() => os.userInfo().username) : opts.user
    const host = opts.host === undefined ? safe(() => os.hostname().split('.')[0]) : opts.host
    for (const [placeholder, w] of [['<user>', user], ['<host>', host]] as const) {
      if (typeof w === 'string' && replaceableWord(w)) {
        this.words.push({ placeholder, re: new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, 'gi') })
      }
    }
  }

  /** Scrub one string. */
  text (value: string): string {
    // A string that is one whole absolute path may contain spaces (`C:\Users\John Smith\x`): let the path
    // patterns run through them by standing a private-use character in for each space while scrubbing.
    const whole = WHOLE_PATH.test(value)
    if (whole) value = value.replaceAll(' ', SPACE)
    value = this.scrubTokens(value)
    return whole ? value.replaceAll(SPACE, ' ') : value
  }

  private scrubTokens (value: string): string {
    for (const { placeholder, re } of this.roots) {
      value = value.replace(re, (_m, rest: string) => placeholder + rest.replace(/\\/g, '/'))
    }
    value = value.replace(WINDOWS_ABS, absPlaceholder)
    value = value.replace(POSIX_PRIVATE, absPlaceholder)
    for (const { placeholder, re } of this.words) value = value.replace(re, placeholder)
    return value
  }

  /** A scrubbed deep copy of a JSON-like value; strings everywhere, including object keys, are scrubbed. */
  scrub<T> (obj: T): T {
    return this.walk(obj) as T
  }

  private walk (obj: unknown): unknown {
    if (typeof obj === 'string') return this.text(obj)
    if (Array.isArray(obj)) return obj.map(x => this.walk(x))
    if (obj !== null && typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) out[this.text(k)] = this.walk(v)
      return out
    }
    return obj
  }

  /** Strings in `obj` (values and keys) that still contain an absolute private path, the user or host name. */
  leaks (obj: unknown): string[] {
    const found: string[] = []
    const test = (re: RegExp, s: string): boolean => { re.lastIndex = 0; return re.test(s) }
    const visit = (v: unknown): void => {
      if (typeof v === 'string') {
        if (test(WINDOWS_ABS, v) || test(POSIX_PRIVATE, v) || this.words.some(w => test(w.re, v))) found.push(v)
      } else if (Array.isArray(v)) v.forEach(visit)
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) { visit(k); visit(x) }
      }
    }
    visit(obj)
    return found
  }
}
