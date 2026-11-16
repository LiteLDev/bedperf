import { readdir, readFile } from 'node:fs/promises'
import type { ProcEntry, ProcTable } from './proctable.ts'

export interface PidStat {
  comm: string
  ppid: number
  /** utime + stime, clock ticks. */
  cpuTicks: number
  /** Start time after boot, clock ticks. */
  startTicks: number
}

/** Parse the fields of `/proc/<pid>/stat` the process table needs. `comm` may contain spaces and parentheses. */
export function parsePidStat (text: string): PidStat {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) throw new Error('malformed stat')
  const f = text.slice(close + 2).trim().split(/\s+/)
  const num = (field: number): number => {
    const v = Number(f[field - 3])
    if (!Number.isFinite(v)) throw new Error(`malformed stat field ${field}`)
    return v
  }
  return { comm: text.slice(open + 1, close), ppid: num(4), cpuTicks: num(14) + num(15), startTicks: num(22) }
}

export interface LinuxProcTableOptions {
  /** Clock ticks per second (default 100). */
  clkTck?: number
  /** Default `/proc`. */
  procRoot?: string
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
}

export function createLinuxProcTable (opts: LinuxProcTableOptions = {}): ProcTable {
  const tck = opts.clkTck ?? 100
  const root = opts.procRoot ?? '/proc'
  const rf = opts.readFile ?? ((p: string) => readFile(p, 'utf8'))
  const rd = opts.readdir ?? ((p: string) => readdir(p))

  async function one (pid: number): Promise<ProcEntry | undefined> {
    try {
      const s = parsePidStat(await rf(`${root}/${pid}/stat`))
      return { pid, ppid: s.ppid, cpuMs: s.cpuTicks * 1000 / tck, start: s.startTicks * 1000 / tck, name: s.comm }
    } catch {
      return undefined // gone, or unreadable
    }
  }
  /** Bounded concurrency so a big process table cannot exhaust file descriptors (EMFILE). */
  async function many (pids: number[]): Promise<ProcEntry[]> {
    const out: ProcEntry[] = []
    for (let i = 0; i < pids.length; i += 64) {
      for (const e of await Promise.all(pids.slice(i, i + 64).map(one))) if (e) out.push(e)
    }
    return out
  }

  return {
    async scan () {
      const pids = (await rd(root)).filter(n => /^\d+$/.test(n)).map(Number)
      return many(pids)
    },
    read: many,
    async close () {}
  }
}
