import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NEUTRAL_LOADER_CONFIG, SERVER_PRESETS, SERVER_PRESET_NAMES, serverBuildSha256, type ServerSpec } from '@bedperf/core'
import type { ExecOptions, ExecResult, InstallExec } from './exec.ts'
import {
  deepMerge, effectiveLoaderConfig, ensureServer, LEVILAMINA_CONFIG_PATH, LIBPYTHON_CHECK, lipSetupCommands, SERVER_COMPLETE_MARKER, serverCacheDir, serverSlug,
  type EnsureServerOptions
} from './flavors.ts'
import { createInstance, destroyInstance } from './instance.ts'
import { findLipWine, lipCachedDownload, lipDataDir, readLipState } from './lip.ts'
import { pristineDirOf, serverExeName, type Platform } from './platform.ts'

const BDS = '1.26.60.6'
const BDS_URL = `https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-${BDS}.zip`

interface Call { cmd: string, args: string[], cwd?: string, env?: Record<string, string> }

function write (file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** A fake lip / python / pip / wine that writes what the real ones would. */
function fakeExec (opts: { libpython?: boolean } = {}): { exec: InstallExec, calls: Call[] } {
  const calls: Call[] = []
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
  const exec: InstallExec = async (cmd, argsIn, o: ExecOptions = {}) => {
    const args = [...argsIn]
    calls.push({ cmd, args, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(o.env !== undefined ? { env: o.env } : {}) })
    const base = cmd.split(/[\\/]/).at(-1)!.replace(/\.exe$/, '')
    if (base === 'python' && args[0] === '-c' && args[1] === LIBPYTHON_CHECK) return ok(`/usr/lib/libpython3.12.so.1.0\n${opts.libpython === false ? 0 : 1}\n`)
    if (base === 'lip' && args[0] === '--version') return ok('0.41.0-beta.4\n')
    if (base === 'lip' && args[0] === 'setup') {
      const ws = o.cwd!
      write(join(ws, 'bedrock_server_mod.exe'), 'mod exe')
      write(join(ws, 'bedrock_server.exe.bak'), 'orig exe')
      write(join(ws, 'PreLoader.dll'), 'preloader')
      write(join(ws, 'server.properties'), 'server-name=Dedicated Server\nonline-mode=true\n')
      write(join(ws, 'behavior_packs/vanilla/manifest.json'), '{}')
      write(join(ws, 'mods/LeviLamina/LeviLamina.dll'), 'll dll')
      write(join(ws, 'mods/LeviLamina/manifest.json'), '{"name":"LeviLamina"}')
      write(join(ws, '.lip/wine/system.reg'), 'reg')
      write(join(ws, '.lip/state.json'), JSON.stringify({
        format: 4,
        platform: 'win-x64',
        packages: [
          pkg('github.com/LiteLDev/bds', '1.26.60', ['bedrock_server.exe', 'server.properties'], undefined, [BDS_URL]),
          pkg('github.com/LiteLDev/LeviLamina', '26.60.7', ['mods/LeviLamina/LeviLamina.dll', 'mods/LeviLamina/manifest.json'], 'abc'),
          pkg('github.com/LiteLDev/PreLoader', '1.16.8', ['PreLoader.dll'], 'def')
        ]
      }))
      return ok()
    }
    if (base === 'lip' && args[0] === 'install') {
      const ws = o.cwd!
      write(join(ws, 'mods/LeviOptimize/LeviOptimize.dll'), 'lo dll')
      const state = JSON.parse(readFileSync(join(ws, '.lip/state.json'), 'utf8')) as { packages: unknown[] }
      state.packages.push(pkg('github.com/LiteLDev/LeviOptimize', args[1]!.split('@')[1]!, ['mods/LeviOptimize/LeviOptimize.dll'], 'ghi'))
      write(join(ws, '.lip/state.json'), JSON.stringify(state))
      return ok()
    }
    if (base === 'wine' && args[0] === '--version') return ok('wine-11.21\n')
    if (base === 'python' && args[0] === '-c' && args[1]!.includes('sys.version_info')) return ok('3.12.4\n')
    if (base === 'python' && args[0] === '-m' && args[1] === 'venv') {
      write(join(args[2]!, 'Scripts', 'python.exe'), 'py')
      write(join(args[2]!, 'bin', 'python'), 'py')
      return ok()
    }
    if (base === 'python' && args[1] === 'pip' && args[2] === 'download') {
      const d = args[args.indexOf('-d') + 1]!
      write(join(d, 'endstone-0.11.15-cp312-cp312-win_amd64.whl'), 'wheel bytes')
      return ok()
    }
    if (base === 'python' && args[1] === 'pip' && args[2] === 'install') return ok()
    if (base === 'python' && args[1] === 'pip' && args[2] === 'freeze') return ok('pyyaml==6.0.3\nendstone==0.11.15\n')
    if (base === 'python' && args[0] === '-c' && args[1]!.includes('__minecraft_version__')) return ok('26.60\n')
    throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })
  }
  return { exec, calls }
}

