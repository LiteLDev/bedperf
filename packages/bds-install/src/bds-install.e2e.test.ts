// Real-network / real-BDS checks. Run only with BEDPERF_E2E=1 (downloads ~90 MB once).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BdsInstance } from '@bedperf/core'
import { createInstance, destroyInstance, ensureBds, hashTree, resolveVersion, restoreWorldSnapshot, saveWorldSnapshot, serverExeName, defaultBdsCacheRoot, readSidecar } from './index.ts'
import type { FetchLike } from './resolve.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const VERSION = '1.26.63.1'
const PORT = 19210

test('resolveVersion(latest/preview) against the real links API', { skip: !e2e, timeout: 60_000 }, async () => {
  const latest = await resolveVersion('latest')
  const preview = await resolveVersion('preview')
  console.log('latest:', JSON.stringify(latest))
  console.log('preview:', JSON.stringify(preview))
  assert.match(latest.version, /^\d+\.\d+\.\d+\.\d+$/)
  assert.equal(latest.preview, false)
  assert.equal(preview.preview, true)
})

test('ensureBds on the existing cache is a no-op', { skip: !e2e }, async () => {
  const root = defaultBdsCacheRoot()
  const dir = join(root, VERSION)
  if (!existsSync(join(dir, serverExeName()))) { console.log('no cached build, skipping'); return }
  const snapshot = (): string => JSON.stringify(readdirSync(root).map(n => [n, statSync(join(root, n)).mtimeMs]).concat(
    readdirSync(dir).map(n => [n, statSync(join(dir, n)).mtimeMs])))
  const before = snapshot()
  const failFetch: FetchLike = async () => { throw new Error('must not hit the network') }
  const r = await ensureBds(VERSION, { acceptEula: true, fetch: failFetch })
  assert.equal(r.cached, true)
  assert.equal(r.dir, dir)
  assert.equal(snapshot(), before)
})

function startServer (inst: BdsInstance): { lines: string[], wait: (re: RegExp, ms: number) => Promise<string>, stop: () => Promise<void> } {
  const proc = spawn(join(inst.dir, serverExeName(inst.platform)), [], {
    cwd: inst.dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: inst.platform === 'win' ? process.env : { ...process.env, LD_LIBRARY_PATH: inst.dir },
    windowsHide: true
  })
  const lines: string[] = []
  const waiters = new Set<(l: string) => void>()
  const onLine = (l: string): void => { lines.push(l); for (const w of waiters) w(l) }
  createInterface({ input: proc.stdout }).on('line', onLine)
  createInterface({ input: proc.stderr }).on('line', onLine)
  const exited = new Promise<void>(r => proc.once('exit', () => r()))
  const wait = (re: RegExp, ms: number): Promise<string> => new Promise((resolve, reject) => {
    const hit = lines.find(l => re.test(l))
    if (hit !== undefined) { resolve(hit); return }
    const t = setTimeout(() => { waiters.delete(w); reject(new Error(`timeout waiting for ${re}\n${lines.slice(-20).join('\n')}`)) }, ms)
    const w = (l: string): void => { if (re.test(l)) { clearTimeout(t); waiters.delete(w); resolve(l) } }
    waiters.add(w)
    void exited.then(() => { if (waiters.delete(w)) { clearTimeout(t); reject(new Error(`BDS exited while waiting for ${re}\n${lines.slice(-20).join('\n')}`)) } })
  })
  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    proc.stdin.write('stop\n')
    const t = setTimeout(() => proc.kill('SIGKILL'), 20_000)
    await exited
    clearTimeout(t)
  }
  return { lines, wait, stop }
}

test('download + extract into a temp cache, create, run, snapshot, restore', { skip: !e2e, timeout: 900_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bedperf-e2e-'))
  const instances: BdsInstance[] = []
  try {
    const cacheRoot = join(tmp, 'cache')
    const t0 = Date.now()
    let last = 0
    const r = await ensureBds(VERSION, {
      acceptEula: true,
      cacheRoot,
      onProgress: p => {
        if (p.phase === 'extract') console.log('extracting...')
        else if (p.received !== undefined && p.received - last > 20e6) { last = p.received; console.log(`downloaded ${(p.received / 1e6).toFixed(0)}/${((p.total ?? 0) / 1e6).toFixed(0)} MB`) }
      }
    })
    console.log(`ensureBds took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    assert.equal(r.cached, false)
    const side = readSidecar(cacheRoot, VERSION)!
    console.log('sidecar:', JSON.stringify(side))
    assert.match(side.sha256, /^[0-9a-f]{64}$/)
    assert.equal((await ensureBds(VERSION, { acceptEula: true, cacheRoot })).cached, true)

    const pack = join(tmp, 'pack')
    mkdirSync(join(pack, 'scripts'), { recursive: true })
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({
      format_version: 2,
      header: { name: 'bds-install e2e', description: 'x', uuid: '6f1c2f4e-0a39-4a51-9a7b-2b9d1f0c0101', version: [1, 0, 0], min_engine_version: [1, 21, 0] },
      modules: [{ type: 'script', language: 'javascript', uuid: '6f1c2f4e-0a39-4a51-9a7b-2b9d1f0c0102', version: [1, 0, 0], entry: 'scripts/main.js' }],
      dependencies: [{ module_name: '@minecraft/server', version: '2.11.0' }]
    }))
    writeFileSync(join(pack, 'scripts', 'main.js'), `import { system } from '@minecraft/server'\nsystem.runInterval(() => console.log('BDSINSTALL|tick ' + system.currentTick), 20)\n`)

    const inst = await createInstance({
      version: VERSION,
      cacheRoot,
      port: PORT,
      portV6: PORT + 1,
      levelName: 'e2e',
      presets: ['bench-flat'],
      properties: { 'server-name': 'bds-install-e2e', 'level-seed': '12345' },
      behaviorPacks: [pack]
    })
    instances.push(inst)
    const s1 = startServer(inst)
    try {
      await s1.wait(/Server started\./, 120_000)
      await s1.wait(new RegExp(`IPv4 supported, port: ${PORT}`), 1_000)
      await s1.wait(/BDSINSTALL\|tick/, 30_000)
    } finally {
      await s1.stop()
    }
    assert.ok(s1.lines.some(l => /Quit correctly/.test(l)), 'clean shutdown')

    const store = join(tmp, 'snapshots')
    const manifest = await saveWorldSnapshot(inst, 'e2e-flat', store)
    console.log(`snapshot: ${manifest.files.length} files, ${manifest.totalBytes} bytes, hash ${manifest.hash}`)
    assert.equal(manifest.hash, hashTree(join(inst.dir, 'worlds', 'e2e')))

    const inst2 = await createInstance({ version: VERSION, cacheRoot, port: PORT, levelName: 'restored', worldSnapshot: { id: 'e2e-flat', store } })
    instances.push(inst2)
    assert.equal(hashTree(join(inst2.dir, 'worlds', 'restored')), manifest.hash)
    await restoreWorldSnapshot('e2e-flat', inst2, store) // explicit API, idempotent
    const s2 = startServer(inst2)
    try {
      await s2.wait(/Server started\./, 120_000)
    } finally {
      await s2.stop()
    }
    assert.ok(s2.lines.some(l => /Quit correctly/.test(l)), 'restored world shuts down cleanly')
  } finally {
    for (const i of instances) await destroyInstance(i)
    for (const i of instances) assert.ok(!existsSync(i.dir))
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
})
