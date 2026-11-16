import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { RUN_FILES } from '@bedperf/core'
import { analyze, ANALYSIS_VERSION } from './analyze.ts'
import { generateRun } from './fixtures.ts'
import { loadRun, parseRepeatEnd } from './load.ts'

const MiB = 1024 * 1024
const root = await mkdtemp(join(tmpdir(), 'bedperf-report-analyze-'))
after(async () => { await rm(root, { recursive: true, force: true }) })

test('loadRun + analyze on a synthetic run', async () => {
  const fx = await generateRun(join(root, 'a'), { seed: 3 })
  const run = await loadRun(fx.dir)
  assert.equal(run.steps.length, fx.steps.length)
  assert.ok(run.probe.length > 100)
  assert.ok(run.sys.length > 100)
  assert.equal(run.badLines, 0)
  assert.deepEqual(run.otherKinds, { 'bds.log': 1, 'orch.custom.future': 1 })

  const a = analyze(run)
  assert.equal(a.headline.source, 'result')
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers)
  assert.equal(a.headline.maxPlayersMedian, fx.result.maxPlayersMedian)
  assert.equal(a.headline.min, Math.min(...fx.result.maxPlayers))
  assert.equal(a.headline.spread, Math.max(...fx.result.maxPlayers) - Math.min(...fx.result.maxPlayers))
  assert.equal(a.headline.aborted, false)
  // Capacity ~40 ± noise: the search lands near it.
  assert.ok(a.headline.maxPlayersMedian! >= 30 && a.headline.maxPlayersMedian! <= 50, String(a.headline.maxPlayersMedian))

  // Model: 9 MiB per player, 24 kB/s tx per player, util slope (0.98 - 0.12) / ~40.
  const mem = a.derived.memPerPlayer!
  assert.ok(Math.abs(mem.slope / MiB - 9) < 0.5, `mem slope ${mem.slope / MiB}`)
  assert.ok(Math.abs(a.derived.netTxPerPlayer!.slope - 24_000) < 1500)
  const util = a.derived.utilPerPlayer!
  assert.ok(util.slope > 0.017 && util.slope < 0.026, `util slope ${util.slope}`)
  assert.ok(a.derived.playersAtUtil1! > 34 && a.derived.playersAtUtil1! < 50, `players@util1 ${a.derived.playersAtUtil1}`)

  // Curves: one per repeat, sorted by players, plus a mean curve.
  assert.equal(a.curves.length, 3)
  for (const c of a.curves) {
    const ps = c.points.map((p) => p.players)
    assert.deepEqual(ps, [...ps].sort((x, y) => x - y))
    assert.ok(c.points.every((p) => p.values.tps !== undefined && p.values.util !== undefined))
  }
  assert.ok(a.meanCurve.points.length >= a.curves[0]!.points.length)

  // Timeline: bands from orch.step.* envelopes, matching the steps and their status.
  assert.equal(a.timeline.bands.length, fx.steps.length)
  assert.equal(a.timeline.bands.filter((b) => b.status === 'pass').length, fx.steps.filter((s) => s.pass).length)
  assert.equal(a.timeline.repeats.length, 3)
  assert.ok(a.timeline.tps.length > 0 && a.timeline.util.length > 0 && a.timeline.players.length > 0)
  for (let i = 1; i < a.timeline.repeats.length; i++) {
    assert.equal(a.timeline.repeats[i]!.x0, a.timeline.repeats[i - 1]!.x1)
  }
})

test('missing result.json: headline recomputed from steps', async () => {
  const fx = await generateRun(join(root, 'aborted'), { seed: 5, aborted: true })
  const a = analyze(await loadRun(fx.dir))
  assert.equal(a.headline.source, 'steps')
  assert.equal(a.headline.aborted, true)
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers)
  assert.equal(a.headline.maxPlayersMedian, fx.result.maxPlayersMedian)
  assert.ok(a.notes.some((n) => n.includes('result.json')))
})

