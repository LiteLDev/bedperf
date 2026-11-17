import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  argv0Name, baseName, findAuxProcesses, findServerProcess, linuxEnvVar, linuxProcState, listLinuxProcesses, namePatternRe, parseStat,
  parseWindowsList, processTree, type ProcessHost, type ProcInfo
} from './proctree.ts'

const p = (pid: number, ppid: number, name: string, start = 0, extra: Partial<ProcInfo> = {}): ProcInfo => ({ pid, ppid, name, start, ...extra })

test('processTree: breadth first from the root, pid-reuse guard on creation time', () => {
  const procs = [
    p(1, 0, 'init', 1),
    p(100, 1, 'endstone.exe', 1000),
    p(101, 100, 'python.exe', 1001),
    p(102, 101, 'python.exe', 1002),
    p(103, 102, 'bedrock_server.exe', 1003),
    p(104, 100, 'conhost.exe', 1001),
    // Older than its "parent": its real parent died and pid 100 was reused.
    p(105, 100, 'stale.exe', 500)
  ]
  assert.deepEqual(processTree(procs, 100).map(x => x.pid), [100, 101, 104, 102, 103])
  assert.equal(findServerProcess(procs, 100, namePatternRe('^bedrock_server(\\.exe)?$'))?.pid, 103)
  assert.equal(findServerProcess(procs, 100, namePatternRe('^stale\\.exe$')), undefined)
  // The root itself may be the game process (wine execs into it).
  assert.equal(findServerProcess(procs, 103, namePatternRe('^BEDROCK_SERVER\\.EXE$'))?.pid, 103)
  // Unknown root: nothing.
  assert.deepEqual(processTree(procs, 999), [])
})

test('findServerProcess: Linux comm is truncated, argv0 carries the Windows image name', () => {
  const procs = [
    p(10, 1, 'wine', 5, { argv0: 'wine' }),
    p(11, 10, 'bedrock_server_', 6, { argv0: 'bedrock_server_mod.exe' })
  ]
  assert.equal(findServerProcess(procs, 10, namePatternRe('^bedrock_server_mod\\.exe$'))?.pid, 11)
})

test('parseWindowsList / parseStat / argv0Name / baseName', () => {
  assert.deepEqual(parseWindowsList('4\t0\t0\tSystem\r\n100\t4\t13400000000000\tbedrock_server.exe\r\n\r\ngarbage\n'), [
    p(4, 0, 'System', 0),
    p(100, 4, 'bedrock_server.exe', 13400000000000)
  ])
  assert.deepEqual(parseStat('4242 (bedrock_server_) S 1 4242 4242 0 -1 4194624 10 0 0 0 300 20 0 0 20 0 37 0 10000 0 0'), { comm: 'bedrock_server_', ppid: 1, startTicks: 10000 })
  assert.deepEqual(parseStat('7 (a (b) c) R 3 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 55 0 0')?.comm, 'a (b) c')
  assert.equal(parseStat('nonsense'), undefined)
  assert.equal(linuxProcState('4242 (bedrock_server_) Z 1 4242'), 'Z')
  assert.equal(linuxProcState('7 (a (b) c) R 3'), 'R')
  assert.equal(linuxProcState('x'), undefined)
  assert.equal(argv0Name('Z:\\tmp\\ll\\bedrock_server_mod.exe\0--x\0'), 'bedrock_server_mod.exe')
  assert.equal(argv0Name('/usr/bin/wineserver\0'), 'wineserver')
  assert.equal(baseName('C:\\a/b\\c.exe'), 'c.exe')
})

test('listLinuxProcesses / linuxEnvVar over a fake /proc', async () => {
  const files: Record<string, string> = {
    '/proc/10/stat': '10 (wine) S 1 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0',
    '/proc/10/cmdline': '/opt/wine/bin/wine\0bedrock_server_mod.exe\0',
    '/proc/11/stat': '11 (bedrock_server_) S 10 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 120 0 0',
    '/proc/11/cmdline': 'Z:\\srv\\bedrock_server_mod.exe\0',
    '/proc/11/environ': 'A=1\0WINEPREFIX=/srv/.lip/wine\0',
    '/proc/13/stat': '13 (wineserver) Z 1 13 13 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 90 0 0' // zombie: skipped
  }
  const opts = {
    readdir: async () => ['10', '11', '12', '13', 'self', 'cpuinfo'],
    readFile: async (path: string) => { const v = files[path]; if (v === undefined) throw new Error('ENOENT'); return v },
    statUid: async () => 1000
  }
  const procs = await listLinuxProcesses(opts)
  assert.deepEqual(procs, [
    { pid: 10, ppid: 1, name: 'wine', start: 1000, argv0: 'wine', uid: 1000 },
    { pid: 11, ppid: 10, name: 'bedrock_server_', start: 1200, argv0: 'bedrock_server_mod.exe', uid: 1000 }
  ])
  assert.equal(await linuxEnvVar(11, 'WINEPREFIX', opts), '/srv/.lip/wine')
  assert.equal(await linuxEnvVar(11, 'NOPE', opts), undefined)
  assert.equal(await linuxEnvVar(10, 'WINEPREFIX', opts), undefined)
})

test('findAuxProcesses: by name, uid and WINEPREFIX, excluding launcher/game', async () => {
  const env: Record<number, string | undefined> = { 20: '/srv/a/wine', 21: '/srv/b/wine', 22: undefined, 23: '/srv/a/wine/' }
  const host = { envVar: async (pid: number) => env[pid] } as unknown as ProcessHost
  const procs = [
    p(20, 1, 'wineserver', 0, { uid: 1000 }),
    p(21, 1, 'wineserver', 0, { uid: 1000 }), // other prefix
    p(22, 1, 'services.exe', 0, { uid: 1000 }), // environ unreadable: kept
    p(23, 1, 'winedevice.exe', 0, { uid: 1000 }),
    p(24, 1, 'wineserver', 0, { uid: 0 }), // other user
    p(25, 1, 'bash', 0, { uid: 1000 }),
    p(26, 1, 'wineserver', 0, { uid: 1000 })
  ]
  const patterns = ['^wineserver$', '^(services|winedevice|plugplay|explorer|rpcss)\\.exe$'].map(namePatternRe)
  assert.deepEqual(await findAuxProcesses(host, procs, { patterns, uid: 1000, winePrefix: '/srv/a/wine', exclude: new Set([26]) }), [20, 22, 23])
  assert.deepEqual(await findAuxProcesses(host, procs, { patterns: [] }), [])
  assert.deepEqual(await findAuxProcesses(host, procs, { patterns: [namePatternRe('^wineserver$')] }), [20, 21, 24, 26])
})
