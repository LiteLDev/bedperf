// Real-server tests for modded flavors and launchers. Run only with BEDPERF_E2E=1 plus the
// variables naming an installed server (each test is skipped without its variables):
//   BEDPERF_E2E_LEVILAMINA=<instance dir with bedrock_server_mod.exe>      (Windows, direct launch)
//   BEDPERF_E2E_LEVIOPTIMIZE=<same, with LeviOptimize installed>
//   BEDPERF_E2E_ENDSTONE_BIN=<venv endstone executable>  BEDPERF_E2E_ENDSTONE_DIR=<server dir>
//   BEDPERF_E2E_WINE_DIR=<LeviLamina instance dir>  BEDPERF_E2E_WINE_BIN=<wine binary>  BEDPERF_E2E_WINE_PREFIX=<WINEPREFIX>
// server.properties must already allow bots (see REQUIRED_BOT_PROPERTIES) and use a free port.
// sysmon and testkit are imported by path: test-only helpers here, not dependencies of this package.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BdsInstance, LaunchSpec } from '@bedperf/core'
import { createPlatformBackend } from '../../sysmon/src/sampler.ts'
import { createTestBot } from '../../testkit/src/index.ts'
import { BdsProcess, createProcessHost, findServerProcess, namePatternRe, processTree, type ProcInfo } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const env = process.env
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function instanceFor (dir: string): BdsInstance {
  const props = readFileSync(join(dir, 'server.properties'), 'utf8')
  const port = Number(/^server-port=(\d+)/m.exec(props)?.[1] ?? 19132)
  return { dir, version: '1.26.60.6', platform: process.platform === 'win32' ? 'win' : 'linux', port, portV6: port + 1, levelName: 'Bedrock level' }
}

async function exercise (name: string, inst: BdsInstance, launch: LaunchSpec, expectLauncher: boolean): Promise<void> {
  const host = createProcessHost()
  const bds = new BdsProcess(inst, { launch, logFile: join(inst.dir, `bedperf-e2e-${name}.log`) })
  const warnings: string[] = []
  bds.on('warning', w => { warnings.push(w) })
  let tree: ProcInfo[] = []
  let serverPid: number | undefined
  let launcherPid: number | undefined
  try {
    await bds.start({ readyTimeoutMs: 240_000 })
    serverPid = bds.serverPid
    launcherPid = bds.launcherPid
    assert.ok(serverPid !== undefined && launcherPid !== undefined)
    assert.equal(bds.pid, serverPid)
    const procs = await host.list()
    const game = findServerProcess(procs, launcherPid, namePatternRe(launch.serverProcess.namePattern))
    assert.equal(game?.pid, serverPid)
    tree = processTree(procs, launcherPid)
    if (expectLauncher) assert.notEqual(serverPid, launcherPid)
    console.log(`${name}: launcher ${launcherPid}, game ${serverPid} (${game!.name}${game!.argv0 ? ` / ${game!.argv0}` : ''}), tree ${tree.map(p => `${p.pid}:${p.name}`).join(' ')}`)

    const a = await bds.queryGametime({ priority: true })
    await sleep(2000)
    const b = await bds.queryGametime()
    assert.ok(b.gametime > a.gametime, `gametime ${a.gametime} -> ${b.gametime}`)
    console.log(`${name}: gametime ${a.gametime} -> ${b.gametime} (${((b.gametime - a.gametime) / ((b.recvAt - a.recvAt) / 1000)).toFixed(2)} TPS)`)
    const lines = await bds.command('list', /players online/)
    assert.match(lines.at(-1)!, /There are 0\/\d+ players online/)

    // A bot joins: join/leave events and the names line of `list` in the loader's log format.
    const joined = new Promise<string>(resolve => bds.once('playerJoin', p => resolve(p.name)))
    const bot = await createTestBot({ port: inst.port, username: 'u3bot' })
    assert.equal(await joined, 'u3bot')
    assert.deepEqual((await bds.listPlayers()).names, ['u3bot'])
    const left = new Promise<string>(resolve => bds.once('playerLeave', p => resolve(p.name)))
    bot.end()
    assert.equal(await left, 'u3bot')

    const backend = createPlatformBackend({ pid: serverPid, net: false })
    try {
      await backend.read()
      const r = await backend.read()
      assert.equal(r.kind, 'reading')
      const names = r.kind === 'reading' ? [...new Set((r.raw.threads ?? []).map(t => t.name ?? ''))] : []
      console.log(`${name}: ${r.kind === 'reading' ? r.raw.threads?.length : 0} threads; MC_SERVER ${names.includes('MC_SERVER') ? 'found' : 'MISSING'}; names: ${names.filter(Boolean).slice(0, 40).join(', ')}`)
      assert.ok(names.includes('MC_SERVER'), 'tick thread MC_SERVER visible')
    } finally {
      await backend.close()
    }
    console.log(`${name}: aux ${JSON.stringify(await bds.auxPids())}`)
  } finally {
    const exit = new Promise<{ expected: boolean }>(resolve => bds.once('exit', resolve))
    const t0 = Date.now()
    await bds.stop(60_000)
    if (serverPid !== undefined) console.log(`${name}: stopped in ${Date.now() - t0} ms, exit expected=${(await exit).expected}`)
  }
  assert.deepEqual(warnings, [])
  // Nothing of the tree survives (pids are compared with creation times to ignore reuse).
  await sleep(1000)
  const after = await host.list()
  const left = tree.filter(p => after.some(q => q.pid === p.pid && q.start === p.start))
  assert.deepEqual(left, [], `orphans: ${JSON.stringify(left)}`)
  assert.deepEqual(await bds.auxPids(), [])
}

