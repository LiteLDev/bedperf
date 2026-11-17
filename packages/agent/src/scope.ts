// CPU scope of an agent: on a shared machine (a batch-scheduler allocation, a container with a cpuset)
// the agent and its workers can only run on some CPUs. Load on the other CPUs belongs to other tenants:
// it cannot slow the bots down through CPU time, so the agent's saturation and interference verdicts
// look only at the CPUs it may use.
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import type { InterferenceSample } from '@bedperf/core'

/** `0-3,8,10-11` → [0,1,2,3,8,10,11] (sorted, unique). Throws on malformed input. */
export function parseCpuList (s: string): number[] {
  const out = new Set<number>()
  for (const part of s.trim().split(',')) {
    if (part === '') continue
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`bad CPU list part '${part}'`)
    const a = Number(m[1])
    const b = m[2] !== undefined ? Number(m[2]) : a
    if (b < a) throw new Error(`bad CPU range '${part}'`)
    for (let i = a; i <= b; i++) out.add(i)
  }
  return [...out].sort((x, y) => x - y)
}

/** Linux: the CPUs this process may run on (`Cpus_allowed_list` of /proc/self/status). Elsewhere: undefined. */
export function allowedCpus (readStatus: () => string = () => readFileSync('/proc/self/status', 'utf8')): number[] | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(readStatus())
    return m ? parseCpuList(m[1]!) : undefined
  } catch {
    return undefined
  }
}

/**
 * The CPU scope for `mode`: `machine` → undefined (whole machine); `auto` → the allowed CPUs when they
 * are fewer than the machine's logical CPUs, else undefined; an explicit list is used as given.
 */
export function resolveCpuScope (
  mode: 'auto' | 'machine' | number[],
  deps: { allowed?: () => number[] | undefined, logical?: () => number } = {}
): number[] | undefined {
  if (mode === 'machine') return undefined
  if (Array.isArray(mode)) return mode.length > 0 ? [...new Set(mode)].sort((a, b) => a - b) : undefined
  const allowed = (deps.allowed ?? allowedCpus)()
  const logical = (deps.logical ?? (() => cpus().length))()
  return allowed !== undefined && allowed.length > 0 && allowed.length < logical ? allowed : undefined
}

/**
 * Restrict a machine-sampler sample to `scope`: `cpuBusy` holds only the scoped CPUs (so its length is
 * the scope size), `busyCores` is their sum and `foreignCores` is that sum minus our own groups (the
 * agent and its workers, which can only run inside the scope). `serverSetForeignCores` is dropped.
 */
export function scopeSample (s: InterferenceSample, scope: readonly number[]): InterferenceSample {
  const cpuBusy = scope.map(i => s.cpuBusy[i] ?? 0)
  const busyCores = cpuBusy.reduce((a, b) => a + b, 0)
  const own = Object.values(s.groups).reduce((a, b) => a + b, 0)
  const out: InterferenceSample = { ...s, cpuBusy, busyCores, foreignCores: busyCores - own }
  delete out.serverSetForeignCores
  return out
}
