import { curveValues } from './analyze.ts'
import { DASH, esc, fmt, fmtBytes, fmtPct, fmtRate, fmtTick, MiB } from './format.ts'
import { flagsHtml, methodologyHtml, repeatsDetail } from './html.ts'
import { interp, niceTicks } from './math.ts'
import { page } from './page.ts'
import { legend, lineChart } from './svg.ts'
import type { Series } from './svg.ts'
import type { Analysis, CurveMetric } from './types.ts'

export type Verdict = 'better' | 'worse' | 'same' | 'n/a'

export interface Delta {
  a: number | undefined
  b: number | undefined
  /** b - a */
  delta: number | undefined
  /** (b - a) / |a| * 100 */
  pct: number | undefined
  verdict: Verdict
}

export interface MetricDef {
  key: string
  label: string
  better: 'higher' | 'lower'
  format: (v: number | undefined) => string
  /** Formatter for the absolute delta when it differs from `format` (e.g. percentage points). */
  deltaFormat?: (v: number | undefined) => string
}

export interface CompareRow extends Delta {
  metric: MetricDef
  /** Matched player count, or undefined for run-level metrics. */
  players: number | undefined
}

export interface Comparison {
  a: Analysis
  b: Analysis
  headline: Delta
  derived: CompareRow[]
  /** Player counts at which curves are compared (inside both runs' measured ranges). */
  players: number[]
  rows: CompareRow[]
}

/** Relative change below which a difference is called "same". */
const SAME_PCT = 1


export const CURVE_DEFS: Array<MetricDef & { key: CurveMetric }> = [
  { key: 'tps', label: 'TPS mean', better: 'higher', format: (v) => fmt(v, 2) },
  { key: 'tickP99', label: 'tick interval p99 (ms)', better: 'lower', format: (v) => fmt(v, 1) },
  { key: 'util', label: 'main-thread util', better: 'lower', format: (v) => fmtPct(v, 1), deltaFormat: (v) => v === undefined ? DASH : `${fmt(v * 100, 1)} pp` },
  { key: 'cpu', label: 'process CPU (% of a core)', better: 'lower', format: (v) => fmt(v, 0) },
  { key: 'rss', label: 'RSS', better: 'lower', format: (v) => fmtBytes(v) },
  { key: 'rssPerPlayer', label: 'RSS per player', better: 'lower', format: (v) => v === undefined ? DASH : `${fmt(v / MiB, 1)} MiB` },
  { key: 'rttP95', label: 'RTT p95 (ms)', better: 'lower', format: (v) => fmt(v, 1) },
  { key: 'netTx', label: 'net tx', better: 'lower', format: (v) => fmtRate(v) }
]

export function delta (a: number | undefined, b: number | undefined, better: 'higher' | 'lower'): Delta {
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
    return { a, b, delta: undefined, pct: undefined, verdict: 'n/a' }
  }
  const d = b - a
  const pct = a !== 0 ? (d / Math.abs(a)) * 100 : (d === 0 ? 0 : undefined)
  let verdict: Verdict
  if (d === 0 || (pct !== undefined && Math.abs(pct) < SAME_PCT)) verdict = 'same'
  else verdict = (d > 0) === (better === 'higher') ? 'better' : 'worse'
  return { a, b, delta: d, pct, verdict }
}

function curvePoints (an: Analysis, m: CurveMetric): Array<[number, number]> {
  return curveValues(an.meanCurve, m)
}

/** Player counts inside both runs' measured ranges: "nice" round numbers plus each run's headline. */
function matchedPlayers (a: Analysis, b: Analysis): number[] {
  const pa = a.meanCurve.points.map((p) => p.players)
  const pb = b.meanCurve.points.map((p) => p.players)
  if (pa.length === 0 || pb.length === 0) return []
  const lo = Math.max(Math.min(...pa), Math.min(...pb))
  const hi = Math.min(Math.max(...pa), Math.max(...pb))
  if (hi < lo) return []
  if (hi === lo) return [lo]
  const set = new Set(niceTicks(lo, hi, 6).ticks.filter((t) => t >= lo && t <= hi && Number.isInteger(t)))
  set.add(lo)
  set.add(hi)
  for (const h of [a.headline.maxPlayersMedian, b.headline.maxPlayersMedian]) {
    if (h !== undefined && h >= lo && h <= hi) set.add(Math.round(h))
  }
  return [...set].sort((x, y) => x - y)
}

