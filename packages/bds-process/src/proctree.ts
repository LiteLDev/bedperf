// Process-table access for launcher-based servers: find the game process among a launcher's
// descendants, find helper processes (wineserver, ...), and kill a whole tree. Every OS call goes
// through `ProcessHost`, so unit tests run against a fake process table.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'

/** One row of the process table. */
export interface ProcInfo {
  pid: number
  ppid: number
  /** Image name. Windows: `bedrock_server.exe`. Linux: `comm` (at most 15 characters). */
  name: string
  /** Linux: basename of argv[0] (Wine shows the Windows image name there). */
  argv0?: string
  /** Creation time, comparable only within one host backend (Windows: FILETIME ms; Linux: ms since boot). 0 = unknown. */
  start: number
  /** Linux: owner uid. */
  uid?: number
}

/** The OS operations `BdsProcess` needs beyond spawning. Injectable for tests. */
export interface ProcessHost {
  readonly platform: NodeJS.Platform
  /** Every process on the machine (best effort; unreadable entries are skipped). */
  list (): Promise<ProcInfo[]>
  /** One environment variable of another process. Undefined when unset, unreadable or unsupported. */
  envVar (pid: number, name: string): Promise<string | undefined>
  /** Uid of this process (POSIX), else undefined. */
  uid (): number | undefined
  /** True while `pid` exists. */
  alive (pid: number): boolean
  /** `process.kill`, errors swallowed. A negative pid signals a process group (POSIX). */
  signal (pid: number, sig: NodeJS.Signals): void
  /** Run a helper command to completion (taskkill, wineserver -k). Rejects on failure. */
  exec (file: string, args: string[], env?: Record<string, string>): Promise<void>
}

