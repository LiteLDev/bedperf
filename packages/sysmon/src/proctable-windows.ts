import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ProcEntry, ProcTable } from './proctable.ts'

const PREFIX = 'BPPT '

/**
 * C# for the helper: one `NtQuerySystemInformation(SystemProcessInformation)` call returns pid,
 * parent pid, create time, CPU times and image name of every process, without opening a handle
 * per process (so protected processes are included) and without WMI (whose provider host would
 * itself show up as foreign load). Offsets are the 64-bit `SYSTEM_PROCESS_INFORMATION` layout.
 * Output is a JSON array of `[pid, ppid, cpuMs, startEpochMs(, "name")]`, pure ASCII.
 */
const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class BpProcTable {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int l, out int r);
  static IntPtr buf = IntPtr.Zero;
  static int size = 0x100000;
  static void Str(StringBuilder sb, string s) {
    sb.Append('"');
    foreach (char ch in s) {
      if (ch == '"' || ch == '\\\\') { sb.Append('\\\\').Append(ch); }
      else if (ch < ' ' || ch > '~') { sb.Append("\\\\u").Append(((int)ch).ToString("x4")); }
      else { sb.Append(ch); }
    }
    sb.Append('"');
  }
  public static string Snap(bool all, string pids) {
    if (IntPtr.Size != 8) throw new Exception("64-bit PowerShell required");
    HashSet<long> want = new HashSet<long>();
    foreach (string s in pids.Split(',')) { long v; if (long.TryParse(s, out v)) want.Add(v); }
    int st; int ret;
    while (true) {
      if (buf == IntPtr.Zero) buf = Marshal.AllocHGlobal(size);
      st = NtQuerySystemInformation(5, buf, size, out ret);
      if (st == unchecked((int)0xC0000004)) { Marshal.FreeHGlobal(buf); buf = IntPtr.Zero; size = Math.Max(size * 2, ret + 0x10000); continue; }
      break;
    }
    if (st != 0) throw new Exception("NtQuerySystemInformation failed: 0x" + st.ToString("X8"));
    StringBuilder sb = new StringBuilder(all ? 65536 : 256);
    sb.Append('[');
    bool first = true;
    long off = 0;
    while (true) {
      IntPtr p = new IntPtr(buf.ToInt64() + off);
      int next = Marshal.ReadInt32(p, 0);
      long pid = Marshal.ReadIntPtr(p, 80).ToInt64();
      if (all || want.Contains(pid)) {
        long create = Marshal.ReadInt64(p, 32);
        long cpu = (Marshal.ReadInt64(p, 40) + Marshal.ReadInt64(p, 48)) / 10000;
        long ppid = Marshal.ReadIntPtr(p, 88).ToInt64();
        long start = create > 0 ? create / 10000 - 11644473600000L : 0;
        if (!first) sb.Append(',');
        first = false;
        sb.Append('[').Append(pid).Append(',').Append(ppid).Append(',').Append(cpu).Append(',').Append(start);
        if (all) {
          int len = Marshal.ReadInt16(p, 56) & 0xffff;
          IntPtr nb = Marshal.ReadIntPtr(p, 64);
          sb.Append(',');
          Str(sb, nb == IntPtr.Zero || len == 0 ? (pid == 0 ? "Idle" : "System") : Marshal.PtrToStringUni(nb, len / 2));
        }
        sb.Append(']');
      }
      if (next == 0) break;
      off += next;
    }
    sb.Append(']');
    return sb.ToString();
  }
}`

/**
 * PowerShell for the long-lived helper, sent as ONE line (`-Command -` executes stdin line by
 * line). It compiles `BpProcTable` once and defines `bpt <seq> <all> '<pids>'`, which prints one
 * `BPPT {"seq":..,"p":[...]}` line (or `"error"`).
 */
export function windowsProcTableScript (): string {
  const cs = CSHARP.split('\n').map(l => l.trim()).filter(Boolean).join(' ').replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop';",
    `try { Add-Type -TypeDefinition '${cs}' } catch { [Console]::Error.WriteLine([string]$_.Exception.Message) };`,
    'function bpt([long]$seq, [int]$all, [string]$pids) {',
    "  try { [Console]::Out.WriteLine('BPPT {\"seq\":' + $seq + ',\"p\":' + [BpProcTable]::Snap($all -eq 1, $pids) + '}') }",
    "  catch { [Console]::Out.WriteLine('BPPT {\"seq\":' + $seq + ',\"error\":' + (ConvertTo-Json -Compress ([string]$_.Exception.Message)) + '}') }",
    '}'
  ].map(l => l.trim()).join(' ')
}

export type ProcTableReply =
  | { seq?: number, kind: 'table', entries: ProcEntry[] }
  | { seq?: number, kind: 'error', message: string }

/** Parse one helper stdout line; null for lines that are not ours. */
export function parseProcTableLine (line: string): ProcTableReply | null {
  const i = line.indexOf(PREFIX)
  if (i < 0) return null
  let o: unknown
  try { o = JSON.parse(line.slice(i + PREFIX.length)) } catch { return { kind: 'error', message: `bad helper line: ${line.slice(0, 200)}` } }
  if (typeof o !== 'object' || o === null) return { kind: 'error', message: `bad helper line: ${line.slice(0, 200)}` }
  const r = o as { seq?: unknown, p?: unknown, error?: unknown }
  const seq = typeof r.seq === 'number' ? { seq: r.seq } : {}
  if (typeof r.error === 'string') return { kind: 'error', ...seq, message: r.error }
  if (!Array.isArray(r.p)) return { kind: 'error', ...seq, message: 'helper reply without table' }
  const entries: ProcEntry[] = []
  for (const row of r.p) {
    if (!Array.isArray(row)) continue
    const [pid, ppid, cpuMs, start, name] = row as unknown[]
    if (typeof pid !== 'number' || typeof ppid !== 'number' || typeof cpuMs !== 'number') continue
    entries.push({ pid, ppid, cpuMs, start: typeof start === 'number' ? start : 0, name: typeof name === 'string' ? name : '' })
  }
  return { kind: 'table', ...seq, entries }
}

export interface WindowsProcTableOptions {
  /** Max wait for one reply (default 10 s); the first also covers PowerShell start-up and the C# compile. */
  replyTimeoutMs?: number
  firstReplyTimeoutMs?: number
}

/**
 * Process table through one long-lived `powershell.exe` child. Requests are serialised; the
 * child exits when its stdin closes, so it cannot be orphaned.
 */
export function createWindowsProcTable (opts: WindowsProcTableOptions = {}): ProcTable {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stderr: string[] = []
  let exited = false
  let closed = false
  let seq = 0
  let first = true
  let pending: { seq: number, resolve: (m: ProcTableReply) => void, reject: (e: Error) => void } | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let closeP: Promise<void> | undefined

  const exitP = new Promise<void>(resolve => child.once('close', () => {
    exited = true
    const p = pending
    pending = null
    p?.reject(new Error(`proctable helper exited${stderr.length ? ': ' + stderr.slice(-5).join(' | ') : ''}`))
    resolve()
  }))
  child.on('error', err => { stderr.push(String(err)) })
  child.stdin.on('error', () => {})
  createInterface({ input: child.stderr }).on('line', l => { if (l.trim()) stderr.push(l); if (stderr.length > 50) stderr.shift() })
  createInterface({ input: child.stdout }).on('line', l => {
    const m = parseProcTableLine(l)
    if (!m || !pending || (m.seq !== undefined && m.seq !== pending.seq)) return
    const p = pending
    pending = null
    p.resolve(m)
  })
  child.stdin.write(windowsProcTableScript() + '\n')

  function request (all: boolean, pids: number[]): Promise<ProcEntry[]> {
    const run = async (): Promise<ProcEntry[]> => {
      if (exited || closed) throw new Error('proctable helper is not running')
      const timeoutMs = first ? (opts.firstReplyTimeoutMs ?? 30_000) : (opts.replyTimeoutMs ?? 10_000)
      first = false
      const mySeq = ++seq
      const list = pids.filter(p => Number.isInteger(p) && p >= 0).join(',')
      const m = await new Promise<ProcTableReply>((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(new Error(`proctable helper did not reply within ${timeoutMs} ms`)) }, timeoutMs)
        pending = {
          seq: mySeq,
          resolve: v => { clearTimeout(timer); resolve(v) },
          reject: e => { clearTimeout(timer); reject(e) }
        }
        child.stdin.write(`bpt ${mySeq} ${all ? 1 : 0} '${list}'\n`)
      })
      if (m.kind === 'error') throw new Error(`proctable helper: ${m.message}`)
      return m.entries
    }
    const p = chain.then(run, run)
    chain = p.catch(() => {})
    return p
  }

  return {
    scan: () => request(true, []),
    read: pids => request(false, pids),
    close (): Promise<void> {
      closeP ??= (async () => {
        closed = true
        const p = pending
        pending = null
        p?.reject(new Error('proctable helper closed'))
        if (!exited) {
          try { child.stdin.end('exit\n') } catch {}
          const t = setTimeout(() => child.kill(), 3000)
          await exitP
          clearTimeout(t)
        }
      })()
      return closeP
    }
  }
}