function pkg (id: string, version: string, files: string[], commit?: string, urls: string[] = []): unknown {
  return {
    manifest: { id, version, variants: { '': [{ platform: 'win-x64', assets: urls.length > 0 ? [{ type: 'zip', urls }] : [] }] } },
    variant: '',
    ...(commit !== undefined ? { commit } : {}),
    files
  }
}

/** A cached vanilla build with a sidecar, so ensureBds needs no network. */
function fakeBdsCache (bdsRoot: string, platform: Platform, version = BDS): string {
  const dir = pristineDirOf(version, { cacheRoot: bdsRoot, platform })
  write(join(dir, serverExeName(platform)), 'bds exe')
  write(join(dir, 'server.properties'), 'server-name=Dedicated Server\n')
  write(join(dir, 'behavior_packs/vanilla/manifest.json'), '{}')
  const side = join(bdsRoot, `${dir.split(/[\\/]/).at(-1)!}.json`)
  write(side, JSON.stringify({ version, sha256: 'a'.repeat(64) }))
  return dir
}

function setup (platform: Platform): { root: string, opts: EnsureServerOptions, calls: Call[], dataDir: string, lipCache: string } {
  const root = mkdtempSync(join(tmpdir(), 'bedperf-flavors-'))
  const dataDir = join(root, 'lipdata')
  const lipCache = join(root, 'lipcache')
  write(join(dataDir, 'wine', 'wine-11.21-amd64-wow64', 'wine-11.21-amd64-wow64', 'bin', 'wine'), '#!wine')
  write(join(dataDir, 'wine', 'wine-11.21-amd64-wow64', 'wine-11.21-amd64-wow64', 'bin', 'wineserver'), '#!wineserver')
  write(lipCachedDownload(BDS_URL, lipCache), 'bds zip bytes')
  const { exec, calls } = fakeExec()
  return {
    root,
    calls,
    dataDir,
    lipCache,
    opts: { acceptEula: true, cacheRoot: root, hostPlatform: platform, exec, lipDataDir: dataDir, lipCacheDir: lipCache, fetch: async () => { throw new Error('no network in tests') } }
  }
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

test('ensureServer refuses without acceptEula', async () => {
  await assert.rejects(ensureServer(SERVER_PRESETS.bds as ServerSpec, { acceptEula: false }), /EULA/)
})

test('lip commands: setup with the pinned loader, then one install per mod', () => {
  assert.deepEqual(lipSetupCommands(SERVER_PRESETS['levilamina-levioptimize'] as unknown as ServerSpec, BDS), [
    ['setup', '--game', '1.26.60', '--loader', 'levilamina@26.60.7', '--accept-eula'],
    ['install', 'github.com/LiteLDev/LeviOptimize@0.18.0']
  ])
  assert.deepEqual(lipSetupCommands({ flavor: 'levilamina', mods: [], runtime: 'native', versions: { levilamina: '26.60.2' } }, '1.26.61.1'), [
    ['setup', '--game', '1.26.61', '--loader', 'levilamina@26.60.2', '--accept-eula']
  ])
})

test('cache keys: per spec and BDS version, never inside bds/', () => {
  const a = serverCacheDir(SERVER_PRESETS.levilamina as ServerSpec, BDS, '/c')
  const b = serverCacheDir(SERVER_PRESETS['levilamina-wine'] as ServerSpec, BDS, '/c')
  const c = serverCacheDir(SERVER_PRESETS.levilamina as ServerSpec, '1.26.61.1', '/c')
  const d = serverCacheDir({ ...SERVER_PRESETS.levilamina, loaderConfig: { x: 1 } } as ServerSpec, BDS, '/c')
  assert.match(a.replaceAll('\\', '/'), /^\/c\/servers\/levilamina-[0-9a-f]{12}$/)
  assert.match(b.replaceAll('\\', '/'), /\/servers\/levilamina-wine-[0-9a-f]{12}$/)
  assert.notEqual(a, c)
  assert.equal(a, d, 'loaderConfig is per instance, not part of the build key')
  assert.equal(serverSlug(SERVER_PRESETS['levilamina-levioptimize-wine'] as unknown as ServerSpec), 'levilamina-levioptimize-wine')
})

test('deepMerge and effective loader config', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 }), { a: { b: 1, c: [3] }, d: 1, e: 2 })
  const base = { a: { b: 1 } }
  deepMerge(base, { a: { b: 2 } })
  assert.deepEqual(base, { a: { b: 1 } }, 'inputs are not modified')
  const eff = effectiveLoaderConfig({ flavor: 'levilamina', mods: [], runtime: 'native', versions: {}, loaderConfig: { targeted: { enableStatistics: true, checkRunningBDS: false } } })
  assert.deepEqual(eff, {
    modules: { crashLogger: { uploadToSentry: false } },
    targeted: { enableStatistics: true, checkRunningBDS: false, vulnerabilityFixes: { limitIPFrequency: false } }
  })
  assert.deepEqual(effectiveLoaderConfig(SERVER_PRESETS.levilamina as ServerSpec), NEUTRAL_LOADER_CONFIG.levilamina)
})

