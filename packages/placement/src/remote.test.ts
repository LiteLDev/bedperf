// Distributed runs: server-machine plans with remote bots, bots-only agent plans, and launched
// servers (launcher + game child + helpers such as wineserver) applied and verified as a set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlacementPlan } from '@bedperf/core'
import { formatCpuList } from './cpus.ts'
import { defaultProfile, parseProfile } from './profile.ts'
import { readTopology, type CpuTopology } from './topology.ts'
import { HARNESS_CPUS, planPlacement, planUsable } from './plan.ts'
import { applyBotWorker, applyToServerTree, wrapSpawn } from './apply.ts'
import { verifyBotWorker, verifyServerProcesses } from './verify.ts'
import { decodePs, fakeRunner, linux14700Files, linux4cFiles, linux8c16tFiles, psOut, win14700Raw, wslFiles } from './fixtures.test-util.ts'

const ids = (plan: PlacementPlan): string[] => plan.checks.map(c => `${c.level}:${c.id}`)
const auto = defaultProfile()
const remote = { bots: 'remote' as const }
const agent = { role: 'bots-only' as const }
const linuxTopo = async (files: Record<string, string>): Promise<CpuTopology> => await readTopology(fakeRunner('linux', { files }))
const winTopo = async (raw: object): Promise<CpuTopology> => await readTopology(fakeRunner('win32', { exec: () => psOut(raw) }))
const oneCore: CpuTopology = { platform: 'linux', virtualization: null, placementKind: 'physical', efficiencySource: 'none', cpus: [{ cpu: 0, core: 0, efficiency: 0 }, { cpu: 1, core: 0, efficiency: 0 }] }

// --- Server machine, remote bots ------------------------------------------------------------------

test('local plans record mode local', async () => {
  const plan = planPlacement(await linuxTopo(linux8c16tFiles()), auto)
  assert.equal(plan.mode, 'local')
  assert.deepEqual(plan, planPlacement(await linuxTopo(linux8c16tFiles()), auto, { bots: 'local', role: 'server' }))
})

test('remote bots, hybrid 14700F: server takes every P-core, harness the E-cores, no bot set', async () => {
  for (const topo of [await winTopo(win14700Raw()), await linuxTopo(linux14700Files())]) {
    const plan = planPlacement(topo, auto, remote)
    assert.equal(plan.mode, 'remote-bots')
    assert.equal(formatCpuList(plan.serverCpus), '0-15')
    assert.deepEqual(plan.botCpus, [])
    assert.equal(formatCpuList(plan.harnessCpus), '16-27')
    assert.deepEqual(ids(plan), ['info:bots_remote'])
    assert.ok(planUsable(plan))
  }
})

test('remote bots, single class: server takes every core but a small harness set', async () => {
  const smt = planPlacement(await linuxTopo(linux8c16tFiles()), auto, remote)
  assert.equal(formatCpuList(smt.harnessCpus), '7,15') // one whole core = HARNESS_CPUS logical CPUs
  assert.equal(smt.harnessCpus.length, HARNESS_CPUS)
  assert.equal(formatCpuList(smt.serverCpus), '0-6,8-14')
  assert.deepEqual(ids(smt), ['info:bots_remote'])

  // no SMT: the harness stops at a quarter of the cores (one), the server keeps three; no bot_cpus fail
  const four = planPlacement(await linuxTopo(linux4cFiles()), auto, remote)
  assert.deepEqual(four.serverCpus, [0, 1, 2])
  assert.deepEqual(four.harnessCpus, [3])
  assert.ok(planUsable(four), ids(four).join())

  const wsl = planPlacement(await linuxTopo(wslFiles()), auto, remote)
  assert.deepEqual(ids(wsl), ['info:bots_remote', 'info:vcpu'])
  assert.equal(formatCpuList(wsl.harnessCpus), '14-15')

  // one core: the server can still run; the harness shares it (warned), unlike a local plan
  const tiny = planPlacement(oneCore, auto, remote)
  assert.deepEqual(tiny.serverCpus, [0, 1])
  assert.deepEqual(tiny.harnessCpus, [0, 1])
  assert.deepEqual(ids(tiny), ['warn:harness_shared', 'info:bots_remote', 'warn:overlap'])
  assert.ok(planUsable(tiny))
})

