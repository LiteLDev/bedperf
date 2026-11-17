import { spawn } from 'node:child_process'

export interface ExecResult { code: number | null, stdout: string, stderr: string }

export interface ExecOptions {
  cwd?: string
  /** Extra environment, merged over process.env. */
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Runs an external command (lip, python, pip, wine, tar) and resolves with its exit code and output.
 * Rejects only when the command cannot be started (e.g. ENOENT). Injectable so tests use fakes.
 */
export type InstallExec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

/** Default `InstallExec`: spawn without a shell, stdin closed, output captured and passed to `log` line by line. */
export function defaultExec (log?: (line: string) => void): InstallExec {
  return async (cmd, args, opts = {}) => await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env !== undefined ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs !== undefined
      ? setTimeout(() => child.kill(), opts.timeoutMs)
      : undefined
    const partials: string[] = []
    const tap = (stream: 'out' | 'err') => {
      const i = partials.push('') - 1
      return (chunk: Buffer): void => {
        const s = chunk.toString('utf8')
        if (stream === 'out') stdout += s
        else stderr += s
        if (log === undefined) return
        const lines = (partials[i] + s).split(/\r?\n/)
        partials[i] = lines.pop() ?? ''
        for (const l of lines) if (l.trim() !== '') log(l)
      }
    }
    child.stdout.on('data', tap('out'))
    child.stderr.on('data', tap('err'))
    child.on('error', err => { if (timer) clearTimeout(timer); reject(err) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      for (const p of partials) if (log !== undefined && p.trim() !== '') log(p)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Run and throw with the command line and output tail when it exits non-zero. */
export async function execOk (exec: InstallExec, cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
  const r = await exec(cmd, args, opts)
  if (r.code !== 0) {
    const tail = (r.stdout + '\n' + r.stderr).trim().split(/\r?\n/).slice(-15).join('\n')
    throw new Error(`'${[cmd, ...args].join(' ')}' exited with code ${String(r.code)}${opts?.cwd !== undefined ? ` (cwd ${opts.cwd})` : ''}:\n${tail}`)
  }
  return r
}
