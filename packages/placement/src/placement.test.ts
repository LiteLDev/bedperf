import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlacementPlan, PlacementProfile } from '@bedperf/core'
import { cpusToMask, formatCpuList, maskToCpus, parseCpuList } from './cpus.ts'
import { canonicalJson, defaultProfile, parseProfile, profileSha256 } from './profile.ts'
import { capacityClasses, coresOf, parseCpuSetBuffer, buildCpuSetBuffer, readTopology, windowsTopologyFromRaw, type CpuTopology, type WindowsTopologyRaw } from './topology.ts'
import { planPlacement, planUsable } from './plan.ts'
import { applyToPid, windowsApplyScript, wrapSpawn } from './apply.ts'
import { judgePlacement, niceFromStat, observedFromWindows, verifyPlacement } from './verify.ts'
import {
  decodePs, fakeRunner, linux14700Files, linux4cFiles, linux8c16tFiles, psOut, win14700Raw, win8c16tRaw, wslFiles
} from './fixtures.test-util.ts'

const ids = (plan: PlacementPlan): string[] => plan.checks.map(c => `${c.level}:${c.id}`)
const auto = defaultProfile()
const linuxTopo = async (files: Record<string, string>): Promise<CpuTopology> => await readTopology(fakeRunner('linux', { files }))
const winTopo = async (raw: object): Promise<CpuTopology> => await readTopology(fakeRunner('win32', { exec: () => psOut(raw) }))

// --- CPU lists --------------------------------------------------------------------------------

test('cpu list parse / format round-trip', () => {
  assert.deepEqual(parseCpuList('0-3,8, 10-11\n'), [0, 1, 2, 3, 8, 10, 11])
  assert.deepEqual(parseCpuList(''), [])
  assert.equal(formatCpuList([11, 0, 1, 2, 3, 8, 10, 3]), '0-3,8,10-11')
  assert.throws(() => parseCpuList('3-1'))
  assert.throws(() => parseCpuList('a'))
})

test('affinity masks cover all 64 bits of group 0', () => {
  assert.equal(cpusToMask([0, 63]), (1n << 63n) + 1n)
  assert.deepEqual(maskToCpus('9223372036854775809'), [0, 63])
  assert.deepEqual(maskToCpus(-1n).length, 64)
  assert.deepEqual(maskToCpus('5', 64), [64, 66])
  assert.throws(() => cpusToMask([64]), /processor group/)
})

// --- Profiles ---------------------------------------------------------------------------------

test('parseProfile fills defaults and validates', () => {
  assert.deepEqual(parseProfile({}), auto)
  const p = parseProfile({ label: 'x', placement: { serverCpus: '0-7', botCpus: [8, 9, 10, 11], priority: 'above_normal' }, gates: { tps: 19.5 } })
  assert.equal(p.placement.harnessCpus, 'bot')
  assert.equal(p.placement.priority, 'above_normal')
  assert.throws(() => parseProfile({ placement: { priority: 'high' } }), /priority/)
  assert.throws(() => parseProfile({ placement: { serverCpus: '0-x' } }), /CPU list/)
  assert.throws(() => parseProfile({ placement: { botCpus: [-1] } }), /invalid CPU/)
  assert.throws(() => parseProfile({ placement: { serverCpus: 'bot' } }), /CPU list/)
  assert.throws(() => parseProfile({ gates: { tps: 'x' } }), /gates.tps/)
  assert.throws(() => parseProfile({ extra: 1 }), /unknown key/)
  assert.throws(() => parseProfile({ placement: { botCpus: ' , ' } }), /empty/)
})