test('remote bots, hybrid with a tiny fastest class falls back to the harness-core split', () => {
  // 1 prime + 3 big + 4 little cores (cpu_capacity ranking on ARM)
  const eff = [2, 1, 1, 1, 0, 0, 0, 0]
  const topo: CpuTopology = { platform: 'linux', virtualization: null, placementKind: 'physical', efficiencySource: 'cpu_capacity', cpus: eff.map((efficiency, cpu) => ({ cpu, core: cpu, efficiency })) }
  const plan = planPlacement(topo, auto, remote)
  assert.deepEqual(plan.harnessCpus, [6, 7])
  assert.deepEqual(plan.serverCpus, [0, 1, 2, 3, 4, 5])
  assert.ok(ids(plan).includes('warn:server_classes'))
})

test('remote bots, explicit profiles: botCpus ignored with a warning, one-sided auto', async () => {
  const lin = await linuxTopo(linux8c16tFiles())
  const withBots = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3', botCpus: '4-7' } }), remote)
  assert.deepEqual(withBots.botCpus, [])
  assert.ok(ids(withBots).includes('warn:bot_cpus_ignored'))
  // harness auto avoids whole cores the server touches, so no SMT sibling of a server CPU
  assert.equal(formatCpuList(withBots.harnessCpus), '4-7,12-15')
  assert.ok(!ids(withBots).includes('warn:smt_split'))

  const harness = planPlacement(lin, parseProfile({ placement: { harnessCpus: '7,15' } }), remote)
  assert.equal(formatCpuList(harness.serverCpus), '0-6,8-14')
  assert.deepEqual(ids(harness), ['info:bots_remote'])

  const all = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-15' } }), remote)
  assert.ok(ids(all).includes('fail:harness_cpus'))

  const shared = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3', harnessCpus: '3,4' } }), remote)
  assert.ok(ids(shared).includes('warn:overlap'))
})

// --- Agent machine, bots only ---------------------------------------------------------------------

test('bots-only: bot workers get every CPU (E-cores included) except a small agent set', async () => {
  const hybrid = planPlacement(await linuxTopo(linux14700Files()), auto, agent)
  assert.equal(hybrid.mode, 'bots-only')
  assert.deepEqual(hybrid.serverCpus, [])
  assert.equal(formatCpuList(hybrid.harnessCpus), '26-27')
  assert.equal(formatCpuList(hybrid.botCpus), '0-25')
  assert.deepEqual(ids(hybrid), ['info:bots_only'])
  assert.ok(planUsable(hybrid))

  const smt = planPlacement(await linuxTopo(linux8c16tFiles()), auto, agent)
  assert.equal(formatCpuList(smt.harnessCpus), '7,15')
  assert.equal(formatCpuList(smt.botCpus), '0-6,8-14')

  // docker --cpuset-cpus=0-3 on an 8c/16t host: only the allowed CPUs are planned
  const docker = planPlacement(await linuxTopo(linux8c16tFiles('0-3')), auto, agent)
  assert.deepEqual(docker.harnessCpus, [3])
  assert.deepEqual(docker.botCpus, [0, 1, 2])

  const tiny = planPlacement(oneCore, auto, agent)
  assert.deepEqual(tiny.botCpus, [0, 1])
  assert.deepEqual(tiny.harnessCpus, [0, 1])
  assert.deepEqual(ids(tiny), ['info:harness_shared', 'info:bots_only'])
  assert.ok(planUsable(tiny))
})

test('bots-only, explicit profiles: serverCpus ignored, explicit bots honoured', async () => {
  const lin = await linuxTopo(linux8c16tFiles())
  const srv = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3' } }), agent)
  assert.ok(ids(srv).includes('warn:server_cpus_ignored'))
  assert.deepEqual(srv.serverCpus, [])
  assert.equal(srv.botCpus.length, 14)

  const bots = planPlacement(lin, parseProfile({ placement: { botCpus: '0-3' } }), agent)
  assert.equal(formatCpuList(bots.harnessCpus), '4-7,12-15')
  const everything = planPlacement(lin, parseProfile({ placement: { botCpus: '0-15' } }), agent)
  assert.deepEqual(everything.harnessCpus, everything.botCpus)
  assert.ok(ids(everything).includes('info:harness_shared'))
  const harness = planPlacement(lin, parseProfile({ placement: { harnessCpus: '0' } }), agent)
  assert.equal(formatCpuList(harness.botCpus), '1-15')
  const overlap = planPlacement(lin, parseProfile({ placement: { botCpus: '0-7', harnessCpus: '7-8' } }), agent)
  assert.deepEqual(ids(overlap), ['info:bots_only', 'warn:overlap'])

  // the role wins over `bots`; wrapSpawn refuses a server role on an agent plan
  assert.equal(planPlacement(lin, auto, { role: 'bots-only', bots: 'remote' }).mode, 'bots-only')
  assert.throws(() => wrapSpawn('x', [], srv, { platform: 'linux' }), /no server CPUs/)
})

