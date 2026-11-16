import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inView, t90Rank, ViewTracker, VIEW_N, type BotViewSample } from './view.ts'
import { aggregateStats, aggregateView, censoredMedian, DEFAULT_SATURATION, nearestRank } from './aggregate.ts'
import type { WorkerStats } from './protocol.ts'

test('t90Rank is ceil(0.9 U) in integers', () => {
  assert.deepEqual([1, 9, 10, 11, 100, 149].map(t90Rank), [1, 9, 9, 10, 90, 135])
  for (let u = 1; u < 500; u++) assert.equal(t90Rank(u), Math.ceil(0.9 * u - 1e-9))
})

test('inView: radius + 1, Euclidean', () => {
  assert.ok(inView(3, 0, 0, 0, 2))
  assert.ok(!inView(4, 0, 0, 0, 2))
  assert.ok(inView(2, 2, 0, 0, 2)) // 8 <= 9
  assert.ok(!inView(3, 1, 0, 0, 2)) // 10 > 9
  assert.ok(inView(1000, 0, 0, 0, Number.POSITIVE_INFINITY))
})

test('ViewTracker: uniq, in-view count and t90 from start_game', () => {
  const v = new ViewTracker()
  v.startGame(1000)
  // 10 columns in a row along x, arriving 10 ms apart from t=1010
  for (let i = 0; i < 10; i++) assert.ok(v.load('overworld', i, 0, 1010 + i * 10))
  assert.ok(!v.load('overworld', 3, 0, 5000), 're-load is not a new sighting')
  assert.ok(v.load('nether', 50, 50, 1200), 'other dimension is a new sighting')
  v.unload(50, 50)
  assert.equal(v.uniq, 11)
  // bot at chunk 0, radius 4: columns 0..5 are in view (U = 6), k = ceil(5.4) = 6 -> 6th arrival at 1060
  const s = v.sample(0, 0, 4, 2000)
  assert.equal(s.inView, 6)
  assert.equal(s.t90Ms, 60)
  assert.equal(s.tNCensored, true)
  assert.equal(s.tNMs, 1000)
  assert.equal(v.sample(0, 0, Number.POSITIVE_INFINITY, 2000).inView, 10)
})

test('ViewTracker: unloaded columns leave the view; a re-load is a new arrival', () => {
  const v = new ViewTracker()
  v.startGame(0)
  v.load('overworld', 0, 0, 10)
  v.load('overworld', 1, 0, 20)
  v.unload(0, 0)
  assert.equal(v.sample(0, 0, 2, 100).inView, 1)
  assert.ok(!v.load('overworld', 0, 0, 90))
  const s = v.sample(0, 0, 2, 100)
  assert.equal(s.inView, 2)
  assert.equal(s.t90Ms, 90)
  assert.equal(v.uniq, 2)
})

test('ViewTracker: a teleport after spawn restarts the view clock; columns already loaded count as 0', () => {
  const v = new ViewTracker()
  v.startGame(0)
  v.load('overworld', 0, 0, 100)
  v.teleport(500)
  v.load('overworld', 100, 100, 700)
  v.load('overworld', 101, 100, 800)
  assert.equal(v.origin, 500)
  const s = v.sample(100, 100, 2, 1000)
  assert.equal(s.inView, 2)
  assert.equal(s.t90Ms, 300) // k = 2
  assert.equal(v.sample(0, 0, 2, 1000).t90Ms, 0)
  v.teleport(2000)
  v.load('overworld', 0, 1, 2100)
  assert.equal(v.teleports, 2)
  assert.equal(v.sample(0, 0, 2, 3000).t90Ms, 100)
})

test('ViewTracker: tN reached at the VIEW_N-th in-view arrival', () => {
  const v = new ViewTracker()
  v.startGame(0)
  let i = 0
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) v.load('overworld', x, z, ++i)
  const s = v.sample(0, 0, 10, 10_000)
  assert.equal(s.inView, 169)
  assert.equal(s.tNCensored, false)
  assert.equal(s.tNMs, VIEW_N)
  assert.equal(s.t90Ms, t90Rank(169))
})

test('ViewTracker: no origin yet means times relative to now', () => {
  const v = new ViewTracker()
  v.load('overworld', 0, 0, 100)
  const s = v.sample(0, 0, 1, 50)
  assert.equal(s.t90Ms, 50)
  assert.equal(s.tNMs, 0)
})