test('missing sysmon data and malformed lines are tolerated', async () => {
  const fx = await generateRun(join(root, 'nosys'), {
    seed: 9,
    noSys: true,
    extraLines: ['not json', '{"t":1}', '{"t":2,"src":"probe","kind":"probe.sample","data":null}', '']
  })
  const run = await loadRun(fx.dir)
  assert.equal(run.sys.length, 0)
  assert.equal(run.badLines, 3)
  const a = analyze(run)
  assert.equal(a.derived.memPerPlayer, undefined)
  assert.equal(a.derived.utilPerPlayer, undefined)
  assert.equal(a.derived.playersAtUtil1, undefined)
  assert.equal(a.timeline.util.length, 0)
  assert.ok(a.steps.every((s) => s.utilMean === undefined && s.rssMean === undefined))
  assert.ok(a.notes.some((n) => n.includes('malformed')))
})

test('steps.json missing: steps recovered from orch.step.end payloads', async () => {
  const fx = await generateRun(join(root, 'nosteps'), { seed: 2, aborted: true })
  await unlink(join(fx.dir, RUN_FILES.steps))
  const a = analyze(await loadRun(fx.dir))
  assert.equal(a.steps.length, fx.steps.length)
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers)
  assert.equal(a.timeline.bands.length, fx.steps.length)
  assert.ok(a.timeline.bands.every((b) => b.status === 'pass' || b.status === 'fail'))
})

test('no steps at all: empty headline, no crash', async () => {
  const fx = await generateRun(join(root, 'empty'), { seed: 2, aborted: true })
  const run = await loadRun(fx.dir)
  run.steps = []
  run.stepMarks = []
  run.repeatStarts = []
  run.repeatEnds = []
  const a = analyze(run)
  assert.equal(a.steps.length, 0)
  assert.equal(a.headline.n, 0)
  assert.equal(a.headline.maxPlayersMedian, undefined)
  assert.equal(a.timeline.bands.length, 0)
  assert.equal(a.timeline.repeats.length, 1)
})

test('loadgen-saturated steps are flagged invalid', async () => {
  const fx = await generateRun(join(root, 'sat'), { seed: 4, saturateAbove: 25 })
  const a = analyze(await loadRun(fx.dir))
  assert.equal(a.headline.loadgenLimited, true)
  assert.ok(a.steps.some((s) => s.invalid))
  assert.ok(a.timeline.bands.some((b) => b.status === 'invalid'))
})

test('repeat statuses: server_failed and invalid repeats are shown but kept out of the median', async () => {
  const fx = await generateRun(join(root, 'statuses'), {
    seed: 7,
    repeats: 5,
    repeatOutcomes: {
      2: { aborted: 'server exited unexpectedly' },
      4: { status: 'invalid', statusReasons: ['clock jump detected'] },
      5: { nullOutcome: true }
    }
  })
  const run = await loadRun(fx.dir)
  assert.equal(run.repeatEnds.length, 5)
  assert.deepEqual(run.repeatStarts, [1, 2, 3, 4, 5])
  assert.deepEqual(run.otherKinds, { 'bds.log': 1, 'orch.custom.future': 1 })
  const a = analyze(run)
  const h = a.headline
  assert.equal(h.kOk, 2)
  assert.equal(h.n, 5)
  assert.deepEqual(h.statusCounts, { ok: 2, server_failed: 1, invalid: 2 })
  assert.deepEqual(h.repeats.map((r) => r.status), ['ok', 'server_failed', 'ok', 'invalid', 'invalid'])
  assert.deepEqual(h.repeats[1]!.reasons, ['server exited unexpectedly'])
  assert.deepEqual(h.repeats[3]!.reasons, ['clock jump detected'])
  assert.deepEqual(h.repeats[4]!.reasons, ['repeat ended without a search result'])
  // Every repeat keeps its value; only ok ones enter the median.
  assert.deepEqual(h.repeats.map((r) => r.maxPlayers), fx.result.maxPlayers)
  const ok = [fx.result.maxPlayers[0]!, fx.result.maxPlayers[2]!]
  assert.deepEqual(h.perRepeat, ok)
  assert.equal(h.maxPlayersMedian, (ok[0]! + ok[1]!) / 2)
  assert.equal(h.min, Math.min(...ok))
  assert.deepEqual(a.okRepeats, [1, 3])
  assert.deepEqual(a.repeatDerived.map((r) => r.repeat), [1, 3])
  assert.equal(a.curves.length, 5)
  assert.equal(a.analysisVersion, ANALYSIS_VERSION)
  assert.ok(a.notes.some((n) => n.includes('2/5 repeats ok') && n.includes('server_failed')))
})

