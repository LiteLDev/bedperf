import type { StepResult } from '@bedperf/core'
import { downsample, linreg, mean, median, num } from './math.ts'
import { provenanceOf, serverViewOf, threatsOf } from './provenance.ts'
import { topologyViewOf } from './topology.ts'
import { CURVE_METRICS } from './types.ts'
import type { Analysis, Curve, CurveMetric, CurvePoint, Derived, Headline, RepeatInfo, RepeatStatus, RunData, StepBand, StepMarkData, StepRow, Timeline } from './types.ts'

/** Max points per timeline series per repeat after downsampling. */
const TIMELINE_POINTS_PER_REPEAT = 600

/**
 * Version of the analysis rules (headline aggregation, repeat statuses, curve and fit inputs,
 * comparison decision rule). Bump it whenever a change can move a number or a verdict computed
 * from the same raw data, so runs analysed under different rules are flagged as not comparable.
 * Pure presentation changes (layout, wording, colours) do not bump it.
 *
 * 2: steps with `invalidReasons` are invalid (left out of curves and fits); tick-counter TPS,
 *    tick CPU per tick, interference and view-load curves; tick CPU per player fit; repeat
 *    statuses from result.json `repeats[]`.
 */
export const ANALYSIS_VERSION = 3

/** A step the orchestrator marked invalid (`invalidReasons`), or loadgen-saturated (older runs). */
function invalidStep (s: StepResult): boolean {
  return s.loadgenSaturated === true || strings((s as StepResult & { invalidReasons?: unknown }).invalidReasons).length > 0
}

/** Status and per-repeat result of every repeat, from repeat envelopes, result.json and steps. */
function repeatInfosOf (run: RunData): { infos: RepeatInfo[], incomplete: number[] } {
  const best = (r: number): number | undefined => {
    const mine = run.steps.filter((s) => s.repeat === r)
    if (mine.length === 0) return undefined
    const passing = mine.filter((s) => s.pass && !invalidStep(s)).map((s) => s.players)
    return passing.length > 0 ? Math.max(...passing) : 0
  }
  const hasMarks = run.repeatStarts.length > 0 || run.repeatEnds.length > 0
  const ids = new Set<number>([...run.steps.map((s) => s.repeat), ...run.repeatStarts, ...run.repeatEnds.map((e) => e.repeat)])
  // result.maxPlayers is indexed by position; the orchestrator numbers repeats from 0, older
  // runs and fixtures from 1. Infer the base from the recorded repeat numbers.
  const base = ids.size === 0 || Math.min(...ids) >= 1 ? 1 : Math.min(...ids)
  const fromResult = (r: number): number | undefined => num(run.result?.maxPlayers[r - base])
  if (run.result !== undefined) run.result.maxPlayers.forEach((_, i) => ids.add(i + base))
  const infos: RepeatInfo[] = []
  const incomplete: number[] = []
  for (const r of [...ids].sort((a, b) => a - b)) {
    const end = run.repeatEnds.find((e) => e.repeat === r)
    let status: RepeatStatus
    let reasons: string[] = []
    let maxPlayers = fromResult(r) ?? best(r)
    if (end !== undefined) {
      maxPlayers = end.maxPlayers ?? maxPlayers
      if (!end.hasOutcome) {
        status = 'invalid'
        reasons = ['repeat ended without a search result']
      } else if (end.status !== undefined) {
        status = end.status
        reasons = end.statusReasons.length > 0 ? end.statusReasons : end.aborted !== undefined ? [end.aborted] : []
      } else if (end.aborted !== undefined) {
        status = 'server_failed'
        reasons = [end.aborted]
      } else {
        status = 'ok'
      }
    } else if (resultRepeatOf(run, r) !== undefined) {
      const rr = resultRepeatOf(run, r)!
      status = rr.status
      reasons = rr.statusReasons
      maxPlayers = rr.maxPlayers ?? maxPlayers
    } else if (hasMarks) {
      // The run records repeat boundaries but this repeat has no end: it was cut off.
      status = 'invalid'
      reasons = ['repeat never ended (run stopped mid-repeat)']
      incomplete.push(r)
    } else if (run.result !== undefined && fromResult(r) !== undefined) {
      // Older run without repeat envelopes: result.json lists every repeat that finished.
      status = 'ok'
    } else if (repeatFinished(run, r, best(r) ?? 0)) {
      status = 'ok'
    } else {
      status = 'invalid'
      reasons = ['search did not finish']
      incomplete.push(r)
    }
    infos.push({ repeat: r, status, reasons, maxPlayers })
  }
  return { infos, incomplete }
}

