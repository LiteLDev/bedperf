import { curveValues } from './analyze.ts'
import {
  comparability, comparabilityWarnings, compareValues, CURVE_DEFS, curveValuesAt, DECISION_RULE, DERIVED_DEFS, fmtChance, IMPLEMENTATION_NOTE,
  fieldValue, IncomparableRunsError, isImplementationComparison, matchedPlayers, runCard, serverOf, STATUS_CLS, STATUS_LABEL, verdictClass
} from './compare.ts'
import type { ComparabilityCheck, ComparabilityWarning, CompareOptions, Delta, MetricDef } from './compare.ts'
import { DASH, esc, fmt, fmtTick } from './format.ts'
import { methodologyHtml } from './html.ts'
import { binomial } from './math.ts'
import { page } from './page.ts'
import { legend, lineChart } from './svg.ts'
import type { Series } from './svg.ts'
import { COMPARABILITY_FIELDS } from './types.ts'
import type { Analysis, CurveMetric, Derived } from './types.ts'

/** One run of a matrix comparison. */
export interface MatrixRun {
  an: Analysis
  /** Server label when the runs differ only by server, else the config name (made unique). */
  label: string
}

/**
 * One metric over every ordered pair. `cells[i][j]` compares row run i against column run j as
 * the baseline (`compareValues(values(j), values(i))`): `better` means every ok repeat of row i
 * beats every ok repeat of column j. The diagonal is undefined.
 */
export interface MatrixMetric {
  metric: MetricDef
  /** Matched player count for curve metrics; undefined for run-level metrics. */
  players: number | undefined
  cells: Array<Array<Delta | undefined>>
}

/** A comparability check of one pair of runs. */
export interface PairCheck {
  i: number
  j: number
  checks: ComparabilityCheck[]
  warnings: ComparabilityWarning[]
  implementation: boolean
}

export interface RankEntry {
  index: number
  label: string
  median: number | undefined
  range: [number, number] | undefined
  kOk: number
  n: number
  /** Runs this run is completely separated above / below on the headline. */
  above: number[]
  below: number[]
}

export interface MatrixComparison {
  runs: MatrixRun[]
  /** Runs are labelled by server: they differ only by the server implementation. */
  byServer: boolean
  /** Every pair is an implementation comparison (all servers differ, the setup is the same). */
  implementation: boolean
  pairs: PairCheck[]
  headline: MatrixMetric
  derived: MatrixMetric[]
  curves: MatrixMetric[]
  /** The player count the curve metrics are compared at (inside every run's ok range). */
  players: number | undefined
  /** Headline ranking, by median, highest first. */
  ranking: RankEntry[]
  /** Mismatching checks across all pairs (labels name the pair); non-empty only when forced. */
  mismatches: ComparabilityCheck[]
  forced: boolean
}

function unique (labels: string[]): boolean {
  return new Set(labels).size === labels.length
}

function labelsOf (ans: readonly Analysis[], byServer: boolean): string[] {
  if (byServer) return ans.map((an) => serverOf(an).label)
  let labels = ans.map((an) => an.name || an.runId)
  if (!unique(labels)) labels = ans.map((an) => `${an.name || an.runId} on ${serverOf(an).label}`)
  if (!unique(labels)) labels = ans.map((an) => `${an.name} (${an.runId})`)
  if (!unique(labels)) labels = labels.map((l, i) => `${l} #${i + 1}`)
  return labels
}

function matrixOf (n: number, metric: MetricDef, players: number | undefined, values: (i: number) => number[]): MatrixMetric {
  const vs = Array.from({ length: n }, (_, i) => values(i))
  const cells = vs.map((row, i) => vs.map((col, j) => i === j ? undefined : compareValues(col, row, metric.better)))
  return { metric, players, cells }
}

/**
 * Compares N ≥ 2 runs pairwise with the complete-separation rule. Every pair must be comparable
 * (as `compareRuns` checks it); throws `IncomparableRunsError` listing the mismatching pairs
 * unless `opts.force`.
 */