/** Compares run B against baseline A. */
export function compareRuns (a: Analysis, b: Analysis): Comparison {
  const players = matchedPlayers(a, b)
  const rows: CompareRow[] = []
  for (const def of CURVE_DEFS) {
    const ca = curvePoints(a, def.key)
    const cb = curvePoints(b, def.key)
    if (ca.length === 0 && cb.length === 0) continue
    for (const p of players) rows.push({ metric: def, players: p, ...delta(interp(ca, p), interp(cb, p), def.better) })
  }
  const da = a.derived
  const db = b.derived
  const derivedDefs: Array<[MetricDef, number | undefined, number | undefined]> = [
    [{ key: 'memPerPlayer', label: 'memory per player', better: 'lower', format: (v) => fmtBytes(v) }, da.memPerPlayer?.slope, db.memPerPlayer?.slope],
    [{ key: 'netTxPerPlayer', label: 'net tx per player', better: 'lower', format: (v) => fmtRate(v) }, da.netTxPerPlayer?.slope, db.netTxPerPlayer?.slope],
    [{ key: 'utilPerPlayer', label: 'main-thread util per player', better: 'lower', format: (v) => fmtPct(v, 2), deltaFormat: (v) => v === undefined ? DASH : `${fmt(v * 100, 2)} pp` }, da.utilPerPlayer?.slope, db.utilPerPlayer?.slope],
    [{ key: 'playersAtUtil1', label: 'players at util 1.0 (extrapolated)', better: 'higher', format: (v) => fmt(v, 0) }, da.playersAtUtil1, db.playersAtUtil1]
  ]
  return {
    a,
    b,
    headline: delta(a.headline.maxPlayersMedian, b.headline.maxPlayersMedian, 'higher'),
    derived: derivedDefs.map(([metric, va, vb]) => ({ metric, players: undefined, ...delta(va, vb, metric.better) })),
    players,
    rows
  }
}

function pctCell (d: Delta): string {
  if (d.verdict === 'n/a' || d.pct === undefined) return `<td class="same">${DASH}</td>`
  const sign = d.pct > 0 ? '+' : ''
  const word = d.verdict === 'same' ? '' : ` <span class="vh">(${d.verdict})</span>`
  return `<td class="${d.verdict}">${sign}${fmt(d.pct, 1)} %${word}</td>`
}

function deltaCell (d: Delta, f: (v: number | undefined) => string): string {
  if (d.delta === undefined) return `<td>${DASH}</td>`
  const s = f(d.delta)
  return `<td>${d.delta > 0 && !s.startsWith('+') ? '+' : ''}${esc(s)}</td>`
}

function runCard (label: string, an: Analysis, slot: number): string {
  const h = an.headline
  return `<div class="hero">
<div class="label"><span class="sw line s${slot}" style="display:inline-block;vertical-align:middle"></span> ${esc(label)}: ${esc(an.name)}</div>
<div class="value">${esc(h.maxPlayersMedian === undefined ? DASH : fmtTick(h.maxPlayersMedian, 1))}</div>
<div class="detail">${repeatsDetail(an)}</div>
<div class="detail">Run ${esc(an.runId)} · BDS ${esc(an.meta.bdsVersion)} · ${esc(an.config.scenario?.module ?? '')} · ${esc(an.meta.host?.cpuModel ?? '')}</div>
${flagsHtml(an)}
</div>`
}