test('bot workers: applyBotWorker / verifyBotWorker use the bot set at normal priority', async () => {
  const plan = planPlacement(await linuxTopo(linux8c16tFiles()), auto, agent)
  const runner = fakeRunner('linux', {
    dirs: { '/proc/77/task': ['77', '78'] },
    files: {
      '/proc/77/status': 'Name:\tnode\nCpus_allowed_list:\t0-6,8-14\n',
      '/proc/77/stat': '77 (node) S 1 77 77 0 -1 0 0 0 0 0 0 0 0 0 20 0 2 0 1 1\n',
      '/proc/77/task/77/status': 'Cpus_allowed_list:\t0-6,8-14\n',
      '/proc/77/task/78/status': 'Cpus_allowed_list:\t0-6,8-14\n'
    }
  })
  const r = await applyBotWorker(77, plan, runner)
  assert.ok(r.ok)
  assert.deepEqual(runner.calls[0], { file: 'taskset', args: ['-a', '-p', '-c', '0-6,8-14', '77'] })
  assert.deepEqual(runner.niced.map(n => n.nice), [0, 0])
  const v = await verifyBotWorker(77, plan, { runner })
  assert.equal(v.verified, true, JSON.stringify(v.violations))
  assert.equal(v.threadCount, 2)
})

// --- Launched servers -------------------------------------------------------------------------------

test('wrapSpawn: a Linux launcher is wrapped so descendants inherit; Windows needs post-spawn applies', () => {
  const plan: PlacementPlan = { serverCpus: [0, 1, 2, 3], botCpus: [], harnessCpus: [6, 7], priority: 'above_normal', kind: 'physical', mode: 'remote-bots', checks: [] }
  const lin = wrapSpawn('lip', ['run', 'wine', 'bedrock_server_mod.exe'], plan, { platform: 'linux' })
  assert.deepEqual([lin.command, ...lin.args], ['taskset', '-c', '0-3', 'nice', '-n', '-5', 'lip', 'run', 'wine', 'bedrock_server_mod.exe'])
  assert.equal(lin.coversDescendants, true)
  const win = wrapSpawn('python.exe', ['-m', 'endstone'], plan, { platform: 'win32' })
  assert.equal(win.coversDescendants, false)
  assert.equal(win.postSpawnApplyRequired, true)
  assert.throws(() => wrapSpawn('node', [], plan, { platform: 'linux', role: 'bot' }), /no bot CPUs/)
})

const plan4 = { serverCpus: [0, 1, 2, 3], priority: 'above_normal' as const }

test('applyToServerTree (Windows): launcher, resolved game and helpers; an exited launcher is fine', async () => {
  const scripts: string[] = []
  const runner = fakeRunner('win32', {
    exec: (_f, args) => {
      const s = decodePs(args)
      scripts.push(s)
      return /GetProcessById\(10\)/.test(s) ? psOut({ affinity: 'process not found', priority: 'process not found' }) : psOut({ affinity: null, priority: null })
    }
  })
  const r = await applyToServerTree(plan4, { launcherPid: 10, serverPid: 20, auxPids: [20, 30] }, runner)
  assert.equal(r.ok, true)
  assert.deepEqual(r.results.map(x => [x.role, x.result.pid, x.result.ok, x.result.gone ?? false]), [
    ['server', 20, true, false], ['launcher', 10, false, true], ['aux', 30, true, false]
  ])
  assert.equal(scripts.length, 3) // 20 given twice, applied once
  assert.ok(scripts.every(s => /\[IntPtr\]\[long\]15/.test(s) && /AboveNormal/.test(s)))

  // right after the spawn only the launcher is known
  const early = await applyToServerTree(plan4, { launcherPid: 11 }, fakeRunner('win32', { exec: () => psOut({ affinity: null, priority: null }) }))
  assert.equal(early.ok, true)

  const serverGone = await applyToServerTree(plan4, { serverPid: 20 }, fakeRunner('win32', { exec: () => psOut({ affinity: 'process not found', priority: 'process not found' }) }))
  assert.equal(serverGone.ok, false)
  const denied = await applyToServerTree(plan4, { serverPid: 20, launcherPid: 10 }, fakeRunner('win32', {
    exec: (_f, args) => /GetProcessById\(10\)/.test(decodePs(args)) ? psOut({ affinity: 'Access is denied', priority: null }) : psOut({ affinity: null, priority: null })
  }))
  assert.equal(denied.ok, false)
  // the launcher exited between the lookup and the set: gone, not refused
  const raced = await applyToServerTree(plan4, { serverPid: 20, launcherPid: 10 }, fakeRunner('win32', {
    exec: (_f, args) => /GetProcessById\(10\)/.test(decodePs(args)) ? psOut({ affinity: 'the process has exited', priority: 'x', gone: true }) : psOut({ affinity: null, priority: null })
  }))
  assert.equal(raced.ok, true)
  assert.match(scripts[0]!, /HasExited/)
  // a launcher whose priority could not be raised still counts once its CPUs are set
  const prio = await applyToServerTree(plan4, { serverPid: 20, launcherPid: 10 }, fakeRunner('win32', {
    exec: (_f, args) => /GetProcessById\(10\)/.test(decodePs(args)) ? psOut({ affinity: null, priority: 'Access is denied' }) : psOut({ affinity: null, priority: null })
  }))
  assert.equal(prio.ok, true)
  await assert.rejects(applyToServerTree(plan4, {}, fakeRunner('win32')), /no pids/)
})

