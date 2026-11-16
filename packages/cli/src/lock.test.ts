import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireMachineLock, defaultLockPath, LockHeldError, pidAlive, type LockInfo } from './lock.ts'

function withTmp (fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bedperf-lock-'))
    try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

test('defaultLockPath honours BEDPERF_LOCK', () => {
  const prev = process.env['BEDPERF_LOCK']
  try {
    process.env['BEDPERF_LOCK'] = join(tmpdir(), 'x.lock')
    assert.equal(defaultLockPath(), join(tmpdir(), 'x.lock'))
    delete process.env['BEDPERF_LOCK']
    assert.match(defaultLockPath(), /machine\.lock$/)
  } finally {
    if (prev === undefined) delete process.env['BEDPERF_LOCK']
    else process.env['BEDPERF_LOCK'] = prev
  }
})

test('pidAlive', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(2 ** 22 + 12345), false)
})

test('acquire, held error names the holder, release, reacquire', withTmp(async dir => {
  const path = join(dir, 'sub', 'machine.lock')
  const a = await acquireMachineLock({ path, runId: 'run-a', bedperfVersion: '1.0', releaseOnExit: false })
  const body = JSON.parse(readFileSync(path, 'utf8')) as LockInfo
  assert.equal(body.pid, process.pid)
  assert.equal(body.runId, 'run-a')
  assert.equal(body.token, a.info.token)
  await assert.rejects(acquireMachineLock({ path, releaseOnExit: false }), (err: unknown) => {
    assert.ok(err instanceof LockHeldError)
    assert.match(err.message, new RegExp(`pid ${process.pid} \\(run run-a\\)`))
    return true
  })
  a.release()
  assert.equal(existsSync(path), false)
  a.release()
  const b = await acquireMachineLock({ path, releaseOnExit: false })
  b.release()
}))

test('a stale lock (dead pid) is taken over; release never removes a lock that is not ours', withTmp(async dir => {
  const path = join(dir, 'machine.lock')
  writeFileSync(path, JSON.stringify({ pid: 999999, since: 'x', bedperfVersion: '0', token: 'old' }))
  const l = await acquireMachineLock({ path, isAlive: () => false, releaseOnExit: false })
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as LockInfo).token, l.info.token)
  writeFileSync(path, JSON.stringify({ pid: 1, since: 'x', bedperfVersion: '0', token: 'someone-else' }))
  l.release()
  assert.equal(existsSync(path), true)
}))

test('a lock left by an earlier process with our own pid is stale (pid reuse in containers)', withTmp(async dir => {
  const path = join(dir, 'machine.lock')
  writeFileSync(path, JSON.stringify({ pid: process.pid, since: 'x', bedperfVersion: '0', token: 'previous-container' }))
  const l = await acquireMachineLock({ path, releaseOnExit: false })
  // ...but a lock this process really holds is not.
  await assert.rejects(acquireMachineLock({ path, releaseOnExit: false }), LockHeldError)
  l.setRunId('run-x')
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as LockInfo).runId, 'run-x')
  l.release()
}))

test('an unreadable lock file is held while fresh and stale once old', withTmp(async dir => {
  const path = join(dir, 'machine.lock')
  writeFileSync(path, '')
  await assert.rejects(acquireMachineLock({ path, releaseOnExit: false }), LockHeldError)
  const { utimesSync } = await import('node:fs')
  utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  const l = await acquireMachineLock({ path, releaseOnExit: false })
  l.release()
}))

const LOCK_URL = pathToFileURL(join(import.meta.dirname, 'lock.ts')).href

/** A child that takes the lock, prints OK or HELD, then holds it for `holdMs` and exits normally. */
function child (path: string, holdMs: number): { proc: ReturnType<typeof spawn>, result: Promise<string> } {
  const code = `
    const { acquireMachineLock } = await import(${JSON.stringify(LOCK_URL)})
    try {
      await acquireMachineLock({ path: ${JSON.stringify(path)} })
      console.log('OK')
      await new Promise(r => setTimeout(r, ${holdMs}))
    } catch (e) { console.log(e.name === 'LockHeldError' ? 'HELD' : 'ERR ' + e.message) }`
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  const result = new Promise<string>((resolve) => {
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) resolve(out.trim())
    })
    proc.on('exit', () => resolve(out.trim()))
  })
  return { proc, result }
}

test('processes: exactly one of two concurrent acquirers wins; a hard-killed holder leaves a stale lock that is taken over', withTmp(async dir => {
  const path = join(dir, 'machine.lock')
  const a = child(path, 60_000)
  const b = child(path, 60_000)
  const results = await Promise.all([a.result, b.result])
  assert.deepEqual([...results].sort(), ['HELD', 'OK'])
  const holder = results[0] === 'OK' ? a : b
  const other = holder === a ? b : a
  await new Promise(resolve => { if (other.proc.exitCode !== null) resolve(null); else other.proc.on('exit', resolve) })
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as LockInfo).pid, holder.proc.pid)

  // Hard kill: no exit handler runs, the file stays behind.
  await new Promise(resolve => { holder.proc.on('exit', resolve); holder.proc.kill('SIGKILL') })
  assert.equal(existsSync(path), true)
  const c = child(path, 0)
  assert.equal(await c.result, 'OK')
  await new Promise(resolve => { if (c.proc.exitCode !== null) resolve(null); else c.proc.on('exit', resolve) })
  // Normal exit released it.
  assert.equal(existsSync(path), false)
}))
