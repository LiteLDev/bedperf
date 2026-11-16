import type { PlacementKind } from '@bedperf/core'
import { maskToCpus, parseCpuList } from './cpus.ts'
import { addTypeStatement, createNodeRunner, runPowerShellJson, type PlacementRunner } from './runner.ts'

/** One logical CPU the harness may use. */
export interface CpuRecord {
  /** Logical CPU index (Windows: group*64 + logical index). */
  cpu: number
  /** Dense physical core id; SMT siblings share it. */
  core: number
  /** Efficiency class: higher is faster. 0 everywhere on non-hybrid parts. */
  efficiency: number
  package?: number
  llc?: number
  numa?: number
}

export interface CpuTopology {
  platform: 'win32' | 'linux'
  /** Logical CPUs the harness may use, sorted by `cpu`. */
  cpus: CpuRecord[]
  /** `wsl2`, a hypervisor name (`kvm`, `hyper-v`, ...), `hypervisor`, or null on bare metal. */
  virtualization: string | null
  placementKind: PlacementKind
  /** How efficiency classes were derived. */
  efficiencySource: 'cpu-sets' | 'cpu_core/cpu_atom' | 'cpu_capacity' | 'none'
}

/** A physical core: its logical CPUs and efficiency class. */
export interface Core {
  id: number
  cpus: number[]
  efficiency: number
}

/** Group a topology's CPUs into physical cores (sorted by first CPU). */
export function coresOf (topology: CpuTopology): Core[] {
  const byId = new Map<number, Core>()
  for (const r of topology.cpus) {
    let core = byId.get(r.core)
    if (!core) { core = { id: r.core, cpus: [], efficiency: r.efficiency }; byId.set(r.core, core) }
    core.cpus.push(r.cpu)
    core.efficiency = Math.max(core.efficiency, r.efficiency)
  }
  const cores = [...byId.values()]
  for (const c of cores) c.cpus.sort((a, b) => a - b)
  return cores.sort((a, b) => a.cpus[0]! - b.cpus[0]!)
}

// BIOS / DMI strings of common hypervisors -> label.
const HYPERVISORS: Array<[string, string]> = [
  ['qemu', 'kvm'],
  ['kvm', 'kvm'],
  ['vmware', 'vmware'],
  ['virtualbox', 'virtualbox'],
  ['innotek', 'virtualbox'],
  ['xen', 'xen'],
  ['amazon ec2', 'aws'],
  ['google compute engine', 'gce'],
  ['google', 'gce'],
  ['parallels', 'parallels'],
  ['virtual machine', 'hyper-v']
]

/** Hypervisor label from vendor/product strings, or null. */
export function hypervisorFromStrings (...parts: Array<string | undefined | null>): string | null {
  const text = parts.filter(p => p).map(p => p!.trim()).join(' ').toLowerCase()
  if (!text) return null
  for (const [needle, label] of HYPERVISORS) if (text.includes(needle)) return label
  return null
}

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------

/** One SYSTEM_CPU_SET_INFORMATION entry of type CpuSetInformation. */
export interface CpuSetEntry {
  id: number
  group: number
  logical: number
  core: number
  llc: number
  numa: number
  efficiency: number
}

/**
 * Unpack the buffer GetSystemCpuSetInformation fills: a sequence of variable-size records
 * `{DWORD Size; CPU_SET_INFORMATION_TYPE Type; {DWORD Id; WORD Group; BYTE LogicalProcessorIndex;
 * BYTE CoreIndex; BYTE LastLevelCacheIndex; BYTE NumaNodeIndex; BYTE EfficiencyClass; ...}}`.
 */
export function parseCpuSetBuffer (buf: Uint8Array): CpuSetEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: CpuSetEntry[] = []
  let offset = 0
  while (offset + 19 <= buf.byteLength) {
    const size = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    if (size === 0) break
    if (type === 0) {
      out.push({
        id: view.getUint32(offset + 8, true),
        group: view.getUint16(offset + 12, true),
        logical: view.getUint8(offset + 14),
        core: view.getUint8(offset + 15),
        llc: view.getUint8(offset + 16),
        numa: view.getUint8(offset + 17),
        efficiency: view.getUint8(offset + 18)
      })
    }
    offset += size
  }
  return out
}

