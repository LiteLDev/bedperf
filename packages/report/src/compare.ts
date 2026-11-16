import { curveValues } from './analyze.ts'
import { DASH, esc, firstAt, fmt, fmtBytes, fmtPct, fmtRate, fmtTick, MiB } from './format.ts'
import { flagsHtml, methodologyHtml, repeatsDetail } from './html.ts'
import { binomial, dominance, interp, median, niceTicks, separationChance } from './math.ts'
import { page } from './page.ts'
import { MIN_PUBLISH_REPEATS } from './provenance.ts'
import { legend, lineChart } from './svg.ts'
import type { Series } from './svg.ts'
import { COMPARABILITY_FIELDS } from './types.ts'
import type { Analysis, Curve, CurveMetric, Derived } from './types.ts'

/**
 * - `better` / `worse`: every ok repeat of B beats (or loses to) every ok repeat of A in the
 *   metric's good direction.
 * - `not separated`: the ranges overlap or touch. This does not mean "equal".
 * - `insufficient repeats`: fewer than MIN_REPEATS values on a side; deltas are still shown.
 * - `n/a`: a side has no value at all.
 */
export type Verdict = 'better' | 'worse' | 'not separated' | 'insufficient repeats' | 'n/a'

/** Fewest per-repeat values per side for which a verdict is given. */
export const MIN_REPEATS = 2

