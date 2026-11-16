import { DASH, esc, fmt, fmtBytes, fmtDuration, fmtPct, fmtRate, fmtTick, MiB } from './format.ts'
import { curveValues } from './analyze.ts'
import { page } from './page.ts'
import { legend, lineChart, timeTicks } from './svg.ts'
import type { Series } from './svg.ts'
import type { Analysis, Curve, CurveMetric, StepRow } from './types.ts'


/** server.properties keys that matter most for performance, shown up front. */
const KEY_PROPERTIES = [
  'max-players', 'view-distance', 'tick-distance', 'max-threads', 'gamemode', 'difficulty', 'level-type',
  'server-authoritative-movement-strict', 'server-authoritative-movement', 'player-movement-settings',
  'compression-threshold', 'compression-algorithm', 'online-mode', 'transport'
]

function slotOf (i: number): number {
  return (i % 8) + 1
}

function repeatLabel (r: number | undefined): string {
  return r === undefined ? 'mean' : `repeat ${r}`
}

export function flagsHtml (a: Analysis): string {
  const h = a.headline
  const flags: string[] = []
  if (h.aborted) flags.push('<span class="flag bad">aborted: no result.json</span>')
  if (h.capped) flags.push('<span class="flag warn">capped: hit ramp.max, true capacity is higher</span>')
  if (h.loadgenLimited) flags.push('<span class="flag warn">loadgen limited: some steps invalid</span>')
  if (flags.length === 0) flags.push('<span class="flag ok">no flags</span>')
  return `<div class="flags">${flags.join('')}</div>`
}

export function repeatsDetail (a: Analysis): string {
  const h = a.headline
  if (h.perRepeat.length === 0) return 'no repeats recorded'
  const list = h.perRepeat.map((v) => esc(v)).join(' · ')
  return `${h.perRepeat.length} repeat${h.perRepeat.length === 1 ? '' : 's'}: ${list} (range ${esc(h.min)}–${esc(h.max)}, spread ${esc(h.spread)})`
}

function tile (k: string, v: string, n = ''): string {
  return `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${n !== '' ? `<div class="n">${esc(n)}</div>` : ''}</div>`
}

function r2Note (r2: number | undefined, n: number | undefined): string {
  return r2 === undefined ? '' : `linear fit, R² ${fmt(r2, 2)}, ${n ?? 0} steps`
}

function headlineSection (a: Analysis): string {
  const h = a.headline
  const d = a.derived
  const value = h.maxPlayersMedian === undefined ? DASH : fmtTick(h.maxPlayersMedian, 1)
  return `<section id="headline" class="headline" aria-label="Headline">
<div class="hero">
<div class="label">Max players @ 20 TPS (median)</div>
<div class="value">${esc(value)}</div>
<div class="detail">${repeatsDetail(a)}</div>
${flagsHtml(a)}
</div>
<div class="tiles">
${tile('Memory per player', fmtBytes(d.memPerPlayer?.slope), r2Note(d.memPerPlayer?.r2, d.memPerPlayer?.n))}
${tile('Net tx per player', fmtRate(d.netTxPerPlayer?.slope), r2Note(d.netTxPerPlayer?.r2, d.netTxPerPlayer?.n))}
${tile('Main-thread util per player', d.utilPerPlayer === undefined ? DASH : `${fmt(d.utilPerPlayer.slope * 100, 2)} %`, r2Note(d.utilPerPlayer?.r2, d.utilPerPlayer?.n))}
${tile('Players at util 1.0 (extrapolated)', d.playersAtUtil1 === undefined ? DASH : fmt(d.playersAtUtil1, 0), 'where the util fit reaches a fully busy tick thread')}
</div>
</section>`
}

function dlItem (k: string, v: unknown): string {
  const s = v === undefined || v === null || v === '' ? DASH : String(v)
  return `<div><dt>${esc(k)}</dt><dd>${esc(s)}</dd></div>`
}

