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
  /** True when the process did not exist (exited before or during the apply). */
  gone?: boolean
}

const WIN_NOT_FOUND = 'process not found'

function validPid (pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`)
}

/** PowerShell that sets a process' affinity mask and priority class, reporting each failure. */
export function windowsApplyScript (pid: number, cpus: readonly number[], priority: PlacementPriority): string {
  validPid(pid)
  const mask = BigInt.asIntN(64, cpusToMask(cpus)) // ProcessorAffinity is a signed IntPtr
  return [
    '$o = [ordered]@{ affinity = $null; priority = $null };',
    `try { $p = [Diagnostics.Process]::GetProcessById(${pid}) } catch { $o.affinity = '${WIN_NOT_FOUND}'; $o.priority = '${WIN_NOT_FOUND}'; bpOut (ConvertTo-Json -Compress $o); return };`,
    `try { $p.ProcessorAffinity = [IntPtr][long]${mask} } catch { $o.affinity = [string]$_.Exception.Message };`,
    `try { $p.PriorityClass = [Diagnostics.ProcessPriorityClass]::${WIN_PRIORITY_CLASS[priority]} } catch { $o.priority = [string]$_.Exception.Message };`,
    // a process that exited between the lookup and the sets is gone, not refused
    'if ($o.affinity -or $o.priority) { try { if ($p.HasExited) { $o.gone = $true } } catch {} };',
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
      const r = await runPowerShellJson<{ affinity: string | null, priority: string | null, gone?: boolean }>(runner, script)
      if (r.affinity) result.affinityError = r.affinity
      if (r.priority) result.priorityError = r.priority
      if (r.affinity === WIN_NOT_FOUND || r.gone === true) result.gone = true
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
      result.gone = true
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
  /**
   * True when every process the command ever starts inherits the placement at creation (Linux
   * `preexec`: the mask and nice carry over fork/exec, so a launcher's game child, Wine helpers and
   * a wineserver it forks are all covered). False on Windows: see `applyToServerTree`.
   */
  coversDescendants: boolean
  cpus: number[]
  priority: PlacementPriority
}

/**
 * Wrap a command so it starts with its placement already in effect. Linux: `taskset -c <cpus>
 * [nice -n <n>] cmd args` (both exec in place, so the pid is the command's and every thread and
 * process it ever starts inherits the mask and nice). When `command` is a launcher (lip, wine,
 * python for Endstone) the game process is a descendant and is covered too, as is a wineserver that
 * wine forks; a wineserver that was already running for the prefix is not (pass it as an aux pid to
 * `applyToServerTree`). Windows has no such wrapper: the command is returned unchanged and
 * `applyToPid` / `applyToServerTree` must follow the spawn. `role` picks the plan's CPU set; only
 * the server is reniced.
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
    return { command, args: [...args], method: 'post-spawn', postSpawnApplyRequired: true, priorityUnconfirmed: false, coversDescendants: false, cpus: [...cpus], priority }
  }
  const nice = NICE[priority]
  const wrapped = ['-c', formatCpuList(cpus), ...(nice !== 0 ? ['nice', '-n', String(nice)] : []), command, ...args]
  return { command: 'taskset', args: wrapped, method: 'preexec', postSpawnApplyRequired: false, priorityUnconfirmed: nice < 0, coversDescendants: true, cpus: [...cpus], priority }
}

export type ServerProcessRole = 'server' | 'launcher' | 'aux'

/** The processes of a launched server. Pass what is known; a pid given twice is used once. */
export interface ServerProcesses {
  /** The game process (`LaunchSpec.serverProcess`), once resolved. */
  serverPid?: number
  /** The spawned command when it is a launcher (lip, wine, python) and not the game itself. */
  launcherPid?: number
  /** Helpers that belong to the server but are not descendants (`LaunchSpec.auxProcessPatterns`, e.g. wineserver). */
  auxPids?: readonly number[]
}

/** The distinct pids of `procs` with their roles: server first, then launcher, then helpers. */
export function serverProcessList (procs: ServerProcesses): Array<{ role: ServerProcessRole, pid: number }> {
  const seen = new Set<number>()
  const list: Array<{ role: ServerProcessRole, pid: number }> = []
  const add = (role: ServerProcessRole, pid: number | undefined): void => {
    if (pid === undefined || seen.has(pid)) return
    validPid(pid)
    seen.add(pid)
    list.push({ role, pid })
  }
  add('server', procs.serverPid)
  add('launcher', procs.launcherPid)
  for (const pid of procs.auxPids ?? []) add('aux', pid)
  return list
}

export interface TreeApplyResult {
  /**
   * True when the game process was placed (CPUs and priority) and every launcher/helper got its CPUs
   * or had already exited. A launcher/helper priority refusal is reported in its result only.
   */
  ok: boolean
  results: Array<{ role: ServerProcessRole, result: ApplyResult }>
}

/**
 * Apply the plan's server CPUs and priority to a launched server's processes.
 *
 * Windows: a child takes its parent's affinity mask when it is created, and does not inherit an
 * above-normal priority class. So call this with `launcherPid` right after the spawn, which makes
 * the children the launcher creates later inherit the mask, and again with the resolved `serverPid`
 * (and helper pids) as soon as it is found, before the server reports ready. A game process created
 * before the launcher was placed runs unplaced until that second call; setting its process mask
 * then resets every existing thread's mask, so the gap stays inside startup and never reaches a
 * measured phase. Endstone's `bedrock_server.exe` (started by Python with an injected DLL) is
 * handled this way.
 *
 * Linux: `wrapSpawn` already covers every descendant; call this only for helpers that were not
 * forked under the wrapper (e.g. a wineserver that was already running).
 *
 * Launcher and helpers get the server's CPUs and priority, as they would under `wrapSpawn` (a
 * wineserver serves the game's Wine calls, so it sits on the game's critical path).
 */
export async function applyToServerTree (
  plan: Pick<PlacementPlan, 'serverCpus' | 'priority'>,
  procs: ServerProcesses,
  runner: PlacementRunner = createNodeRunner()
): Promise<TreeApplyResult> {
  const list = serverProcessList(procs)
  if (list.length === 0) throw new Error('applyToServerTree: no pids')
  // In parallel: on Windows each apply is a PowerShell launch, and the game runs unplaced meanwhile.
  const results: TreeApplyResult['results'] = await Promise.all(list.map(async ({ role, pid }) =>
    ({ role, result: await applyToPid(pid, plan.serverCpus, plan.priority, runner) })))
  const ok = results.every(({ role, result: r }) =>
    role === 'server' ? r.ok : (r.gone === true || r.affinityError === undefined))
  return { ok, results }
}

/** Place one bot worker process on the plan's bot CPUs at normal priority (an agent calls this per worker). */
export async function applyBotWorker (pid: number, plan: Pick<PlacementPlan, 'botCpus'>, runner: PlacementRunner = createNodeRunner()): Promise<ApplyResult> {
  return await applyToPid(pid, plan.botCpus, 'normal', runner)
}
