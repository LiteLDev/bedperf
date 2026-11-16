// The machine lock: one measured run per machine at a time. Two benchmarks sharing a CPU measure each other.
//
// The lock is a file created exclusively (`open(path, 'wx')`) holding who took it. It is removed when the
// holder releases it or exits (including process.exit after a second Ctrl+C and uncaught crashes). A holder
// killed hard leaves the file behind; the next run sees that its pid is gone and takes the lock over.
import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cacheBaseDir } from '@bedperf/bds-install'

export const ENV_LOCK = 'BEDPERF_LOCK'

/** Written into the lock file. */
export interface LockInfo {
  pid: number
  /** ISO time the lock was taken. */
  since: string
  runId?: string
  bedperfVersion: string
  /** Random; identifies this hold so a release never removes somebody else's lock. */
  token: string
}

export interface MachineLock {
  readonly path: string
  readonly info: LockInfo
  /** Record the run id in the lock file once it is known (no-op if the lock is no longer ours). */
  setRunId: (runId: string) => void
  /** Remove the lock file if it is still ours. Idempotent; synchronous so it works in an 'exit' handler. */
  release: () => void
}

/** Tokens of the locks this process holds: tells our own live holds from a stale file left by an earlier process with our pid. */
const heldTokens = new Set<string>()

export class LockHeldError extends Error {
  readonly path: string
  readonly holder: LockInfo | undefined
  constructor (path: string, holder: LockInfo | undefined) {
    const who = holder !== undefined
      ? `pid ${holder.pid}${holder.runId !== undefined ? ` (run ${holder.runId})` : ''} since ${holder.since}, bedperf ${holder.bedperfVersion}`
      : 'another process'
    super(`another benchmark holds the machine lock ${path}: ${who}. Wait for it to finish; if that process is gone, delete the file.`)
    this.name = 'LockHeldError'
    this.path = path
    this.holder = holder
  }
}

/** `$BEDPERF_LOCK`, else `<cache root>/machine.lock`. Benchmarks sharing a machine must share this file. */
export function defaultLockPath (): string {
  const env = process.env[ENV_LOCK]
  return env !== undefined && env !== '' ? env : join(cacheBaseDir(), 'machine.lock')
}

/** True unless signalling `pid` reports it does not exist (EPERM means it exists but is not ours). */
export function pidAlive (pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export interface AcquireOptions {
  path?: string
  runId?: string
  bedperfVersion?: string
  /** Injectable liveness check. */
  isAlive?: (pid: number) => boolean
  pid?: number
  /** Register a process 'exit' handler that releases the lock. Default true. */
  releaseOnExit?: boolean
}

function readInfo (path: string): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as LockInfo
    return typeof v.pid === 'number' && typeof v.token === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

/** An unreadable lock file younger than this may still be being written by its creator. */
const UNREADABLE_GRACE_MS = 10_000

function fileAgeMs (path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return Infinity
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Take the machine lock or throw `LockHeldError`. A lock whose holder pid is dead is stale and is taken over.
 */
export async function acquireMachineLock (opts: AcquireOptions = {}): Promise<MachineLock> {
  const path = opts.path ?? defaultLockPath()
  const isAlive = opts.isAlive ?? pidAlive
  const info: LockInfo = {
    pid: opts.pid ?? process.pid,
    since: new Date().toISOString(),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    bedperfVersion: opts.bedperfVersion ?? '0.0.0',
    token: randomBytes(12).toString('hex')
  }
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fh = await open(path, 'wx')
      try {
        await fh.writeFile(JSON.stringify(info) + '\n')
      } finally {
        await fh.close()
      }
      return makeLock(path, info, opts.releaseOnExit !== false)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let holder = readInfo(path)
    // The creator may not have written its body yet: give it a moment before calling the file garbage.
    for (let i = 0; holder === undefined && i < 10; i++) {
      await sleep(50)
      holder = readInfo(path)
    }
    if (holder === undefined && fileAgeMs(path) < UNREADABLE_GRACE_MS) throw new LockHeldError(path, undefined)
    // Our own pid with a token we do not hold: left by an earlier process that had the same pid (containers).
    const ownStale = holder !== undefined && holder.pid === (opts.pid ?? process.pid) && !heldTokens.has(holder.token)
    if (holder !== undefined && !ownStale && isAlive(holder.pid)) throw new LockHeldError(path, holder)
    takeOverStale(path, holder)
  }
  throw new LockHeldError(path, readInfo(path))
}

/**
 * Move a stale lock file aside; the caller then retries the exclusive create. If what we moved is not the
 * stale lock we judged (another process took it over in between), put it back with an exclusive link so that
 * live holder keeps its lock. The put-back can only fail if a third process created a lock in the same
 * instant; that needs three runs starting together over a stale lock and is not handled further.
 */
function takeOverStale (path: string, stale: LockInfo | undefined): void {
  const aside = `${path}.${randomBytes(6).toString('hex')}.stale`
  try {
    renameSync(path, aside)
  } catch {
    return
  }
  const moved = readInfo(aside)
  if (moved !== undefined && moved.token !== stale?.token) {
    try { linkSync(aside, path) } catch {}
  }
  try { unlinkSync(aside) } catch {}
}

function makeLock (path: string, info: LockInfo, releaseOnExit: boolean): MachineLock {
  let released = false
  heldTokens.add(info.token)
  const release = (): void => {
    if (released) return
    released = true
    heldTokens.delete(info.token)
    process.off('exit', release)
    if (readInfo(path)?.token !== info.token) return
    try { unlinkSync(path) } catch {}
  }
  const setRunId = (runId: string): void => {
    if (released || readInfo(path)?.token !== info.token) return
    info.runId = runId
    try { writeFileSync(path, JSON.stringify(info) + '\n') } catch {}
  }
  if (releaseOnExit) process.on('exit', release)
  return { path, info, setRunId, release }
}
