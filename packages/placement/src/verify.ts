import type {
  PlacementCheck, PlacementPlan, PlacementPriority, PlacementSetMember, PlacementSetVerification, PlacementVerification, PlacementViolation
} from '@bedperf/core'
import { serverProcessList, type ServerProcesses } from './apply.ts'
import { formatCpuList, maskToCpus, normalizeCpus, sameCpus } from './cpus.ts'
import { addTypeStatement, createNodeRunner, runPowerShellJson, type PlacementRunner } from './runner.ts'
import { cpusAllowedFromStatus } from './topology.ts'

/** What a process looks like right now; null fields could not be read. */
export interface ObservedProcess {
  gone: boolean
  processCpus: number[] | null
  priority: string | null
  /** Per thread: allowed CPUs, or null if unreadable. */
  threads: Array<{ tid: number, cpus: number[] | null }>
}

const WIN_CLASS_NAMES: Record<string, string> = {
  Normal: 'normal',
  AboveNormal: 'above_normal',
  BelowNormal: 'below_normal',
  High: 'high',
  Idle: 'idle',
  RealTime: 'realtime'
}

/** Priority name for a Linux nice value. */
export function priorityFromNice (nice: number): string {
  if (nice === 0) return 'normal'
  if (nice === -5) return 'above_normal'
  return `nice_${nice}`
}

/** The nice value (field 19) from /proc/<pid>/stat text; comm may contain spaces and ')'. */
export function niceFromStat (stat: string): number | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  // fields[0] is field 3 (state); nice is field 19.
  const v = Number(fields[19 - 3])
  return Number.isInteger(v) ? v : undefined
}

interface WinThreadsRaw {
  gone?: boolean
  error?: string
  mask?: string
  priority?: string
  threads?: Array<[number, number | null, string | null]>
}

