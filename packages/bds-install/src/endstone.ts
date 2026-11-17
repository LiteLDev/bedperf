// Endstone (github.com/EndstoneMC/endstone): a pip package whose `endstone` CLI starts BDS with its
// runtime injected (Windows: detours DLL injection; Linux: LD_PRELOAD of mimalloc + libendstone_runtime.so).
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execOk, type InstallExec } from './exec.ts'
import type { HostOs } from './lip.ts'

/** Lowest Python Endstone ships wheels for. */
export const ENDSTONE_MIN_PYTHON: readonly [number, number] = [3, 11]

export interface PythonInfo { command: string, prefixArgs: string[], version: string }

/** Candidate interpreters, in order: Windows `python`, `py -3`; Linux `python3`, `python`. */
export function pythonCandidates (os: HostOs): Array<{ command: string, prefixArgs: string[] }> {
  return os === 'windows'
    ? [{ command: 'python', prefixArgs: [] }, { command: 'py', prefixArgs: ['-3'] }]
    : [{ command: 'python3', prefixArgs: [] }, { command: 'python', prefixArgs: [] }]
}

/** Find a Python >= 3.11 (or check `python` when given). */
export async function findPython (exec: InstallExec, os: HostOs, python?: string): Promise<PythonInfo> {
  const cands = python !== undefined ? [{ command: python, prefixArgs: [] }] : pythonCandidates(os)
  const seen: string[] = []
  for (const c of cands) {
    try {
      const r = await exec(c.command, [...c.prefixArgs, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'])
      const v = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout)
      if (r.code !== 0 || !v) { seen.push(`${c.command}: not runnable`); continue }
      const major = Number(v[1])
      const minor = Number(v[2])
      if (major < ENDSTONE_MIN_PYTHON[0] || (major === ENDSTONE_MIN_PYTHON[0] && minor < ENDSTONE_MIN_PYTHON[1])) {
        seen.push(`${c.command}: ${v[0]}`)
        continue
      }
      return { ...c, version: v[0] }
    } catch {
      seen.push(`${c.command}: not found`)
    }
  }
  throw new Error(`Endstone needs Python >= ${ENDSTONE_MIN_PYTHON.join('.')} (${seen.join('; ')}). Install one or pass { python }.`)
}

/** `python` / `endstone` inside a venv. */
export function venvBin (venv: string, name: 'python' | 'endstone', os: HostOs): string {
  return os === 'windows' ? join(venv, 'Scripts', `${name}.exe`) : join(venv, 'bin', name)
}

/**
 * Create `venv`, download the endstone wheel into `wheelDir` (so its sha256 can be recorded) and
 * install it with its dependencies. Returns the wheel path.
 */
export async function installEndstone (opts: {
  exec: InstallExec
  os: HostOs
  python: PythonInfo
  venv: string
  wheelDir: string
  version: string
}): Promise<{ wheel: string }> {
  const { exec, os } = opts
  await execOk(exec, opts.python.command, [...opts.python.prefixArgs, '-m', 'venv', opts.venv])
  const py = venvBin(opts.venv, 'python', os)
  const pipFlags = ['--disable-pip-version-check', '--no-input']
  await execOk(exec, py, ['-m', 'pip', 'download', ...pipFlags, '--no-deps', '--only-binary=:all:', '-d', opts.wheelDir, `endstone==${opts.version}`])
  const wheel = findEndstoneWheel(opts.wheelDir, opts.version)
  if (wheel === undefined) throw new Error(`pip download did not produce an endstone ${opts.version} wheel in ${opts.wheelDir}`)
  await execOk(exec, py, ['-m', 'pip', 'install', ...pipFlags, wheel])
  return { wheel }
}

export function findEndstoneWheel (dir: string, version: string): string | undefined {
  if (!existsSync(dir)) return undefined
  const name = readdirSync(dir).filter(f => f.startsWith(`endstone-${version}-`) && f.endsWith('.whl')).sort()[0]
  return name !== undefined ? join(dir, name) : undefined
}

/**
 * Python run by the Windows launcher: Endstone's CLI, with the loopback exemption (an elevated
 * `CheckNetIsolation LoopbackExempt -a` that pops a UAC prompt when the Minecraft UWP app is not
 * exempt yet) disabled. The exemption only lets the Windows Store client reach a server on
 * localhost; bedperf's bots do not need it.
 */
export const ENDSTONE_WINDOWS_LAUNCHER =
  'import sys; from endstone.cli.windows import WindowsBootstrap as B; ' +
  'B._add_loopback_exemption = lambda self: None; ' +
  'from endstone.cli import main; sys.argv[0] = "endstone"; main()'