test('profileSha256 ignores the label and key order, and changes with any setting', () => {
  const a: PlacementProfile = { label: 'a', placement: { serverCpus: 'auto', botCpus: 'auto', harnessCpus: 'bot', priority: 'normal' }, gates: { b: 1, a: 2 } }
  const b: PlacementProfile = { placement: { priority: 'normal', harnessCpus: 'bot', botCpus: 'auto', serverCpus: 'auto' }, gates: { a: 2, b: 1 }, label: 'other' }
  assert.equal(profileSha256(a), profileSha256(b))
  assert.match(profileSha256(a), /^[0-9a-f]{64}$/)
  assert.notEqual(profileSha256(a), profileSha256({ ...a, placement: { ...a.placement, priority: 'above_normal' } }))
  assert.notEqual(profileSha256(a), profileSha256({ ...a, gates: { a: 2, b: 1.5 } }))
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 'x' }], a: null }), '{"a":null,"b":[1,{"c":"x","d":1}]}')
  const spec = (botCpus: string | number[]): string => profileSha256({ ...auto, placement: { ...auto.placement, botCpus } })
  assert.equal(spec('0-3'), spec([3, 2, 1, 0]))
  assert.equal(spec('0-3'), spec('0,1,2,3'))
  assert.notEqual(spec('0-3'), spec('0-4'))
  // absent gates hash like empty gates
  assert.equal(profileSha256(auto), profileSha256({ ...auto, gates: {} }))
})

// --- Topology ---------------------------------------------------------------------------------

test('CPU set buffer: unpacks the documented SYSTEM_CPU_SET_INFORMATION layout', () => {
  const buf = buildCpuSetBuffer([{ group: 1, logical: 5, core: 4, llc: 2, numa: 1, efficiency: 1, id: 300 }])
  assert.deepEqual(parseCpuSetBuffer(buf), [{ id: 300, group: 1, logical: 5, core: 4, llc: 2, numa: 1, efficiency: 1 }])
})

test('Windows topology: 14700F hybrid via PowerShell runner', async () => {
  let script = ''
  const runner = fakeRunner('win32', { exec: (file, args) => { assert.equal(file, 'powershell.exe'); script = decodePs(args); return psOut(win14700Raw()) } })
  const topo = await readTopology(runner)
  assert.match(script, /GetSystemCpuSetInformation/)
  assert.match(script, /GetProcessById\(1000\)/)
  assert.equal(topo.cpus.length, 28)
  assert.equal(coresOf(topo).length, 20)
  assert.deepEqual([...new Set(topo.cpus.map(c => c.efficiency))].sort(), [0, 1])
  assert.equal(topo.placementKind, 'physical')
  assert.equal(topo.efficiencySource, 'cpu-sets')
  const c1 = topo.cpus.find(c => c.cpu === 1)!
  assert.equal(c1.core, topo.cpus.find(c => c.cpu === 0)!.core, 'SMT siblings share a core')
})