export function windowsVerifyScript (pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`)
  return addTypeStatement() + [
    // Only "no such process" (ArgumentException) or a positive HasExited means gone; access
    // denied on an elevated process must surface as an error, not as an exit.
    'function bpGone { try { $q = [Diagnostics.Process]::GetProcessById(' + pid + ') } catch [ArgumentException] { return $true } catch { return $false }; try { return $q.HasExited } catch { return $false } };',
    "if (bpGone) { bpOut '{\"gone\":true}'; return };",
    `try { bpOut ([BpPlacement]::Threads(${pid})) } catch { $m = [string]$_.Exception.Message; if (bpGone) { bpOut '{"gone":true}' } else { bpOut (ConvertTo-Json -Compress @{ error = $m }) } }`
  ].join('\n')
}

/** ObservedProcess from the Windows script's output (pure). */
export function observedFromWindows (raw: WinThreadsRaw): ObservedProcess {
  if (raw.gone) return { gone: true, processCpus: null, priority: null, threads: [] }
  if (raw.error !== undefined) throw new Error(`reading process placement failed: ${raw.error}`)
  return {
    gone: false,
    processCpus: raw.mask !== undefined ? maskToCpus(raw.mask) : null,
    priority: raw.priority !== undefined ? (WIN_CLASS_NAMES[raw.priority] ?? raw.priority.toLowerCase()) : null,
    threads: (raw.threads ?? []).map(([tid, group, mask]) => ({
      tid,
      cpus: group === null || mask === null ? null : maskToCpus(mask, group * 64)
    }))
  }
}

export async function observeLinux (pid: number, runner: PlacementRunner): Promise<ObservedProcess> {
  const status = await runner.readFile(`/proc/${pid}/status`)
  if (status === undefined) return { gone: true, processCpus: null, priority: null, threads: [] }
  const stat = await runner.readFile(`/proc/${pid}/stat`)
  const nice = stat !== undefined ? niceFromStat(stat) : undefined
  const tids = ((await runner.readDir(`/proc/${pid}/task`)) ?? []).filter(t => /^\d+$/.test(t)).map(Number).sort((a, b) => a - b)
  const threads: ObservedProcess['threads'] = []
  for (const tid of tids) {
    const s = await runner.readFile(`/proc/${pid}/task/${tid}/status`)
    if (s === undefined) continue // exited meanwhile
    threads.push({ tid, cpus: cpusAllowedFromStatus(s) ?? null })
  }
  return { gone: false, processCpus: cpusAllowedFromStatus(status) ?? null, priority: nice === undefined ? null : priorityFromNice(nice), threads }
}

export async function observeProcess (pid: number, runner: PlacementRunner): Promise<ObservedProcess> {
  if (runner.platform === 'linux') return await observeLinux(pid, runner)
  return observedFromWindows(await runPowerShellJson<WinThreadsRaw>(runner, windowsVerifyScript(pid)))
}

/**
 * Judge an observation against the planned CPUs and priority (pure). `allowSubset`: a process
 * affinity that is a non-empty subset of the plan passes (recorded as info), for helper processes
 * that narrow their own mask (Wine's services pin themselves to one CPU); it still cannot escape.
 */
export function judgePlacement (
  pid: number, expected: readonly number[], priority: PlacementPriority | undefined, obs: ObservedProcess, allowSubset = false
): PlacementVerification {
  const expectedCpus = normalizeCpus(expected)
  const allowed = new Set(expectedCpus)
  const checks: PlacementCheck[] = []
  const violations: PlacementViolation[] = []
  const narrowed: Array<{ tid: number, cpus: number[] }> = []
  if (obs.gone) {
    violations.push({ kind: 'process_gone', message: `process ${pid} exited` })
    checks.push({ id: 'process', level: 'fail', summary: `process ${pid} exited` })
    return { verified: false, pid, expectedCpus, processCpus: null, priority: null, narrowed, threadCount: 0, checks, violations }
  }
  if (obs.processCpus === null) {
    violations.push({ kind: 'process_affinity', message: 'process affinity could not be read' })
    checks.push({ id: 'process_affinity', level: 'fail', summary: 'process affinity could not be read' })
  } else if (allowSubset && obs.processCpus.length > 0 && obs.processCpus.length < expectedCpus.length && obs.processCpus.every(c => allowed.has(c))) {
    checks.push({ id: 'process_affinity', level: 'info', summary: `process affinity ${formatCpuList(obs.processCpus)}, a subset of the planned ${formatCpuList(expectedCpus)}` })
  } else if (!sameCpus(obs.processCpus, expectedCpus)) {
    const msg = `process affinity ${formatCpuList(obs.processCpus)} != planned ${formatCpuList(expectedCpus)}`
    violations.push({ kind: 'process_affinity', message: msg, cpus: obs.processCpus })
    checks.push({ id: 'process_affinity', level: 'fail', summary: msg })
  } else {
    checks.push({ id: 'process_affinity', level: 'ok', summary: `process affinity ${formatCpuList(expectedCpus)}` })
  }
  let outside = 0
  let unreadable = 0
  for (const t of obs.threads) {
    if (t.cpus === null) { unreadable++; continue }
    if (!t.cpus.every(c => allowed.has(c))) {
      outside++
      violations.push({ kind: 'thread_outside', tid: t.tid, cpus: t.cpus, message: `thread ${t.tid} may run on ${formatCpuList(t.cpus)}, outside ${formatCpuList(expectedCpus)}` })
    } else if (t.cpus.length !== allowed.size) {
      narrowed.push({ tid: t.tid, cpus: t.cpus })
    }
  }
  checks.push(outside
    ? { id: 'threads', level: 'fail', summary: `${outside}/${obs.threads.length} threads may run outside the planned CPUs` }
    : { id: 'threads', level: 'ok', summary: `all ${obs.threads.length - unreadable} readable threads stay inside the planned CPUs` })
  if (narrowed.length) {
    checks.push({ id: 'narrowed', level: 'info', summary: `${narrowed.length} threads are pinned to a subset of the plan`, detail: { tids: narrowed.map(n => n.tid) } })
  }
  if (unreadable) {
    checks.push({ id: 'threads_unreadable', level: 'info', summary: `${unreadable} threads could not be read` })
  }
  if (priority !== undefined) {
    if (obs.priority !== priority) {
      const msg = `priority ${obs.priority ?? 'unknown'} != planned ${priority}`
      violations.push({ kind: 'priority', message: msg })
      checks.push({ id: 'priority', level: 'fail', summary: msg })
    } else {
      checks.push({ id: 'priority', level: 'ok', summary: `priority ${priority}` })
    }
  }
  return {
    verified: violations.length === 0,
    pid,
    expectedCpus,
    processCpus: obs.processCpus,
    priority: obs.priority,
    narrowed,
    threadCount: obs.threads.length,
    checks,
    violations
  }
}

/**
 * Check that a running process and every one of its threads stay inside the plan's server CPUs
 * and that its priority is the planned one. Pass `{cpus, priority}` to verify another role
 * (e.g. a bot worker: `{cpus: plan.botCpus, priority: 'normal'}`), or `priority: null` to skip it.
 */
export async function verifyPlacement (
  pid: number,
  plan: Pick<PlacementPlan, 'serverCpus' | 'priority'>,
  opts: { cpus?: readonly number[], priority?: PlacementPriority | null, runner?: PlacementRunner, allowSubset?: boolean } = {}
): Promise<PlacementVerification> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`)
  const runner = opts.runner ?? createNodeRunner()
  const cpus = opts.cpus ?? plan.serverCpus
  const priority = opts.priority === null ? undefined : (opts.priority ?? plan.priority)
  return judgePlacement(pid, cpus, priority, await observeProcess(pid, runner), opts.allowSubset ?? false)
}

