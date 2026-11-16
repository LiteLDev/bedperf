import { readdir, readFile } from 'node:fs/promises'
import type { Backend, BackendResult, NetCounter, RawThread } from './types.ts'

export interface ProcStat {
  comm: string
  state: string
  /** utime + stime, clock ticks. */
  cpuTicks: number
  numThreads: number
  /** Resident pages. */
  rssPages: number
}

/**
 * Parse `/proc/<pid>/stat` or `/proc/<pid>/task/<tid>/stat`. `comm` is in parentheses and
 * may itself contain spaces and parentheses, so split on the LAST `)`.
 */
export function parseProcStat (text: string): ProcStat {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) throw new Error('malformed stat')
  const comm = text.slice(open + 1, close)
  // Fields after comm start at field 3 (state); index 0 here == field 3.
  const f = text.slice(close + 2).trim().split(/\s+/)
  const num = (field: number): number => {
    const v = Number(f[field - 3])
    if (!Number.isFinite(v)) throw new Error(`malformed stat field ${field}`)
    return v
  }
  return {
    comm,
    state: f[0] ?? '?',
    cpuTicks: num(14) + num(15),
    numThreads: num(20),
    rssPages: num(24)
  }
}

export interface ProcStatus {
  vmRssBytes?: number
  rssAnonBytes?: number
  threads?: number
}

/** Parse `/proc/<pid>/status` (kB values converted to bytes). */
export function parseProcStatus (text: string): ProcStatus {
  const out: ProcStatus = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)(\s+kB)?/.exec(line)
    if (!m) continue
    const v = Number(m[2]) * (m[3] ? 1024 : 1)
    if (m[1] === 'VmRSS') out.vmRssBytes = v
    else if (m[1] === 'RssAnon') out.rssAnonBytes = v
    else if (m[1] === 'Threads') out.threads = v
  }
  return out
}

/** Per-interface rx/tx byte counters from `/proc/net/dev`, excluding `lo`. */
export function parseNetDev (text: string): NetCounter[] {
  const out: NetCounter[] = []
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const iface = line.slice(0, i).trim()
    if (iface === 'lo' || iface === '' || iface.includes('|')) continue
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number)
    // Receive: bytes packets errs drop fifo frame compressed multicast | Transmit: bytes ...
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue
    out.push({ name: iface, rxBytes: f[0]!, txBytes: f[8]! })
  }
  return out
}

/**
 * First field of `/proc/<pid>/task/<tid>/schedstat`: time spent on a CPU, ns. Unlike
 * utime+stime it is not quantized to clock ticks. Returns undefined if malformed.
 */
export function parseSchedstat (text: string): number | undefined {
  const v = Number(text.trim().split(/\s+/)[0])
  return text.trim() !== '' && Number.isFinite(v) && v >= 0 ? v : undefined
}

export interface LinuxBackendOptions {
  pid: number
  /** Clock ticks per second (`getconf CLK_TCK`). */
  clkTck?: number
  pageSize?: number
  net?: boolean
  procRoot?: string
  /**
   * Per-thread CPU from `task/<tid>/schedstat` (ns resolution) instead of utime+stime (clock
   * ticks), when the kernel provides it (default true). Decided once, at the first read, so a
   * thread's cumulative CPU never switches source mid-run.
   */
  schedstat?: boolean
}

function isGone (err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESRCH'
}

export function createLinuxBackend (opts: LinuxBackendOptions): Backend {
  const root = opts.procRoot ?? '/proc'
  const base = `${root}/${opts.pid}`
  const msPerTick = 1000 / (opts.clkTck ?? 100)
  const pageSize = opts.pageSize ?? 4096
  const wantNet = opts.net ?? true

  // undefined until the first thread read decides whether schedstat is usable.
  let useSchedstat: boolean | undefined = opts.schedstat === false ? false : undefined

  async function readThreadSchedNs (t: string): Promise<number | undefined> {
    try { return parseSchedstat(await readFile(`${base}/task/${t}/schedstat`, 'utf8')) } catch { return undefined }
  }

  async function readThreads (): Promise<RawThread[]> {
    const tids = await readdir(`${base}/task`)
    if (useSchedstat === undefined) {
      // Probe on the main task (tid == pid), falling back to any listed task.
      const probe = tids.includes(String(opts.pid)) ? String(opts.pid) : tids[0]
      // A running process has nonzero on-CPU time; 0 means a placeholder ("0 0 0" when the
      // kernel's sched_info accounting is off), so fall back to utime+stime.
      const ns = probe === undefined ? undefined : await readThreadSchedNs(probe)
      useSchedstat = ns !== undefined && ns > 0
    }
    const sched = useSchedstat
    const out = await Promise.all(tids.map(async (t): Promise<RawThread | null> => {
      try {
        const [statText, ns] = await Promise.all([
          readFile(`${base}/task/${t}/stat`, 'utf8'),
          sched ? readThreadSchedNs(t) : undefined
        ])
        const st = parseProcStat(statText)
        // With schedstat in use, a thread whose schedstat vanished has exited: skip it rather
        // than mix units for its tid.
        if (sched && ns === undefined) return null
        return { tid: Number(t), name: st.comm, cpuMs: sched ? ns! / 1e6 : st.cpuTicks * msPerTick }
      } catch { return null } // thread exited between readdir and read
    }))
    return out.filter((x): x is RawThread => x !== null)
  }

  return {
    async read (): Promise<BackendResult> {
      try {
        const [statText, statusText] = await Promise.all([
          readFile(`${base}/stat`, 'utf8'),
          readFile(`${base}/status`, 'utf8')
        ])
        const t = Date.now()
        const st = parseProcStat(statText)
        if (st.state === 'Z' || st.state === 'X') return { kind: 'exited' }
        const status = parseProcStatus(statusText)
        const [threads, fds, netText] = await Promise.all([
          readThreads().catch(() => undefined),
          readdir(`${base}/fd`).then(l => l.length, () => undefined),
          // /proc/<pid>/net/dev is per network namespace, i.e. system-wide for a normal host.
          wantNet ? readFile(`${base}/net/dev`, 'utf8').catch(() => undefined) : undefined
        ])
        const raw: BackendResult = {
          kind: 'reading',
          raw: {
            t,
            procCpuMs: st.cpuTicks * msPerTick,
            rssBytes: status.vmRssBytes ?? st.rssPages * pageSize,
            threadCount: status.threads ?? st.numThreads
          }
        }
        if (status.rssAnonBytes !== undefined) raw.raw.privateBytes = status.rssAnonBytes
        if (fds !== undefined) raw.raw.handles = fds
        if (threads) raw.raw.threads = threads
        if (netText !== undefined) raw.raw.net = parseNetDev(netText)
        return raw
      } catch (err) {
        if (isGone(err)) return { kind: 'exited' }
        throw err
      }
    },
    async close (): Promise<void> {}
  }
}
