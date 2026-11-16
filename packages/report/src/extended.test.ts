// Newer measurements (tick counter, tick CPU, interference, view load, placement, provenance):
// read defensively, rendered when present, absent without breaking older runs.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { RUN_FILES } from '@bedperf/core'
import { analyze } from './analyze.ts'
import { compareRuns, IncomparableRunsError, renderCompareHtml } from './compare.ts'
import { generateRun } from './fixtures.ts'
import type { FixtureOptions } from './fixtures.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'
import { cpuList } from './provenance.ts'
import type { Analysis } from './types.ts'

const root = await mkdtemp(join(tmpdir(), 'bedperf-report-ext-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

let n = 0
async function run (opts: FixtureOptions): Promise<Analysis> {
  const fx = await generateRun(join(root, `r${n++}`), { extended: true, ...opts })
  return analyze(await loadRun(fx.dir))
}

function clean (html: string): void {
  assert.doesNotMatch(html, /NaN|undefined|Infinity/)
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b/i)
  assert.equal((html.match(/<svg[\s>]/g) ?? []).length, (html.match(/<\/svg>/g) ?? []).length)
}

test('extended run: step fields, tick CPU per player, timeline series and provenance', async () => {
  const a = await run({ seed: 1, interferenceStep: { repeat: 2, index: 1 } })
  const s = a.steps.find((r) => !r.invalid)!
  assert.ok(s.counterTps! > 19 && s.counterTps! <= 20.5)
  assert.ok(s.tickCpuMsPerTick! > 0)
  assert.equal(s.tickThreadSource, 'name')
  assert.ok(s.foreignMean! < 0.2)
  assert.ok(s.inViewMedian! > 400)
  assert.ok(s.viewT90MsP50! > 1000)
  assert.ok(s.chunksPerSec! > 0)
  assert.equal(s.placementVerified, true)
  assert.ok(s.gametimeLatencyP50! > 0)

  const bad = a.steps.filter((r) => r.invalid)
  assert.equal(bad.length, 1)
  assert.match(bad[0]!.invalidReasons[0]!, /interference/)
  // Invalid steps stay out of the curves: no curve point carries the spike.
  assert.ok(a.curves.every((c) => c.points.every((p) => (p.values.foreignMean ?? 0) < 0.5)))

  // Tick CPU per tick grows ~1.2 ms per player in the util model (0.86 util / 40 players × 50 ms).
  const fit = a.derived.tickCpuPerPlayer!
  assert.ok(fit.slope > 0.8 && fit.slope < 1.6, `slope ${fit.slope}`)
  assert.ok(fit.r2 > 0.9)
  assert.ok(a.repeatDerived.every((r) => r.derived.tickCpuPerPlayer !== undefined))

  assert.ok(a.timeline.counterTps.length > 10)
  assert.ok(a.timeline.foreign.length > 100)
  assert.ok(a.timeline.serverSetForeign.length > 100)
  assert.ok(a.timeline.tickCpu.length > 100)
  assert.ok(a.timeline.counterTps.every(([, y]) => y > 10 && y < 25))

  const p = a.provenance
  assert.match(p.configSha256!, /^5be0/)
  assert.equal(p.machineFingerprint, '1a2b3c4d5e6f7a8b')
  assert.equal(p.harness?.dirty, false)
  assert.equal(p.placement?.kind, 'physical')
  assert.equal(p.placement?.serverCpus, '0-7 (8)')
  assert.equal(p.placement?.verified, true)
  assert.ok(p.gates.some(([k, v]) => k === 'foreignMean' && v === '0.5'))
  assert.equal(p.bedbooCommit, 'fc62cc3')

  assert.ok(a.publishable)
  const ids = a.threats.map((t) => t.id)
  for (const id of ['invalid-steps', 'colocated', 'loopback']) assert.ok(ids.includes(id), id)
  assert.ok(!ids.includes('provenance'))
})

test('threats: dirty harness, vcpu, too few ok repeats, unverified placement', async () => {
  const a = await run({ seed: 2, dirty: true, placementKind: 'vcpu', repeats: 2 })
  const ids = a.threats.map((t) => t.id)
  assert.ok(ids.includes('dirty'))
  assert.ok(ids.includes('vcpu'))
  assert.ok(ids.includes('repeats'))
  assert.equal(a.publishable, false)
  assert.equal(a.threats[0]!.level, 'bad')
  const html = renderHtml(a)
  clean(html)
  assert.match(html, /<section id="threats" class="threats unpub"/)
  assert.match(html, /not publishable/)
  assert.match(html, /unofficial: dirty/)
  assert.match(html, /flag warn">vcpu/)
  assert.match(html, /Not publishable: 2\/2 repeats ok/)

  const fx = await generateRun(join(root, 'unverified'), { extended: true, seed: 3, metaExtra: { placement: { kind: 'physical', verified: false } } })
  const u = analyze(await loadRun(fx.dir))
  assert.ok(u.threats.some((t) => t.id === 'placement' && t.level === 'bad'))
  assert.match(renderHtml(u), /placement not verified/)
})

test('renderHtml: provenance panel, threats box, new charts, columns and timeline panels', async () => {
  const a = await run({ seed: 4, interferenceStep: { repeat: 1, index: 0 } })
  const html = renderHtml(a)
  clean(html)
  for (const id of ['threats', 'provenance']) assert.match(html, new RegExp(`<section id="${id}"`))
  for (const t of ['Config hash', 'Machine fingerprint', 'Harness', 'BDS zip hash', 'Probe pack hash', 'bedboo commit', 'CPU placement', 'Gates', 'Placement checks']) assert.ok(html.includes(t), t)
  assert.match(html, /1a2b3c4d5e6f7a8b/)
  assert.match(html, /0.0.0 @ 2acaef1d6c5b/)
  assert.match(html, /flag ok">clean/)
  assert.match(html, /flag ok">verified/)
  for (const id of ['chart-tickcpu', 'chart-counter-tps', 'chart-view', 'chart-chunks', 'chart-inview', 'chart-foreign']) assert.match(html, new RegExp(`id="${id}"`), id)
  for (const th of ['counter TPS', 'tick CPU ms/tick', 'foreign cores', 'in view', 'view t90 s', 'chunks/s', 'flags']) assert.ok(html.includes(`>${th}</th>`), th)
  assert.match(html, /Tick CPU per player/)
  assert.match(html, /settle capped/)
  assert.match(html, /views incomplete/)
  assert.match(html, /invalid: interference: foreign mean/)
  assert.match(html, /tick-counter TPS/)
  assert.match(html, /id="tl-1-tickcpu-clip"/)
  assert.match(html, /id="tl-1-foreign-clip"/)
  assert.match(html, /foreign on server CPUs/)
})

test('older run renders without the new panels or columns', async () => {
  const fx = await generateRun(join(root, 'old'), { seed: 1 })
  const a = analyze(await loadRun(fx.dir))
  assert.deepEqual(a.timeline.counterTps, [])
  assert.deepEqual(a.timeline.tickCpu, [])
  assert.equal(a.derived.tickCpuPerPlayer, undefined)
  assert.ok(a.threats.some((t) => t.id === 'provenance' && t.level === 'info'))
  assert.ok(a.publishable)
  const html = renderHtml(a)
  clean(html)
  assert.match(html, /<section id="provenance"/)
  assert.match(html, /not recorded/)
  assert.doesNotMatch(html, /id="chart-tickcpu"/)
  assert.doesNotMatch(html, />counter TPS<\/th>/)
  assert.doesNotMatch(html, /id="tl-1-foreign-clip"/)
  // The checked-in example fixtures' shape (loadgen saturation) still marks steps invalid.
  const sat = analyze(await loadRun((await generateRun(join(root, 'sat'), { seed: 1, saturateAbove: 25 })).dir))
  const inv = sat.steps.filter((s) => s.invalid)
  assert.ok(inv.length > 0)
  assert.deepEqual(inv[0]!.invalidReasons, ['loadgen saturated'])
})

test('result.json repeats[] give statuses when there are no repeat envelopes', async () => {
  const fx = await generateRun(join(root, 'resrep'), { extended: true, seed: 6, repeatMarks: false })
  const result = JSON.parse(await readFile(join(fx.dir, RUN_FILES.result), 'utf8'))
  result.repeats[1].status = 'server_failed'
  result.repeats[1].statusReasons = ['watchdog: no tick for 30 s']
  result.invalidLimited = true
  await writeFile(join(fx.dir, RUN_FILES.result), JSON.stringify(result))
  const a = analyze(await loadRun(fx.dir))
  assert.deepEqual(a.headline.repeats.map((r) => r.status), ['ok', 'server_failed', 'ok'])
  assert.deepEqual(a.headline.repeats[1]!.reasons, ['watchdog: no tick for 30 s'])
  assert.equal(a.headline.kOk, 2)
  assert.equal(a.headline.invalidLimited, true)
  assert.ok(a.threats.some((t) => t.id === 'invalid-limited'))
  assert.match(renderHtml(a), /invalid-limited/)
})

test('compare: new metrics with complete separation, tick CPU per player, warnings', async () => {
  const a = await run({ seed: 1, capacities: [38, 40, 42] })
  const b = await run({ seed: 2, name: 'tuned', capacities: [54, 56, 58], tickCpuScale: 0.7 })
  const c = compareRuns(a, b)
  const keys = new Set(c.rows.map((r) => r.metric.key))
  for (const k of ['counterTps', 'tickCpuMsPerTick', 'viewT90']) assert.ok(keys.has(k), k)
  const cpu = c.rows.find((r) => r.metric.key === 'tickCpuMsPerTick' && r.players === 30)!
  assert.equal(cpu.metric.better, 'lower')
  assert.equal(cpu.verdict, 'better')
  const slope = c.derived.find((r) => r.metric.key === 'tickCpuPerPlayer')!
  assert.equal(slope.metric.better, 'lower')
  assert.equal(slope.verdict, 'better')
  assert.equal(c.rows.find((r) => r.metric.key === 'counterTps')!.metric.better, 'higher')
  assert.equal(c.rows.find((r) => r.metric.key === 'viewT90')!.metric.better, 'lower')
  assert.deepEqual(c.warnings, [])
  const html = renderCompareHtml(c)
  clean(html)
  assert.match(html, /tick CPU per player/)
  assert.match(html, /cmp-tickCpuMsPerTick-clip/)

  // vcpu and a dirty harness warn but do not refuse (the fingerprint differs, so force).
  const v = await run({ seed: 3, placementKind: 'vcpu', dirty: true, metaExtra: { machine: { fingerprint: '1a2b3c4d5e6f7a8b' } } })
  const w = compareRuns(a, v)
  assert.ok(w.warnings.some((x) => x.key === 'placementKind'))
  assert.ok(w.warnings.some((x) => x.key === 'harnessDirty'))
  const wh = renderCompareHtml(w)
  clean(wh)
  assert.match(wh, /Comparison warnings/)
  assert.match(wh, /virtual CPUs/)
  assert.match(wh, /dirty harness/)
  assert.match(wh, /st invalid">warning/)

  // A different machine fingerprint refuses unless forced.
  const other = await run({ seed: 4, placementKind: 'vcpu' })
  assert.throws(() => compareRuns(a, other), (err: unknown) => err instanceof IncomparableRunsError && err.mismatches.some((m) => m.key === 'machineFingerprint'))
  assert.equal(compareRuns(a, other, { force: true }).forced, true)
})

test('cpuList compresses ranges', () => {
  assert.equal(cpuList([0, 1, 2, 3, 8, 10, 11]), '0-3,8,10-11 (7)')
  assert.equal(cpuList('auto'), 'auto')
  assert.equal(cpuList([]), undefined)
  assert.equal(cpuList(undefined), undefined)
})
