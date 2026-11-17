import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SERVER_PRESET_NAMES } from '@bedperf/core'
import type { ServerPresetName } from '@bedperf/core'
import { analyze } from './analyze.ts'
import { comparability, compareRuns, IncomparableRunsError, renderCompareHtml } from './compare.ts'
import { generateRun, remoteTopologyFixture } from './fixtures.ts'
import type { FixtureOptions } from './fixtures.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'
import { compareMatrix, renderMatrixHtml } from './matrix.ts'
import type { Analysis } from './types.ts'
import { writeCompareMatrix } from './write.ts'

const root = await mkdtemp(join(tmpdir(), 'bedperf-report-flavors-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

function checkHtml (html: string): void {
  assert.ok(html.startsWith('<!doctype html>'))
  assert.equal((html.match(/<svg[\s>]/g) ?? []).length, (html.match(/<\/svg>/g) ?? []).length)
  assert.doesNotMatch(html, /NaN|undefined|Infinity/)
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b/i)
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
}

let n = 0
const dirs = new Map<Analysis, string>()
async function run (opts: FixtureOptions): Promise<Analysis> {
  const fx = await generateRun(join(root, `r${n++}`), { extended: true, ...opts })
  const an = analyze(await loadRun(fx.dir))
  dirs.set(an, fx.dir)
  return an
}

test('every server preset: server panel, label in the headline, flavor threats', async () => {
  for (const [i, preset] of SERVER_PRESET_NAMES.entries()) {
    const a = await run({ seed: i + 1, server: preset, os: preset === 'endstone' ? 'linux' : undefined })
    const s = a.server!
    assert.equal(s.recorded, true)
    assert.ok(s.buildSha256 !== undefined && s.specSha256 !== undefined)
    assert.equal(s.versions[0]![0], 'bds')
    const ids = a.threats.map((t) => t.id)
    assert.equal(ids.includes('wine'), preset.endsWith('-wine'), preset)
    assert.equal(ids.includes('allocator'), preset === 'endstone', preset)
    assert.equal(ids.includes('loader-config'), preset.startsWith('levilamina'), preset)
    if (preset.startsWith('levilamina')) {
      assert.ok(s.loaderOverrides.some((o) => o.path === 'modules.enableStatistics' && o.value === 'false' && o.source === 'neutral'))
      assert.ok(s.loaderConfig !== undefined)
    }
    if (preset.includes('levioptimize')) assert.ok(s.artifacts.some((x) => x.name === 'levioptimize'))
    const html = renderHtml(a)
    checkHtml(html)
    assert.match(html, /<section id="server"/)
    assert.ok(html.includes(`<h1>bedperf report: walk-default on ${s.label}</h1>`), preset)
    assert.match(html, /<section id="topology"/)
  }
})

test('old run without server/topology: vanilla BDS, local, loopback threat kept', async () => {
  const a = analyze(await loadRun((await generateRun(join(root, 'old'), { seed: 1 })).dir))
  assert.equal(a.server?.label, 'bds')
  assert.equal(a.server?.recorded, false)
  assert.equal(a.topology?.mode, 'local')
  assert.ok(a.threats.some((t) => t.id === 'loopback'))
  const html = renderHtml(a)
  checkHtml(html)
  assert.match(html, /No server build recorded/)
})

test('remote topology: agents, telemetry, saturated interval, lost event, no loopback warning', async () => {
  const a = await run({ seed: 4, server: 'bds', topology: remoteTopologyFixture() })
  const t = a.topology!
  assert.equal(t.mode, 'remote')
  assert.equal(t.agents.length, 2)
  assert.match(t.sha256!, /^[0-9a-f]{64}$/)
  const [x, y] = t.agents
  assert.equal(x!.lost, 1)
  assert.equal(x!.saturatedSamples, 0)
  assert.ok(y!.saturatedSamples > 0)
  assert.equal(y!.link?.rttMedianMs, 0.41)
  assert.equal(t.series.length, 2)
  assert.equal(t.series[1]!.saturated.length, 1)
  assert.ok(t.steps.length > 0)
  assert.ok(t.steps.some((s) => s.agents.some((z) => z.agent === y!.name && z.saturated)))
  assert.ok(t.steps.every((s) => s.agents.every((z) => z.maxTotalCores !== undefined)))
  assert.equal(t.links.filter((l) => l.event === 'lost').length, 1)
  const ids = a.threats.map((th) => th.id)
  for (const id of ['remote-network', 'agent-saturated', 'agent-lost']) assert.ok(ids.includes(id), id)
  assert.ok(!ids.includes('loopback') && !ids.includes('colocated'))
  assert.match(a.threats.find((th) => th.id === 'remote-network')!.text, /0\.34 ms \[0\.21, 0\.92\]/)
  // The agent envelopes are read, not ignored.
  assert.ok(!a.notes.some((no) => no.includes('agent.telemetry')))
  const html = renderHtml(a)
  checkHtml(html)
  assert.match(html, /<h2>Topology: remote \(2 agents\)/)
  assert.match(html, /Agent load per step/)
  assert.match(html, /lost at/)
  assert.match(html, /saturated/)
})

test('implementation comparison: different servers on the same setup compare; machine or topology mismatch refuses', async () => {
  const bds = await run({ seed: 1, server: 'bds', capacities: [38, 40, 42] })
  const ll = await run({ seed: 2, server: 'levilamina', capacities: [44, 46, 48] })
  const checks = comparability(bds, ll)
  assert.equal(checks.find((k) => k.key === 'configSha256')!.status, 'match')
  assert.equal(checks.find((k) => k.key === 'configSha256')!.label, 'benchmark config hash')
  assert.equal(checks.find((k) => k.key === 'server')!.status, 'differs')
  assert.equal(checks.find((k) => k.key === 'serverBuildSha256')!.status, 'differs')
  assert.equal(checks.find((k) => k.key === 'topology')!.status, 'match')
  const c = compareRuns(bds, ll)
  assert.equal(c.implementation, true)
  assert.equal(c.forced, false)
  assert.equal(c.headline.verdict, 'better')
  const html = renderCompareHtml(c)
  checkHtml(html)
  assert.match(html, /Implementation comparison/)
  assert.match(html, /differs \(implementation comparison\)/)

  // Wine runs on a Linux host: a different machine fingerprint refuses.
  const wine = await run({ seed: 3, server: 'levilamina-wine' })
  assert.throws(() => compareRuns(bds, wine), (err: unknown) => err instanceof IncomparableRunsError && err.mismatches.some((m) => m.key === 'machineFingerprint'))
  assert.equal(compareRuns(bds, wine, { force: true }).forced, true)

  // Local vs remote bots: topology mismatch.
  const remote = await run({ seed: 4, server: 'levilamina', topology: remoteTopologyFixture() })
  assert.throws(() => compareRuns(ll, remote), /topology differs/)

  // Same server spec, different build bytes: the build check refuses.
  const rebuilt = await run({ seed: 5, server: 'levilamina', metaExtra: { server: { ...ll.meta.server!, buildSha256: 'f'.repeat(64) } } })
  assert.throws(() => compareRuns(ll, rebuilt), (err: unknown) => err instanceof IncomparableRunsError && err.mismatches.map((m) => m.key).join() === 'serverBuildSha256')

  // Same server spec, different effective loader config: refused (the spec hash leaves it out).
  const tuned = await run({ seed: 8, server: 'levilamina', metaExtra: { server: { ...ll.meta.server!, loaderConfig: { modules: { enableStatistics: false, tickRate: 30 } } } } })
  assert.throws(() => compareRuns(ll, tuned), (err: unknown) => err instanceof IncomparableRunsError && err.mismatches.map((m) => m.key).join() === 'loaderConfig')

  // A forced comparison is never labelled an implementation comparison.
  const forced = compareRuns(bds, wine, { force: true })
  assert.equal(forced.implementation, false)
  assert.doesNotMatch(renderCompareHtml(forced), /id="implementation"/)

  // An older run (no server, no benchConfigSha256) of the same benchmark: its configSha256 is the
  // benchmark hash, so it compares with a new LeviLamina run as an implementation comparison.
  const old = await run({ seed: 9, server: 'bds', metaExtra: { server: undefined, benchConfigSha256: undefined, configSha256: bds.meta.benchConfigSha256 } })
  const co = compareRuns(old, ll)
  assert.equal(co.implementation, true)
  assert.equal(co.comparability.find((k) => k.key === 'configSha256')!.status, 'match')

  // Different allocators are a comparison warning.
  const endstone = await run({ seed: 6, server: 'endstone', os: 'linux' })
  const wl = await run({ seed: 7, server: 'levilamina-wine' })
  const cw = compareRuns(endstone, wl)
  assert.ok(cw.warnings.some((w) => w.key === 'allocator'))
  assert.ok(cw.warnings.some((w) => w.key === 'runtime'))
})

test('matrix compare: pairwise verdicts, ranking, labels by server', async () => {
  const caps: Array<[ServerPresetName, number[]]> = [['bds', [38, 40, 42]], ['levilamina', [45, 47, 49]], ['levilamina-levioptimize', [54, 56, 58]], ['endstone', [30, 31, 32]]]
  const ans = await Promise.all(caps.map(([server, capacities], i) => run({ seed: 10 + i, server, capacities })))
  const m = compareMatrix(ans)
  assert.equal(m.byServer, true)
  assert.equal(m.implementation, true)
  assert.deepEqual(m.runs.map((r) => r.label), ['bds', 'levilamina', 'levilamina+levioptimize', 'endstone'])
  assert.equal(m.pairs.length, 6)
  assert.equal(m.headline.cells[0]![0], undefined)
  // levioptimize (row 2) beats every other run; endstone (row 3) loses to every other run.
  assert.ok([0, 1, 3].every((j) => m.headline.cells[2]![j]!.verdict === 'better'))
  assert.ok([0, 1, 2].every((j) => m.headline.cells[3]![j]!.verdict === 'worse'))
  assert.equal(m.headline.cells[2]![0]!.chance, 1 / 20)
  // Antisymmetric verdicts.
  assert.equal(m.headline.cells[0]![2]!.verdict, 'worse')
  assert.deepEqual(m.ranking.map((r) => r.label), ['levilamina+levioptimize', 'levilamina', 'bds', 'endstone'])
  assert.deepEqual(m.ranking[0]!.above.sort(), [0, 1, 3])
  assert.ok(m.players !== undefined && m.curves.length > 0)
  const html = renderMatrixHtml(m)
  checkHtml(html)
  for (const id of ['headline', 'ranking', 'comparability', 'matrix', 'scaling', 'decision-rule']) assert.match(html, new RegExp(`<section id="${id}"`), id)
  assert.match(html, /Implementation comparison/)

  const out = join(root, 'matrix.html')
  const res = await writeCompareMatrix(ans.map((an) => dirs.get(an)!), out)
  assert.equal(res.comparison.runs.length, 4)
  assert.match(await readFile(out, 'utf8'), /Pairwise verdicts/)

  // One run on another machine: refused, naming the pair; force labels by config name.
  const other = await run({ seed: 20, server: 'levilamina-wine' })
  assert.throws(() => compareMatrix([...ans, other]), (err: unknown) => err instanceof IncomparableRunsError && err.mismatches.some((x) => x.key === 'machineFingerprint' && x.label.includes('on levilamina (wine)')))
  const forced = compareMatrix([ans[0]!, other, ans[1]!], { force: true })
  assert.equal(forced.forced, true)
  assert.equal(forced.byServer, false)
  checkHtml(renderMatrixHtml(forced))
  assert.match(renderMatrixHtml(forced), /These runs are not comparable/)
})