test('applyToServerTree (Linux): a pre-existing wineserver is placed with taskset', async () => {
  const runner = fakeRunner('linux', { dirs: { '/proc/490/task': ['490'] } })
  const r = await applyToServerTree({ ...plan4, priority: 'normal' }, { auxPids: [490] }, runner)
  assert.equal(r.ok, true)
  assert.deepEqual(runner.calls, [{ file: 'taskset', args: ['-a', '-p', '-c', '0-3', '490'] }])
  const gone = await applyToServerTree(plan4, { serverPid: 500, auxPids: [491] }, fakeRunner('linux', {
    dirs: { '/proc/500/task': ['500'] },
    exec: (_f, args) => args.at(-1) === '491' ? { code: 1, stdout: '', stderr: "taskset: failed to get pid 491's affinity: No such process" } : { code: 0, stdout: '', stderr: '' },
    setPriority: id => { if (id === 491) throw Object.assign(new Error('ESRCH'), { code: 'ERR_SYSTEM_ERROR', info: { code: 'ESRCH' } }) }
  }))
  assert.equal(gone.results[1]!.result.gone, true)
  assert.equal(gone.ok, true)
})

// Wine on Linux: `taskset -c 0-3 nice -n -5 wine bedrock_server_mod.exe`. The game is a Linux
// process named after the .exe with its threads under /proc/<pid>/task; wineserver was forked by
// wine and inherited the mask; the wine launcher (pid 480) has already exited.
const STAT = (pid: number, comm: string, nice: number): string => `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 ${nice} 9 0 1 1\n`
const STATUS = (name: string, list: string): string => `Name:\t${name}\nCpus_allowed:\tf\nCpus_allowed_list:\t${list}\n`
function wineProc (over: Record<string, string> = {}): { files: Record<string, string>, dirs: Record<string, string[]> } {
  const files: Record<string, string> = {
    '/proc/500/status': STATUS('bedrock_server_', '0-3'),
    '/proc/500/stat': STAT(500, 'bedrock_server_', -5),
    '/proc/490/status': STATUS('wineserver', '0-3'),
    '/proc/490/stat': STAT(490, 'wineserver', -5),
    '/proc/490/task/490/status': STATUS('wineserver', '0-3')
  }
  for (const tid of [500, 501, 502, 503, 504]) files[`/proc/500/task/${tid}/status`] = STATUS('bedrock_server_', tid === 503 ? '2' : '0-3')
  return { files: { ...files, ...over }, dirs: { '/proc/500/task': ['500', '501', '502', '503', '504'], '/proc/490/task': ['490'] } }
}

