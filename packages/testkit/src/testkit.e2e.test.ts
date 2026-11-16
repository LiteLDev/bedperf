// Real-BDS smoke test. Runs only when BEDPERF_E2E=1 (needs the BDS cache; see README).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestBds, createTestBot } from './index.ts'

const e2e = process.env.BEDPERF_E2E === '1'

test('BDS starts, runs a script pack and accepts a bedboo bot', { skip: !e2e, timeout: 180_000 }, async () => {
  const pack = mkdtempSync(join(tmpdir(), 'bedperf-pack-'))
  mkdirSync(join(pack, 'scripts'))
  writeFileSync(join(pack, 'manifest.json'), JSON.stringify({
    format_version: 2,
    header: { name: 'testkit smoke', description: 'x', uuid: '6f1c2f4e-0a39-4a51-9a7b-2b9d1f0c0001', version: [1, 0, 0], min_engine_version: [1, 21, 0] },
    modules: [{ type: 'script', language: 'javascript', uuid: '6f1c2f4e-0a39-4a51-9a7b-2b9d1f0c0002', version: [1, 0, 0], entry: 'scripts/main.js' }],
    dependencies: [{ module_name: '@minecraft/server', version: '2.11.0' }]
  }))
  writeFileSync(join(pack, 'scripts', 'main.js'), `import { system } from '@minecraft/server'\nsystem.runInterval(() => console.log('TESTKIT|tick ' + system.currentTick), 20)\n`)

  const bds = await startTestBds({ port: 19190, behaviorPacks: [pack] })
  try {
    await bds.waitForLine(/TESTKIT\|tick/, 30_000, true)
    const bot = await createTestBot({ port: 19190, username: 'testkit0' })
    await bds.waitForLine(/Player connected: testkit0/, 10_000, true)
    assert.ok(bot.entity)
    bot.end()
  } finally {
    await bds.stop()
    rmSync(pack, { recursive: true, force: true })
  }
})
