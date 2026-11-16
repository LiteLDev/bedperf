// End-to-end against the real machine and a real BDS. Run with BEDPERF_E2E=1 (needs the BDS cache,
// see repo README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { availableParallelism } from 'node:os'
import { formatCpuList, cpusToMask } from './cpus.ts'
import { applyToPid } from './apply.ts'
import { defaultProfile } from './profile.ts'
import { planPlacement } from './plan.ts'
import { coresOf, readTopology } from './topology.ts'
import { verifyPlacement } from './verify.ts'

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

/** Change a process' affinity behind the harness's back. */
function setAffinityOutOfBand (pid: number, cpus: number[]): void {
  if (process.platform === 'win32') {
    const mask = BigInt.asIntN(64, cpusToMask(cpus))
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).ProcessorAffinity = [IntPtr][long]${mask}`], { windowsHide: true })
  } else {
    execFileSync('taskset', ['-a', '-p', '-c', formatCpuList(cpus), String(pid)])
  }
}

test('placement: real topology, plan, apply to a real BDS, verify, detect an out-of-band change', { skip: !e2e, timeout: 240_000 }, async () => {
  const topo = await readTopology()
  const cores = coresOf(topo)
  const classes = [...new Set(topo.cpus.map(c => c.efficiency))].sort()
  console.log(`topology: ${topo.cpus.length} CPUs, ${cores.length} cores, classes ${classes.join(',')}, ${topo.efficiencySource}, ${topo.placementKind}${topo.virtualization ? ` (${topo.virtualization})` : ''}`)
  assert.ok(topo.cpus.length >= 1 && topo.cpus.length <= availableParallelism(), `cpus ${topo.cpus.length} vs ${availableParallelism()}`)
  assert.ok(cores.length >= 1 && cores.length <= topo.cpus.length)
  assert.ok(classes.length >= 1 && classes.length <= 4, `classes ${classes}`)
  assert.equal(new Set(topo.cpus.map(c => c.cpu)).size, topo.cpus.length)

  const plan = planPlacement(topo, defaultProfile())
  console.log(`plan: server ${formatCpuList(plan.serverCpus)} bots ${formatCpuList(plan.botCpus)} checks ${JSON.stringify(plan.checks)}`)
  assert.ok(plan.serverCpus.length >= 2, 'need two server CPUs for this test')
  assert.ok(plan.serverCpus.every(c => !plan.botCpus.includes(c)))

  const { startTestBds } = await import('../../testkit/src/index.ts')
  const bds = await startTestBds({ port: await freePortPair() })
  try {
    const pid = bds.proc.pid!
    const two = plan.serverCpus.slice(0, 2)
    const applied = await applyToPid(pid, two, 'above_normal')
    console.log(`apply: ${JSON.stringify(applied)}`)
    assert.equal(applied.ok, true, JSON.stringify(applied))

    const ok = await verifyPlacement(pid, plan, { cpus: two, priority: 'above_normal' })
    console.log(`verify: ${JSON.stringify(ok.checks)}`)
    assert.equal(ok.verified, true, JSON.stringify(ok.violations))
    assert.deepEqual(ok.processCpus, two)
    assert.ok(ok.threadCount > 1, `threads ${ok.threadCount}`)

    const other = topo.cpus.map(c => c.cpu).filter(c => !two.includes(c)).slice(0, 2)
    setAffinityOutOfBand(pid, other)
    const bad = await verifyPlacement(pid, plan, { cpus: two, priority: 'above_normal' })
    console.log(`after out-of-band change: ${JSON.stringify(bad.checks)}`)
    assert.equal(bad.verified, false)
    assert.ok(bad.violations.some(v => v.kind === 'process_affinity'))
    assert.ok(bad.violations.some(v => v.kind === 'thread_outside'))
  } finally {
    await bds.stop()
  }
})