export function compareMatrix (ans: readonly Analysis[], opts: CompareOptions = {}): MatrixComparison {
  if (ans.length < 2) throw new Error('compareMatrix needs at least two runs')
  const pairs: PairCheck[] = []
  for (let i = 0; i < ans.length; i++) {
    for (let j = i + 1; j < ans.length; j++) {
      pairs.push({ i, j, checks: comparability(ans[i]!, ans[j]!), warnings: comparabilityWarnings(ans[i]!, ans[j]!), implementation: isImplementationComparison(ans[i]!, ans[j]!) })
    }
  }
  const clean = pairs.every((p) => p.checks.every((c) => c.status !== 'mismatch'))
  const byServer = clean && unique(ans.map((an) => serverOf(an).label))
  const labels = labelsOf(ans, byServer)
  const mismatches = pairs.flatMap((p) => p.checks.filter((c) => c.status === 'mismatch').map((c) => ({ ...c, label: `${c.label} (${labels[p.i]} vs ${labels[p.j]})` })))
  if (mismatches.length > 0 && opts.force !== true) throw new IncomparableRunsError(mismatches)

  const n = ans.length
  const headlineDef: MetricDef = { key: 'maxPlayers', label: 'max players @ 20 TPS', better: 'higher', format: (v) => v === undefined ? DASH : fmtTick(v, 1) }
  const headline = matrixOf(n, headlineDef, undefined, (i) => ans[i]!.headline.perRepeat)
  const slopes = (an: Analysis, pick: (d: Derived) => number | undefined): number[] =>
    an.repeatDerived.flatMap((r) => { const v = pick(r.derived); return v === undefined ? [] : [v] })
  const derived = DERIVED_DEFS.map(({ pick, ...metric }) => matrixOf(n, metric, undefined, (i) => slopes(ans[i]!, pick)))
    .filter((m) => m.cells.some((row) => row.some((c) => c !== undefined && c.verdict !== 'n/a')))

  // Curve metrics at one load every run measured: the highest matched count at or below the
  // lowest headline (all servers still holding 20 TPS), else the lowest matched count.
  const matched = matchedPlayers(...ans)
  // A run without a headline never held 20 TPS: compare at the lowest matched count.
  const floor = Math.min(...ans.map((an) => an.headline.maxPlayersMedian ?? -Infinity))
  const players = matched.filter((p) => p <= floor).at(-1) ?? matched[0]
  const curves: MatrixMetric[] = []
  if (players !== undefined) {
    for (const def of CURVE_DEFS) {
      const m = matrixOf(n, def, players, (i) => curveValuesAt(ans[i]!, def.key, players))
      if (m.cells.some((row) => row.some((c) => c !== undefined && c.verdict !== 'n/a'))) curves.push(m)
    }
  }

  const ranking: RankEntry[] = ans.map((an, i): RankEntry => {
    const per = an.headline.perRepeat
    return {
      index: i,
      label: labels[i]!,
      median: an.headline.maxPlayersMedian,
      range: per.length > 0 ? [Math.min(...per), Math.max(...per)] : undefined,
      kOk: an.headline.kOk,
      n: an.headline.n,
      above: headline.cells[i]!.flatMap((c, j) => c?.verdict === 'better' ? [j] : []),
      below: headline.cells[i]!.flatMap((c, j) => c?.verdict === 'worse' ? [j] : [])
    }
  }).sort((a, b) => (b.median ?? -Infinity) - (a.median ?? -Infinity) || a.index - b.index)

  return {
    runs: ans.map((an, i) => ({ an, label: labels[i]! })),
    byServer,
    implementation: mismatches.length === 0 && pairs.every((p) => p.implementation),
    pairs,
    headline,
    derived,
    curves,
    players,
    ranking,
    mismatches,
    forced: mismatches.length > 0
  }
}

// --- HTML ------------------------------------------------------------------------------------

