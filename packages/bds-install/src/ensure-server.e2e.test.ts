// Real installs of every server flavor, each started once from its LaunchSpec. Run only with
// BEDPERF_E2E=1. Uses the real bedperf cache (BEDPERF_CACHE_DIR to redirect) and lip / Python / Wine.
// BEDPERF_E2E_PRESETS=bds,endstone picks presets; the default is every preset that runs on this host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { NEUTRAL_LOADER_CONFIG, SERVER_PRESETS, SERVER_PRESET_NAMES, type LaunchSpec, type ServerPresetName, type ServerSpec } from '@bedperf/core'
import { createInstance, destroyInstance, ensureServer, LEVILAMINA_CONFIG_PATH } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'
const isWin = process.platform === 'win32'
const BDS = '1.26.60.6'
const BASE_PORT = 19320

const presets = (process.env.BEDPERF_E2E_PRESETS?.split(',').map(s => s.trim()).filter(Boolean) as ServerPresetName[] | undefined) ??
  SERVER_PRESET_NAMES.filter(n => isWin ? SERVER_PRESETS[n].runtime === 'native' : (SERVER_PRESETS[n].runtime === 'wine' || SERVER_PRESETS[n].flavor !== 'levilamina'))

function killTree (pid: number): void {
  if (isWin) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
  else try { process.kill(-pid, 'SIGKILL') } catch {}
}

/** Spawn a LaunchSpec, wait for "Server started", send `stop`, wait for exit. */
async function runOnce (l: LaunchSpec, label: string): Promise<string[]> {
  const proc = spawn(l.command, l.args, {
    cwd: l.cwd,
    env: { ...process.env, ...l.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin
  })
  const lines: string[] = []
  const exited = new Promise<number | null>(resolve => proc.once('exit', code => resolve(code)))
  const started = new Promise<void>((resolve, reject) => {
    const onLine = (line: string): void => {
      lines.push(line)
      if (process.env.BEDPERF_E2E_VERBOSE === '1') console.log(`[${label}] ${line}`)
      if (/Server started/.test(line)) resolve()
    }
    createInterface({ input: proc.stdout }).on('line', onLine)
    createInterface({ input: proc.stderr }).on('line', onLine)
    proc.once('error', reject)
    void exited.then(code => reject(new Error(`${label} exited (${String(code)}) before starting:\n${lines.slice(-30).join('\n')}`)))
  })
  const t0 = Date.now()
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no "Server started" in 180 s:\n${lines.slice(-30).join('\n')}`)), 180_000) })])
    console.log(`${label}: started in ${Date.now() - t0} ms`)
    proc.stdin.write((l.stopCommand ?? 'stop') + '\n')
    const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 60_000))])
    assert.notEqual(code, 'timeout', `${label} did not exit after stop`)
    console.log(`${label}: stopped with code ${String(code)}`)
  } finally {
    clearTimeout(timer)
    if (proc.pid !== undefined && (l.killTree || proc.exitCode === null)) killTree(proc.pid)
    if (l.wine?.wineserverBin !== undefined) spawnSync(l.wine.wineserverBin, ['-k'], { env: { ...process.env, ...l.env }, stdio: 'ignore' })
  }
  return lines
}

presets.forEach((name, i) => {
  test(`ensureServer + createInstance + start: ${name}`, { skip: !e2e, timeout: 1_800_000 }, async () => {
    const spec = SERVER_PRESETS[name] as unknown as ServerSpec
    const t0 = Date.now()
    const srv = await ensureServer(spec, { acceptEula: true, bdsVersion: BDS, log: l => console.log(`[${name} install] ${l}`) })
    console.log(`${name}: installed in ${Date.now() - t0} ms at ${srv.pristineDir}`)
    console.log(JSON.stringify({ ...srv.build, spec: undefined }, null, 2))
    assert.ok(existsSync(join(srv.pristineDir, srv.build.exeName)))
    assert.equal(srv.build.bdsVersion, BDS)
    for (const a of srv.build.artifacts) {
      if (a.name !== 'python') assert.match(a.sha256 ?? '', /^[0-9a-f]{64}$/, `artifact ${a.name} has a sha256`)
    }

    const port = BASE_PORT + 2 * i
    const inst = await createInstance({ server: srv, port, levelName: 'e2e', presets: ['bench-flat'] })
    try {
      if (spec.flavor === 'levilamina') {
        assert.deepEqual(JSON.parse(readFileSync(join(inst.dir, LEVILAMINA_CONFIG_PATH), 'utf8')), NEUTRAL_LOADER_CONFIG.levilamina)
      }
      const lines = await runOnce(srv.launch(inst.dir), name)
      if (spec.flavor === 'levilamina') {
        assert.ok(lines.some(l => /LeviLamina/.test(l)), 'LeviLamina loaded')
        // LeviLamina filled in its defaults and kept bedperf's overrides.
        const cfg = JSON.parse(readFileSync(join(inst.dir, LEVILAMINA_CONFIG_PATH), 'utf8')) as {
          modules: { crashLogger: { uploadToSentry: boolean } }
          targeted: { enableStatistics: boolean, vulnerabilityFixes: { limitIPFrequency: boolean }, checkRunningBDS?: boolean }
        }
        assert.equal(cfg.modules.crashLogger.uploadToSentry, false)
        assert.equal(cfg.targeted.enableStatistics, false)
        assert.equal(cfg.targeted.vulnerabilityFixes.limitIPFrequency, false)
        assert.equal(typeof cfg.targeted.checkRunningBDS, 'boolean', 'defaults were merged in')
      }
      if (spec.mods.includes('levioptimize')) assert.ok(lines.some(l => /LeviOptimize/i.test(l)), 'LeviOptimize loaded')
      if (spec.flavor === 'endstone') assert.ok(lines.some(l => /endstone/i.test(l)), 'Endstone loaded')
    } finally {
      await destroyInstance(inst)
    }
  })
})
