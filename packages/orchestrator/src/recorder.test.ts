import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RUN_FILES, Scrubber, sha256Json, type RunMeta } from '@bedperf/core'
import { parseConfig } from './config.ts'
import { runBenchmark } from './engine.ts'
import { RunRecorder } from './recorder.ts'
import { createSimDeps } from './sim.ts'

async function withTmp<T> (fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-rec-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function walk (dir: string, sub = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(path.join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? e.name : `${sub}/${e.name}`
    if (e.isDirectory()) out.push(...await walk(dir, rel))
    else out.push(rel)
  }
  return out
}

test('simulated run: meta.json carries scrubbed provenance and a correct files manifest', async () => {
  await withTmp(async dir => {
    const config = parseConfig({
      name: 'prov-test',
      // A path under the run dir and one under home: both must be scrubbed from config.json.
      scenario: { module: 'sim://idle', params: { note: path.join(os.homedir(), 'secret', 'x.json') } },
      ramp: { start: 10, step: 10, max: 30, settleSec: 5, holdSec: 10, resolution: 5 },
      repeats: 1,
      warmupSec: 5
    })
    const { deps } = createSimDeps({ capacity: 20 }, dir)
    const out = await runBenchmark(config, deps, { meta: { artifacts: { bdsZipSha256: 'f'.repeat(64) } } })
    const metaText = await readFile(path.join(out.dir, RUN_FILES.meta), 'utf8')
    const configText = await readFile(path.join(out.dir, RUN_FILES.config), 'utf8')
    const meta = JSON.parse(metaText) as RunMeta

    assert.equal(meta.host.hostname, undefined)
    assert.match(meta.configSha256 ?? '', /^[0-9a-f]{64}$/)
    assert.equal(meta.configSha256, sha256Json(JSON.parse(configText)))
    assert.match(meta.machine?.fingerprint ?? '', /^[0-9a-f]{16}$/)
    assert.ok((meta.machine?.logical ?? 0) > 0)
    assert.equal(typeof meta.harness?.node, 'string')
    assert.match(meta.harness?.git ?? '', /^[0-9a-f]{40}$/, 'run from a git checkout')
    assert.equal(typeof meta.harness?.dirty, 'boolean')
    assert.equal(meta.artifacts?.bdsZipSha256, 'f'.repeat(64))
    assert.equal(meta.analysisVersion, undefined)
    assert.ok(configText.includes('<home>/secret/x.json'), configText)

    // Manifest: every file but meta.json, with the right hash and size.
    const files = meta.files ?? {}
    const onDisk = (await walk(out.dir)).filter(f => f !== RUN_FILES.meta).sort()
    assert.deepEqual(Object.keys(files).sort(), onDisk)
    for (const [rel, d] of Object.entries(files)) {
      const buf = await readFile(path.join(out.dir, rel))
      assert.equal(d.sha256, createHash('sha256').update(buf).digest('hex'), rel)
      assert.equal(d.bytes, (await stat(path.join(out.dir, rel))).size, rel)
    }
    for (const f of [RUN_FILES.config, RUN_FILES.samples, RUN_FILES.steps, RUN_FILES.result]) assert.ok(f in files, f)

    // Nothing private left.
    assert.deepEqual(new Scrubber().leaks(meta), [])
    assert.deepEqual(new Scrubber().leaks(JSON.parse(configText)), [])
    const user = os.userInfo().username
    const host = os.hostname()
    for (const text of [metaText, configText]) {
      if (user.length >= 3) assert.ok(!text.toLowerCase().includes(user.toLowerCase()), `user name in ${text}`)
      if (host.length >= 3) assert.ok(!text.toLowerCase().includes(host.toLowerCase()), `host name in ${text}`)
    }
  })
})

test('RunRecorder: injected provenance and scrubber; report.html is never in the manifest', async () => {
  await withTmp(async dir => {
    const config = parseConfig({ name: 'x', scenario: { module: 'sim://idle' }, ramp: { start: 1, step: 1, max: 2 }, repeats: 1 })
    const machine = { fingerprint: '0123456789abcdef', os: 'TestOS 1', cpuModel: 'cpu', logical: 4, ramGiB: 8 }
    const harness = { version: '9', node: 'v24' }
    const rec = await RunRecorder.create({ runsDir: dir, config, provenance: async () => ({ machine, harness }) })
    const { writeFile, mkdir } = await import('node:fs/promises')
    await writeFile(path.join(rec.dir, RUN_FILES.report), '<html>')
    await mkdir(path.join(rec.dir, 'sub'))
    await writeFile(path.join(rec.dir, 'sub', 'a.txt'), 'abc')
    await rec.close()
    const meta = JSON.parse(await readFile(path.join(rec.dir, RUN_FILES.meta), 'utf8')) as RunMeta
    assert.deepEqual(meta.machine, machine)
    assert.deepEqual(meta.harness, harness)
    assert.deepEqual(Object.keys(meta.files ?? {}).sort(), [RUN_FILES.config, RUN_FILES.samples, 'sub/a.txt'].sort())
    assert.deepEqual(meta.files?.['sub/a.txt'], { sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3 })
  })
})