function cellHtml (d: Delta | undefined): string {
  if (d === undefined) return `<td class="same">${DASH}</td>`
  const pct = d.pct === undefined ? '' : `${d.pct > 0 ? '+' : ''}${fmt(d.pct, 1)} % · `
  const chance = d.chance !== undefined ? ` · ${fmtChance(d.chance)}` : ''
  return `<td class="l ${verdictClass(d.verdict)}">${esc(d.verdict)} <span class="vn">${esc(pct)}${d.bValues.length} v ${d.aValues.length}${esc(chance)}</span></td>`
}

function matrixTable (m: MatrixMetric, labels: readonly string[], id: string): string {
  const title = `${m.metric.label}${m.players !== undefined ? ` at ${m.players} players` : ''}`
  const med = (i: number): string => {
    const row = m.cells[i]!
    const d = row.find((c) => c !== undefined)
    return d === undefined ? DASH : m.metric.format(d.b)
  }
  return `<figure class="matrix" id="${esc(id)}"><h3>${esc(title)} <span class="rng">(${m.metric.better} is better)</span></h3>
<div class="scroll"><table class="matrix">
<thead><tr><th class="l">row vs column</th><th>median</th>${labels.map((l) => `<th class="l">${esc(l)}</th>`).join('')}</tr></thead>
<tbody>${m.cells.map((row, i) => `<tr><th class="l">${esc(labels[i])}</th><td>${esc(med(i))}</td>${row.map(cellHtml).join('')}</tr>`).join('\n')}</tbody>
</table></div></figure>`
}