test('levilamina native: lip setup + install in the workspace, marker last, cached afterwards', async () => {
  const s = setup('win')
  try {
    const spec = SERVER_PRESETS['levilamina-levioptimize'] as unknown as ServerSpec
    const srv = await ensureServer(spec, s.opts)
    const ws = srv.pristineDir
    assert.equal(ws, join(serverCacheDir(spec, BDS, s.root), 'server'))
    const lipCalls = s.calls.filter(c => c.cmd === 'lip' && c.args[0] !== '--version')
    assert.deepEqual(lipCalls.map(c => c.args), lipSetupCommands(spec, BDS))
    assert.ok(lipCalls.every(c => c.cwd === ws))
    assert.ok(existsSync(join(dirname(ws), SERVER_COMPLETE_MARKER)))

    const b = srv.build
    assert.equal(b.exeName, 'bedrock_server_mod.exe')
    assert.equal(b.binaryPlatform, 'win')
    assert.equal(b.bdsVersion, BDS)
    assert.equal(b.label, 'levilamina+levioptimize')
    const art = Object.fromEntries(b.artifacts.map(a => [a.name, a]))
    assert.deepEqual(Object.keys(art).sort(), ['bds', 'levilamina', 'levioptimize', 'lip', 'preloader'])
    assert.equal(art.bds!.sha256, sha('bds zip bytes'), 'bds sha is the zip in lip\'s cache')
    assert.equal(art.bds!.version, BDS)
    assert.equal(art.levilamina!.version, '26.60.7')
    assert.equal(art.levilamina!.source, 'github.com/LiteLDev/LeviLamina@26.60.7#abc')
    assert.match(art.levioptimize!.sha256!, /^[0-9a-f]{64}$/)
    assert.equal(art.lip!.version, '0.41.0-beta.4')
    assert.equal(b.buildSha256, serverBuildSha256(b.artifacts))
    assert.deepEqual(b.loaderConfig, NEUTRAL_LOADER_CONFIG.levilamina)
    assert.deepEqual(JSON.parse(srv.instanceFiles![LEVILAMINA_CONFIG_PATH]!), NEUTRAL_LOADER_CONFIG.levilamina)

    const l = srv.launch('/inst')
    assert.equal(l.command, join('/inst', 'bedrock_server_mod.exe'))
    assert.deepEqual(l.args, [])
    assert.equal(l.cwd, '/inst')
    assert.equal(l.killTree, true)
    assert.ok(new RegExp(l.serverProcess.namePattern, 'i').test('bedrock_server_mod.exe'))
    assert.equal(l.wine, undefined)

    // Cached: no commands at all; a different loaderConfig reuses the build.
    const n = s.calls.length
    const again = await ensureServer({ ...spec, loaderConfig: { targeted: { enableStatistics: true } } }, s.opts)
    assert.equal(s.calls.length, n)
    assert.equal(again.build.buildSha256, b.buildSha256)
    assert.equal((again.build.loaderConfig as { targeted: { enableStatistics: boolean } }).targeted.enableStatistics, true)
    assert.deepEqual(again.build.spec.loaderConfig, { targeted: { enableStatistics: true } })

    // Partial install (no marker): redone from scratch.
    write(join(ws, 'junk.txt'), 'x')
    rmSync(join(dirname(ws), SERVER_COMPLETE_MARKER))
    await ensureServer(spec, s.opts)
    assert.equal(s.calls.filter(c => c.args[0] === 'setup').length, 2)
    assert.equal(existsSync(join(ws, 'junk.txt')), false)
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
})

test('levilamina under wine: lip\'s Wine, shared prefix, wine LaunchSpec', async () => {
  const s = setup('linux')
  try {
    const spec = SERVER_PRESETS['levilamina-wine'] as unknown as ServerSpec
    const srv = await ensureServer(spec, s.opts)
    const wineBin = join(s.dataDir, 'wine', 'wine-11.21-amd64-wow64', 'wine-11.21-amd64-wow64', 'bin', 'wine')
    assert.equal(srv.build.binaryPlatform, 'win')
    const wine = srv.build.artifacts.find(a => a.name === 'wine')!
    assert.equal(wine.version, '11.21')
    assert.match(wine.sha256!, /^[0-9a-f]{64}$/)
    const l = srv.launch('/srv/inst')
    assert.equal(l.command, wineBin)
    assert.deepEqual(l.args, [join('/srv/inst', 'bedrock_server_mod.exe')])
    assert.deepEqual(l.env, { WINEPREFIX: join(srv.pristineDir, '.lip', 'wine'), WINEDEBUG: '-all' })
    assert.deepEqual(l.wine, { prefix: join(srv.pristineDir, '.lip', 'wine'), wineBin, wineserverBin: join(dirname(wineBin), 'wineserver'), version: '11.21' })
    assert.equal(l.killTree, true)
    const re = new RegExp(l.serverProcess.namePattern)
    assert.ok(re.test('bedrock_server_mod.exe'))
    assert.ok(re.test('bedrock_server_'), 'truncated comm')
    assert.ok(!re.test('wineserver'))
    assert.ok(l.auxProcessPatterns!.some(p => new RegExp(p).test('wineserver')))
    assert.ok(l.auxProcessPatterns!.some(p => new RegExp(p).test('winedevice.exe')))
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
})

test('runtime / host mismatches fail clearly', async () => {
  const lin = setup('linux')
  const win = setup('win')
  try {
    await assert.rejects(ensureServer(SERVER_PRESETS.levilamina as ServerSpec, lin.opts), /Windows-only.*wine/)
    await assert.rejects(ensureServer(SERVER_PRESETS['levilamina-wine'] as ServerSpec, win.opts), /on Windows use runtime 'native'/)
    await assert.rejects(ensureServer({ ...SERVER_PRESETS.endstone, runtime: 'wine' } as ServerSpec, win.opts), /natively only/)
    await assert.rejects(ensureServer({ ...SERVER_PRESETS.bds, runtime: 'wine' } as ServerSpec, win.opts), /natively only/)
  } finally {
    rmSync(lin.root, { recursive: true, force: true })
    rmSync(win.root, { recursive: true, force: true })
  }
})

for (const platform of ['win', 'linux'] as const) {
  test(`endstone (${platform}): venv + wheel, vanilla BDS pre-placed, LaunchSpec`, async () => {
    const s = setup(platform)
    try {
      fakeBdsCache(join(s.root, 'bds'), platform)
      const spec = SERVER_PRESETS.endstone as ServerSpec
      const srv = await ensureServer(spec, s.opts)
      const root = serverCacheDir(spec, BDS, s.root)
      assert.equal(srv.pristineDir, join(root, 'server'))
      assert.equal(readFileSync(join(srv.pristineDir, 'version.txt'), 'utf8'), '26.60')
      assert.ok(existsSync(join(srv.pristineDir, serverExeName(platform))))
      const venvCall = s.calls.find(c => c.args.includes('venv'))!
      assert.deepEqual(venvCall.args, ['-m', 'venv', join(root, 'venv')])
      assert.ok(s.calls.some(c => c.args.includes('endstone==0.11.15') && c.args.includes('download')))
      const art = Object.fromEntries(srv.build.artifacts.map(a => [a.name, a]))
      assert.equal(art.endstone!.sha256, sha('wheel bytes'))
      assert.equal(art.endstone!.version, '0.11.15')
      assert.equal(art.bds!.sha256, 'a'.repeat(64))
      assert.equal(art.python!.version, '3.12.4')
      assert.equal(art['python-deps']!.sha256, sha('endstone==0.11.15\npyyaml==6.0.3\n'))
      assert.equal(srv.build.exeName, serverExeName(platform))
      assert.equal(srv.build.allocator, platform === 'linux' ? 'mimalloc-preload' : undefined)
      assert.ok(srv.build.notes.length > 0)

      const l = srv.launch('/i')
      const tail = ['-y', '-s', '/i', '--no-interactive']
      if (platform === 'win') {
        assert.equal(l.command, join(root, 'venv', 'Scripts', 'python.exe'))
        assert.equal(l.args[0], '-c')
        assert.match(l.args[1]!, /_add_loopback_exemption = lambda self: None/)
        assert.deepEqual(l.args.slice(2), tail)
      } else {
        assert.equal(l.command, join(root, 'venv', 'bin', 'endstone'))
        assert.deepEqual(l.args, tail)
      }
      assert.equal(l.killTree, true)
      assert.ok(new RegExp(l.serverProcess.namePattern).test(serverExeName(platform)))

      const n = s.calls.length
      await ensureServer(spec, s.opts)
      assert.equal(s.calls.length, n, 'cached')
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  })
}

test('endstone on Linux requires the shared libpython', async () => {
  const s = setup('linux')
  try {
    fakeBdsCache(join(s.root, 'bds'), 'linux')
    const { exec } = fakeExec({ libpython: false })
    await assert.rejects(ensureServer(SERVER_PRESETS.endstone as ServerSpec, { ...s.opts, exec }), /apt-get install libpython3\.12/)
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
})

test('endstone rejects a BDS version it does not run', async () => {
  const s = setup('win')
  try {
    await assert.rejects(ensureServer(SERVER_PRESETS.endstone as ServerSpec, { ...s.opts, bdsVersion: '1.26.63.1' }), /runs BDS 1\.26\.60, not 1\.26\.63\.1/)
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
})

test('bds: ensureBds cache, zip sha artifact, LD_LIBRARY_PATH on Linux', async () => {
  for (const platform of ['win', 'linux'] as const) {
    const s = setup(platform)
    try {
      const dir = fakeBdsCache(join(s.root, 'bds'), platform)
      const srv = await ensureServer(undefined, { ...s.opts, bdsVersion: BDS })
      assert.equal(srv.pristineDir, dir)
      assert.deepEqual(srv.build.artifacts, [{ name: 'bds', version: BDS, sha256: 'a'.repeat(64) }])
      assert.equal(srv.build.exeName, serverExeName(platform))
      assert.equal(s.calls.length, 0)
      const l = srv.launch('/i')
      assert.equal(l.command, join('/i', serverExeName(platform)))
      assert.equal(l.killTree, false)
      if (platform === 'linux') assert.match(l.env!.LD_LIBRARY_PATH!, /^\/i(:|$)/)
      else assert.equal(l.env, undefined)
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  }
})

test('every preset yields a LaunchSpec on its host', async () => {
  for (const name of SERVER_PRESET_NAMES) {
    const spec = SERVER_PRESETS[name] as unknown as ServerSpec
    const platform: Platform = spec.runtime === 'wine' ? 'linux' : 'win'
    const s = setup(platform)
    try {
      fakeBdsCache(join(s.root, 'bds'), platform)
      const srv = await ensureServer(spec, { ...s.opts, bdsVersion: BDS })
      const l = srv.launch(join(s.root, 'inst'))
      assert.ok(l.command.length > 0, name)
      assert.equal(l.cwd, join(s.root, 'inst'), name)
      assert.ok(new RegExp(l.serverProcess.namePattern, 'i').test(srv.build.exeName.slice(0, platform === 'linux' && spec.runtime === 'wine' ? 15 : undefined)), name)
      assert.equal(srv.build.spec.flavor, spec.flavor)
      assert.match(srv.build.buildSha256, /^[0-9a-f]{64}$/)
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  }
})

test('createInstance from an InstalledServer: loader dirs, shared wine prefix, instance files', async () => {
  const s = setup('linux')
  try {
    const srv = await ensureServer(SERVER_PRESETS['levilamina-levioptimize-wine'] as unknown as ServerSpec, s.opts)
    const inst = await createInstance({ server: srv, port: 19320, dir: join(s.root, 'inst') })
    assert.equal(inst.version, BDS)
    assert.equal(inst.platform, 'linux', 'a Wine instance runs on Linux')
    const d = inst.dir
    assert.ok(existsSync(join(d, 'bedrock_server_mod.exe')))
    assert.ok(existsSync(join(d, 'mods/LeviOptimize/LeviOptimize.dll')))
    assert.ok(existsSync(join(d, '.lip/state.json')))
    assert.equal(existsSync(join(d, '.lip/wine')), false, 'wine prefix stays in the pristine dir')
    assert.ok(statSync(join(d, 'mods/LeviLamina')).isDirectory())
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(d, 'mods/LeviLamina/LeviLamina.dll')).ino, statSync(join(srv.pristineDir, 'mods/LeviLamina/LeviLamina.dll')).ino)
    }
    assert.equal(statSync(join(d, 'mods/LeviLamina/manifest.json')).nlink, 1, 'non-binaries are copied')
    const cfg = JSON.parse(readFileSync(join(d, LEVILAMINA_CONFIG_PATH), 'utf8')) as unknown
    assert.deepEqual(cfg, NEUTRAL_LOADER_CONFIG.levilamina)
    assert.equal(existsSync(join(srv.pristineDir, LEVILAMINA_CONFIG_PATH)), false, 'pristine untouched')
    assert.match(readFileSync(join(d, 'server.properties'), 'utf8'), /server-port=19320/)
    await destroyInstance(inst)

    await assert.rejects(createInstance({ server: { ...srv, build: { ...srv.build, exeName: 'nope.exe' } }, port: 1 }), /nope\.exe is missing/)
    await assert.rejects(createInstance({ server: { ...srv, instanceFiles: { '../x': '' } }, port: 1, dir: join(s.root, 'inst2') }), /escapes/)
  } finally {
    rmSync(s.root, { recursive: true, force: true })
  }
})

test('lip paths and state parsing', () => {
  assert.equal(lipDataDir('linux', { HOME: '/home/u' }).replaceAll('\\', '/'), '/home/u/.local/share/lip')
  assert.equal(lipDataDir('linux', { HOME: '/home/u', XDG_DATA_HOME: '/x' }).replaceAll('\\', '/'), '/x/lip')
  assert.equal(lipDataDir('windows', { LOCALAPPDATA: 'C:\\L' }), join('C:\\L', 'lip', 'Data'))
  assert.equal(lipCachedDownload('u', '/c'), join('/c', 'http-' + sha('u')))
  const root = mkdtempSync(join(tmpdir(), 'bedperf-lip-'))
  try {
    assert.equal(findLipWine(root), undefined)
    write(join(root, 'wine', 'w-1', 'bin', 'wine'), '')
    assert.equal(findLipWine(root)!.wineBin, join(root, 'wine', 'w-1', 'bin', 'wine'))
    write(join(root, 'ws', '.lip', 'state.json'), JSON.stringify({ platform: 'win-x64', packages: [pkg('github.com/LiteLDev/bds', '1.26.60', ['a'], undefined, [BDS_URL]), { manifest: {} }] }))
    const st = readLipState(join(root, 'ws'))
    assert.deepEqual(st.packages, [{ id: 'github.com/LiteLDev/bds', version: '1.26.60', files: ['a'], urls: [BDS_URL] }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