/** A `result.json` `repeats[]` entry for repeat `r` (matched on `index`), read defensively. */
function resultRepeatOf (run: RunData, r: number): { status: RepeatStatus, statusReasons: string[], maxPlayers?: number } | undefined {
  const list = (run.result as { repeats?: unknown } | undefined)?.repeats
  if (!Array.isArray(list)) return undefined
  for (const e of list as unknown[]) {
    if (e === null || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    if (num(o.index) !== r || typeof o.status !== 'string' || !['ok', 'invalid', 'server_failed'].includes(o.status)) continue
    const maxPlayers = num(o.maxPlayers)
    return { status: o.status as RepeatStatus, statusReasons: strings(o.statusReasons), ...(maxPlayers !== undefined ? { maxPlayers } : {}) }
  }
  return undefined
}

function headlineOf (run: RunData): Headline {
  const { infos, incomplete } = repeatInfosOf(run)
  const ok = infos.filter((i) => i.status === 'ok')
  const perRepeat = ok.map((i) => i.maxPlayers).filter((v): v is number => v !== undefined)
  const statusCounts: Record<RepeatStatus, number> = { ok: 0, server_failed: 0, invalid: 0 }
  for (const i of infos) statusCounts[i.status]++
  const okEnds = run.repeatEnds.filter((e) => ok.some((i) => i.repeat === e.repeat))
  const cap = num(run.config.ramp?.max)
  // Capped describes the median, so only ok repeats count. result.capped covers every repeat, so
  // it is used only for older runs without repeat envelopes (where every listed repeat is ok).
  const capped = okEnds.some((e) => e.capped === true) || (cap !== undefined && perRepeat.some((v) => v >= cap)) ||
    (run.repeatEnds.length === 0 && run.result?.capped === true)
  const loadgenLimited = run.result?.loadgenLimited === true || run.repeatEnds.some((e) => e.loadgenLimited === true) ||
    run.steps.some((s) => s.loadgenSaturated)
  const invalidLimited = (run.result as { invalidLimited?: unknown } | undefined)?.invalidLimited === true
  return {
    maxPlayersMedian: median(perRepeat),
    perRepeat,
    repeats: infos,
    kOk: ok.length,
    n: infos.length,
    statusCounts,
    min: perRepeat.length > 0 ? Math.min(...perRepeat) : undefined,
    max: perRepeat.length > 0 ? Math.max(...perRepeat) : undefined,
    spread: perRepeat.length > 0 ? Math.max(...perRepeat) - Math.min(...perRepeat) : undefined,
    capped,
    loadgenLimited,
    invalidLimited,
    source: run.result !== undefined ? 'result' : 'steps',
    aborted: run.result === undefined,
    incompleteRepeats: incomplete
  }
}

/** Whether a repeat's ramp + bisect search reached a conclusion, judged from its steps. */
function repeatFinished (run: RunData, repeat: number, best: number): boolean {
  const ramp = run.config.ramp
  if (ramp === undefined) return true
  const steps = run.steps.filter((s) => s.repeat === repeat)
  if (best >= ramp.max) return true
  // A saturated load generator ends the search.
  if (steps.some((s) => s.loadgenSaturated)) return true
  const fails = steps.filter((s) => !s.pass && !invalidStep(s) && s.players > best).map((s) => s.players)
  if (fails.length === 0) return false
  const resolution = ramp.resolution > 0 ? ramp.resolution : ramp.step
  return Math.min(...fails) - best <= resolution
}

/** A number, or the `mean` of a Summary-like object. */
function numOrMean (v: unknown): number | undefined {
  return num(v) ?? (v !== null && typeof v === 'object' ? num((v as { mean?: unknown }).mean) : undefined)
}

function strings (v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '').map(String) : []
}

