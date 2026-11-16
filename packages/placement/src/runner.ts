import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { setPriority } from 'node:os'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Every OS access the placement code makes. Tests pass a fake; production uses
 * `createNodeRunner()`.
 */
export interface PlacementRunner {
  platform: 'win32' | 'linux'
  /** The harness's own pid (its allowed CPUs bound the topology). */
  selfPid: number
  /** Run a program to completion. Never rejects for a non-zero exit; `code` carries it. */
  exec (file: string, args: readonly string[]): Promise<ExecResult>
  /** File contents, or undefined if it cannot be read. */
  readFile (path: string): Promise<string | undefined>
  /** Directory entries, or undefined if it cannot be listed. */
  readDir (path: string): Promise<string[] | undefined>
  /** setpriority(PRIO_PROCESS, id, nice): per thread on Linux. Throws on failure. */
  setPriority (id: number, nice: number): void
}

export function createNodeRunner (): PlacementRunner {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error(`placement supports Windows and Linux, not ${process.platform}`)
  }
  return {
    platform: process.platform,
    selfPid: process.pid,
    exec: (file, args) => new Promise(resolve => {
      execFile(file, [...args], { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === -1 ? err.message : '') })
      })
    }),
    readFile: async path => { try { return await readFile(path, 'utf8') } catch { return undefined } },
    readDir: async path => { try { return await readdir(path) } catch { return undefined } },
    setPriority: (id, nice) => setPriority(id, nice)
  }
}

const PS_PREFIX = 'BPPL '

/**
 * Run a PowerShell script (Windows PowerShell 5.1, always present) and return the JSON payload
 * of its last `BPPL <json>` line. The script is passed via -EncodedCommand so quoting is a non-issue.
 */
export async function runPowerShellJson<T> (runner: PlacementRunner, script: string): Promise<T> {
  const full = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';\n" +
    `function bpOut($s) { [Console]::Out.WriteLine('${PS_PREFIX}' + $s) }\n${script}`
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  const r = await runner.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded])
  const line = r.stdout.split(/\r?\n/).reverse().find(l => l.startsWith(PS_PREFIX))
  if (line === undefined) {
    throw new Error(`powershell exited ${r.code} without a result${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 500)}` : ''}`)
  }
  return JSON.parse(line.slice(PS_PREFIX.length)) as T
}

/**
 * C# helper compiled once per PowerShell call with Add-Type: CPU set enumeration and per-thread
 * group affinity, which have no managed API.
 */
export const WIN_NATIVE_CS = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class BpPlacement {
  [StructLayout(LayoutKind.Sequential)]
  public struct GroupAffinity { public UIntPtr Mask; public ushort Group; public ushort R0; public ushort R1; public ushort R2; }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint returned, IntPtr process, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetThreadGroupAffinity(IntPtr thread, out GroupAffinity affinity);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static string CpuSets() {
    uint len = 0;
    GetSystemCpuSetInformation(IntPtr.Zero, 0, out len, IntPtr.Zero, 0);
    if (len == 0) return "";
    IntPtr buf = Marshal.AllocHGlobal((int)len);
    try {
      if (!GetSystemCpuSetInformation(buf, len, out len, IntPtr.Zero, 0)) return "";
      byte[] bytes = new byte[len];
      Marshal.Copy(buf, bytes, 0, (int)len);
      return Convert.ToBase64String(bytes);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  public static string Threads(int pid) {
    Process p = Process.GetProcessById(pid);
    StringBuilder sb = new StringBuilder();
    sb.Append("{\\"mask\\":\\"").Append(((ulong)p.ProcessorAffinity.ToInt64()).ToString()).Append("\\"");
    sb.Append(",\\"priority\\":\\"").Append(p.PriorityClass.ToString()).Append("\\",\\"threads\\":[");
    bool first = true;
    foreach (ProcessThread t in p.Threads) {
      if (!first) sb.Append(",");
      first = false;
      IntPtr h = OpenThread(0x0800, false, (uint)t.Id);
      GroupAffinity a;
      if (h == IntPtr.Zero) { sb.Append("[").Append(t.Id).Append(",null,null]"); continue; }
      try {
        if (GetThreadGroupAffinity(h, out a)) sb.Append("[").Append(t.Id).Append(",").Append(a.Group).Append(",\\"").Append(a.Mask.ToUInt64().ToString()).Append("\\"]");
        else sb.Append("[").Append(t.Id).Append(",null,null]");
      } finally { CloseHandle(h); }
    }
    sb.Append("]}");
    return sb.ToString();
  }
}
`

/** PowerShell statement that compiles `WIN_NATIVE_CS` unless already loaded. */
export function addTypeStatement (): string {
  return `if (-not ('BpPlacement' -as [type])) { Add-Type -TypeDefinition @'\n${WIN_NATIVE_CS}\n'@ }\n`
}