test('Windows topology: intersects with the harness mask, detects VMs, falls back without CPU sets', async () => {
  const raw = { ...win8c16tRaw(), allowedMask: String(0xffn) } as WindowsTopologyRaw
  const t = windowsTopologyFromRaw(raw)
  assert.deepEqual(t.cpus.map(c => c.cpu), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(coresOf(t).length, 4)
  const vm = windowsTopologyFromRaw({ ...raw, manufacturer: 'Microsoft Corporation', product: 'Virtual Machine' })
  assert.equal(vm.virtualization, 'hyper-v')
  assert.equal(vm.placementKind, 'vcpu')
  assert.equal(windowsTopologyFromRaw({ ...raw, manufacturer: 'VMware, Inc.' }).virtualization, 'vmware')
  const bare = windowsTopologyFromRaw({ cpuSets: '', allowedMask: '15' })
  assert.deepEqual(bare.cpus.map(c => [c.cpu, c.core]), [[0, 0], [1, 1], [2, 2], [3, 3]])
  assert.equal(bare.efficiencySource, 'none')
})

test('Linux topology: 14700F via cpu_core/cpu_atom', async () => {
  const t = await linuxTopo(linux14700Files())
  assert.equal(t.cpus.length, 28)
  assert.equal(coresOf(t).length, 20)
  assert.equal(t.efficiencySource, 'cpu_core/cpu_atom')
  assert.equal(t.cpus.find(c => c.cpu === 3)!.efficiency, 1)
  assert.equal(t.cpus.find(c => c.cpu === 20)!.efficiency, 0)
  assert.equal(t.placementKind, 'physical')
})

test('Linux topology: cpu_capacity ranking, allowed-list intersection, WSL', async () => {
  const cap = await linuxTopo({
    ...linux4cFiles(),
    '/sys/devices/system/cpu/cpu0/cpu_capacity': '1024\n',
    '/sys/devices/system/cpu/cpu1/cpu_capacity': '1024\n',
    '/sys/devices/system/cpu/cpu2/cpu_capacity': '512\n',
    '/sys/devices/system/cpu/cpu3/cpu_capacity': '512\n'
  })
  assert.equal(cap.efficiencySource, 'cpu_capacity')
  assert.deepEqual([...capacityClasses([1024, 1009, 1024, 512, 530, 300])].sort((a, b) => a[0] - b[0]), [[300, 0], [512, 1], [530, 1], [1009, 2], [1024, 2]])
  assert.deepEqual(cap.cpus.map(c => c.efficiency), [1, 1, 0, 0])

  const restricted = await linuxTopo(linux8c16tFiles('0-3,8-11'))
  assert.deepEqual(restricted.cpus.map(c => c.cpu), [0, 1, 2, 3, 8, 9, 10, 11])
  assert.equal(coresOf(restricted).length, 4)
  assert.deepEqual(coresOf(restricted)[0]!.cpus, [0, 8])

  const wsl = await linuxTopo(wslFiles())
  assert.equal(wsl.virtualization, 'wsl2')
  assert.equal(wsl.placementKind, 'vcpu')
  const kvm = await linuxTopo({ ...linux4cFiles(), '/sys/class/dmi/id/sys_vendor': 'QEMU\n' })
  assert.equal(kvm.virtualization, 'kvm')
  const hv = await linuxTopo({ ...linux4cFiles(), '/sys/class/dmi/id/sys_vendor': 'Some OEM\n', '/proc/cpuinfo': 'flags\t: fpu hypervisor\n' })
  assert.equal(hv.virtualization, 'hypervisor')
})

// --- Planning ---------------------------------------------------------------------------------

test('auto plan, hybrid 14700F: server on P-cores, bots on E-cores (Windows and Linux agree)', async () => {
  for (const topo of [await winTopo(win14700Raw()), await linuxTopo(linux14700Files())]) {
    const plan = planPlacement(topo, auto)
    assert.equal(formatCpuList(plan.serverCpus), '0-15')
    assert.equal(formatCpuList(plan.botCpus), '16-27')
    assert.deepEqual(plan.harnessCpus, plan.botCpus)
    assert.equal(plan.kind, 'physical')
    assert.ok(planUsable(plan), ids(plan).join())
    assert.equal(plan.profileSha256, profileSha256(auto))
  }
})

test('auto plan, plain 8c/16t: bots take the two highest whole cores', async () => {
  const lin = planPlacement(await linuxTopo(linux8c16tFiles()), auto)
  assert.equal(formatCpuList(lin.botCpus), '6-7,14-15')
  assert.equal(formatCpuList(lin.serverCpus), '0-5,8-13')
  assert.deepEqual(ids(lin), [])
  const win = planPlacement(await winTopo(win8c16tRaw()), auto)
  assert.equal(formatCpuList(win.botCpus), '12-15')
  assert.equal(formatCpuList(win.serverCpus), '0-11')
  assert.ok(planUsable(win))
})

test('auto plan, 4 cores without SMT: bots get 2 CPUs and the plan fails', async () => {
  const plan = planPlacement(await linuxTopo(linux4cFiles()), auto)
  assert.deepEqual(plan.botCpus, [2, 3])
  assert.deepEqual(plan.serverCpus, [0, 1])
  assert.deepEqual(ids(plan), ['fail:bot_cpus'])
  assert.equal(planUsable(plan), false)
})

test('auto plan, WSL: vcpu kind with an info check', async () => {
  const plan = planPlacement(await linuxTopo(wslFiles()), auto)
  assert.equal(plan.kind, 'vcpu')
  assert.equal(formatCpuList(plan.botCpus), '12-15')
  assert.deepEqual(ids(plan), ['info:vcpu'])
})

test('hybrid with too few slow CPUs falls back to the core split', () => {
  const topo: CpuTopology = {
    platform: 'linux',
    virtualization: null,
    placementKind: 'physical',
    efficiencySource: 'cpu_capacity',
    cpus: [0, 1, 2, 3, 4, 5, 6, 7].map(cpu => ({ cpu, core: cpu, efficiency: cpu < 6 ? 1 : 0 }))
  }
  const plan = planPlacement(topo, auto)
  // order: E 7, E 6, then P 5, P 4; half = 4 cores
  assert.deepEqual(plan.botCpus, [4, 5, 6, 7])
  assert.ok(planUsable(plan))
})

test('explicit sets: smt_split and server_classes warnings, one-sided auto, harness override', async () => {
  const lin = await linuxTopo(linux8c16tFiles())
  const split = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3', botCpus: '8-15' } }))
  assert.deepEqual(ids(split), ['warn:smt_split'])
  assert.match(split.checks[0]!.summary, /8-11/)

  const hybrid = await linuxTopo(linux14700Files())
  const mixed = planPlacement(hybrid, parseProfile({ placement: { serverCpus: '14-17', botCpus: '20-27' } }))
  assert.deepEqual(ids(mixed), ['warn:server_classes'])

  const oneSided = planPlacement(lin, parseProfile({ placement: { serverCpus: [0, 8, 1, 9] } }))
  assert.equal(formatCpuList(oneSided.botCpus), '2-7,10-15')
  const botsOnly = planPlacement(lin, parseProfile({ placement: { botCpus: '7,15' } }))
  assert.equal(formatCpuList(botsOnly.serverCpus), '0-6,8-14')
  assert.ok(ids(botsOnly).includes('fail:bot_cpus'))

  // an explicit harness set is reserved before the auto split
  const harness = planPlacement(lin, parseProfile({ placement: { harnessCpus: '0,8' } }))
  assert.deepEqual(harness.harnessCpus, [0, 8])
  assert.ok(!harness.serverCpus.includes(0) && !harness.botCpus.includes(0))
  assert.deepEqual(ids(harness), [])
  const overlap = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3', botCpus: '4-7', harnessCpus: '3' } }))
  assert.ok(ids(overlap).includes('warn:overlap'))

  const unknown = planPlacement(lin, parseProfile({ placement: { serverCpus: '0-3', botCpus: '40-43' } }))
  assert.ok(ids(unknown).includes('fail:unknown_cpus'))
})

test('processor_group fails on Windows only', () => {
  const cpus = Array.from({ length: 72 }, (_, cpu) => ({ cpu, core: cpu, efficiency: 0 }))
  const base = { virtualization: null, placementKind: 'physical' as const, efficiencySource: 'none' as const, cpus }
  const profile = parseProfile({ placement: { serverCpus: '0-63', botCpus: '64-71' } })
  assert.ok(ids(planPlacement({ ...base, platform: 'win32' }, profile)).includes('fail:processor_group'))
  assert.ok(!ids(planPlacement({ ...base, platform: 'linux' }, profile)).includes('fail:processor_group'))
})

test('single core cannot be auto-split', () => {
  const topo: CpuTopology = { platform: 'linux', virtualization: null, placementKind: 'physical', efficiencySource: 'none', cpus: [{ cpu: 0, core: 0, efficiency: 0 }, { cpu: 1, core: 0, efficiency: 0 }] }
  const plan = planPlacement(topo, auto)
  assert.deepEqual(plan.serverCpus, [0, 1])
  assert.ok(ids(plan).includes('fail:too_few_cores'))
})

// --- Apply ------------------------------------------------------------------------------------

test('Windows apply: signed mask and priority class through PowerShell', async () => {
  assert.match(windowsApplyScript(42, [0, 63], 'above_normal'), /\[IntPtr\]\[long\]-9223372036854775807/)
  let script = ''
  const runner = fakeRunner('win32', { exec: (_f, args) => { script = decodePs(args); return psOut({ affinity: null, priority: null }) } })
  const ok = await applyToPid(42, [3, 2], 'above_normal', runner)
  assert.deepEqual(ok, { ok: true, pid: 42, cpus: [2, 3], priority: 'above_normal', method: 'post-spawn' })
  assert.match(script, /GetProcessById\(42\)/)
  assert.match(script, /\[IntPtr\]\[long\]12/)
  assert.match(script, /ProcessPriorityClass\]::AboveNormal/)

  const denied = await applyToPid(42, [0], 'normal', fakeRunner('win32', { exec: () => psOut({ affinity: 'Access is denied', priority: null }) }))
  assert.equal(denied.ok, false)
  assert.equal(denied.affinityError, 'Access is denied')
  const broken = await applyToPid(42, [0], 'normal', fakeRunner('win32', { exec: () => ({ code: 1, stdout: '', stderr: 'boom' }) }))
  assert.equal(broken.ok, false)
  assert.match(broken.affinityError!, /boom/)
  await assert.rejects(applyToPid(42, [64], 'normal', fakeRunner('win32')), /processor group/)
})