test('verifyServerProcesses: game under Wine on Linux with per-thread affinity, wineserver and an exited launcher', async () => {
  const procs = { serverPid: 500, launcherPid: 480, auxPids: [490] }
  const good = await verifyServerProcesses(plan4, procs, { runner: fakeRunner('linux', wineProc()) })
  assert.equal(good.verified, true, JSON.stringify(good.checks))
  assert.equal(good.server.threadCount, 5)
  assert.deepEqual(good.server.narrowed, [{ tid: 503, cpus: [2] }])
  assert.deepEqual(good.members.map(m => m.role), ['server', 'launcher', 'aux'])
  assert.deepEqual(good.checks.map(c => `${c.level}:${c.id}`), ['ok:server', 'info:launcher_gone', 'ok:aux_placement'])

  // a game thread set its own mask outside the plan (Wine maps SetThreadAffinityMask to sched_setaffinity)
  const thread = await verifyServerProcesses(plan4, procs, { runner: fakeRunner('linux', wineProc({ '/proc/500/task/502/status': STATUS('bedrock_server_', '0-7') })) })
  assert.equal(thread.verified, false)
  assert.deepEqual(thread.server.violations.map(v => [v.kind, v.tid]), [['thread_outside', 502]])

  // a wineserver that was already running outside the wrapper; its priority is not judged
  const aux = await verifyServerProcesses(plan4, procs, {
    runner: fakeRunner('linux', wineProc({ '/proc/490/status': STATUS('wineserver', '0-15'), '/proc/490/task/490/status': STATUS('wineserver', '0-15'), '/proc/490/stat': STAT(490, 'wineserver', 0) }))
  })
  assert.equal(aux.verified, false)
  assert.equal(aux.server.verified, true)
  assert.deepEqual(aux.checks.map(c => `${c.level}:${c.id}`), ['ok:server', 'info:launcher_gone', 'fail:aux_placement'])
  assert.ok(!aux.members[2]!.verification.violations.some(v => v.kind === 'priority'))

  // Wine narrows helper services to one CPU of the plan: still inside, so it passes (as info)
  const narrowAux = await verifyServerProcesses(plan4, procs, {
    runner: fakeRunner('linux', wineProc({ '/proc/490/status': STATUS('wineserver', '2'), '/proc/490/task/490/status': STATUS('wineserver', '2') }))
  })
  assert.equal(narrowAux.verified, true, JSON.stringify(narrowAux.checks))
  assert.ok(narrowAux.members[2]!.verification.checks.some(c => c.id === 'process_affinity' && c.level === 'info'))
  // ... but the game process itself must have exactly the planned CPUs
  const narrowGame = await verifyServerProcesses(plan4, procs, { runner: fakeRunner('linux', wineProc({ '/proc/500/status': STATUS('bedrock_server_', '2') })) })
  assert.equal(narrowGame.server.verified, false)
  assert.deepEqual(narrowGame.server.violations.map(v => v.kind), ['process_affinity'])

  // `nice -n -5` without CAP_SYS_NICE leaves the game at nice 0
  const nice = await verifyServerProcesses(plan4, { serverPid: 500 }, { runner: fakeRunner('linux', wineProc({ '/proc/500/stat': STAT(500, 'bedrock_server_', 0) })) })
  assert.deepEqual(nice.server.violations.map(v => v.kind), ['priority'])
  const gone = await verifyServerProcesses(plan4, { serverPid: 999 }, { runner: fakeRunner('linux') })
  assert.equal(gone.verified, false)
  assert.deepEqual(gone.checks.map(c => `${c.level}:${c.id}`), ['fail:server'])
})

test('verifyServerProcesses: Endstone on Windows (python launcher, bedrock_server.exe child)', async () => {
  const byPid: Record<number, object> = {
    // python.exe: placed right after the spawn, normal priority class
    40: { mask: '15', priority: 'Normal', threads: [[41, 0, '15']] },
    // bedrock_server.exe: placed once resolved; one thread narrowed by the game
    50: { mask: '15', priority: 'AboveNormal', threads: [[51, 0, '15'], [52, 0, '4'], [53, 0, '15']] }
  }
  const runner = (over: Record<number, object> = {}): ReturnType<typeof fakeRunner> => fakeRunner('win32', {
    exec: (_f, args) => {
      const pid = Number(/Threads\((\d+)\)/.exec(decodePs(args))![1])
      return psOut({ ...byPid, ...over }[pid] ?? { gone: true })
    }
  })
  const ok = await verifyServerProcesses(plan4, { serverPid: 50, launcherPid: 40 }, { runner: runner() })
  assert.equal(ok.verified, true, JSON.stringify(ok.checks))
  assert.deepEqual(ok.server.narrowed, [{ tid: 52, cpus: [2] }])

  // the child was created before the launcher was placed and never got the post-spawn apply
  const missed = await verifyServerProcesses(plan4, { serverPid: 50, launcherPid: 40 }, {
    runner: runner({ 50: { mask: String((1n << 28n) - 1n), priority: 'Normal', threads: [[51, 0, String((1n << 28n) - 1n)]] } })
  })
  assert.equal(missed.verified, false)
  assert.deepEqual(missed.server.violations.map(v => v.kind), ['process_affinity', 'thread_outside', 'priority'])
  assert.equal(missed.members[1]!.verification.verified, true)
})