/**
 * Verify a launched server's process set against the plan's server CPUs. The game process
 * (`serverPid`) is verified fully: process affinity, every thread and the priority. The launcher and
 * helper processes (e.g. wineserver) are verified for process and thread affinity only, since
 * whether their priority is raised does not affect the measurement, and their process affinity may
 * be a subset of the server CPUs (Wine narrows some helpers to one CPU); one that has exited is
 * recorded as info, not a failure. Works for a game under Wine on Linux (a Linux process whose
 * threads are in /proc/<pid>/task) and for Endstone's `bedrock_server.exe` child on Windows.
 */
export async function verifyServerProcesses (
  plan: Pick<PlacementPlan, 'serverCpus' | 'priority'>,
  procs: ServerProcesses & { serverPid: number },
  opts: { cpus?: readonly number[], priority?: PlacementPriority | null, runner?: PlacementRunner } = {}
): Promise<PlacementSetVerification> {
  const runner = opts.runner ?? createNodeRunner()
  const members: PlacementSetMember[] = []
  const checks: PlacementCheck[] = []
  let verified = true
  let server: PlacementVerification | undefined
  const list = serverProcessList(procs)
  // In parallel: on Windows each observation is a PowerShell launch.
  const observed = await Promise.all(list.map(async ({ role, pid }) => role === 'server'
    ? await verifyPlacement(pid, plan, { ...opts, runner })
    : await verifyPlacement(pid, plan, { cpus: opts.cpus, priority: null, runner, allowSubset: true })))
  for (const [i, { role, pid }] of list.entries()) {
    const v = observed[i]!
    if (role === 'server') {
      server = v
      members.push({ role, verification: server })
      if (!server.verified) verified = false
      checks.push(server.verified
        ? { id: 'server', level: 'ok', summary: `server process ${pid}: ${server.threadCount} threads inside the plan` }
        : { id: 'server', level: 'fail', summary: `server process ${pid}: ${server.violations.map(v => v.message).join('; ')}` })
      continue
    }
    members.push({ role, verification: v })
    if (v.violations.some(x => x.kind === 'process_gone')) {
      checks.push({ id: `${role}_gone`, level: 'info', summary: `${role} process ${pid} has exited` })
    } else if (!v.verified) {
      verified = false
      checks.push({ id: `${role}_placement`, level: 'fail', summary: `${role} process ${pid}: ${v.violations.map(x => x.message).join('; ')}` })
    } else {
      checks.push({ id: `${role}_placement`, level: 'ok', summary: `${role} process ${pid} inside the plan` })
    }
  }
  return { verified, server: server!, members, checks }
}

/** Verify one bot worker against the plan's bot CPUs at normal priority. */
export async function verifyBotWorker (pid: number, plan: Pick<PlacementPlan, 'botCpus'>, opts: { runner?: PlacementRunner } = {}): Promise<PlacementVerification> {
  return await verifyPlacement(pid, { serverCpus: plan.botCpus, priority: 'normal' }, { runner: opts.runner })
}