function comparabilityMatrix (m: MatrixComparison): string {
  const labels = m.runs.map((r) => r.label)
  const rows = COMPARABILITY_FIELDS.map((f) => {
    const checks = m.pairs.map((p) => p.checks.find((c) => c.key === f.key)!)
    const status: ComparabilityCheck['status'] = checks.some((c) => c.status === 'mismatch') ? 'mismatch'
      : checks.some((c) => c.status === 'differs') ? 'differs'
        : checks.some((c) => c.status === 'unverified') ? 'unverified' : 'match'
    // Each run's own value (pairwise checks may fall back to other hashes for older runs).
    const values = m.runs.map((r) => fieldValue(f, r.an))
    return `<tr><td class="l">${esc(f.label)}</td>${values.map((v) => `<td class="l"><code>${esc(v ?? DASH)}</code></td>`).join('')}<td class="l"><span class="st ${STATUS_CLS[status]}">${STATUS_LABEL[status]}</span></td></tr>`
  }).join('\n')
  const warnings = m.pairs.flatMap((p) => p.warnings.map((w) => `${labels[p.i]} vs ${labels[p.j]}: ${w.text}`))
  const uniq = [...new Set(warnings)]
  return `<section id="comparability" aria-label="Comparability">
<h2>Comparability</h2>
<div class="scroll"><table>
<thead><tr><th class="l">field</th>${labels.map((l) => `<th class="l">${esc(l)}</th>`).join('')}<th class="l">status</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
${uniq.length > 0 ? `<div class="cmp-warn" role="note"><b>Comparison warnings.</b><ul>${uniq.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
</section>`
}

/** Renders a self-contained HTML page comparing N runs pairwise. */
export function renderMatrixHtml (m: MatrixComparison): string {
  const labels = m.runs.map((r) => r.label)
  const banner = m.forced
    ? `<div class="banner" role="alert"><b>These runs are not comparable.</b> ${m.mismatches.map((x) => `${esc(x.label)} differs (<code>${esc(x.a ?? DASH)}</code> vs <code>${esc(x.b ?? DASH)}</code>)`).join('; ')}. The comparison was forced; differences below may come from the setup, not the server.</div>`
    : ''
  const name = (i: number): string => esc(labels[i])
  const rank = m.ranking.map((r, k) => `<tr><td>${k + 1}</td><td class="l">${name(r.index)}</td><td>${r.median === undefined ? DASH : esc(fmtTick(r.median, 1))}${r.range !== undefined && r.range[0] !== r.range[1] ? ` <span class="rng">[${esc(fmtTick(r.range[0], 1))}, ${esc(fmtTick(r.range[1], 1))}]</span>` : ''}</td><td>${esc(r.kOk)}/${esc(r.n)}</td><td class="l better">${r.above.map(name).join(', ') || DASH}</td><td class="l worse">${r.below.map(name).join(', ') || DASH}</td></tr>`).join('\n')
  const series = (key: CurveMetric, scale: number): Series[] => m.runs.map((r, i) => ({ name: r.label, slot: (i % 8) + 1, markers: true, points: curveValues(r.an.meanCurve, key).map(([x, y]) => [x, y * scale] as [number, number]) }))
  const tps = series('tps', 1)
  const util = series('util', 100)
  const chanceTable = [[3, 3], [5, 5]].map(([a, b]) => `${a} v ${b}: 1/${binomial(a! + b!, a!)}`).join(', ')
  const body = `<header>
<h1>bedperf comparison: ${esc(m.runs.length)} runs</h1>
<p class="sub">${m.byServer ? 'Runs are labelled by server. ' : ''}Each matrix cell compares the row run against the column run (the baseline) between medians over ok repeats: a verdict, the change of the medians, m v n ok repeats and the chance of complete separation with no real difference.</p>
${m.implementation ? `<p class="sub" id="implementation">${esc(IMPLEMENTATION_NOTE)}</p>` : ''}
</header>
${banner}
<section id="headline" aria-label="Headline">
<h2>Max players @ 20 TPS</h2>
<div class="vs">
${m.runs.map((r, i) => runCard(r.label, r.an, (i % 8) + 1)).join('\n')}
</div>
</section>
<section id="ranking" aria-label="Ranking">
<h2>Ranking: max players @ 20 TPS</h2>
<p class="foot">Ordered by median. A run is only established above another when every ok repeat of it beats every ok repeat of the other (complete separation); neighbours that are not separated are not ranked against each other.</p>
<div class="scroll"><table>
<thead><tr><th>#</th><th class="l">run</th><th>median [min, max]</th><th>ok</th><th class="l">separated above</th><th class="l">separated below</th></tr></thead>
<tbody>${rank}</tbody>
</table></div>
</section>
${comparabilityMatrix(m)}
<section id="matrix" aria-label="Pairwise verdicts">
<h2>Pairwise verdicts</h2>
${matrixTable(m.headline, labels, 'mx-headline')}
${m.derived.map((x, k) => matrixTable(x, labels, `mx-derived-${k}`)).join('\n')}
${m.curves.length > 0 ? `<p class="foot">Curve metrics at ${esc(m.players)} players: every ok repeat's scaling curve linearly interpolated there (inside every run's measured range, at or below the lowest headline when possible).</p>` : ''}
${m.curves.map((x, k) => matrixTable(x, labels, `mx-curve-${k}`)).join('\n')}
</section>
<section id="scaling" aria-label="Scaling">
<h2>Scaling, mean over ok repeats</h2>
<div class="charts">
<figure><h3>TPS</h3>${legend(tps)}${lineChart({ id: 'mx-tps', label: 'TPS against players, all runs', xLabel: 'players', yLabel: 'TPS', series: tps, refLines: [{ value: 20, label: '20 TPS' }], yInclude: [16, 20], xInclude: [0] })}</figure>
<figure><h3>Main-thread utilisation</h3>${legend(util)}${lineChart({ id: 'mx-util', label: 'Main-thread utilisation against players, all runs', xLabel: 'players', yLabel: 'util %', series: util, refLines: [{ value: 100, label: 'util 1.0' }], yInclude: [0, 100], xInclude: [0] })}</figure>
</div>
</section>
<section id="decision-rule" class="foot" aria-label="Decision rule">
<h2>Decision rule</h2>
<p>${esc(DECISION_RULE)}</p>
<p>In the matrices, B is the row and A the column. Chance of complete separation with no real difference: ${esc(chanceTable)}. With ${esc(m.pairs.length)} pairs some separations are expected by chance alone: each pair separates in either direction with chance 2 / C(m + n, m) (1/10 at 3 v 3), so read isolated verdicts in a large matrix with care.</p>
</section>
${methodologyHtml()}`
  return page(`bedperf: ${labels.join(' vs ')}`, body)
}
