import type { PlacementPlan, PlacementPriority } from '@bedperf/core'
import { cpusToMask, formatCpuList, normalizeCpus } from './cpus.ts'
import { createNodeRunner, runPowerShellJson, type PlacementRunner } from './runner.ts'

/** Linux nice values per priority. Below 0 needs root, CAP_SYS_NICE or RLIMIT_NICE. */
export const NICE: Record<PlacementPriority, number> = { normal: 0, above_normal: -5 }

/** Windows PriorityClass names per priority. */
export const WIN_PRIORITY_CLASS: Record<PlacementPriority, string> = { normal: 'Normal', above_normal: 'AboveNormal' }

export type ApplyMethod = 'preexec' | 'post-spawn'

export interface ApplyResult {
  ok: boolean
  pid: number
  cpus: number[]
  priority: PlacementPriority
  method: ApplyMethod
  /** Undefined on success, otherwise why the affinity could not be set. */
  affinityError?: string
  /** Undefined on success, otherwise why the priority could not be set. */
  priorityError?: string
}

function validPid (pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`)
}

/** PowerShell that sets a process' affinity mask and priority class, reporting each failure. */
export function windowsApplyScript (pid: number, cpus: readonly number[], priority: PlacementPriority): string {
  validPid(pid)
  const mask = BigInt.asIntN(64, cpusToMask(cpus)) // ProcessorAffinity is a signed IntPtr
  return [
    '$o = [ordered]@{ affinity = $null; priority = $null };',
    `try { $p = [Diagnostics.Process]::GetProcessById(${pid}) } catch { $o.affinity = 'process not found'; $o.priority = 'process not found'; bpOut (ConvertTo-Json -Compress $o); return };`,
    `try { $p.ProcessorAffinity = [IntPtr][long]${mask} } catch { $o.affinity = [string]$_.Exception.Message };`,
    `try { $p.PriorityClass = [Diagnostics.ProcessPriorityClass]::${WIN_PRIORITY_CLASS[priority]} } catch { $o.priority = [string]$_.Exception.Message };`,
    'bpOut (ConvertTo-Json -Compress $o)'
  ].join('\n')
}

/**
 * Pin a running process (all its threads) to `cpus` and set its priority. Never throws for an
 * OS refusal: failures come back in `affinityError` / `priorityError` with `ok: false`.
 * Windows: ProcessorAffinity + PriorityClass. Linux: `taskset -a -p -c` + setpriority per thread
 * (renice; `above_normal` needs CAP_SYS_NICE).
 */
export async function applyToPid (
  pid: number,
  cpus: readonly number[],
  priority: PlacementPriority,
  runner: PlacementRunner = createNodeRunner()
): Promise<ApplyResult> {
  validPid(pid)
  const list = normalizeCpus(cpus)
  if (list.length === 0) throw new Error('applyToPid: empty CPU list')
  const result: ApplyResult = { ok: true, pid, cpus: list, priority, method: 'post-spawn' }
  if (runner.platform === 'win32') {
    const script = windowsApplyScript(pid, list, priority) // throws for CPUs outside group 0
    try {
      const r = await runPowerShellJson<{ affinity: string | null, priority: string | null }>(runner, script)
      if (r.affinity) result.affinityError = r.affinity
      if (r.priority) result.priorityError = r.priority
    } catch (err) {
      const msg = (err as Error).message
      result.affinityError = msg
      result.priorityError = msg
    }
  } else {
    const r = await runner.exec('taskset', ['-a', '-p', '-c', formatCpuList(list), String(pid)])
    if (r.code !== 0) result.affinityError = `taskset exited ${r.code}: ${(r.stderr || r.stdout).trim()}`
    const nice = NICE[priority]
    const tids = ((await runner.readDir(`/proc/${pid}/task`)) ?? []).filter(t => /^\d+$/.test(t)).map(Number)
    if (tids.length === 0) tids.push(pid)
    const failed: string[] = []
    let exited = 0
    for (const tid of tids) {
      try {
        runner.setPriority(tid, nice)
      } catch (err) {
        // os.setPriority throws ERR_SYSTEM_ERROR with the errno name in `info.code`.
        const e = err as NodeJS.ErrnoException & { info?: { code?: string } }
        if ((e.info?.code ?? e.code) === 'ESRCH') { exited++; continue } // thread exited meanwhile
        failed.push(`tid ${tid}: ${e.message}`)
      }
    }
    if (exited === tids.length) {
      result.priorityError = `process ${pid} not found`
    } else if (failed.length) {
      result.priorityError = `could not set nice ${nice} on ${failed.length}/${tids.length} threads` +
        `${nice < 0 ? ' (negative nice needs root or CAP_SYS_NICE)' : ''}: ${failed[0]}`
    }
  }
  result.ok = result.affinityError === undefined && result.priorityError === undefined
  return result
}

export interface WrappedSpawn {
  command: string
  args: string[]
  method: ApplyMethod
  /** True when the caller must call `applyToPid` right after spawning (Windows). */
  postSpawnApplyRequired: boolean
  /**
   * True when the wrapper asks for a nice change it cannot confirm: GNU `nice` only warns and
   * still runs the command at the old nice without CAP_SYS_NICE. Call `verifyPlacement` (or
   * `applyToPid`, which reports the refusal) after the spawn.
   */
  priorityUnconfirmed: boolean
  cpus: number[]
  priority: PlacementPriority
}

/**
 * Wrap a command so it starts with its placement already in effect. Linux: `taskset -c <cpus>
 * [nice -n <n>] cmd args` (both exec in place, so the pid is the server's and every thread it ever
 * starts inherits the mask). Windows has no such wrapper: the command is returned unchanged and
 * `applyToPid` must follow the spawn. `role` picks the plan's CPU set; only the server is reniced.
 */
export function wrapSpawn (
  command: string,
  args: readonly string[],
  plan: PlacementPlan,
  opts: { platform?: 'win32' | 'linux', role?: 'server' | 'bot' | 'harness' } = {}
): WrappedSpawn {
  const platform = opts.platform ?? (process.platform === 'win32' ? 'win32' : 'linux')
  const role = opts.role ?? 'server'
  const cpus = role === 'server' ? plan.serverCpus : role === 'bot' ? plan.botCpus : plan.harnessCpus
  const priority: PlacementPriority = role === 'server' ? plan.priority : 'normal'
  if (cpus.length === 0) throw new Error(`wrapSpawn: the plan has no ${role} CPUs`)
  if (platform === 'win32') {
    return { command, args: [...args], method: 'post-spawn', postSpawnApplyRequired: true, priorityUnconfirmed: false, cpus: [...cpus], priority }
  }
  const nice = NICE[priority]
  const wrapped = ['-c', formatCpuList(cpus), ...(nice !== 0 ? ['nice', '-n', String(nice)] : []), command, ...args]
  return { command: 'taskset', args: wrapped, method: 'preexec', postSpawnApplyRequired: false, priorityUnconfirmed: nice < 0, cpus: [...cpus], priority }
}