test('0-based repeat numbers (as the orchestrator writes them) map onto result.json by position', async () => {
  for (const repeatMarks of [true, false]) {
    const fx = await generateRun(join(root, `zero-${repeatMarks}`), { seed: 3, repeatBase: 0, repeatMarks, repeatOutcomes: { 1: { aborted: 'crash' } } })
    const h = analyze(await loadRun(fx.dir)).headline
    assert.deepEqual(h.repeats.map((r) => r.repeat), [0, 1, 2])
    assert.deepEqual(h.repeats.map((r) => r.maxPlayers), fx.result.maxPlayers)
    assert.equal(h.n, 3)
    assert.equal(h.kOk, repeatMarks ? 2 : 3)
    assert.deepEqual(h.incompleteRepeats, [])
  }
})

test('explicit outcome.status wins over aborted', async () => {
  const fx = await generateRun(join(root, 'explicit'), { seed: 7, repeatOutcomes: { 1: { aborted: 'x', status: 'ok' } } })
  const a = analyze(await loadRun(fx.dir))
  assert.equal(a.headline.repeats[0]!.status, 'ok')
  assert.equal(a.headline.kOk, 3)
})

test('a repeat that never ended is invalid (incomplete)', async () => {
  const fx = await generateRun(join(root, 'noend'), { seed: 5, aborted: true, repeatOutcomes: { 3: { noEnd: true } } })
  const a = analyze(await loadRun(fx.dir))
  assert.deepEqual(a.headline.incompleteRepeats, [3])
  assert.equal(a.headline.repeats[2]!.status, 'invalid')
  assert.match(a.headline.repeats[2]!.reasons[0]!, /never ended/)
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers.slice(0, 2))
  assert.equal(a.headline.kOk, 2)
})

test('parseRepeatEnd reads payloads defensively', () => {
  assert.equal(parseRepeatEnd(1, null), undefined)
  assert.equal(parseRepeatEnd(1, { outcome: {} }), undefined)
  assert.deepEqual(parseRepeatEnd(1, { repeat: 2, outcome: null }), { t: 1, repeat: 2, hasOutcome: false, statusReasons: [] })
  const e = parseRepeatEnd(5, { repeat: 1, outcome: { status: 'weird', statusReasons: ['a', 3], maxPlayers: 40, aborted: 'boom' } })!
  assert.equal(e.status, undefined)
  assert.deepEqual(e.statusReasons, ['a', '3'])
  assert.equal(e.maxPlayers, 40)
  assert.equal(e.aborted, 'boom')
})

test('aborted mid-repeat (older run without repeat envelopes): the unfinished repeat is left out of the headline', async () => {
  const fx = await generateRun(join(root, 'midrepeat'), { seed: 5, aborted: true, repeatMarks: false })
  // Keep only the first ramp step of repeat 3, as if the run died right after it.
  const kept = fx.steps.filter((s) => s.repeat < 3 || s.index === 0)
  await writeFile(join(fx.dir, RUN_FILES.steps), JSON.stringify(kept))
  const a = analyze(await loadRun(fx.dir))
  assert.deepEqual(a.headline.incompleteRepeats, [3])
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers.slice(0, 2))
  assert.ok(a.notes.some((n) => n.includes('repeat 3 invalid (search did not finish)')))
})

test('truncated result.json is treated as missing', async () => {
  const fx = await generateRun(join(root, 'truncated'), { seed: 5 })
  const file = join(fx.dir, RUN_FILES.result)
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.slice(0, 20))
  const a = analyze(await loadRun(fx.dir))
  assert.equal(a.headline.source, 'steps')
  assert.deepEqual(a.headline.perRepeat, fx.result.maxPlayers)
  assert.ok(a.notes.some((n) => n.includes('could not be parsed')))
})

test('step marks without repeat/index are matched to steps by time', async () => {
  const fx = await generateRun(join(root, 'nokeys'), { seed: 6 })
  const run = await loadRun(fx.dir)
  for (const m of run.stepMarks) m.data = { players: m.data.players }
  const a = analyze(run)
  assert.equal(a.timeline.bands.length, fx.steps.length)
  for (const b of a.timeline.bands) {
    const s = fx.steps.find((x) => x.repeat === b.repeat && x.index === b.index)!
    assert.ok(s !== undefined)
    assert.equal(b.status, s.pass ? 'pass' : 'fail')
  }
})

test('loadRun rejects a directory without config.json', async () => {
  await assert.rejects(loadRun(join(root, 'does-not-exist')), /config\.json/)
})