/** Build a SYSTEM_CPU_SET_INFORMATION buffer (32-byte records) — for fixtures and tests. */
export function buildCpuSetBuffer (entries: Array<Omit<CpuSetEntry, 'id' | 'llc' | 'numa'> & Partial<CpuSetEntry>>): Uint8Array {
  const SIZE = 32
  const buf = new Uint8Array(entries.length * SIZE)
  const view = new DataView(buf.buffer)
  entries.forEach((e, i) => {
    const o = i * SIZE
    view.setUint32(o, SIZE, true)
    view.setUint32(o + 4, 0, true)
    view.setUint32(o + 8, e.id ?? 256 + i, true)
    view.setUint16(o + 12, e.group, true)
    view.setUint8(o + 14, e.logical)
    view.setUint8(o + 15, e.core)
    view.setUint8(o + 16, e.llc ?? 0)
    view.setUint8(o + 17, e.numa ?? 0)
    view.setUint8(o + 18, e.efficiency)
  })
  return buf
}

/** What the Windows topology script reports. */
export interface WindowsTopologyRaw {
  /** base64 SYSTEM_CPU_SET_INFORMATION buffer; empty if the call failed. */
  cpuSets: string
  /** The harness process' affinity mask, unsigned decimal. */
  allowedMask: string
  manufacturer?: string | null
  product?: string | null
}

export function windowsTopologyScript (selfPid: number): string {
  if (!Number.isInteger(selfPid) || selfPid <= 0) throw new Error(`invalid pid ${selfPid}`)
  return addTypeStatement() + [
    '$sets = [BpPlacement]::CpuSets();',
    `$raw = [Diagnostics.Process]::GetProcessById(${selfPid}).ProcessorAffinity.ToInt64();`,
    '$mask = [BitConverter]::ToUInt64([BitConverter]::GetBytes($raw), 0).ToString();',
    '$bios = $null; try { $bios = Get-ItemProperty -Path "HKLM:\\HARDWARE\\DESCRIPTION\\System\\BIOS" } catch { };',
    '$o = [ordered]@{ cpuSets = $sets; allowedMask = $mask; manufacturer = $(if ($bios) { [string]$bios.SystemManufacturer } else { $null }); product = $(if ($bios) { [string]$bios.SystemProductName } else { $null }) };',
    'bpOut (ConvertTo-Json -Compress $o)'
  ].join('\n')
}

/** Topology from the Windows script's output (pure). */
export function windowsTopologyFromRaw (raw: WindowsTopologyRaw): CpuTopology {
  const allowed = new Set(maskToCpus(raw.allowedMask))
  const entries = raw.cpuSets ? parseCpuSetBuffer(Buffer.from(raw.cpuSets, 'base64')) : []
  const virtualization = hypervisorFromStrings(raw.manufacturer, raw.product)
  const placementKind: PlacementKind = virtualization ? 'vcpu' : 'physical'
  if (entries.length === 0) {
    return {
      platform: 'win32',
      cpus: [...allowed].sort((a, b) => a - b).map(cpu => ({ cpu, core: cpu, efficiency: 0 })),
      virtualization,
      placementKind,
      efficiencySource: 'none'
    }
  }
  // The process mask only covers its own group; on group 0 that is CPUs 0..63.
  const sorted = [...entries].sort((a, b) => a.group - b.group || a.logical - b.logical)
  const coreIds = new Map<string, number>()
  const cpus: CpuRecord[] = []
  for (const e of sorted) {
    const key = `${e.group}:${e.core}`
    if (!coreIds.has(key)) coreIds.set(key, coreIds.size)
    const cpu = e.group * 64 + e.logical
    if (!allowed.has(cpu)) continue
    cpus.push({ cpu, core: coreIds.get(key)!, efficiency: e.efficiency, llc: e.llc, numa: e.numa })
  }
  return { platform: 'win32', cpus, virtualization, placementKind, efficiencySource: 'cpu-sets' }
}

// ---------------------------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------------------------

/** `Cpus_allowed_list` of a /proc/<pid>[/task/<tid>]/status text, or undefined. */
export function cpusAllowedFromStatus (status: string): number[] | undefined {
  const m = /^Cpus_allowed_list:\s*(.*)$/m.exec(status)
  return m ? parseCpuList(m[1]!) : undefined
}