function jsonish (v: unknown): string {
  if (v === undefined) return DASH
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function metaSection (a: Analysis): string {
  const m = a.meta
  const c = a.config
  const started = Date.parse(m.startedAt)
  const finished = m.finishedAt !== undefined ? Date.parse(m.finishedAt) : Number.NaN
  const duration = Number.isFinite(started) && Number.isFinite(finished) ? fmtDuration((finished - started) / 1000) : undefined
  const props = c.serverProperties ?? {}
  const keyProps = KEY_PROPERTIES.filter((k) => k in props)
  const world = c.world?.snapshot !== undefined ? `snapshot ${c.world.snapshot}` : `seed ${c.world?.seed ?? DASH}, ${c.world?.levelType ?? 'DEFAULT'}`
  const ramp = c.ramp !== undefined ? `start ${c.ramp.start}, step ${c.ramp.step}, max ${c.ramp.max}, resolution ${c.ramp.resolution}; settle ${c.ramp.settleSec} s, hold ${c.ramp.holdSec} s` : undefined
  const cr = c.criteria
  const criteria = cr !== undefined
    ? `TPS mean ≥ ${cr.minAvgTps}, worst window ≥ ${cr.minWorstWindowTps} (discard ${cr.worstWindowDiscardPct} %), tick p99 ≤ ${cr.maxTickIntervalP99Ms} ms, bot failures ≤ ${cr.maxBotFailures}${cr.maxMainThreadUtil !== undefined ? `, util ≤ ${cr.maxMainThreadUtil}` : ''}`
    : undefined
  const host = m.host ?? {}
  const allProps = Object.entries(props).map(([k, v]) => `<div><dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd></div>`).join('')
  return `<section id="metadata" aria-label="Run metadata">
<h2>Run metadata</h2>
<dl class="meta">
${dlItem('Config', a.name)}
${dlItem('Run id', a.runId)}
${dlItem('Started', m.startedAt)}
${dlItem('Duration', duration)}
${dlItem('BDS version', m.bdsVersion)}
${dlItem('Bot version', m.botVersion)}
${dlItem('bedboo commit', m.bedbooCommit)}
${dlItem('bedperf version', m.bedperfVersion)}
${dlItem('Host CPU', host.cpuModel !== undefined ? `${host.cpuModel} (${host.cpuCount} threads)` : undefined)}
${dlItem('Host RAM', fmtBytes(host.totalMemBytes, 0))}
${dlItem('Host OS', host.os !== undefined ? `${host.os} ${host.arch ?? ''}` : undefined)}
${dlItem('Loadgen colocated', m.colocated === undefined ? undefined : m.colocated ? 'yes' : 'no')}
${dlItem('Scenario', c.scenario?.module)}
${dlItem('Scenario params', jsonish(c.scenario?.params ?? {}))}
${dlItem('World', world)}
${dlItem('Loadgen', c.loadgen !== undefined ? `${c.loadgen.botsPerWorker} bots/worker, join every ${c.loadgen.joinIntervalMs} ms` : undefined)}
${dlItem('Ramp', ramp)}
${dlItem('Pass criteria', criteria)}
${dlItem('Repeats / warmup', `${c.repeats ?? DASH} / ${c.warmupSec ?? DASH} s`)}
${keyProps.map((k) => dlItem(k, props[k])).join('\n')}
</dl>
<details><summary>All server properties (${Object.keys(props).length})</summary><dl class="meta">${allProps}</dl></details>
</section>`
}

function curveSeries (curves: Curve[], metric: CurveMetric, scale = 1): Series[] {
  return curves.map((c, i) => ({
    name: repeatLabel(c.repeat),
    slot: slotOf(i),
    markers: true,
    points: curveValues(c, metric).map(([x, y]) => [x, y * scale] as [number, number])
  }))
}

function scalingSection (a: Analysis): string {
  const curves = a.curves
  const tip = (unit: string, digits: number) => (x: number, y: number): string => `${x} players: ${fmt(y, digits)} ${unit}`
  const withTip = (ss: Series[], unit: string, digits: number): Series[] => ss.map((s) => ({ ...s, tip: (x, y) => `${s.name}, ${tip(unit, digits)(x, y)}` }))

  const tps = withTip(curveSeries(curves, 'tps'), 'TPS', 2)
  const util = withTip(curveSeries(curves, 'util', 100), '% util', 1)
  const fit = a.derived.utilPerPlayer
  const allPlayers = a.steps.map((s) => s.players)
  if (fit !== undefined && allPlayers.length > 0) {
    const x0 = Math.min(...allPlayers)
    const x1 = Math.max(...allPlayers, a.derived.playersAtUtil1 ?? 0)
    util.push({ name: 'linear fit', slot: 'muted', dash: true, points: [[x0, (fit.intercept + fit.slope * x0) * 100], [x1, (fit.intercept + fit.slope * x1) * 100]] })
  }
  // RSS per player above the zero-player baseline (intercept of the RSS fit); raw RSS / players
  // is dominated by the fixed baseline at low counts.
  const mem = a.derived.memPerPlayer
  const rss = withTip(curves.map((c, i): Series => ({
    name: repeatLabel(c.repeat),
    slot: slotOf(i),
    markers: true,
    points: c.points.flatMap((p): Array<[number, number]> => {
      const v = p.values.rss
      return v === undefined || mem === undefined || p.players <= 0 ? [] : [[p.players, (v - mem.intercept) / p.players / MiB]]
    })
  })), 'MiB/player', 2)
  const rtt = withTip(curveSeries(curves, 'rttP95'), 'ms', 1)

  const fig = (id: string, title: string, series: Series[], chart: string): string =>
    `<figure id="${id}"><h3>${esc(title)}</h3>${legend(series)}${chart}</figure>`

  return `<section id="scaling" aria-label="Scaling">
<h2>Scaling with player count</h2>
<div class="charts">
${fig('chart-tps', 'TPS (step mean)', tps, lineChart({ id: 'sc-tps', label: 'Mean TPS against players', xLabel: 'players', yLabel: 'TPS', series: tps, refLines: [{ value: 20, label: '20 TPS' }], yInclude: [16, 20], xInclude: [0] }))}
${fig('chart-util', 'Main-thread utilisation', util, lineChart({ id: 'sc-util', label: 'Main-thread utilisation against players', xLabel: 'players', yLabel: 'util %', series: util, refLines: [{ value: 100, label: 'util 1.0' }], yInclude: [0, 100], xInclude: [0] }))}
${fig('chart-rss', 'RSS per player (above the 0-player baseline)', rss, lineChart({ id: 'sc-rss', label: 'RSS per player against players', xLabel: 'players', yLabel: 'MiB / player', series: rss, refLines: mem !== undefined ? [{ value: mem.slope / MiB, label: `slope ${fmt(mem.slope / MiB, 1)} MiB` }] : [], yInclude: [0], xInclude: [0] }))}
${fig('chart-rtt', 'Tick-bound RTT p95', rtt, lineChart({ id: 'sc-rtt', label: 'RTT p95 against players', xLabel: 'players', yLabel: 'ms', series: rtt, yInclude: [0], xInclude: [0] }))}
</div>
</section>`
}

function timelineSection (a: Analysis): string {
  const tl = a.timeline
  const parts: string[] = []
  for (const w of tl.repeats) {
    const inW = (p: readonly [number, number]): boolean => p[0] >= w.x0 && p[0] <= w.x1
    const bands = tl.bands.filter((b) => b.t1 >= w.x0 && b.t0 <= w.x1)
    const dom: [number, number] = [w.x0, w.x1 > w.x0 ? w.x1 : w.x0 + 1]
    const common = { xDomain: dom, xTickValues: (lo: number, hi: number) => timeTicks(lo, hi, 8), xFormat: (v: number) => fmtDuration(v), bands, xLabel: 'run time (m:ss)' }
    const tps: Series[] = [{ name: 'TPS (1 s window, min per bucket)', slot: 1, points: tl.tps.filter(inW) }]
    const util: Series[] = [{ name: 'main-thread util', slot: 2, points: tl.util.filter(inW).map(([x, y]) => [x, y * 100] as [number, number]) }]
    const players: Series[] = [{ name: 'players', slot: 3, points: tl.players.filter(inW) }]
    const title = tl.repeats.length > 1 ? `Repeat ${w.repeat}` : 'Run'
    parts.push(`<div class="repeat" id="timeline-r${esc(w.repeat)}">
<h3>${esc(title)}</h3>
${legend([...tps, ...util, ...players], true)}
<div class="scroll"><div class="panels">
${lineChart({ ...common, id: `tl-${w.repeat}-tps`, label: `TPS over time, ${title}`, yLabel: 'TPS', series: tps, refLines: [{ value: 20, label: '20 TPS' }], yInclude: [16, 20], height: 200, width: 720 })}
${lineChart({ ...common, id: `tl-${w.repeat}-util`, label: `Main-thread utilisation over time, ${title}`, yLabel: 'util %', series: util, refLines: [{ value: 100, label: 'util 1.0' }], yInclude: [0, 100], height: 180, width: 720 })}
${lineChart({ ...common, id: `tl-${w.repeat}-players`, label: `Players over time, ${title}`, yLabel: 'players', series: players, yInclude: [0], height: 180, width: 720 })}
</div></div>
</div>`)
  }
  return `<section id="timeline" aria-label="Timeline">
<h2>Timeline</h2>
${parts.join('\n')}
</section>`
}

function statusCell (r: StepRow): string {
  if (r.invalid) return '<span class="st invalid">invalid</span>'
  return r.pass ? '<span class="st pass">pass</span>' : '<span class="st fail">fail</span>'
}

function stepsSection (a: Analysis): string {
  const rows = a.steps.map((r) => `<tr>
<td>${esc(r.repeat)}</td><td>${esc(r.index)}</td><td class="l">${esc(r.phase)}</td><td>${esc(r.players)}</td><td class="l">${statusCell(r)}</td>
<td>${fmt(r.tpsMean, 2)}</td><td>${fmt(r.tpsMin, 1)}</td><td>${fmt(r.tickP99, 1)}</td><td>${esc(r.over50)}</td><td>${esc(r.over100)}</td>
<td>${fmtPct(r.utilMean, 1)}</td><td>${fmt(r.cpuMean, 0)}</td><td>${r.rssMean === undefined ? DASH : `${fmt(r.rssMean / MiB, 0)} MiB`}</td><td>${fmt(r.rttP95, 1)}</td>
<td>${fmtRate(r.netRxBps)}</td><td>${fmtRate(r.netTxBps)}</td><td>${esc(r.botFailures)}</td>
<td class="reasons">${r.failReasons.length > 0 ? r.failReasons.map(esc).join('<br>') : ''}</td>
</tr>`).join('\n')
  return `<section id="steps" aria-label="Steps">
<h2>Steps</h2>
<div class="scroll">
<table>
<thead><tr>
<th>rep</th><th>#</th><th class="l">phase</th><th>players</th><th class="l">result</th>
<th>TPS mean</th><th>TPS min</th><th>tick p99 ms</th><th>&gt;50 ms</th><th>&gt;100 ms</th>
<th>util mean</th><th>CPU %</th><th>RSS</th><th>RTT p95 ms</th><th>net rx</th><th>net tx</th><th>bot fails</th><th class="l">fail reasons</th>
</tr></thead>
<tbody>
${rows || '<tr><td class="l" colspan="18">No steps recorded.</td></tr>'}
</tbody>
</table>
</div>
</section>`
}

export function methodologyHtml (notes: string[] = []): string {
  return `<section id="methodology" class="foot" aria-label="Methodology">
<h2>Methodology</h2>
<p>The headline is the largest bot count that passed every criterion in a step, taken as the median over independent repeats on fresh instances. Each repeat ramps the bot count until the first failing step, then bisects between the last pass and the first fail. Steps measured while the load generator was saturated are invalid rather than failed.</p>
<ul>
<li><b>TPS</b> comes from the Script API probe: ticks per ~1 s window, measured inside the server tick.</li>
<li><b>Main-thread utilisation</b> is the CPU share of the busiest server thread (OS sampling). Because BDS sleeps out the rest of each 50 ms tick it approximates MSPT / 50 ms. It cannot separate lock waits from sleep and does not include work offloaded to other threads.</li>
<li><b>Per-player figures</b> are least-squares slopes over the step means of all repeats. Utilisation is fitted on passing steps when possible, because it flattens near 1.0 once the tick thread is saturated. "Players at util 1.0" extrapolates that fit.</li>
<li><b>RSS per player</b> in the scaling chart is (RSS − fitted zero-player RSS) / players, so the fixed server baseline does not dominate low player counts. It converges on the memory-per-player slope.</li>
<li><b>RTT</b> is the tick-bound round trip of a scripted ping as seen by the bots, i.e. client-perceived lag.</li>
<li>The timeline is downsampled for size. TPS shows the minimum of each bucket so dips stay visible.</li>
</ul>
${notes.length > 0 ? `<h3>Notes</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<p>Generated by bedperf.</p>
</section>`
}

/** Renders the self-contained HTML report for one run. */
export function renderHtml (a: Analysis): string {
  const body = `<header>
<h1>bedperf report: ${esc(a.name)}</h1>
<p class="sub">Run ${esc(a.runId)} · BDS ${esc(a.meta.bdsVersion)} · ${esc(a.config.scenario?.module ?? '')}</p>
</header>
${headlineSection(a)}
${metaSection(a)}
${scalingSection(a)}
${timelineSection(a)}
${stepsSection(a)}
${methodologyHtml(a.notes)}`
  return page(`bedperf: ${a.name}`, body)
}