test('censoredMedian and nearestRank', () => {
  assert.equal(censoredMedian([]), null)
  assert.equal(censoredMedian([{ v: 5, censored: false }, { v: 1, censored: true }, { v: 3, censored: false }]), 5)
  assert.equal(censoredMedian([{ v: 5, censored: false }, { v: 1, censored: true }, { v: 3, censored: true }]), null)
  assert.equal(censoredMedian([{ v: 2, censored: false }, { v: 4, censored: false }]), 3)
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
  assert.equal(nearestRank([100, 900], 0.5), 100)
  assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1), 10)
  assert.equal(nearestRank([7], 0.9), 7)
})

test('aggregateView merges per-bot samples', () => {
  const b = (uniq: number, inV: number, t90: number | undefined, tN: number, c: boolean): BotViewSample =>
    ({ uniq, inView: inV, ...(t90 !== undefined ? { t90Ms: t90 } : {}), tNMs: tN, tNCensored: c })
  assert.deepEqual(aggregateView([]), {})
  const a = aggregateView([b(100, 90, 2000, 1500, false), b(50, 40, 1000, 3000, true), b(0, 0, undefined, 3000, true)])
  assert.equal(a.uniqChunks, 150)
  assert.deepEqual(a.inView, { min: 0, median: 40, max: 90 })
  assert.deepEqual(a.viewT90Ms, { p50: 1000, p90: 2000, max: 2000, n: 2 })
  assert.deepEqual(a.viewTNMs, { medianCensored: null, censored: 2, n: 3 })
})

test('aggregateStats: chunks/s, packets, totalCores, view and cache flag', () => {
  const r = (over: Partial<WorkerStats>): WorkerStats => ({
    type: 'stats', workerId: 0, intervalMs: 1000, bots: 1, joinLatencyMs: [], rttMs: [], corrections: 0, rxBytes: 0, eventLoopP99Ms: 0, mainThreadCpuPct: 0, cpuPct: 0, rssBytes: 0, ...over
  })
  const v: BotViewSample = { uniq: 150, inView: 149, t90Ms: 1200, tNMs: 800, tNCensored: false }
  const w0 = r({ cpuPct: 150, chunkLoads: 300, packets: { level_chunk: 300, subchunk: 310 }, view: [v, v], chunkCacheSeen: false, blobMissReplies: 0 })
  const w1 = r({ workerId: 1, cpuPct: 50, chunkLoads: 100, packets: { level_chunk: 100, text: 2 }, view: [v], chunkCacheSeen: false, blobMissReplies: 4 })
  const s = aggregateStats({
    t: 0, target: 3, connected: 3, spawned: 3, joinFailures: 0, unexpectedDisconnects: 0, elapsedMs: 2000,
    reports: [w0, w1], workers: [{ latest: w0, sinceMs: 0 }, { latest: w1, sinceMs: 0 }], thresholds: DEFAULT_SATURATION, staleMs: 10_000
  })
  assert.equal(s.chunksPerSec, 200)
  assert.deepEqual(s.packets, { level_chunk: 400, subchunk: 310, text: 2 })
  assert.equal(s.loadgen.totalCores, 2)
  assert.equal(s.loadgen.blobMissReplies, 4)
  assert.equal(s.uniqChunks, 450)
  assert.deepEqual(s.inView, { min: 149, median: 149, max: 149 })
  assert.equal(s.viewT90Ms?.n, 3)
  assert.equal(s.viewTNMs?.medianCensored, 800)
  assert.equal(s.chunkCacheSeen, false)

  // a stale worker's view snapshot is not merged
  const st = aggregateStats({
    t: 0, target: 3, connected: 3, spawned: 3, joinFailures: 0, unexpectedDisconnects: 0, elapsedMs: 2000,
    reports: [], workers: [{ latest: w0, sinceMs: 0 }, { latest: w1, sinceMs: 60_000 }], thresholds: DEFAULT_SATURATION, staleMs: 10_000
  })
  assert.equal(st.viewTNMs?.n, 2)

  // old-style reports (no view fields): nothing new appears except the loadgen extras
  const old = aggregateStats({
    t: 0, target: 1, connected: 1, spawned: 1, joinFailures: 0, unexpectedDisconnects: 0, elapsedMs: 1000,
    reports: [r({})], workers: [{ latest: r({}), sinceMs: 0 }], thresholds: DEFAULT_SATURATION, staleMs: 10_000
  })
  assert.equal(old.chunksPerSec, undefined)
  assert.equal(old.packets, undefined)
  assert.equal(old.inView, undefined)
  assert.equal(old.chunkCacheSeen, undefined)
})