async function readInt (runner: PlacementRunner, path: string): Promise<number | undefined> {
  const t = await runner.readFile(path)
  if (t === undefined) return undefined
  const n = Number.parseInt(t.trim(), 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Rank distinct cpu_capacity values into efficiency classes. Values within 10% of the lowest
 * value of their class share it, so favored-core boosts (ITMT, AMD preferred cores) of a few
 * percent do not make every core its own class.
 */
export function capacityClasses (values: readonly number[]): Map<number, number> {
  const levels = [...new Set(values)].sort((a, b) => a - b)
  const out = new Map<number, number>()
  let cls = -1
  let floor = -Infinity
  for (const v of levels) {
    if (v > floor * 1.1) { cls++; floor = v }
    out.set(v, cls)
  }
  return out
}

async function linuxEfficiency (runner: PlacementRunner, online: number[]): Promise<{ classes: Map<number, number>, source: CpuTopology['efficiencySource'] }> {
  const core = await runner.readFile('/sys/devices/cpu_core/cpus')
  const atom = await runner.readFile('/sys/devices/cpu_atom/cpus')
  if (core !== undefined && atom !== undefined) {
    const classes = new Map<number, number>()
    for (const c of parseCpuList(atom)) classes.set(c, 0)
    for (const c of parseCpuList(core)) classes.set(c, 1)
    return { classes, source: 'cpu_core/cpu_atom' }
  }
  const capacity = new Map<number, number>()
  for (const cpu of online) {
    const v = await readInt(runner, `/sys/devices/system/cpu/cpu${cpu}/cpu_capacity`)
    if (v !== undefined && v >= 0) capacity.set(cpu, v)
  }
  const classOf = capacityClasses([...capacity.values()])
  if (new Set(classOf.values()).size > 1) {
    return { classes: new Map([...capacity].map(([cpu, v]) => [cpu, classOf.get(v)!])), source: 'cpu_capacity' }
  }
  return { classes: new Map(), source: 'none' }
}

export async function linuxVirtualization (runner: PlacementRunner): Promise<string | null> {
  const release = ((await runner.readFile('/proc/sys/kernel/osrelease')) ?? '').toLowerCase()
  if (release.includes('microsoft') || release.includes('wsl')) return 'wsl2'
  const vendor = await runner.readFile('/sys/class/dmi/id/sys_vendor')
  const product = await runner.readFile('/sys/class/dmi/id/product_name')
  const hv = hypervisorFromStrings(vendor, product)
  if (hv) return hv
  const cpuinfo = (await runner.readFile('/proc/cpuinfo')) ?? ''
  const flags = cpuinfo.split('\n').find(l => l.startsWith('flags'))
  if (flags && flags.split(':').slice(1).join(':').split(/\s+/).includes('hypervisor')) return 'hypervisor'
  return null
}

export async function readLinuxTopology (runner: PlacementRunner): Promise<CpuTopology> {
  const base = '/sys/devices/system/cpu'
  const onlineText = await runner.readFile(`${base}/online`)
  let online: number[]
  if (onlineText !== undefined) {
    online = parseCpuList(onlineText)
  } else {
    online = ((await runner.readDir(base)) ?? [])
      .map(e => /^cpu(\d+)$/.exec(e)).filter(m => m !== null).map(m => Number(m[1])).sort((a, b) => a - b)
  }
  const selfStatus = await runner.readFile('/proc/self/status')
  const allowed = new Set<number>((selfStatus === undefined ? undefined : cpusAllowedFromStatus(selfStatus)) ?? online)
  const { classes, source } = await linuxEfficiency(runner, online)
  const coreIds = new Map<string, number>()
  const cpus: CpuRecord[] = []
  for (const cpu of online) {
    const topo = `${base}/cpu${cpu}/topology`
    const pkg = (await readInt(runner, `${topo}/physical_package_id`)) ?? 0
    const die = (await readInt(runner, `${topo}/die_id`)) ?? 0
    const coreId = (await readInt(runner, `${topo}/core_id`)) ?? cpu
    const key = `${pkg}:${die}:${coreId}`
    if (!coreIds.has(key)) coreIds.set(key, coreIds.size)
    if (!allowed.has(cpu)) continue
    cpus.push({ cpu, core: coreIds.get(key)!, efficiency: classes.get(cpu) ?? 0, package: pkg })
  }
  const virtualization = await linuxVirtualization(runner)
  return { platform: 'linux', cpus, virtualization, placementKind: virtualization ? 'vcpu' : 'physical', efficiencySource: source }
}

/** Read the CPU topology the harness may use on this machine. */
export async function readTopology (runner: PlacementRunner = createNodeRunner()): Promise<CpuTopology> {
  if (runner.platform === 'linux') return await readLinuxTopology(runner)
  const raw = await runPowerShellJson<WindowsTopologyRaw>(runner, windowsTopologyScript(runner.selfPid))
  return windowsTopologyFromRaw(raw)
}