function bool (v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function objectOf (v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function rowOf (s: StepResult): StepRow {
  // Newer fields are not in older cores' StepResult; read them all defensively.
  const x = s as StepResult & Record<string, unknown>
  const invalidReasons = strings(x.invalidReasons)
  if (invalidReasons.length === 0 && s.loadgenSaturated === true) invalidReasons.push('loadgen saturated')
  const interference = objectOf(x.interference)
  const latency = objectOf(x.gametimeLatencyMs)
  const row: StepRow = {
    repeat: s.repeat,
    index: s.index,
    phase: s.phase,
    players: s.players,
    pass: s.pass,
    invalid: invalidReasons.length > 0,
    invalidReasons,
    failReasons: Array.isArray(s.failReasons) ? s.failReasons.map(String) : [],
    startT: s.startT,
    endT: s.endT,
    tpsMean: num(s.tps?.mean),
    tpsMin: num(s.tps?.min),
    tickP99: num(s.tickIntervalMs?.p99),
    over50: num(s.over50) ?? 0,
    over100: num(s.over100) ?? 0,
    utilMean: num(s.mainThreadUtil?.mean),
    cpuMean: num(s.cpuPct?.mean),
    rssMean: num(s.rssBytes?.mean),
    rttP95: num(s.rttMs?.p95),
    netRxBps: num(s.netRxBytesPerSec),
    netTxBps: num(s.netTxBytesPerSec),
    botFailures: num(s.botFailures) ?? 0
  }
  const opt: Partial<StepRow> = {
    counterTps: numOrMean(x.counterTps),
    counterTpsLow5: numOrMean(x.counterTpsLow5),
    gametimeMaxGapMs: num(x.gametimeMaxGapMs),
    gametimeLatencyP50: num(latency.p50) ?? num(x.gametimeLatencyMs),
    tickCpuMsPerTick: numOrMean(x.tickCpuMsPerTick),
    tickThreadSource: x.tickThreadSource === 'name' || x.tickThreadSource === 'busiest' ? x.tickThreadSource : undefined,
    foreignMean: num(interference.foreignMean),
    foreignPeak10s: num(interference.foreignPeak10s),
    serverSetForeignMean: num(interference.serverSetForeignMean),
    placementVerified: bool(x.placementVerified),
    settleSec: num(x.settleSec),
    settleCapped: bool(x.settleCapped),
    viewsIncomplete: bool(x.viewsIncomplete),
    inViewMedian: numOrMean(x.inViewMedian),
    viewT90MsP50: numOrMean(x.viewT90MsP50),
    chunksPerSec: numOrMean(x.chunksPerSec),
    uniqChunksPerBot: numOrMean(x.uniqChunksPerBot)
  }
  for (const [k, v] of Object.entries(opt)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v
  return row
}

function metricOf (r: StepRow, m: CurveMetric): number | undefined {
  switch (m) {
    case 'tps': return r.tpsMean
    case 'util': return r.utilMean
    case 'cpu': return r.cpuMean
    case 'rss': return r.rssMean
    case 'rssPerPlayer': return r.rssMean !== undefined && r.players > 0 ? r.rssMean / r.players : undefined
    case 'rttP95': return r.rttP95
    case 'netTx': return r.netTxBps
    case 'tickP99': return r.tickP99
    case 'counterTps': return r.counterTps
    case 'tickCpuMsPerTick': return r.tickCpuMsPerTick
    case 'foreignMean': return r.foreignMean
    case 'inViewMedian': return r.inViewMedian
    case 'viewT90': return r.viewT90MsP50
    case 'chunksPerSec': return r.chunksPerSec
  }
}

/** [players, value] pairs of one metric along a curve, skipping points without it. */
export function curveValues (c: Curve, m: CurveMetric): Array<[number, number]> {
  return c.points.flatMap((p): Array<[number, number]> => {
    const v = p.values[m]
    return v === undefined ? [] : [[p.players, v]]
  })
}

/** Groups rows by player count and averages each metric. */
function curveOf (rows: readonly StepRow[], repeat: number | undefined): Curve {
  const groups = new Map<number, StepRow[]>()
  for (const r of rows) {
    const g = groups.get(r.players)
    if (g === undefined) groups.set(r.players, [r])
    else g.push(r)
  }
  const points: CurvePoint[] = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([players, g]) => {
    const values: CurvePoint['values'] = {}
    for (const m of CURVE_METRICS) {
      const v = mean(g.map((r) => metricOf(r, m)).filter((x): x is number => x !== undefined))
      if (v !== undefined) values[m] = v
    }
    return { players, values }
  })
  return { repeat, points }
}

function derivedOf (rows: readonly StepRow[]): Derived {
  const pairs = (f: (r: StepRow) => number | undefined, src: readonly StepRow[] = rows): Array<[number, number]> =>
    src.flatMap((r) => { const v = f(r); return v === undefined ? [] : [[r.players, v] as [number, number]] })
  const d: Derived = {}
  const mem = linreg(pairs((r) => r.rssMean))
  if (mem !== undefined) d.memPerPlayer = mem
  const tx = linreg(pairs((r) => r.netTxBps))
  if (tx !== undefined) d.netTxPerPlayer = tx
  const rx = linreg(pairs((r) => r.netRxBps))
  if (rx !== undefined) d.netRxPerPlayer = rx
  // Fit util below saturation: once the tick thread is pegged util flattens near 1.0.
  const passing = rows.filter((r) => r.pass)
  const util = linreg(pairs((r) => r.utilMean, passing)) ?? linreg(pairs((r) => r.utilMean))
  if (util !== undefined) {
    d.utilPerPlayer = util
    if (util.slope > 0) {
      const p = (1 - util.intercept) / util.slope
      if (Number.isFinite(p) && p >= 0) d.playersAtUtil1 = p
    }
  }
  // Fitted on passing steps for the same reason: past saturation the tick stretches.
  const cpu = linreg(pairs((r) => r.tickCpuMsPerTick, passing)) ?? linreg(pairs((r) => r.tickCpuMsPerTick))
  if (cpu !== undefined) d.tickCpuPerPlayer = cpu
  return d
}

function key (repeat: number | undefined, index: number | undefined): string {
  return `${repeat ?? '?'}:${index ?? '?'}`
}

function timelineOf (run: RunData, rows: readonly StepRow[]): Timeline {
  const firstTs = [run.runStartT, run.probe[0]?.t, run.sys[0]?.t, run.bot[0]?.t, run.interference[0]?.t, run.gametime[0]?.data.t, run.stepMarks[0]?.t, rows[0]?.startT]
    .filter((x): x is number => x !== undefined && Number.isFinite(x))
  const t0 = firstTs.length > 0 ? Math.min(...firstTs) : 0
  const sec = (t: number): number => (t - t0) / 1000

  const rowByKey = new Map(rows.map((r) => [key(r.repeat, r.index), r]))
  /**
   * The StepRow a band belongs to: by (repeat, index) when the marks carry them, otherwise the row
   * whose measurement window lies inside the band (rows' startT/endT are epoch ms).
   */
  const rowFor = (repeat: number | undefined, index: number | undefined, t0: number, t1: number): StepRow | undefined => {
    if (repeat !== undefined && index !== undefined) return rowByKey.get(key(repeat, index))
    return rows.find((r) => r.startT >= t0 - 1000 && r.endT <= t1 + 1000)
  }
  const statusOf = (r: StepRow | undefined, endPass?: boolean, endSat?: boolean): StepBand['status'] => {
    if (r !== undefined) return r.invalid ? 'invalid' : r.pass ? 'pass' : 'fail'
    if (endSat === true) return 'invalid'
    if (endPass !== undefined) return endPass ? 'pass' : 'fail'
    return 'unknown'
  }

  const bands: StepBand[] = []
  if (run.stepMarks.length > 0) {
    interface Open { t: number, repeat: number | undefined, index: number | undefined, players: number | undefined }
    const open = new Map<string, Open>()
    let lastKey: string | undefined
    let seq = 0
    const close = (s: Open, t1: number, end?: StepMarkData): void => {
      const r = rowFor(s.repeat, s.index, s.t, t1)
      bands.push({
        repeat: s.repeat ?? r?.repeat ?? 1,
        index: s.index ?? r?.index ?? bands.length,
        players: num(end?.players) ?? s.players ?? r?.players ?? 0,
        t0: sec(s.t),
        t1: sec(t1),
        status: statusOf(r, end?.pass, end?.loadgenSaturated)
      })
    }
    for (const m of run.stepMarks) {
      const repeat = num(m.data.repeat)
      const index = num(m.data.index)
      const keyed = repeat !== undefined && index !== undefined
      if (m.edge === 'start') {
        const k = keyed ? key(repeat, index) : `seq:${seq++}`
        open.set(k, { t: m.t, repeat, index, players: num(m.data.players) })
        lastKey = k
      } else {
        // Pair by (repeat, index) when present, else with the most recently started step.
        const k = keyed && open.has(key(repeat, index)) ? key(repeat, index) : lastKey
        const s = k !== undefined ? open.get(k) : undefined
        if (s === undefined) continue
        open.delete(k!)
        if (k === lastKey) lastKey = undefined
        close(s, m.t, m.data)
      }
    }
    // Steps that started but never ended (aborted run): close at the last sample.
    const lastT = Math.max(run.probe.at(-1)?.t ?? -Infinity, run.sys.at(-1)?.t ?? -Infinity, run.bot.at(-1)?.t ?? -Infinity, run.runEndT ?? -Infinity)
    for (const s of open.values()) {
      if (Number.isFinite(lastT) && lastT > s.t) close(s, lastT)
    }
  } else {
    for (const r of rows) {
      if (Number.isFinite(r.startT) && Number.isFinite(r.endT)) {
        bands.push({ repeat: r.repeat, index: r.index, players: r.players, t0: sec(r.startT), t1: sec(r.endT), status: statusOf(r) })
      }
    }
  }
  bands.sort((a, b) => a.t0 - b.t0)

  const tpsRaw = run.probe.map((p): [number, number] => [sec(p.t), p.data.tps]).filter(([, y]) => Number.isFinite(y))
  const utilRaw = run.sys.flatMap((s): Array<[number, number]> => {
    const u = num(s.data.mainThread?.util)
    return u === undefined ? [] : [[sec(s.t), u]]
  })
  const playersRaw = run.probe.length > 0
    ? run.probe.flatMap((p): Array<[number, number]> => { const v = num(p.data.players); return v === undefined ? [] : [[sec(p.t), v]] })
    : run.bot.flatMap((b): Array<[number, number]> => { const v = num(b.data.spawned); return v === undefined ? [] : [[sec(b.t), v]] })

  // Tick-counter TPS between consecutive replies, at the midpoint. Pairs far apart compared with
  // the sampling period (a gap between repeats, a server restart) are skipped.
  const gt = run.gametime.map((g) => g.data)
  const period = median(gt.slice(1).map((g, i) => g.t - gt[i]!.t).filter((d) => d > 0)) ?? 0
  const counterRaw: Array<[number, number]> = []
  const counterAbs: Array<[number, number]> = []
  for (let i = 1; i < gt.length; i++) {
    const a = gt[i - 1]!
    const b = gt[i]!
    const dt = b.t - a.t
    if (!(dt > 0) || dt > 3 * period || !(b.gametime >= a.gametime)) continue
    const rate = (b.gametime - a.gametime) / (dt / 1000)
    counterRaw.push([sec((a.t + b.t) / 2), rate])
    counterAbs.push([(a.t + b.t) / 2, rate])
  }
  const foreignRaw = run.interference.flatMap((s): Array<[number, number]> => { const v = num(s.data.foreignCores); return v === undefined ? [] : [[sec(s.t), v]] })
  const serverSetRaw = run.interference.flatMap((s): Array<[number, number]> => { const v = num(s.data.serverSetForeignCores); return v === undefined ? [] : [[sec(s.t), v]] })
  // Tick CPU per tick: tick-thread CPU ms per second (consecutive cumulative cpuMs of the same
  // thread) divided by the TPS at that time (probe, else the tick counter).
  const tpsAt = nearest(run.probe.map((p): [number, number] => [p.t, p.data.tps]).filter(([, y]) => Number.isFinite(y)))
  const counterAt = nearest(counterAbs)
  const tickCpuRaw: Array<[number, number]> = []
  for (let i = 1; i < run.sys.length; i++) {
    const a = run.sys[i - 1]!
    const b = run.sys[i]!
    const ca = num(a.data.mainThread?.cpuMs)
    const cb = num(b.data.mainThread?.cpuMs)
    if (ca === undefined || cb === undefined || a.data.mainThread?.tid !== b.data.mainThread?.tid) continue
    const dt = b.t - a.t
    if (!(dt > 0) || cb < ca) continue
    const mid = (a.t + b.t) / 2
    const tps = tpsAt(mid) ?? counterAt(mid)
    if (tps === undefined || tps < 0.5) continue
    tickCpuRaw.push([sec(mid), (cb - ca) / (dt / 1000) / tps])
  }

  const lastX = Math.max(0, tpsRaw.at(-1)?.[0] ?? 0, utilRaw.at(-1)?.[0] ?? 0, playersRaw.at(-1)?.[0] ?? 0, counterRaw.at(-1)?.[0] ?? 0, foreignRaw.at(-1)?.[0] ?? 0, serverSetRaw.at(-1)?.[0] ?? 0, tickCpuRaw.at(-1)?.[0] ?? 0, ...bands.map((b) => b.t1))
  const repeatIds = [...new Set(bands.map((b) => b.repeat))].sort((a, b) => a - b)
  const repeats: Timeline['repeats'] = []
  let x0 = 0
  repeatIds.forEach((r, i) => {
    const mine = bands.filter((b) => b.repeat === r)
    const x1 = i === repeatIds.length - 1 ? lastX : Math.max(...mine.map((b) => b.t1))
    repeats.push({ repeat: r, x0, x1 })
    x0 = x1
  })
  if (repeats.length === 0) repeats.push({ repeat: 1, x0: 0, x1: lastX })

  const budget = TIMELINE_POINTS_PER_REPEAT * repeats.length
  return {
    t0,
    tps: downsample(tpsRaw, budget, 'min'),
    util: downsample(utilRaw, budget, 'mean'),
    players: downsample(playersRaw, budget, 'max'),
    counterTps: downsample(counterRaw, budget, 'min'),
    foreign: downsample(foreignRaw, budget, 'max'),
    serverSetForeign: downsample(serverSetRaw, budget, 'max'),
    tickCpu: downsample(tickCpuRaw, budget, 'mean'),
    bands,
    repeats
  }
}

/**
 * Nearest-sample lookup (within 5 s) over time-sorted [t, value] pairs, for joining series sampled
 * at different instants. Queries must come in non-decreasing t.
 */
function nearest (pts: ReadonlyArray<readonly [number, number]>): (t: number) => number | undefined {
  let i = 0
  return (t) => {
    if (pts.length === 0) return undefined
    while (i + 1 < pts.length && Math.abs(pts[i + 1]![0] - t) <= Math.abs(pts[i]![0] - t)) i++
    return Math.abs(pts[i]![0] - t) <= 5000 ? pts[i]![1] : undefined
  }
}

/** Computes everything the report shows from a loaded run. */
export function analyze (run: RunData): Analysis {
  const steps = run.steps.map(rowOf)
  const repeats = [...new Set(steps.map((s) => s.repeat))].sort((a, b) => a - b)
  // Invalid steps (loadgen saturated, interference, placement not verified, ... as recorded in
  // `invalidReasons`) do not measure the server, so they stay out of the curves and fits.
  const valid = steps.filter((s) => !s.invalid)
  const curves = repeats.map((r) => curveOf(valid.filter((s) => s.repeat === r), r))
  const headline = headlineOf(run)
  const okRepeats = headline.repeats.filter((i) => i.status === 'ok').map((i) => i.repeat)
  // Aggregate curves and fits use the ok repeats only, like the headline, so a crashed or cut-off
  // repeat cannot shift them. With no ok repeat at all, fall back to every valid step.
  const okSet = new Set(okRepeats)
  const fitRows = okRepeats.length > 0 ? valid.filter((s) => okSet.has(s.repeat)) : valid
  const notes: string[] = [...run.warnings]
  if (run.result === undefined) notes.push('result.json is missing (run aborted?); the headline was recomputed from the recorded steps.')
  const notOk = headline.repeats.filter((i) => i.status !== 'ok')
  if (notOk.length > 0) {
    notes.push(`${headline.kOk}/${headline.n} repeats ok. Left out of the median${okRepeats.length > 0 ? ', the mean curve and the fits' : ''}: ${notOk.map((i) => `repeat ${i.repeat} ${i.status}${i.reasons.length > 0 ? ` (${i.reasons.join('; ')})` : ''}`).join(', ')}.`)
  }
  if (steps.length === 0) notes.push('No step results were recorded.')
  if (steps.length > valid.length) notes.push(`${steps.length - valid.length} invalid step(s) are left out of the curves and fits.`)
  if (run.probe.length === 0) notes.push('No probe samples; TPS timeline is empty.')
  if (run.sys.length === 0) notes.push('No sysmon samples; main-thread utilisation timeline is empty.')
  if (run.badLines > 0) notes.push(`${run.badLines} malformed line(s) in samples.jsonl were skipped.`)
  const other = Object.entries(run.otherKinds)
  if (other.length > 0) notes.push(`Ignored envelope kinds: ${other.map(([k, n]) => `${k} (${n})`).join(', ')}.`)

  const provenance = provenanceOf(run.meta)
  const timeline = timelineOf(run, steps)
  const server = serverViewOf(run.meta)
  const topology = topologyViewOf(run, steps, timeline.t0)
  const threats = threatsOf(run, headline, steps, provenance, server, topology)
  return {
    analysisVersion: ANALYSIS_VERSION,
    name: String(run.config.name ?? run.result?.config ?? ''),
    runId: String(run.meta.runId ?? run.result?.runId ?? ''),
    config: run.config,
    meta: run.meta,
    headline,
    steps,
    curves,
    meanCurve: curveOf(fitRows, undefined),
    derived: derivedOf(fitRows),
    repeatDerived: okRepeats.map((r) => ({ repeat: r, derived: derivedOf(valid.filter((s) => s.repeat === r)) })),
    okRepeats,
    timeline,
    provenance,
    server,
    topology,
    threats,
    publishable: !threats.some((t) => t.level === 'bad'),
    notes
  }
}
