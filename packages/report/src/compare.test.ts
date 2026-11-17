import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { analyze } from './analyze.ts'
import { compareRuns, compareValues, comparability, delta, fmtChance, IncomparableRunsError, renderCompareHtml } from './compare.ts'
import { generateRun } from './fixtures.ts'
import type { FixtureOptions } from './fixtures.ts'
import { loadRun } from './load.ts'
import type { Analysis } from './types.ts'
import { writeCompare } from './write.ts'

const root = await mkdtemp(join(tmpdir(), 'bedperf-report-compare-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

const SAME = { configSha256: 'cfg-1', machine: { fingerprint: 'fp-1' }, analysisVersion: 1, bdsBuildSha256: 'bds-1', placement: { profileSha256: 'pl-1' } }

let n = 0
const dirs = new Map<Analysis, string>()
async function run (opts: FixtureOptions): Promise<Analysis> {
  const fx = await generateRun(join(root, `r${n++}`), { metaExtra: SAME, ...opts })
  const an = analyze(await loadRun(fx.dir))
  dirs.set(an, fx.dir)
  return an
}

test('compareValues: complete separation, overlap, insufficient repeats', () => {
  const sep = compareValues([30, 32, 34], [40, 42, 44], 'higher')
  assert.equal(sep.verdict, 'better')
  assert.equal(sep.chance, 1 / 20)
  assert.equal(sep.a, 32)
  assert.equal(sep.b, 42)
  assert.equal(sep.delta, 10)
  assert.deepEqual(sep.aRange, [30, 34])
  assert.deepEqual(sep.bRange, [40, 44])
  assert.equal(compareValues([30, 32, 34], [40, 42, 44], 'lower').verdict, 'worse')
  assert.equal(compareValues([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 'higher').chance, 1 / 252)

  const over = compareValues([30, 36, 34], [35, 42, 44], 'higher')
  assert.equal(over.verdict, 'not separated')
  assert.equal(over.chance, 1 / 20)
  // Touching ranges are not separated.
  assert.equal(compareValues([30, 32, 35], [35, 40, 41], 'higher').verdict, 'not separated')

  const few = compareValues([30], [40, 42, 44], 'higher')
  assert.equal(few.verdict, 'insufficient repeats')
  assert.equal(few.chance, undefined)
  assert.equal(few.delta, 12)
  assert.equal(compareValues([], [1, 2], 'higher').verdict, 'n/a')
  assert.equal(delta(1, 2, 'higher').verdict, 'insufficient repeats')
  assert.equal(delta(undefined, 2, 'higher').verdict, 'n/a')
  assert.equal(fmtChance(1 / 20), '1/20')
  assert.equal(fmtChance(undefined), '–')
})

test('3 ok vs 3 ok, fully separated: better, chance 1/20', async () => {
  const a = await run({ seed: 1, capacities: [38, 40, 42] })
  const b = await run({ seed: 2, name: 'tuned', capacities: [54, 56, 58] })
  const c = compareRuns(a, b)
  assert.equal(c.headline.verdict, 'better')
  assert.equal(c.headline.chance, 1 / 20)
  assert.equal(c.headline.aValues.length, 3)
  assert.ok(c.comparability.every((k) => k.status === 'match' || (k.key === 'serverBuildSha256' && k.status === 'unverified')))
  assert.equal(c.forced, false)
  // Util at matched counts compares per-repeat values; higher capacity → lower util → better.
  const util = c.rows.filter((r) => r.metric.key === 'util')
  assert.ok(util.length > 0)
  for (const r of util) {
    assert.equal(r.aValues.length, 3)
    assert.equal(r.bValues.length, 3)
  }
  assert.ok(util.some((r) => r.verdict === 'better'))
  // Every matched count lies inside every ok repeat's measured range.
  for (const p of c.players) {
    for (const an of [a, b]) for (const cv of an.curves) assert.ok(p >= cv.points[0]!.players && p <= cv.points.at(-1)!.players)
  }
  const derivedUtil = c.derived.find((r) => r.metric.key === 'utilPerPlayer')!
  assert.equal(derivedUtil.aValues.length, 3)
  assert.equal(derivedUtil.verdict, 'better')

  const html = renderCompareHtml(c)
  assert.match(html, /better: every ok repeat of B is above every ok repeat of A \(3 v 3\)\. Chance of this with no real difference: 1\/20\./)
  assert.match(html, /<section id="decision-rule"/)
  assert.match(html, /3 v 3: 1\/20, 5 v 5: 1\/252/)
  assert.doesNotMatch(html, /class="banner"/)
})

test('overlapping repeats: not separated', async () => {
  const a = await run({ seed: 1, capacities: [36, 44, 40] })
  const b = await run({ seed: 2, capacities: [42, 38, 46] })
  const c = compareRuns(a, b)
  assert.equal(c.headline.verdict, 'not separated')
  assert.match(renderCompareHtml(c), /not separated: the ok repeats&#39; ranges overlap/)
})

test('a server_failed repeat is shown as k/n and excluded from the median', async () => {
  const a = await run({ seed: 1, capacities: [38, 40, 42] })
  const b = await run({ seed: 2, capacities: [54, 56, 58], repeatOutcomes: { 2: { aborted: 'server crashed' } } })
  assert.equal(b.headline.kOk, 2)
  const c = compareRuns(a, b)
  assert.equal(c.headline.bValues.length, 2)
  assert.deepEqual(c.headline.bValues, [b.headline.repeats[0]!.maxPlayers, b.headline.repeats[2]!.maxPlayers])
  assert.equal(c.headline.verdict, 'better')
  assert.equal(c.headline.chance, 1 / 10)
  const html = renderCompareHtml(c)
  assert.match(html, /2\/3 repeats ok/)
  assert.match(html, /server_failed/)

  const single = await run({ seed: 3, capacities: [50, 50, 50], repeatOutcomes: { 1: { aborted: 'x' }, 2: { status: 'invalid' } } })
  assert.equal(compareRuns(a, single).headline.verdict, 'insufficient repeats')
})

test('mismatched configSha256 throws; force renders a banner', async () => {
  const a = await run({ seed: 1 })
  const b = await run({ seed: 2, metaExtra: { ...SAME, configSha256: 'cfg-2' } })
  assert.throws(() => compareRuns(a, b), (err: unknown) => {
    assert.ok(err instanceof IncomparableRunsError)
    assert.deepEqual(err.mismatches.map((m) => m.key), ['configSha256'])
    assert.match(err.message, /config hash differs/)
    return true
  })
  const c = compareRuns(a, b, { force: true })
  assert.equal(c.forced, true)
  const html = renderCompareHtml(c)
  assert.match(html, /<div class="banner" role="alert"><b>These runs are not comparable\.<\/b> benchmark config hash differs/)
  assert.match(html, /MISMATCH/)

  // writeCompare refuses too, unless forced.
  const out = join(root, 'forced.html')
  await assert.rejects(writeCompare(dirs.get(a)!, dirs.get(b)!, out), IncomparableRunsError)
  await assert.rejects(stat(out))
  await writeCompare(dirs.get(a)!, dirs.get(b)!, out, { force: true })
  assert.match(await readFile(out, 'utf8'), /These runs are not comparable/)
})

test('missing comparability fields: cannot verify, still compares', async () => {
  const a = await run({ seed: 1, metaExtra: {} })
  const b = await run({ seed: 2 })
  const checks = comparability(a, b)
  assert.equal(checks.find((k) => k.key === 'configSha256')!.status, 'unverified')
  assert.equal(checks.find((k) => k.key === 'bdsVersion')!.status, 'match')
  const c = compareRuns(a, b)
  assert.equal(c.forced, false)
  assert.match(renderCompareHtml(c), /Cannot verify config hash/)
  // A differing bot version is a mismatch.
  const d = await run({ seed: 2, metaExtra: { ...SAME, botVersion: '9.9.9' } })
  assert.throws(() => compareRuns(b, d), /bot version differs/)
})