export interface Delta {
  /** Median of A's per-repeat values. */
  a: number | undefined
  /** Median of B's per-repeat values. */
  b: number | undefined
  /** b - a (difference of the medians) */
  delta: number | undefined
  /** (b - a) / |a| * 100 */
  pct: number | undefined
  verdict: Verdict
  /** Per-repeat values (ok repeats only) behind the medians. */
  aValues: number[]
  bValues: number[]
  /** [min, max] of each side's values. */
  aRange: [number, number] | undefined
  bRange: [number, number] | undefined
  /**
   * Chance of complete separation in one given direction when there is no real difference,
   * 1 / C(m + n, m). Undefined when a side has fewer than MIN_REPEATS values.
   */
  chance: number | undefined
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

/** One comparability field of the two runs. */
export interface ComparabilityCheck {
  key: string
  label: string
  a: string | undefined
  b: string | undefined
  /** `unverified` when either run does not record the field (older runs). */
  status: 'match' | 'mismatch' | 'unverified'
}

/**
 * Something that does not refuse the comparison but weakens it: a vcpu placement, a dirty
 * harness, a different harness commit, a run that is not publishable on its own.
 */
export interface ComparabilityWarning {
  key: string
  label: string
  a: string | undefined
  b: string | undefined
  text: string
}

export interface CompareOptions {
  /** Compare even when comparability fields mismatch; the page then carries a warning banner. */
  force?: boolean
}

export interface Comparison {
  a: Analysis
  b: Analysis
  headline: Delta
  derived: CompareRow[]
  /** Player counts at which curves are compared (inside both runs' measured ranges). */
  players: number[]
  rows: CompareRow[]
  comparability: ComparabilityCheck[]
  /** The mismatching checks; non-empty only when the comparison was forced. */
  mismatches: ComparabilityCheck[]
  /** Setup differences and weaknesses that do not refuse the comparison. */
  warnings: ComparabilityWarning[]
  forced: boolean
}

/** Thrown by `compareRuns` when the runs differ in a field that makes them incomparable. */
export class IncomparableRunsError extends Error {
  readonly mismatches: ComparabilityCheck[]
  constructor (mismatches: ComparabilityCheck[]) {
    super(`runs are not comparable: ${mismatches.map((m) => `${m.label} differs (A ${m.a ?? DASH}, B ${m.b ?? DASH})`).join('; ')}. Pass force to compare anyway.`)
    this.name = 'IncomparableRunsError'
    this.mismatches = mismatches
  }
}

export const DECISION_RULE = `B is called better or worse than A on a metric only when every ok repeat of B beats every ok repeat of A in that metric's good direction (complete separation). With no real difference, every ordering of the m + n values is equally likely, so complete separation in a given direction happens by chance with probability 1 / C(m + n, m): 1/20 for 3 vs 3 repeats, 1/252 for 5 vs 5. Overlapping or touching ranges are "not separated", which does not mean equal. With fewer than ${MIN_REPEATS} ok repeats on a side no verdict is given. Server-failed and invalid repeats are never values.`

export const CURVE_DEFS: Array<MetricDef & { key: CurveMetric }> = [
  { key: 'tps', label: 'TPS mean', better: 'higher', format: (v) => fmt(v, 2) },
  { key: 'tickP99', label: 'tick interval p99 (ms)', better: 'lower', format: (v) => fmt(v, 1) },
  { key: 'util', label: 'main-thread util', better: 'lower', format: (v) => fmtPct(v, 1), deltaFormat: (v) => v === undefined ? DASH : `${fmt(v * 100, 1)} pp` },
  { key: 'cpu', label: 'process CPU (% of a core)', better: 'lower', format: (v) => fmt(v, 0) },
  { key: 'rss', label: 'RSS', better: 'lower', format: (v) => fmtBytes(v) },
  { key: 'rssPerPlayer', label: 'RSS per player', better: 'lower', format: (v) => v === undefined ? DASH : `${fmt(v / MiB, 1)} MiB` },
  { key: 'rttP95', label: 'RTT p95 (ms)', better: 'lower', format: (v) => fmt(v, 1) },
  { key: 'netTx', label: 'net tx', better: 'lower', format: (v) => fmtRate(v) },
  { key: 'counterTps', label: 'tick-counter TPS', better: 'higher', format: (v) => fmt(v, 2) },
  { key: 'tickCpuMsPerTick', label: 'tick CPU per tick (ms)', better: 'lower', format: (v) => fmt(v, 2) },
  { key: 'viewT90', label: 'view load t90, median bot (s)', better: 'lower', format: (v) => v === undefined ? DASH : fmt(v / 1000, 2) }
]

const DERIVED_DEFS: Array<MetricDef & { pick: (d: Derived) => number | undefined }> = [
  { key: 'memPerPlayer', label: 'memory per player', better: 'lower', format: (v) => fmtBytes(v), pick: (d) => d.memPerPlayer?.slope },
  { key: 'netTxPerPlayer', label: 'net tx per player', better: 'lower', format: (v) => fmtRate(v), pick: (d) => d.netTxPerPlayer?.slope },
  { key: 'utilPerPlayer', label: 'main-thread util per player', better: 'lower', format: (v) => fmtPct(v, 2), deltaFormat: (v) => v === undefined ? DASH : `${fmt(v * 100, 2)} pp`, pick: (d) => d.utilPerPlayer?.slope },
  { key: 'playersAtUtil1', label: 'players at util 1.0 (extrapolated)', better: 'higher', format: (v) => fmt(v, 0), pick: (d) => d.playersAtUtil1 },
  { key: 'tickCpuPerPlayer', label: 'tick CPU per player (ms/tick)', better: 'lower', format: (v) => fmt(v, 3), pick: (d) => d.tickCpuPerPlayer?.slope }
]

function range (xs: readonly number[]): [number, number] | undefined {
  return xs.length > 0 ? [Math.min(...xs), Math.max(...xs)] : undefined
}

/** Compares B's per-repeat values against A's with the complete-separation rule. */
export function compareValues (aValues: readonly number[], bValues: readonly number[], better: 'higher' | 'lower'): Delta {
  const av = aValues.filter(Number.isFinite)
  const bv = bValues.filter(Number.isFinite)
  const a = median(av)
  const b = median(bv)
  const base = { aValues: av, bValues: bv, aRange: range(av), bRange: range(bv) }
  if (a === undefined || b === undefined) {
    return { a, b, delta: undefined, pct: undefined, verdict: 'n/a', chance: undefined, ...base }
  }
  const d = b - a
  const pct = a !== 0 ? (d / Math.abs(a)) * 100 : (d === 0 ? 0 : undefined)
  let verdict: Verdict
  let chance: number | undefined
  if (av.length < MIN_REPEATS || bv.length < MIN_REPEATS) {
    verdict = 'insufficient repeats'
  } else {
    chance = separationChance(av.length, bv.length)
    const dom = dominance(av, bv)
    verdict = dom === 'overlap' ? 'not separated' : (dom === 'higher') === (better === 'higher') ? 'better' : 'worse'
  }
  return { a, b, delta: d, pct, verdict, chance, ...base }
}

/** Single-value comparison (one value per side): deltas only, verdict `insufficient repeats`. */
export function delta (a: number | undefined, b: number | undefined, better: 'higher' | 'lower'): Delta {
  return compareValues(a === undefined ? [] : [a], b === undefined ? [] : [b], better)
}

/** "1/20" for a separation chance. */
export function fmtChance (chance: number | undefined): string {
  if (chance === undefined || !Number.isFinite(chance) || chance <= 0) return DASH
  return `1/${Math.round(1 / chance)}`
}

// --- comparability ---------------------------------------------------------------------------

/** Checks every comparability field of the two runs. */
export function comparability (a: Analysis, b: Analysis): ComparabilityCheck[] {
  return COMPARABILITY_FIELDS.map(({ key, label, paths }) => {
    const va = firstAt(a.meta, paths)
    const vb = firstAt(b.meta, paths)
    const status = va === undefined || vb === undefined ? 'unverified' : va === vb ? 'match' : 'mismatch'
    return { key, label, a: va, b: vb, status }
  })
}

/** Warnings that do not refuse a comparison: placement kind, harness state, publishability. */
export function comparabilityWarnings (a: Analysis, b: Analysis): ComparabilityWarning[] {
  const out: ComparabilityWarning[] = []
  const pa = a.provenance
  const pb = b.provenance
  const side = (an: Analysis): string => an === a ? 'A' : 'B'
  const kindA = pa?.placement?.kind
  const kindB = pb?.placement?.kind
  if (kindA === 'vcpu' || kindB === 'vcpu' || (kindA !== undefined && kindB !== undefined && kindA !== kindB)) {
    const who = [kindA === 'vcpu' ? 'A' : '', kindB === 'vcpu' ? 'B' : ''].filter((x) => x !== '').join(' and ')
    out.push({
      key: 'placementKind',
      label: 'placement kind',
      a: kindA,
      b: kindB,
      text: kindA !== undefined && kindB !== undefined && kindA !== kindB
        ? 'One run used physical CPUs and the other virtual CPUs: differences may come from virtualization.'
        : `${who} ran on virtual CPUs (VM or WSL2): hypervisor noise widens the spread.`
    })
  }
  const harness = (an: Analysis): string | undefined => {
    const h = an.provenance?.harness
    if (h === undefined) return undefined
    return `${h.git?.slice(0, 12) ?? h.version ?? '?'}${h.dirty === true ? ' (dirty)' : ''}`
  }
  const dirty = [a, b].filter((an) => an.provenance?.harness?.dirty === true).map(side)
  if (dirty.length > 0) {
    out.push({ key: 'harnessDirty', label: 'harness', a: harness(a), b: harness(b), text: `${dirty.join(' and ')} ran from a dirty harness (uncommitted changes): unofficial, not reproducible from a commit.` })
  }
  if (pa?.harness?.git !== undefined && pb?.harness?.git !== undefined && pa.harness.git !== pb.harness.git) {
    out.push({ key: 'harnessGit', label: 'harness commit', a: harness(a), b: harness(b), text: 'The runs were measured by different harness commits.' })
  }
  for (const [key, label, va, vb] of [
    ['probePackSha256', 'probe pack hash', pa?.probePackSha256, pb?.probePackSha256],
    ['bedbooCommit', 'bedboo commit', pa?.bedbooCommit, pb?.bedbooCommit]
  ] as const) {
    if (va !== undefined && vb !== undefined && va !== vb) out.push({ key, label, a: va, b: vb, text: `The ${label} differs: the measuring side changed between the runs.` })
  }
  const unverified = [a, b].filter((an) => an.provenance?.placement?.verified === false).map(side)
  if (unverified.length > 0) out.push({ key: 'placementVerified', label: 'placement verified', a: String(pa?.placement?.verified ?? DASH), b: String(pb?.placement?.verified ?? DASH), text: `CPU placement did not verify in ${unverified.join(' and ')}.` })
  // Same rule as each run's own report (threatsOf): any `bad` threat blocks publishing.
  const unpub = [a, b].filter((an) => an.publishable === false || (an.publishable === undefined && an.headline.kOk < MIN_PUBLISH_REPEATS))
  if (unpub.length > 0) {
    const why = (an: Analysis): string => (an.threats ?? []).filter((t) => t.level === 'bad').map((t) => t.id).join(', ') || `fewer than ${MIN_PUBLISH_REPEATS} ok repeats`
    out.push({ key: 'publishable', label: 'publishable', a: a.publishable === false ? 'no' : 'yes', b: b.publishable === false ? 'no' : 'yes', text: `Not publishable: ${unpub.map((an) => `${side(an)} (${why(an)})`).join(', ')}. ${a.headline.kOk} v ${b.headline.kOk} ok repeats.` })
  }
  return out
}

// --- comparison ------------------------------------------------------------------------------

const okCurveCache = new WeakMap<Analysis, Curve[]>()

/** Per-repeat curves of the ok repeats (cached per analysis). */
function okCurves (an: Analysis): Curve[] {
  let cs = okCurveCache.get(an)
  if (cs === undefined) {
    const ok = new Set(an.okRepeats)
    cs = an.curves.filter((c) => c.repeat !== undefined && ok.has(c.repeat))
    okCurveCache.set(an, cs)
  }
  return cs
}

function playerSpan (c: Curve): [number, number] | undefined {
  return range(c.points.map((p) => p.players))
}

/**
 * Player counts at which every ok repeat of both runs was measured ("nice" round numbers plus
 * each run's headline). Falls back to the mean curves' common range when the repeats share none.
 */
function matchedPlayers (a: Analysis, b: Analysis): number[] {
  const spans = [...okCurves(a), ...okCurves(b)].map(playerSpan)
  const hasBoth = okCurves(a).length > 0 && okCurves(b).length > 0
  let lo = -Infinity
  let hi = Infinity
  if (hasBoth && spans.every((s) => s !== undefined)) {
    for (const s of spans as Array<[number, number]>) { lo = Math.max(lo, s[0]); hi = Math.min(hi, s[1]) }
  }
  if (!hasBoth || !(hi >= lo)) {
    const pa = a.meanCurve.points.map((p) => p.players)
    const pb = b.meanCurve.points.map((p) => p.players)
    if (pa.length === 0 || pb.length === 0) return []
    lo = Math.max(Math.min(...pa), Math.min(...pb))
    hi = Math.min(Math.max(...pa), Math.max(...pb))
  }
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

/** Per-ok-repeat values of a curve metric at `players`, interpolated on each repeat's curve. */
function curveValuesAt (an: Analysis, m: CurveMetric, players: number): number[] {
  return okCurves(an).flatMap((c) => {
    const v = interp(curveValues(c, m), players)
    return v === undefined ? [] : [v]
  })
}

/**
 * Compares run B against baseline A. Throws `IncomparableRunsError` when a comparability field
 * differs, unless `opts.force` is set.
 */
export function compareRuns (a: Analysis, b: Analysis, opts: CompareOptions = {}): Comparison {
  const checks = comparability(a, b)
  const mismatches = checks.filter((c) => c.status === 'mismatch')
  if (mismatches.length > 0 && opts.force !== true) throw new IncomparableRunsError(mismatches)

  const players = matchedPlayers(a, b)
  const rows: CompareRow[] = []
  for (const def of CURVE_DEFS) {
    const any = (an: Analysis): boolean => okCurves(an).some((c) => curveValues(c, def.key).length > 0)
    if (!any(a) && !any(b)) continue
    for (const p of players) rows.push({ metric: def, players: p, ...compareValues(curveValuesAt(a, def.key, p), curveValuesAt(b, def.key, p), def.better) })
  }
  const slopes = (an: Analysis, pick: (d: Derived) => number | undefined): number[] =>
    an.repeatDerived.flatMap((r) => { const v = pick(r.derived); return v === undefined ? [] : [v] })
  const derived = DERIVED_DEFS.map(({ pick, ...metric }): CompareRow => ({ metric, players: undefined, ...compareValues(slopes(a, pick), slopes(b, pick), metric.better) }))
  return {
    a,
    b,
    headline: compareValues(a.headline.perRepeat, b.headline.perRepeat, 'higher'),
    derived,
    players,
    rows,
    comparability: checks,
    mismatches,
    warnings: comparabilityWarnings(a, b),
    forced: mismatches.length > 0
  }
}

// --- HTML ------------------------------------------------------------------------------------

function verdictClass (v: Verdict): string {
  return v === 'better' ? 'better' : v === 'worse' ? 'worse' : 'same'
}

function verdictCell (d: Delta): string {
  const n = d.aValues.length > 0 || d.bValues.length > 0 ? ` <span class="vn">${d.aValues.length} v ${d.bValues.length}${d.chance !== undefined ? `, chance ${fmtChance(d.chance)}` : ''}</span>` : ''
  return `<td class="l ${verdictClass(d.verdict)}">${esc(d.verdict)}${n}</td>`
}

function pctCell (d: Delta): string {
  if (d.pct === undefined) return `<td class="same">${DASH}</td>`
  const sign = d.pct > 0 ? '+' : ''
  return `<td class="${verdictClass(d.verdict)}">${sign}${fmt(d.pct, 1)} %</td>`
}

function deltaCell (d: Delta, f: (v: number | undefined) => string): string {
  if (d.delta === undefined) return `<td>${DASH}</td>`
  const s = f(d.delta)
  return `<td>${d.delta > 0 && !s.startsWith('+') ? '+' : ''}${esc(s)}</td>`
}

/** "median [min, max]" of one side. */
function valueCell (v: number | undefined, r: [number, number] | undefined, n: number, f: (v: number | undefined) => string): string {
  if (v === undefined) return `<td>${DASH}</td>`
  const rng = r !== undefined && n > 1 ? ` <span class="rng">[${esc(f(r[0]))}, ${esc(f(r[1]))}]</span>` : ''
  return `<td>${esc(f(v))}${rng}</td>`
}

function rowCells (r: CompareRow): string {
  const f = r.metric.format
  return `${valueCell(r.a, r.aRange, r.aValues.length, f)}${valueCell(r.b, r.bRange, r.bValues.length, f)}${deltaCell(r, r.metric.deltaFormat ?? f)}${pctCell(r)}${verdictCell(r)}`
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

function headlineVerdictText (h: Delta): string {
  const m = h.aValues.length
  const n = h.bValues.length
  switch (h.verdict) {
    case 'better':
    case 'worse':
      return `${h.verdict}: every ok repeat of B is ${h.verdict === 'better' ? 'above' : 'below'} every ok repeat of A (${m} v ${n}). Chance of this with no real difference: ${fmtChance(h.chance)}.`
    case 'not separated':
      return `not separated: the ok repeats' ranges overlap (${m} v ${n}; complete separation would have had chance ${fmtChance(h.chance)}). This does not mean equal.`
    case 'insufficient repeats':
      return `insufficient repeats: ${m} v ${n} ok repeats, at least ${MIN_REPEATS} per side are needed for a verdict.`
    case 'n/a':
      return 'not comparable: a run has no ok repeat'
  }
}

function comparabilitySection (c: Comparison): string {
  const label = { match: 'match', mismatch: 'MISMATCH', unverified: 'cannot verify' }
  const cls = { match: 'pass', mismatch: 'fail', unverified: 'invalid' }
  const rows = c.comparability.map((k) => `<tr><td class="l">${esc(k.label)}</td><td class="l"><code>${esc(k.a ?? DASH)}</code></td><td class="l"><code>${esc(k.b ?? DASH)}</code></td><td class="l"><span class="st ${cls[k.status]}">${label[k.status]}</span></td></tr>`).join('\n')
  const warnRows = (c.warnings ?? []).map((w) => `<tr><td class="l">${esc(w.label)}</td><td class="l"><code>${esc(w.a ?? DASH)}</code></td><td class="l"><code>${esc(w.b ?? DASH)}</code></td><td class="l"><span class="st invalid">warning</span></td></tr>`).join('\n')
  const warnBox = (c.warnings ?? []).length > 0
    ? `<div class="cmp-warn" role="note"><b>Comparison warnings.</b><ul>${c.warnings.map((w) => `<li data-warning="${esc(w.key)}">${esc(w.text)}</li>`).join('')}</ul></div>`
    : ''
  const unverified = c.comparability.filter((k) => k.status === 'unverified')
  const note = unverified.length > 0
    ? `<p class="foot">Cannot verify ${unverified.map((k) => esc(k.label)).join(', ')}: at least one run does not record ${unverified.length === 1 ? 'it' : 'them'} (older run). The comparison assumes they match.</p>`
    : ''
  return `<section id="comparability" aria-label="Comparability">
<h2>Comparability</h2>
<div class="scroll"><table>
<thead><tr><th class="l">field</th><th class="l">A</th><th class="l">B</th><th class="l">status</th></tr></thead>
<tbody>${rows}${warnRows !== '' ? `\n${warnRows}` : ''}</tbody>
</table></div>
${note}
${warnBox}
</section>`
}

function hasCurve (c: Comparison, m: CurveMetric): boolean {
  return curveValues(c.a.meanCurve, m).length > 0 || curveValues(c.b.meanCurve, m).length > 0
}

/** Renders a self-contained HTML comparison of run B against baseline A. */
export function renderCompareHtml (c: Comparison): string {
  const h = c.headline
  const headlineDelta = h.delta === undefined
    ? DASH
    : `${h.delta > 0 ? '+' : ''}${fmtTick(h.delta, 1)} players${h.pct !== undefined ? ` (${h.pct > 0 ? '+' : ''}${fmt(h.pct, 1)} %)` : ''}`

  const overlay = (key: CurveMetric, scale: number, yLabel: string, ref: { value: number, label: string } | undefined, include: number[]): string => {
    const series: Series[] = [
      { name: `A: ${c.a.name}`, slot: 1, markers: true, points: curveValues(c.a.meanCurve, key).map(([x, y]) => [x, y * scale] as [number, number]) },
      { name: `B: ${c.b.name}`, slot: 2, markers: true, points: curveValues(c.b.meanCurve, key).map(([x, y]) => [x, y * scale] as [number, number]) }
    ]
    return `${legend(series)}${lineChart({ id: `cmp-${key}`, label: `${yLabel} against players, A vs B`, xLabel: 'players', yLabel, series, refLines: ref !== undefined ? [ref] : [], yInclude: include, xInclude: [0] })}`
  }

  const derivedRows = c.derived.map((r) => `<tr><td class="l">${esc(r.metric.label)}</td>${rowCells(r)}</tr>`).join('\n')
  const metricRows = c.rows.map((r) => `<tr><td class="l">${esc(r.metric.label)}</td><td>${esc(r.players)}</td>${rowCells(r)}</tr>`).join('\n')
  const banner = c.forced
    ? `<div class="banner" role="alert"><b>These runs are not comparable.</b> ${c.mismatches.map((m) => `${esc(m.label)} differs (A <code>${esc(m.a ?? DASH)}</code>, B <code>${esc(m.b ?? DASH)}</code>)`).join('; ')}. The comparison was forced; differences below may come from the setup, not the change under test.</div>`
    : ''
  const chanceTable = [[3, 3], [5, 5]].map(([m, n]) => `${m} v ${n}: 1/${binomial(m! + n!, m!)}`).join(', ')

  const body = `<header>
<h1>bedperf comparison</h1>
<p class="sub">A (baseline): ${esc(c.a.name)} · B: ${esc(c.b.name)}. Deltas are B relative to A, between medians over ok repeats; brackets give each side's [min, max].</p>
</header>
${banner}
<section id="headline" aria-label="Headline">
<h2>Max players @ 20 TPS</h2>
<div class="vs">
${runCard('A', c.a, 1)}
${runCard('B', c.b, 2)}
<div class="hero"><div class="label">Change (B − A, medians)</div><div class="value delta ${verdictClass(h.verdict)}">${esc(headlineDelta)}</div><div class="detail verdict">${esc(headlineVerdictText(h))}</div></div>
</div>
</section>
${comparabilitySection(c)}
<section id="derived" aria-label="Derived metrics">
<h2>Per-player costs</h2>
<p class="foot">Slopes fitted per ok repeat; the verdict compares those per-repeat slopes.</p>
<div class="scroll"><table>
<thead><tr><th class="l">metric</th><th>A</th><th>B</th><th>Δ</th><th>Δ %</th><th class="l">verdict</th></tr></thead>
<tbody>${derivedRows}</tbody>
</table></div>
</section>
<section id="scaling" aria-label="Scaling">
<h2>Scaling, mean over ok repeats</h2>
<div class="charts">
<figure><h3>TPS</h3>${overlay('tps', 1, 'TPS', { value: 20, label: '20 TPS' }, [16, 20])}</figure>
<figure><h3>Main-thread utilisation</h3>${overlay('util', 100, 'util %', { value: 100, label: 'util 1.0' }, [0, 100])}</figure>
${hasCurve(c, 'tickCpuMsPerTick') ? `<figure><h3>Tick CPU per tick</h3>${overlay('tickCpuMsPerTick', 1, 'ms / tick', undefined, [0])}</figure>` : ''}
${hasCurve(c, 'counterTps') ? `<figure><h3>Tick-counter TPS</h3>${overlay('counterTps', 1, 'TPS', { value: 20, label: '20 TPS' }, [16, 20])}</figure>` : ''}
</div>
</section>
<section id="metrics" aria-label="Metric deltas">
<h2>Metrics at matched player counts</h2>
<p class="foot">Each ok repeat's scaling curve is linearly interpolated at player counts inside the ok repeats' measured ranges${c.players.length > 0 ? ` (${c.players.map(esc).join(', ')})` : ''}; the verdict compares those per-repeat values. A repeat that did not measure a count is left out of that row, which the m v n in the verdict shows.</p>
<div class="scroll"><table>
<thead><tr><th class="l">metric</th><th>players</th><th>A</th><th>B</th><th>Δ</th><th>Δ %</th><th class="l">verdict</th></tr></thead>
<tbody>${metricRows || '<tr><td class="l" colspan="7">The runs have no overlapping player range.</td></tr>'}</tbody>
</table></div>
</section>
<section id="decision-rule" class="foot" aria-label="Decision rule">
<h2>Decision rule</h2>
<p>${esc(DECISION_RULE)}</p>
<p>Chance of complete separation with no real difference: ${esc(chanceTable)}. Each verdict cell shows its own m v n and chance.</p>
</section>
${methodologyHtml()}`
  return page(`bedperf: ${c.a.name} vs ${c.b.name}`, body)
}
