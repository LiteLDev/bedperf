// End-to-end for distributed placement: remote-bots plans against a real BDS (Windows), a launcher
// whose child is the "game" (Windows post-spawn applies, Linux taskset wrapper), and bots-only plans
// on the real topology. Run with BEDPERF_E2E=1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatCpuList } from './cpus.ts'
import { applyToServerTree, wrapSpawn } from './apply.ts'
import { defaultProfile } from './profile.ts'
import { planPlacement, planUsable } from './plan.ts'
import { readTopology } from './topology.ts'
import { verifyServerProcesses } from './verify.ts'

const e2e = process.env.BEDPERF_E2E === '1'

function udpFree (port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = createSocket('udp4')
    s.once('error', () => { s.close(); resolve(false) })
    s.bind(port, () => s.close(() => resolve(true)))
  })
}

async function freePortPair (): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + 2 * Math.floor(Math.random() * 10000)
    if (await udpFree(port) && await udpFree(port + 1)) return port
  }
  throw new Error('no free UDP port pair')
}

test('remote-bots plan applied to a real BDS and verified with every thread', { skip: !e2e || process.platform !== 'win32', timeout: 240_000 }, async () => {
  const topo = await readTopology()
  const plan = planPlacement(topo, defaultProfile(), { bots: 'remote' })
  console.log(`remote plan: server ${formatCpuList(plan.serverCpus)} harness ${formatCpuList(plan.harnessCpus)} checks ${JSON.stringify(plan.checks)}`)
  assert.ok(planUsable(plan), JSON.stringify(plan.checks))
  assert.deepEqual(plan.botCpus, [])
  assert.ok(plan.checks.some(c => c.id === 'bots_remote'))

  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: await freePortPair() })
  try {
    const pid = bds.proc.pid!
    const applied = await applyToServerTree({ ...plan, priority: 'above_normal' }, { serverPid: pid })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const v = await verifyServerProcesses({ ...plan, priority: 'above_normal' }, { serverPid: pid })
    console.log(`verify: ${JSON.stringify(v.checks)}`)
    assert.equal(v.verified, true, JSON.stringify(v.server.violations))
    assert.ok(v.server.threadCount > 1)
  } finally {
    await bds.stop()
  }
})

// The "launcher" starts a multi-threaded node child that keeps a CPU busy, detached on Linux like a
// daemonizing wineserver, and prints its pid.
const LAUNCHER = `
const { spawn } = require('node:child_process')
const busy = 'setInterval(() => { let x = 0; for (let i = 0; i < 2e6; i++) x += i }, 20)'
const c = spawn(process.execPath, ['-e', busy], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true })
console.log('CHILD ' + c.pid)
setInterval(() => {}, 1000)
`

function childPid (launcher: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = ''
    launcher.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /CHILD (\d+)/.exec(out)
      if (m) resolve(Number(m[1]))
    })
    launcher.once('exit', code => reject(new Error(`launcher exited ${code}`)))
  })
}

test('launcher: the game child is placed (taskset wrapper on Linux, post-spawn applies on Windows) and verified', { skip: !e2e, timeout: 60_000 }, async () => {
  const topo = await readTopology()
  const plan = planPlacement(topo, defaultProfile(), { bots: 'remote' })
  assert.ok(planUsable(plan), JSON.stringify(plan.checks))
  // above_normal needs CAP_SYS_NICE on Linux; root in the container has it
  const priority = process.platform === 'win32' || process.getuid?.() === 0 ? 'above_normal' as const : 'normal' as const
  const placed = { ...plan, priority }
  const dir = mkdtempSync(join(tmpdir(), 'bedperf-launcher-'))
  const script = join(dir, 'launcher.cjs')
  writeFileSync(script, LAUNCHER)
  const w = wrapSpawn(process.execPath, [script], placed)
  const launcher = spawn(w.command, w.args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let child: number | undefined
  try {
    if (w.postSpawnApplyRequired) {
      // right after the spawn: place the launcher so the child it creates inherits the mask
      const early = await applyToServerTree(placed, { launcherPid: launcher.pid! })
      assert.equal(early.ok, true, JSON.stringify(early))
    }
    child = await childPid(launcher)
    if (w.postSpawnApplyRequired) {
      // once resolved: the child itself (the priority class is not inherited on Windows)
      const late = await applyToServerTree(placed, { serverPid: child, launcherPid: launcher.pid! })
      assert.equal(late.ok, true, JSON.stringify(late))
    }
    await new Promise(resolve => setTimeout(resolve, 500)) // let the child start its worker threads
    const procs = { serverPid: child, launcherPid: launcher.pid! }
    const v = await verifyServerProcesses(placed, procs)
    console.log(`launcher verify (${w.method}): ${JSON.stringify(v.checks)} threads ${v.server.threadCount}`)
    assert.equal(v.verified, true, JSON.stringify(v.members.map(m => m.verification.violations)))
    assert.ok(v.server.threadCount > 1, `threads ${v.server.threadCount}`)
    assert.equal(v.server.priority, priority)

    const other = topo.cpus.map(c => c.cpu).filter(c => !plan.serverCpus.includes(c))
    assert.ok(other.length > 0)
    const bad = await verifyServerProcesses(placed, procs, { cpus: other })
    assert.equal(bad.verified, false)
    assert.ok(bad.server.violations.some(x => x.kind === 'process_affinity'))
    assert.ok(bad.server.violations.some(x => x.kind === 'thread_outside'))
    assert.ok(bad.checks.some(c => c.id === 'launcher_placement' && c.level === 'fail'))
  } finally {
    if (child !== undefined) try { process.kill(child) } catch {}
    launcher.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bots-only plan on the real topology', { skip: !e2e }, async () => {
  const topo = await readTopology()
  const plan = planPlacement(topo, defaultProfile(), { role: 'bots-only' })
  console.log(`bots-only plan on ${topo.cpus.length} allowed CPUs: bots ${formatCpuList(plan.botCpus)} agent ${formatCpuList(plan.harnessCpus)} checks ${JSON.stringify(plan.checks)}`)
  assert.ok(planUsable(plan), JSON.stringify(plan.checks))
  assert.deepEqual(plan.serverCpus, [])
  const allowed = new Set(topo.cpus.map(c => c.cpu))
  assert.ok([...plan.botCpus, ...plan.harnessCpus].every(c => allowed.has(c)))
  if (topo.cpus.length >= 2 && !plan.checks.some(c => c.id === 'harness_shared')) {
    assert.ok(plan.botCpus.every(c => !plan.harnessCpus.includes(c)))
    assert.equal(plan.botCpus.length + plan.harnessCpus.length, topo.cpus.length)
  }
})
