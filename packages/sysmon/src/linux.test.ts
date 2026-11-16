import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinuxBackend, parseNetDev, parseProcStat, parseProcStatus } from './linux.ts'

const STAT = '4242 (bedrock_server) S 1 4242 4242 0 -1 4194560 120000 0 3 0 1500 250 0 0 20 0 37 0 9999 2147483648 51200 18446744073709551615 0 0 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0\n'
// comm with spaces and a ')' inside.
const TASK_STAT = '4250 (Server Thr) d) R 1 4242 4242 0 -1 4194624 10 0 0 0 700 50 0 0 20 0 37 0 10000 0 0 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 -1 3 0 0 0 0 0\n'

const STATUS = `Name:\tbedrock_server
Umask:\t0022
State:\tS (sleeping)
Tgid:\t4242
VmPeak:\t 2400000 kB
VmRSS:\t  204800 kB
RssAnon:\t  150000 kB
RssFile:\t   54800 kB
Threads:\t37
`

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 99999999  100000    0    0    0     0          0         0 99999999  100000    0    0    0     0       0          0
  eth0: 1000000    2000    0    0    0     0          0         0   500000    1500    0    0    0     0       0          0
docker0:    2000      10    0    0    0     0          0         0     3000      12    0    0    0     0       0          0
`

const NET_PARSED = [{ name: 'eth0', rxBytes: 1000000, txBytes: 500000 }, { name: 'docker0', rxBytes: 2000, txBytes: 3000 }]

test('parseProcStat', () => {
  assert.deepEqual(parseProcStat(STAT), { comm: 'bedrock_server', state: 'S', cpuTicks: 1750, numThreads: 37, rssPages: 51200 })
  const t = parseProcStat(TASK_STAT)
  assert.equal(t.comm, 'Server Thr) d')
  assert.equal(t.state, 'R')
  assert.equal(t.cpuTicks, 750)
  assert.throws(() => parseProcStat('garbage'))
})

test('parseProcStatus', () => {
  assert.deepEqual(parseProcStatus(STATUS), { vmRssBytes: 204800 * 1024, rssAnonBytes: 150000 * 1024, threads: 37 })
  assert.deepEqual(parseProcStatus('Name:\tkthreadd\nThreads:\t1\n'), { threads: 1 })
})

test('parseNetDev excludes lo and headers', () => {
  assert.deepEqual(parseNetDev(NET_DEV), NET_PARSED)
  assert.deepEqual(parseNetDev(''), [])
})

test('linux backend reads a fake /proc tree and reports exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sysmon-proc-'))
  try {
    const p = join(root, '4242')
    mkdirSync(join(p, 'task', '4242'), { recursive: true })
    mkdirSync(join(p, 'task', '4250'), { recursive: true })
    mkdirSync(join(p, 'fd'), { recursive: true })
    mkdirSync(join(p, 'net'), { recursive: true })
    for (const fd of ['0', '1', '2']) writeFileSync(join(p, 'fd', fd), '')
    writeFileSync(join(p, 'stat'), STAT)
    writeFileSync(join(p, 'status'), STATUS)
    writeFileSync(join(p, 'task', '4242', 'stat'), STAT)
    writeFileSync(join(p, 'task', '4250', 'stat'), TASK_STAT)
    writeFileSync(join(p, 'net', 'dev'), NET_DEV)

    const be = createLinuxBackend({ pid: 4242, procRoot: root, clkTck: 100 })
    const r = await be.read()
    assert.equal(r.kind, 'reading')
    if (r.kind !== 'reading') return
    assert.equal(r.raw.procCpuMs, 17500)
    assert.equal(r.raw.rssBytes, 204800 * 1024)
    assert.equal(r.raw.privateBytes, 150000 * 1024)
    assert.equal(r.raw.handles, 3)
    assert.equal(r.raw.threadCount, 37)
    assert.deepEqual(r.raw.threads?.sort((a, b) => a.tid - b.tid),
      [{ tid: 4242, name: 'bedrock_server', cpuMs: 17500 }, { tid: 4250, name: 'Server Thr) d', cpuMs: 7500 }])
    assert.deepEqual(r.raw.net, NET_PARSED)

    writeFileSync(join(p, 'stat'), STAT.replace(') S ', ') Z '))
    assert.deepEqual(await be.read(), { kind: 'exited' })
    rmSync(p, { recursive: true, force: true })
    assert.deepEqual(await be.read(), { kind: 'exited' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