test('Linux apply: taskset -a -p -c and per-thread nice, reporting CAP_SYS_NICE failures', async () => {
  const runner = fakeRunner('linux', {
    dirs: { '/proc/42/task': ['42', '43', '44'] },
    setPriority: (id, nice) => { if (nice < 0 && id !== 44) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  })
  const r = await applyToPid(42, [1, 0, 2, 9], 'above_normal', runner)
  assert.deepEqual(runner.calls, [{ file: 'taskset', args: ['-a', '-p', '-c', '0-2,9', '42'] }])
  assert.equal(r.ok, false)
  assert.equal(r.affinityError, undefined)
  assert.match(r.priorityError!, /2\/3 threads.*CAP_SYS_NICE/)

  const fine = fakeRunner('linux', { dirs: { '/proc/42/task': ['42', '43'] } })
  assert.equal((await applyToPid(42, [0], 'normal', fine)).ok, true)
  assert.deepEqual(fine.niced, [{ id: 42, nice: 0 }, { id: 43, nice: 0 }])

  // os.setPriority reports errno names in info.code; exited threads are skipped
  const racy = fakeRunner('linux', {
    dirs: { '/proc/42/task': ['42', '43'] },
    setPriority: id => { if (id === 43) throw Object.assign(new Error('uv_os_setpriority returned ESRCH'), { code: 'ERR_SYSTEM_ERROR', info: { code: 'ESRCH' } }) }
  })
  assert.equal((await applyToPid(42, [0], 'above_normal', racy)).ok, true)
  const gone = fakeRunner('linux', { setPriority: () => { throw Object.assign(new Error('ESRCH'), { code: 'ERR_SYSTEM_ERROR', info: { code: 'ESRCH' } }) } })
  assert.match((await applyToPid(42, [0], 'normal', gone)).priorityError!, /not found/)

  const noTaskset = await applyToPid(42, [0], 'normal', fakeRunner('linux', { exec: () => ({ code: 1, stdout: '', stderr: 'taskset: failed to set pid 42 affinity' }) }))
  assert.match(noTaskset.affinityError!, /failed to set/)
})

test('wrapSpawn: taskset/nice pre-exec on Linux, post-spawn on Windows', () => {
  const plan: PlacementPlan = { serverCpus: [0, 1, 2, 3], botCpus: [4, 5, 6, 7], harnessCpus: [4, 5, 6, 7], priority: 'above_normal', kind: 'physical', checks: [] }
  const lin = wrapSpawn('./bedrock_server', ['--x'], plan, { platform: 'linux' })
  assert.deepEqual([lin.command, ...lin.args], ['taskset', '-c', '0-3', 'nice', '-n', '-5', './bedrock_server', '--x'])
  assert.equal(lin.method, 'preexec')
  assert.equal(lin.postSpawnApplyRequired, false)
  assert.equal(lin.priorityUnconfirmed, true)
  const bot = wrapSpawn('node', ['worker.ts'], plan, { platform: 'linux', role: 'bot' })
  assert.deepEqual([bot.command, ...bot.args], ['taskset', '-c', '4-7', 'node', 'worker.ts'])
  const win = wrapSpawn('bedrock_server.exe', [], plan, { platform: 'win32' })
  assert.deepEqual([win.command, win.args, win.method, win.postSpawnApplyRequired], ['bedrock_server.exe', [], 'post-spawn', true])
})

// --- Verify -----------------------------------------------------------------------------------

const STAT = (nice: number): string => `42 (bedrock_server) d) S 1 42 42 0 -1 4194560 120 0 3 0 1500 250 0 0 20 ${nice} 37 0 9999 2147483648\n`
const STATUS = (list: string): string => `Name:\tbedrock_server\nCpus_allowed:\tf\nCpus_allowed_list:\t${list}\n`

test('niceFromStat handles comm with spaces and parentheses', () => {
  assert.equal(niceFromStat(STAT(-5)), -5)
  assert.equal(niceFromStat(STAT(0)), 0)
})

test('Linux verify: outside threads violate, narrowed threads are recorded, priority compared', async () => {
  const plan = { serverCpus: [0, 1, 2, 3], priority: 'above_normal' as const }
  const files = {
    '/proc/42/status': STATUS('0-3'),
    '/proc/42/stat': STAT(-5),
    '/proc/42/task/42/status': STATUS('0-3'),
    '/proc/42/task/43/status': STATUS('2'),
    '/proc/42/task/44/status': STATUS('0-3')
  }
  const good = await verifyPlacement(42, plan, { runner: fakeRunner('linux', { files, dirs: { '/proc/42/task': ['42', '43', '44', '45'] } }) })
  assert.equal(good.verified, true, JSON.stringify(good.violations))
  assert.deepEqual(good.narrowed, [{ tid: 43, cpus: [2] }])
  assert.equal(good.threadCount, 3) // 45 exited between listing and reading
  assert.equal(good.priority, 'above_normal')

  const bad = await verifyPlacement(42, plan, {
    runner: fakeRunner('linux', {
      files: { ...files, '/proc/42/stat': STAT(0), '/proc/42/task/44/status': STATUS('0-7') },
      dirs: { '/proc/42/task': ['42', '43', '44'] }
    })
  })
  assert.equal(bad.verified, false)
  assert.deepEqual(bad.violations.map(v => v.kind), ['thread_outside', 'priority'])
  assert.equal(bad.violations[0]!.tid, 44)

  const skipPrio = await verifyPlacement(42, plan, { priority: null, runner: fakeRunner('linux', { files: { ...files, '/proc/42/stat': STAT(0) }, dirs: { '/proc/42/task': ['42'] } }) })
  assert.equal(skipPrio.verified, true)

  const gone = await verifyPlacement(42, plan, { runner: fakeRunner('linux') })
  assert.equal(gone.verified, false)
  assert.deepEqual(gone.violations.map(v => v.kind), ['process_gone'])
})

test('Windows verify: parses masks per group and priority class names', async () => {
  const raw = { mask: '15', priority: 'AboveNormal', threads: [[10, 0, '15'], [11, 0, '1'], [12, null, null], [13, 0, String((1n << 63n) | 1n)]] }
  const obs = observedFromWindows(raw as never)
  assert.deepEqual(obs.processCpus, [0, 1, 2, 3])
  assert.equal(obs.priority, 'above_normal')
  assert.deepEqual(obs.threads[3]!.cpus, [0, 63])
  const v = judgePlacement(7, [0, 1, 2, 3], 'above_normal', obs)
  assert.equal(v.verified, false)
  assert.deepEqual(v.violations.map(x => [x.kind, x.tid]), [['thread_outside', 13]])
  assert.deepEqual(v.narrowed, [{ tid: 11, cpus: [0] }])
  assert.ok(v.checks.some(c => c.id === 'threads_unreadable'))

  let script = ''
  const runner = fakeRunner('win32', { exec: (_f, args) => { script = decodePs(args); return psOut({ mask: '3', priority: 'Normal', threads: [[1, 0, '3']] }) } })
  const ok = await verifyPlacement(99, { serverCpus: [0, 1], priority: 'normal' }, { runner })
  assert.equal(ok.verified, true)
  assert.match(script, /\[BpPlacement\]::Threads\(99\)/)
  const moved = await verifyPlacement(99, { serverCpus: [0, 1], priority: 'normal' }, { runner: fakeRunner('win32', { exec: () => psOut({ mask: '12', priority: 'High', threads: [[1, 0, '12']] }) }) })
  assert.deepEqual(moved.violations.map(x => x.kind), ['process_affinity', 'thread_outside', 'priority'])
  const gone = await verifyPlacement(99, { serverCpus: [0, 1], priority: 'normal' }, { runner: fakeRunner('win32', { exec: () => psOut({ gone: true }) }) })
  assert.deepEqual(gone.violations.map(x => x.kind), ['process_gone'])
})