/** Basename of a path written with either separator. */
export function baseName (path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Case-insensitive image-name matcher built from a LaunchSpec RegExp source. */
export function namePatternRe (source: string): RegExp {
  return new RegExp(source, 'i')
}

/** True when the image name (or, on Linux, the basename of argv[0]) matches. */
export function procMatches (p: ProcInfo, re: RegExp): boolean {
  re.lastIndex = 0
  if (re.test(p.name)) return true
  if (p.argv0 === undefined || p.argv0 === '') return false
  re.lastIndex = 0
  return re.test(p.argv0)
}

/**
 * `root` (when present in `procs`) followed by its descendants, breadth first, lowest pid first
 * within a generation. A parent link is followed only when the child was created no earlier than
 * the parent (when both times are known), so a reused parent pid cannot adopt unrelated processes.
 */
export function processTree (procs: readonly ProcInfo[], root: number): ProcInfo[] {
  const byPid = new Map<number, ProcInfo>()
  const kids = new Map<number, ProcInfo[]>()
  for (const p of procs) {
    byPid.set(p.pid, p)
    if (p.pid === p.ppid) continue
    const list = kids.get(p.ppid)
    if (list) list.push(p)
    else kids.set(p.ppid, [p])
  }
  const out: ProcInfo[] = []
  const rootInfo = byPid.get(root)
  if (rootInfo) out.push(rootInfo)
  const seen = new Set<number>([root])
  let gen: Array<{ pid: number, start: number }> = [{ pid: root, start: rootInfo?.start ?? 0 }]
  while (gen.length > 0) {
    const next: Array<{ pid: number, start: number }> = []
    for (const parent of gen) {
      const children = (kids.get(parent.pid) ?? []).slice().sort((a, b) => a.pid - b.pid)
      for (const c of children) {
        if (seen.has(c.pid)) continue
        if (parent.start > 0 && c.start > 0 && c.start < parent.start) continue
        seen.add(c.pid)
        out.push(c)
        next.push({ pid: c.pid, start: c.start })
      }
    }
    gen = next
  }
  return out
}

/** The game process: `root` itself or its first descendant whose name matches `re`. */
export function findServerProcess (procs: readonly ProcInfo[], root: number, re: RegExp): ProcInfo | undefined {
  return processTree(procs, root).find(p => procMatches(p, re))
}

export interface AuxFilter {
  patterns: readonly RegExp[]
  /** Pids never reported (launcher, server). */
  exclude?: ReadonlySet<number>
  /** Only processes of this uid (Linux). */
  uid?: number
  /** Wine: keep only processes whose WINEPREFIX is this (processes whose environment is unreadable are kept). */
  winePrefix?: string
}

/**
 * Helper processes of the server matched by name anywhere in the table (they are usually not
 * descendants: wineserver daemonizes). Narrowed by uid and, for Wine, by WINEPREFIX.
 */
export async function findAuxProcesses (host: ProcessHost, procs: readonly ProcInfo[], f: AuxFilter): Promise<number[]> {
  if (f.patterns.length === 0) return []
  const out: number[] = []
  for (const p of procs) {
    if (f.exclude?.has(p.pid)) continue
    if (!f.patterns.some(re => procMatches(p, re))) continue
    if (f.uid !== undefined && p.uid !== undefined && p.uid !== f.uid) continue
    if (f.winePrefix !== undefined) {
      const prefix = await host.envVar(p.pid, 'WINEPREFIX')
      if (prefix !== undefined && trimSlash(prefix) !== trimSlash(f.winePrefix)) continue
    }
    out.push(p.pid)
  }
  return out.sort((a, b) => a - b)
}

function trimSlash (s: string): string {
  return s.replace(/[\\/]+$/, '')
}

function execP (file: string, args: string[], env?: Record<string, string>, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: env === undefined ? process.env : { ...process.env, ...env }
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args.join(' ')} failed: ${err.message}${stderr ? ` (${String(stderr).trim()})` : ''}`))
      else resolve(String(stdout))
    })
  })
}

/** PowerShell printing `pid<TAB>ppid<TAB>creationFileTimeMs<TAB>name` per process. */
export const WINDOWS_LIST_SCRIPT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = [long]($_.CreationDate.ToFileTimeUtc() / 10000) }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$c`t$($_.Name)" }'

/** Parse the output of `WINDOWS_LIST_SCRIPT`. */
export function parseWindowsList (text: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const f = line.split('\t')
    if (f.length < 4) continue
    const pid = Number(f[0])
    const ppid = Number(f[1])
    const start = Number(f[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    out.push({ pid, ppid, start: Number.isFinite(start) ? start : 0, name: f.slice(3).join('\t').trim() })
  }
  return out
}

/** Fields of `/proc/<pid>/stat`: comm, ppid, starttime (clock ticks since boot). */
export function parseStat (text: string): { comm: string, ppid: number, startTicks: number } | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return undefined
  const f = text.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(f[1])
  const startTicks = Number(f[19])
  if (!Number.isInteger(ppid)) return undefined
  return { comm: text.slice(open + 1, close), ppid, startTicks: Number.isFinite(startTicks) ? startTicks : 0 }
}

/** The state letter of `/proc/<pid>/stat` (`R`, `S`, `Z`, ...). */
export function linuxProcState (statText: string): string | undefined {
  const close = statText.lastIndexOf(')')
  return close < 0 ? undefined : statText.slice(close + 2, close + 3) || undefined
}

/** Basename of argv[0] from `/proc/<pid>/cmdline` (NUL-separated). */
export function argv0Name (cmdline: string): string {
  const a0 = cmdline.split('\0')[0] ?? ''
  return baseName(a0.trim())
}

export interface LinuxHostOptions {
  procRoot?: string
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
  statUid?: (path: string) => Promise<number>
}

export async function listLinuxProcesses (opts: LinuxHostOptions = {}): Promise<ProcInfo[]> {
  const root = opts.procRoot ?? '/proc'
  const rf = opts.readFile ?? ((p: string) => readFile(p, 'utf8'))
  const rd = opts.readdir ?? ((p: string) => readdir(p))
  const su = opts.statUid ?? (async (p: string) => (await stat(p)).uid)
  const pids = (await rd(root)).filter(n => /^\d+$/.test(n)).map(Number)
  const one = async (pid: number): Promise<ProcInfo | undefined> => {
    try {
      const s = parseStat(await rf(`${root}/${pid}/stat`))
      if (!s) return undefined
      const p: ProcInfo = { pid, ppid: s.ppid, name: s.comm, start: s.startTicks * 10 }
      try { p.argv0 = argv0Name(await rf(`${root}/${pid}/cmdline`)) } catch {}
      try { p.uid = await su(`${root}/${pid}`) } catch {}
      return p
    } catch {
      return undefined
    }
  }
  const out: ProcInfo[] = []
  for (let i = 0; i < pids.length; i += 64) {
    for (const p of await Promise.all(pids.slice(i, i + 64).map(one))) if (p) out.push(p)
  }
  return out
}

/** Read one variable from `/proc/<pid>/environ`. */
export async function linuxEnvVar (pid: number, name: string, opts: LinuxHostOptions = {}): Promise<string | undefined> {
  const rf = opts.readFile ?? ((p: string) => readFile(p, 'utf8'))
  try {
    const env = await rf(`${opts.procRoot ?? '/proc'}/${pid}/environ`)
    for (const kv of env.split('\0')) {
      if (kv.startsWith(name + '=')) return kv.slice(name.length + 1)
    }
  } catch {}
  return undefined
}

/** The real host: CIM on Windows, `/proc` on Linux. */
export function createProcessHost (): ProcessHost {
  const platform = process.platform
  return {
    platform,
    async list () {
      if (platform === 'win32') {
        return parseWindowsList(await execP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_SCRIPT], undefined, 30_000))
      }
      if (platform === 'linux') return listLinuxProcesses()
      throw new Error(`no process table on ${platform}`)
    },
    envVar: (pid, name) => platform === 'linux' ? linuxEnvVar(pid, name) : Promise.resolve(undefined),
    uid: () => typeof process.getuid === 'function' ? process.getuid() : undefined,
    alive (pid) {
      try {
        process.kill(pid, 0)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
      }
      // Linux: a dead child its parent has not reaped yet is a zombie and still answers signal 0.
      if (platform === 'linux') {
        try {
          return !/^[ZX]$/.test(linuxProcState(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? '')
        } catch {
          return false
        }
      }
      return true
    },
    signal (pid, sig) {
      try { process.kill(pid, sig) } catch {}
    },
    async exec (file, args, env) {
      await execP(file, args, env)
    }
  }
}