const SKIP = 'set BEDPERF_E2E=1 and the flavor variables'

for (const [name, key] of [['levilamina', 'BEDPERF_E2E_LEVILAMINA'], ['levilamina-levioptimize', 'BEDPERF_E2E_LEVIOPTIMIZE']] as const) {
  const dir = env[key]
  test(`${name}: direct launch of bedrock_server_mod.exe`, { skip: !e2e || dir === undefined ? SKIP : false, timeout: 600_000 }, async () => {
    const launch: LaunchSpec = {
      command: join(dir!, 'bedrock_server_mod.exe'),
      args: [],
      cwd: dir!,
      serverProcess: { namePattern: '^bedrock_server_mod\\.exe$' },
      killTree: true
    }
    await exercise(name, instanceFor(dir!), launch, false)
  })
}

test('endstone: python launcher, game process found among descendants', {
  skip: !e2e || env.BEDPERF_E2E_ENDSTONE_BIN === undefined || env.BEDPERF_E2E_ENDSTONE_DIR === undefined ? SKIP : false,
  timeout: 600_000
}, async () => {
  const dir = env.BEDPERF_E2E_ENDSTONE_DIR!
  const launch: LaunchSpec = {
    command: env.BEDPERF_E2E_ENDSTONE_BIN!,
    args: ['-y', '-s', dir, '--no-interactive'],
    cwd: dir,
    serverProcess: { namePattern: '^bedrock_server(\\.exe)?$' },
    killTree: true
  }
  await exercise('endstone', instanceFor(dir), launch, true)
})

test('levilamina on wine', {
  skip: !e2e || env.BEDPERF_E2E_WINE_DIR === undefined || env.BEDPERF_E2E_WINE_BIN === undefined || env.BEDPERF_E2E_WINE_PREFIX === undefined ? SKIP : false,
  timeout: 900_000
}, async () => {
  const dir = env.BEDPERF_E2E_WINE_DIR!
  const prefix = env.BEDPERF_E2E_WINE_PREFIX!
  const wineBin = env.BEDPERF_E2E_WINE_BIN!
  const launch: LaunchSpec = {
    command: wineBin,
    args: ['bedrock_server_mod.exe'],
    cwd: dir,
    env: { WINEPREFIX: prefix, WINEDEBUG: '-all' },
    serverProcess: { namePattern: '^bedrock_server_mod\\.exe$' },
    auxProcessPatterns: ['^wineserver$', '^(services|winedevice|plugplay|explorer|rpcss|svchost|conhost|start)\\.exe$'],
    killTree: true,
    wine: { prefix, wineBin }
  }
  await exercise('levilamina-wine', instanceFor(dir), launch, false)
})
