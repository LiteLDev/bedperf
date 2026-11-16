// Real-machine interference sampling. Run with BEDPERF_E2E=1. The host may carry background
// load, so assertions are relative to a baseline measured in the same run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import type { InterferenceSample } from '@bedperf/core'
import { createMachineSampler, idleCheck, summarizeInterference } from './machine.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Start a busy loop OUTSIDE our process tree: an intermediate node spawns it detached, prints its
 * pid and exits, so the loop is an orphan that the harness group (rooted at our pid) cannot reach.
 */
function spawnOrphanBusyLoop (): Promise<number> {
  const launcher = "const c=require('child_process').spawn(process.execPath,['-e','for(;;){}'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()"
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', launcher], (err, stdout) => {
      if (err) return reject(err)
      const pid = Number(stdout.trim())
      if (Number.isInteger(pid) && pid > 0) resolve(pid)
      else reject(new Error(`bad pid ${stdout}`))
    })
  })
}

test('idleCheck returns a finite summary', { skip: !e2e, timeout: 120_000 }, async () => {
  const r = await idleCheck({ durationSec: 5, serverCpus: [0, 1], thresholds: { foreignMean: 1e9, foreignPeak10s: 1e9, serverSetForeignMean: 1e9 } })
  console.log('idle', r.summary, r.top.slice(0, 5))
  assert.equal(r.ok, true)
  assert.equal(r.summary.samples, 5)
  assert.ok(Number.isFinite(r.summary.foreignMean))
  assert.ok(Number.isFinite(r.summary.foreignPeak10s))
  assert.ok(Number.isFinite(r.summary.serverSetForeignMean!))
})

test('an unregistered busy process is foreign until it joins the bots group', { skip: !e2e, timeout: 120_000 }, async () => {
  const samples: InterferenceSample[] = []
  const sampler = createMachineSampler({ groups: { harness: [process.pid] }, topIntervalMs: 5000 })
  await sampler.start(s => samples.push(s))
  const window = async (sec: number): Promise<InterferenceSample[]> => {
    const n = samples.length
    await sleep(sec * 1000)
    return samples.slice(n)
  }
  let busyPid: number | undefined
  try {
    await sleep(2500)
    const base = summarizeInterference(await window(8))
    busyPid = await spawnOrphanBusyLoop()
    await sleep(1500)
    const foreignWin = await window(8)
    const busy = summarizeInterference(foreignWin)
    const top = foreignWin.filter(s => s.top).flatMap(s => s.top!)
    sampler.setGroup('bots', [busyPid])
    await sleep(1500)
    const joinedWin = await window(8)
    const joined = summarizeInterference(joinedWin)
    console.log({ busyPid, base, busy, joined, top: top.slice(0, 3), bots: joinedWin.map(s => s.groups.bots.toFixed(2)) })
    assert.ok(busy.foreignMean - base.foreignMean >= 0.5, `foreign rose by ${busy.foreignMean - base.foreignMean}`)
    assert.ok(busy.foreignMean - joined.foreignMean >= 0.3, `foreign fell by ${busy.foreignMean - joined.foreignMean}`)
    assert.ok(top.some(t => t.pid === busyPid && t.cores > 0.5), 'busy loop listed among top foreign processes')
    assert.ok(joinedWin.every(s => s.groups.bots > 0.6), 'bots group carries the busy loop')
  } finally {
    if (busyPid) try { process.kill(busyPid) } catch {}
    await sampler.stop()
  }
})
