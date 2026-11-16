// Fake OS runners and topology fixtures for the unit tests.
import type { ExecResult, PlacementRunner } from './runner.ts'
import { buildCpuSetBuffer } from './topology.ts'
import { formatCpuList } from './cpus.ts'

export interface FakeRunner extends PlacementRunner {
  files: Map<string, string>
  dirs: Map<string, string[]>
  calls: Array<{ file: string, args: string[] }>
  niced: Array<{ id: number, nice: number }>
}

export function fakeRunner (platform: 'win32' | 'linux', opts: {
  files?: Record<string, string>
  dirs?: Record<string, string[]>
  exec?: (file: string, args: string[]) => ExecResult
  setPriority?: (id: number, nice: number) => void
} = {}): FakeRunner {
  const files = new Map(Object.entries(opts.files ?? {}))
  const dirs = new Map(Object.entries(opts.dirs ?? {}))
  const calls: FakeRunner['calls'] = []
  const niced: FakeRunner['niced'] = []
  return {
    platform,
    selfPid: 1000,
    files,
    dirs,
    calls,
    niced,
    exec: async (file, args) => {
      calls.push({ file, args: [...args] })
      return opts.exec ? opts.exec(file, [...args]) : { code: 0, stdout: '', stderr: '' }
    },
    readFile: async path => files.get(path),
    readDir: async path => dirs.get(path),
    setPriority: (id, nice) => { opts.setPriority?.(id, nice); niced.push({ id, nice }) }
  }
}

/** Decode the script a fake received through `powershell.exe -EncodedCommand`. */
export function decodePs (args: string[]): string {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le')
}

export const psOut = (payload: unknown): ExecResult => ({ code: 0, stdout: `noise\r\nBPPL ${JSON.stringify(payload)}\r\n`, stderr: '' })

// --- Windows fixtures ------------------------------------------------------------------------

/** i7-14700F: 8 P-cores with HT (logical 0-15, class 1) + 12 E-cores (16-27, class 0). */
export function win14700Raw (manufacturer = 'Micro-Star International Co., Ltd.', product = 'MS-7E06'): object {
  const entries = []
  for (let i = 0; i < 16; i++) entries.push({ group: 0, logical: i, core: i - (i % 2), efficiency: 1 })
  for (let i = 16; i < 28; i++) entries.push({ group: 0, logical: i, core: i, efficiency: 0 })
  return {
    cpuSets: Buffer.from(buildCpuSetBuffer(entries)).toString('base64'),
    allowedMask: String((1n << 28n) - 1n),
    manufacturer,
    product
  }
}

/** 8 cores / 16 threads, Windows enumeration (siblings adjacent). */
export function win8c16tRaw (): object {
  const entries = []
  for (let i = 0; i < 16; i++) entries.push({ group: 0, logical: i, core: i - (i % 2), efficiency: 0 })
  return { cpuSets: Buffer.from(buildCpuSetBuffer(entries)).toString('base64'), allowedMask: String((1n << 16n) - 1n), manufacturer: 'ASUS', product: 'PRIME' }
}

// --- Linux fixtures --------------------------------------------------------------------------

export interface LinuxCpu { cpu: number, core: number, pkg?: number, die?: number, capacity?: number }

export function linuxFiles (cpus: LinuxCpu[], extra: Record<string, string> = {}, allowed?: string): Record<string, string> {
  const files: Record<string, string> = {
    '/sys/devices/system/cpu/online': formatCpuList(cpus.map(c => c.cpu)) + '\n',
    '/proc/self/status': `Name:\tnode\nCpus_allowed:\tffff\nCpus_allowed_list:\t${allowed ?? formatCpuList(cpus.map(c => c.cpu))}\n`,
    '/proc/sys/kernel/osrelease': '6.8.0-45-generic\n',
    '/sys/class/dmi/id/sys_vendor': 'Micro-Star International Co., Ltd.\n',
    '/sys/class/dmi/id/product_name': 'MS-7E06\n',
    '/proc/cpuinfo': 'processor\t: 0\nflags\t\t: fpu vme de pse tsc msr sse sse2 ht\n'
  }
  for (const c of cpus) {
    const t = `/sys/devices/system/cpu/cpu${c.cpu}/topology`
    files[`${t}/physical_package_id`] = `${c.pkg ?? 0}\n`
    files[`${t}/die_id`] = `${c.die ?? 0}\n`
    files[`${t}/core_id`] = `${c.core}\n`
    if (c.capacity !== undefined) files[`/sys/devices/system/cpu/cpu${c.cpu}/cpu_capacity`] = `${c.capacity}\n`
  }
  return { ...files, ...extra }
}

/** i7-14700F under Linux: cpu_core 0-15 (pairs share core_id), cpu_atom 16-27. */
export function linux14700Files (): Record<string, string> {
  const cpus: LinuxCpu[] = []
  for (let i = 0; i < 16; i++) cpus.push({ cpu: i, core: Math.floor(i / 2) * 4 })
  for (let i = 16; i < 28; i++) cpus.push({ cpu: i, core: 32 + (i - 16) })
  return linuxFiles(cpus, { '/sys/devices/cpu_core/cpus': '0-15\n', '/sys/devices/cpu_atom/cpus': '16-27\n' })
}

/** 8c/16t, Linux enumeration: cpu i and i+8 are siblings. */
export function linux8c16tFiles (allowed?: string): Record<string, string> {
  const cpus: LinuxCpu[] = []
  for (let i = 0; i < 16; i++) cpus.push({ cpu: i, core: i % 8 })
  return linuxFiles(cpus, {}, allowed)
}

/** 4 cores, no SMT. */
export function linux4cFiles (): Record<string, string> {
  return linuxFiles([0, 1, 2, 3].map(i => ({ cpu: i, core: i })))
}

/** WSL2 guest with 16 vCPUs paired as SMT siblings. */
export function wslFiles (): Record<string, string> {
  const cpus: LinuxCpu[] = []
  for (let i = 0; i < 16; i++) cpus.push({ cpu: i, core: Math.floor(i / 2) })
  return linuxFiles(cpus, {
    '/proc/sys/kernel/osrelease': '5.15.167.4-microsoft-standard-WSL2\n',
    '/sys/class/dmi/id/sys_vendor': '\n',
    '/proc/cpuinfo': 'processor\t: 0\nflags\t\t: fpu vme de pse tsc hypervisor sse\n'
  })
}
