import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, preset, runBenchmark } from '@bedperf/orchestrator'
import { createSimDeps } from '@bedperf/orchestrator/sim'
import { parseArgs, UsageError } from './args.ts'
import { analyzeCommand } from './analyze.ts'
import { applyMachineProfile, configFromArgs, configsFromArgs, exitCodeForError } from './main.ts'

test('--machine-profile merges placement and known gates; unknown gates are usage errors', () => {
  const raw = structuredClone(preset('quick')) as unknown as Record<string, unknown>
  applyMachineProfile(raw, { label: 'box', placement: { serverCpus: '0-3', priority: 'above_normal' }, gates: { idleSec: 5 } })
  const c = parseConfig(raw)
  assert.equal(c.placement?.serverCpus, '0-3')
  assert.equal(c.placement?.botCpus, 'auto')
  assert.equal(c.placement?.priority, 'above_normal')
  assert.equal(c.placement?.label, 'box')
  assert.equal(c.gates?.idleSec, 5)
  assert.throws(() => applyMachineProfile(raw, { gates: { minTps: 1 } }), UsageError)
  assert.equal(exitCodeForError(new UsageError('x')), 2)
  assert.equal(exitCodeForError(new Error('x')), 1)
})

test('--set reaches the new config sections', async () => {
  const c = await configFromArgs(parseArgs(['run', '--set', 'placement.enabled=false', '--set', 'gates.foreignMean=1', '--set', 'ramp.settle.mode=fixed', '--set', 'cooldownSec=0']))
  assert.equal(c.placement?.enabled, false)
  assert.equal(c.gates?.foreignMean, 1)
  assert.equal(c.ramp.settle?.mode, 'fixed')
  assert.equal(c.cooldownSec, 0)
})

test('--configs needs at least two files and no --preset', async () => {
  await assert.rejects(configsFromArgs(parseArgs(['run', '--configs', 'a.json'])), UsageError)
  await assert.rejects(configsFromArgs(parseArgs(['run', '--configs', 'a.json,b.json', '--preset', 'quick'])), UsageError)
})

test('analyze: a simulated run recomputes unchanged; a tampered steps.json differs and --write restores it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bedperf-cli-'))
  try {
    const { deps } = createSimDeps({ capacity: 15 }, dir)
    const config = parseConfig({ name: 'an', scenario: { module: 'sim://idle' }, repeats: 1, warmupSec: 10, ramp: { start: 10, step: 10, max: 20, holdSec: 10, resolution: 0 }, sampling: { gametimeIntervalSec: 1 } })
    const out = await runBenchmark(config, deps)
    const a = await analyzeCommand(out.dir)
    assert.equal(a.verdict, 'unchanged', a.lines.join('\n'))
    assert.equal(a.exitCode, 0)
    const stepsFile = path.join(out.dir, 'steps.json')
    const orig = await readFile(stepsFile, 'utf8')
    const steps = JSON.parse(orig) as Array<{ pass: boolean }>
    steps[0]!.pass = !steps[0]!.pass
    await writeFile(stepsFile, JSON.stringify(steps))
    const b = await analyzeCommand(out.dir)
    assert.equal(b.verdict, 'differs')
    assert.deepEqual(b.differing, ['0/0'])
    assert.equal(b.manifestOk, false)
    assert.equal(b.exitCode, 1)
    const c = await analyzeCommand(out.dir, { write: true })
    assert.equal(c.verdict, 'rewritten')
    assert.equal(await readFile(stepsFile, 'utf8'), orig)
    const d = await analyzeCommand(out.dir)
    assert.equal(d.exitCode, 0, d.lines.join('\n'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
