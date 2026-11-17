import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { RUN_FILES } from '@bedperf/core'
import { analyze } from './analyze.ts'
import { compareRuns, renderCompareHtml } from './compare.ts'
import { generateRun } from './fixtures.ts'
import { renderHtml } from './html.ts'
import { loadRun } from './load.ts'
import { writeCompare, writeReport } from './write.ts'

const root = await mkdtemp(join(tmpdir(), 'bedperf-report-html-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

/** Structural checks shared by every rendered page. */
function checkHtml (html: string): void {
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.trimEnd().endsWith('</html>'))
  const open = (html.match(/<svg[\s>]/g) ?? []).length
  const close = (html.match(/<\/svg>/g) ?? []).length
  assert.equal(open, close, 'every <svg> closes')
  // Only text content and attribute values matter, but the whole document must be free of these.
  assert.doesNotMatch(html, /NaN|undefined|Infinity/)
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b/i, 'no external resources or scripts')
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, 'no external URLs')
  assert.ok(html.length < 2 * 1024 * 1024)
}

test('renderHtml has all sections and charts', async () => {
  const a = analyze(await loadRun((await generateRun(join(root, 'a'), { seed: 1 })).dir))
  const html = renderHtml(a)
  checkHtml(html)
  for (const id of ['headline', 'metadata', 'scaling', 'timeline', 'steps', 'methodology']) {
    assert.match(html, new RegExp(`<section id="${id}"`), id)
  }
  assert.match(html, /Max players @ 20 TPS/)
  assert.match(html, new RegExp(`<div class="value">${a.headline.maxPlayersMedian}</div>`))
  assert.match(html, /1\.26\.63\.1/)
  assert.match(html, /AMD Ryzen 9 7950X/)
  assert.match(html, /view-distance/)
  assert.match(html, /prefers-color-scheme: dark/)
  for (const id of ['chart-tps', 'chart-util', 'chart-rss', 'chart-rtt']) assert.match(html, new RegExp(`id="${id}"`))
  // 4 scaling charts + 3 panels per repeat.
  assert.equal((html.match(/<svg /g) ?? []).length, 4 + 3 * 3)
  assert.match(html, />20 TPS</)
  assert.match(html, />util 1\.0</)
  assert.match(html, /class="band band-pass"/)
  assert.match(html, /class="band band-fail"/)
  // One table row per step.
  assert.equal((html.match(/<tr>\n<td>/g) ?? []).length, a.steps.length)
})

test('renderHtml shows repeat statuses and k/n ok', async () => {
  const fx = await generateRun(join(root, 'statuses'), {
    seed: 4,
    repeatOutcomes: { 2: { aborted: 'server exited with code 3221225477' } },
    metaExtra: { configSha256: 'abc123', machine: { fingerprint: 'fp-1' } }
  })
  const a = analyze(await loadRun(fx.dir))
  const html = renderHtml(a)
  checkHtml(html)
  assert.match(html, /2\/3 repeats ok/)
  assert.match(html, /1 repeat server_failed/)
  assert.match(html, /server exited with code 3221225477/)
  assert.match(html, /<details class="repeats" open>/)
  assert.match(html, /abc123/)
  assert.match(html, /fp-1/)
  assert.match(html, /analysis version 3/)
})

test('renderHtml escapes user strings', async () => {
  const evil = '<script>alert("x")</script>&<img src=x onerror=alert(1)>'
  const fx = await generateRun(join(root, 'evil'), { seed: 2, name: evil, runId: '"><svg onload=alert(1)>' })
  const a = analyze(await loadRun(fx.dir))
  a.steps[0]!.failReasons = ['<b>bad</b>']
  const html = renderHtml(a)
  checkHtml(html)
  assert.ok(!html.includes(evil))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<svg onload'))
  assert.ok(!html.includes('<b>bad</b>'))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&lt;img'))
})

test('renderHtml with missing data renders dashes, not NaN/undefined', async () => {
  const fx = await generateRun(join(root, 'sparse'), { seed: 3, noSys: true, aborted: true })
  const run = await loadRun(fx.dir)
  const html = renderHtml(analyze(run))
  checkHtml(html)
  assert.match(html, /aborted/)
  assert.match(html, /No data/)

  run.steps = []
  run.stepMarks = []
  run.probe = []
  run.bot = []
  const empty = renderHtml(analyze(run))
  checkHtml(empty)
  assert.match(empty, /No steps recorded/)
})

test('compareRuns: deltas, verdicts and matched player counts', async () => {
  const a = analyze(await loadRun((await generateRun(join(root, 'cmpA'), { seed: 1 })).dir))
  const b = analyze(await loadRun((await generateRun(join(root, 'cmpB'), { seed: 1, name: 'tuned', capacity: 50, memPerPlayerBytes: 6 * 1024 * 1024 })).dir))
  const c = compareRuns(a, b)
  assert.equal(c.headline.delta, b.headline.maxPlayersMedian! - a.headline.maxPlayersMedian!)
  assert.equal(c.headline.verdict, 'better')
  const mem = c.derived.find((r) => r.metric.key === 'memPerPlayer')!
  assert.equal(mem.verdict, 'better')
  assert.ok(mem.pct! < -20)
  assert.ok(c.players.length > 0)
  for (const p of c.players) {
    assert.ok(Number.isInteger(p))
    assert.ok(p >= 10)
  }
  // Higher capacity → lower util at the same player count.
  const util = c.rows.filter((r) => r.metric.key === 'util' && r.players === 30)
  assert.equal(util.length, 1)
  assert.equal(util[0]!.verdict, 'better')

  assert.equal(c.headline.chance, 1 / 20)

  const self = compareRuns(a, a)
  assert.equal(self.headline.verdict, 'not separated')
  assert.ok(self.rows.every((r) => r.verdict === 'not separated' || r.verdict === 'n/a' || r.verdict === 'insufficient repeats'))

  const html = renderCompareHtml(c)
  checkHtml(html)
  for (const id of ['headline', 'comparability', 'derived', 'scaling', 'metrics', 'decision-rule', 'methodology']) assert.match(html, new RegExp(`<section id="${id}"`))
  assert.match(html, /class="l better"/)
  assert.match(html, /chance 1\/20/)
  assert.match(html, /3\/3 repeats ok/)
})

test('writeReport and writeCompare write files', async () => {
  const a = await generateRun(join(root, 'wA'), { seed: 6 })
  const b = await generateRun(join(root, 'wB'), { seed: 8 })
  const report = await writeReport(a.dir)
  assert.equal(report, join(a.dir, RUN_FILES.report))
  checkHtml(await readFile(report, 'utf8'))
  const out = await writeCompare(a.dir, b.dir, join(root, 'out', 'compare.html'))
  checkHtml(await readFile(out, 'utf8'))
  assert.ok((await stat(out)).size > 1000)
})