/** Renders a self-contained HTML comparison of run B against baseline A. */
export function renderCompareHtml (c: Comparison): string {
  const h = c.headline
  const headlineDelta = h.delta === undefined
    ? DASH
    : `${h.delta > 0 ? '+' : ''}${fmtTick(h.delta, 1)} players${h.pct !== undefined ? ` (${h.pct > 0 ? '+' : ''}${fmt(h.pct, 1)} %)` : ''}`

  const overlay = (key: CurveMetric, scale: number, yLabel: string, ref: { value: number, label: string } | undefined, include: number[]): string => {
    const series: Series[] = [
      { name: `A: ${c.a.name}`, slot: 1, markers: true, points: curvePoints(c.a, key).map(([x, y]) => [x, y * scale] as [number, number]) },
      { name: `B: ${c.b.name}`, slot: 2, markers: true, points: curvePoints(c.b, key).map(([x, y]) => [x, y * scale] as [number, number]) }
    ]
    return `${legend(series)}${lineChart({ id: `cmp-${key}`, label: `${yLabel} against players, A vs B`, xLabel: 'players', yLabel, series, refLines: ref !== undefined ? [ref] : [], yInclude: include, xInclude: [0] })}`
  }

  const derivedRows = c.derived.map((r) => `<tr><td class="l">${esc(r.metric.label)}</td><td>${esc(r.metric.format(r.a))}</td><td>${esc(r.metric.format(r.b))}</td>${deltaCell(r, r.metric.deltaFormat ?? r.metric.format)}${pctCell(r)}</tr>`).join('\n')
  const metricRows = c.rows.map((r) => `<tr><td class="l">${esc(r.metric.label)}</td><td>${esc(r.players)}</td><td>${esc(r.metric.format(r.a))}</td><td>${esc(r.metric.format(r.b))}</td>${deltaCell(r, r.metric.deltaFormat ?? r.metric.format)}${pctCell(r)}</tr>`).join('\n')

  const body = `<header>
<h1>bedperf comparison</h1>
<p class="sub">A (baseline): ${esc(c.a.name)} · B: ${esc(c.b.name)}. Deltas are B relative to A.</p>
</header>
<section id="headline" aria-label="Headline">
<h2>Max players @ 20 TPS</h2>
<div class="vs">
${runCard('A', c.a, 1)}
${runCard('B', c.b, 2)}
<div class="hero"><div class="label">Change (B − A)</div><div class="value delta ${h.verdict === 'n/a' ? 'same' : h.verdict}">${esc(headlineDelta)}</div><div class="detail">${esc(h.verdict === 'n/a' ? 'not comparable' : h.verdict)}</div></div>
</div>
</section>
<section id="derived" aria-label="Derived metrics">
<h2>Per-player costs</h2>
<div class="scroll"><table>
<thead><tr><th class="l">metric</th><th>A</th><th>B</th><th>Δ</th><th>Δ %</th></tr></thead>
<tbody>${derivedRows}</tbody>
</table></div>
</section>
<section id="scaling" aria-label="Scaling">
<h2>Scaling, mean over repeats</h2>
<div class="charts">
<figure><h3>TPS</h3>${overlay('tps', 1, 'TPS', { value: 20, label: '20 TPS' }, [16, 20])}</figure>
<figure><h3>Main-thread utilisation</h3>${overlay('util', 100, 'util %', { value: 100, label: 'util 1.0' }, [0, 100])}</figure>
</div>
</section>
<section id="metrics" aria-label="Metric deltas">
<h2>Metrics at matched player counts</h2>
<p class="foot">Values are linearly interpolated on each run's mean scaling curve at player counts inside both measured ranges${c.players.length > 0 ? ` (${c.players.map(esc).join(', ')})` : ''}. Changes under ${SAME_PCT} % count as the same.</p>
<div class="scroll"><table>
<thead><tr><th class="l">metric</th><th>players</th><th>A</th><th>B</th><th>Δ</th><th>Δ %</th></tr></thead>
<tbody>${metricRows || '<tr><td class="l" colspan="6">The runs have no overlapping player range.</td></tr>'}</tbody>
</table></div>
</section>
${methodologyHtml()}`
  return page(`bedperf: ${c.a.name} vs ${c.b.name}`, body)
}
