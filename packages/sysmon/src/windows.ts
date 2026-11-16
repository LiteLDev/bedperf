import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Backend, BackendResult, RawReading } from './types.ts'

const PREFIX = 'BPSM '

/**
 * PowerShell for the long-lived helper. It defines `bp <seq>`, which prints ONE line
 * `BPSM {"seq":<seq>,...}` per call; Node writes `bp <seq>` to the helper's stdin once per
 * interval and matches replies by `seq`. Kept on a single line because `-Command -` executes
 * stdin line by line. Numbers are integers only, so the output is culture-invariant.
 */
export function windowsHelperScript (pid: number, net: boolean): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`)
  const lines = [
    "$ErrorActionPreference = 'Stop';",
    '$bpSelf = [Diagnostics.Process]::GetCurrentProcess();',
    `$bpP = $null; try { $bpP = [Diagnostics.Process]::GetProcessById(${pid}) } catch { };`,
    "function bpOut($s) { [Console]::Out.WriteLine('BPSM ' + $s) };",
    'function bp([long]$seq) {',
    "  $pre = '{\"seq\":' + $seq + ',';",
    "  if ($null -eq $bpP) { bpOut ($pre + '\"exited\":true}'); return };",
    '  try {',
    '    $bpP.Refresh();',
    "    if ($bpP.HasExited) { bpOut ($pre + '\"exited\":true}'); return };",
    '    $sb = New-Object Text.StringBuilder;',
    "    [void]$sb.Append($pre).Append('\"t\":').Append([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());",
    "    [void]$sb.Append(',\"cpu\":').Append([long]$bpP.TotalProcessorTime.TotalMilliseconds);",
    "    [void]$sb.Append(',\"ws\":').Append([long]$bpP.WorkingSet64);",
    "    [void]$sb.Append(',\"pb\":').Append([long]$bpP.PrivateMemorySize64);",
    "    [void]$sb.Append(',\"h\":').Append([long]$bpP.HandleCount);",
    "    [void]$sb.Append(',\"th\":[');",
    '    $bpFirst = $true;',
    '    foreach ($th in $bpP.Threads) {',
    '      try {',
    '        $ms = [long]$th.TotalProcessorTime.TotalMilliseconds;',
    "        if (-not $bpFirst) { [void]$sb.Append(',') };",
    "        [void]$sb.Append('[').Append([long]$th.Id).Append(',').Append($ms).Append(']');",
    '        $bpFirst = $false',
    '      } catch { }',
    '    };',
    "    [void]$sb.Append(']');",
    ...(net
      ? [
          "    [void]$sb.Append(',\"net\":[');",
          '    $bpFirst = $true;',
          '    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {',
          "      if ($n.NetworkInterfaceType -ne 'Loopback' -and $n.OperationalStatus -eq 'Up') {",
          '        try {',
          '          $s = $n.GetIPStatistics();',
          "          if (-not $bpFirst) { [void]$sb.Append(',') };",
          // Adapter ids are GUIDs like {XXXXXXXX-...}: safe inside a JSON string.
          "          [void]$sb.Append('[\"').Append($n.Id).Append('\",').Append([long]$s.BytesReceived).Append(',').Append([long]$s.BytesSent).Append(']');",
          '          $bpFirst = $false',
          '        } catch { }',
          '      }',
          '    };',
          "    [void]$sb.Append(']');"
        ]
      : []),
    "    [void]$sb.Append(',\"self\":').Append([long]$bpSelf.TotalProcessorTime.TotalMilliseconds).Append('}');",
    '    bpOut $sb.ToString()',
    '  } catch {',
    // Only a positive HasExited means exited; e.g. access denied must surface as an error.
    '    $bpEx = $false; try { $bpP.Refresh(); $bpEx = $bpP.HasExited } catch { };',
    "    if ($bpEx) { bpOut ($pre + '\"exited\":true}') } else { bpOut ($pre + '\"error\":' + (ConvertTo-Json -Compress ([string]$_.Exception.Message)) + '}') }",
    '  }',
    '}'
  ]
  return lines.map(l => l.trim()).join(' ')
}

export type HelperMessage =
  | { kind: 'reading', seq?: number, raw: RawReading, selfCpuMs?: number }
  | { kind: 'exited', seq?: number }
  | { kind: 'error', seq?: number, message: string }

interface WireSample {
  seq: number
  t: number
  cpu: number
  ws: number
  pb: number
  h: number
  th: Array<[number, number]>
  net: Array<[string, number, number]>
  self: number
  exited: boolean
  error: string
}

/** Parse one stdout line of the helper. Returns null for lines that are not ours. */
export function parseHelperLine (line: string): HelperMessage | null {
  const i = line.indexOf(PREFIX)
  if (i < 0) return null
  let o: unknown
  try { o = JSON.parse(line.slice(i + PREFIX.length)) } catch { return { kind: 'error', message: `bad helper line: ${line}` } }
  if (typeof o !== 'object' || o === null) return { kind: 'error', message: `bad helper line: ${line}` }
  const r = o as Partial<WireSample>
  const seq = typeof r.seq === 'number' ? { seq: r.seq } : {}
  if (r.exited) return { kind: 'exited', ...seq }
  if (typeof r.error === 'string') return { kind: 'error', ...seq, message: r.error }
  if (typeof r.t !== 'number' || typeof r.cpu !== 'number' || typeof r.ws !== 'number') {
    return { kind: 'error', ...seq, message: `incomplete helper sample: ${line}` }
  }
  const raw: RawReading = { t: r.t, procCpuMs: r.cpu, rssBytes: r.ws }
  if (typeof r.pb === 'number') raw.privateBytes = r.pb
  if (typeof r.h === 'number') raw.handles = r.h
  if (Array.isArray(r.th)) {
    raw.threads = r.th.map(([tid, cpuMs]) => ({ tid, cpuMs }))
    raw.threadCount = raw.threads.length
  }
  if (Array.isArray(r.net)) raw.net = r.net.map(([name, rxBytes, txBytes]) => ({ name, rxBytes, txBytes }))
  const msg: HelperMessage = { kind: 'reading', ...seq, raw }
  if (typeof r.self === 'number') msg.selfCpuMs = r.self
  return msg
}

export interface WindowsBackendOptions {
  pid: number
  net?: boolean
  /** Max wait for one helper reply (the first one also covers PowerShell start-up). */
  replyTimeoutMs?: number
  firstReplyTimeoutMs?: number
}

export function createWindowsBackend (opts: WindowsBackendOptions): Backend {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const stderr: string[] = []
  let selfCpuMs: number | undefined
  let exited = false
  let seq = 0
  let pending: { seq: number, resolve: (m: HelperMessage) => void, reject: (e: Error) => void } | null = null
  let first = true
  let closeP: Promise<void> | undefined

  const exitP = new Promise<void>(resolve => child.once('close', () => {
    exited = true
    const p = pending
    pending = null
    p?.reject(new Error(`sysmon helper exited${stderr.length ? ': ' + stderr.slice(-5).join(' | ') : ''}`))
    resolve()
  }))
  child.on('error', err => { stderr.push(String(err)) })
  child.stdin.on('error', () => {}) // EPIPE after the helper died is reported via `close`
  createInterface({ input: child.stderr }).on('line', l => { if (l.trim()) stderr.push(l); if (stderr.length > 50) stderr.shift() })
  createInterface({ input: child.stdout }).on('line', l => {
    const m = parseHelperLine(l)
    if (!m) return
    if (m.kind === 'reading' && m.selfCpuMs !== undefined) selfCpuMs = m.selfCpuMs
    // Drop stale replies to requests that already timed out.
    if (!pending || (m.seq !== undefined && m.seq !== pending.seq)) return
    const p = pending
    pending = null
    p.resolve(m)
  })
  child.stdin.write(windowsHelperScript(opts.pid, opts.net ?? true) + '\n')

  return {
    async read (): Promise<BackendResult> {
      if (exited || closeP) throw new Error('sysmon helper is not running')
      if (pending) throw new Error('concurrent read')
      const timeoutMs = first ? (opts.firstReplyTimeoutMs ?? 20_000) : (opts.replyTimeoutMs ?? 10_000)
      first = false
      const mySeq = ++seq
      const m = await new Promise<HelperMessage>((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(new Error(`sysmon helper did not reply within ${timeoutMs} ms`)) }, timeoutMs)
        pending = {
          seq: mySeq,
          resolve: v => { clearTimeout(timer); resolve(v) },
          reject: e => { clearTimeout(timer); reject(e) }
        }
        child.stdin.write(`bp ${mySeq}\n`)
      })
      if (m.kind === 'error') throw new Error(`sysmon helper: ${m.message}`)
      if (m.kind === 'exited') return { kind: 'exited' }
      return { kind: 'reading', raw: m.raw }
    },
    close (): Promise<void> {
      closeP ??= (async () => {
        const p = pending
        pending = null
        p?.reject(new Error('sysmon helper closed'))
        if (!exited) {
          try { child.stdin.end('exit\n') } catch {}
          const t = setTimeout(() => child.kill(), 3000)
          await exitP
          clearTimeout(t)
        }
      })()
      return closeP
    },
    helper () {
      const h: { pid?: number, cpuMs?: number } = {}
      if (child.pid !== undefined) h.pid = child.pid
      if (selfCpuMs !== undefined) h.cpuMs = selfCpuMs
      return h
    }
  }
}
