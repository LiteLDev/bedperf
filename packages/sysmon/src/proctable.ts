import { createLinuxProcTable } from './proctable-linux.ts'
import { createWindowsProcTable } from './proctable-windows.ts'

/** One row of the machine's process table. */
export interface ProcEntry {
  pid: number
  ppid: number
  /** Cumulative CPU (user + kernel), ms. */
  cpuMs: number
  /**
   * Process start time in a backend-specific unit, only comparable within one backend (Windows:
   * epoch ms; Linux: ms since boot). 0 = unknown. Together with `pid` it identifies a process
   * across pid reuse.
   */
  start: number
  /** Image / comm name. May be empty in `read()` results. */
  name: string
}

/** Machine process table: a full scan (rare) and a cheap read of a few known pids (every sample). */
export interface ProcTable {
  /** Every process on the machine. */
  scan (): Promise<ProcEntry[]>
  /** Only these pids; pids that are gone are simply missing. `name` may be empty. */
  read (pids: number[]): Promise<ProcEntry[]>
  close (): Promise<void>
}

export function createPlatformProcTable (): ProcTable {
  if (process.platform === 'win32') return createWindowsProcTable()
  if (process.platform === 'linux') return createLinuxProcTable()
  throw new Error(`sysmon: no process table for platform ${process.platform}`)
}
