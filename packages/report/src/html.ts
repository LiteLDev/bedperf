import { DASH, esc, firstAt, fmt, fmtBytes, fmtDuration, fmtPct, fmtRate, fmtTick, MiB } from './format.ts'
import { ANALYSIS_VERSION, curveValues } from './analyze.ts'
import { page } from './page.ts'
import { legend, lineChart, timeTicks } from './svg.ts'
import type { Series } from './svg.ts'
import { MIN_PUBLISH_REPEATS } from './provenance.ts'
import { REPEAT_STATUSES } from './types.ts'
import type { Analysis, Curve, CurveMetric, StepRow, Threat } from './types.ts'

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
  if (h.invalidLimited) flags.push('<span class="flag warn">invalid-limited: search stopped on invalid steps</span>')
  if (a.provenance?.harness?.dirty === true) flags.push('<span class="flag bad">unofficial: dirty harness</span>')
  if (a.provenance?.placement?.kind === 'vcpu') flags.push('<span class="flag warn">vcpu: virtualized CPUs</span>')
  if (a.provenance?.placement?.verified === false) flags.push('<span class="flag bad">placement not verified</span>')
  if (h.kOk < MIN_PUBLISH_REPEATS) flags.push(`<span class="flag bad">not publishable: ${esc(h.kOk)} ok repeat${h.kOk === 1 ? '' : 's'} (&lt; ${MIN_PUBLISH_REPEATS})</span>`)
  if (h.statusCounts.server_failed > 0) flags.push(`<span class="flag bad">${h.statusCounts.server_failed} repeat${h.statusCounts.server_failed === 1 ? '' : 's'} server_failed</span>`)
  if (h.statusCounts.invalid > 0) flags.push(`<span class="flag warn">${h.statusCounts.invalid} repeat${h.statusCounts.invalid === 1 ? '' : 's'} invalid</span>`)
  if (flags.length === 0) flags.push('<span class="flag ok">no flags</span>')
  return `<div class="flags">${flags.join('')}</div>`
}

/** "k/n ok · median [min, max] · per-repeat values with status" for a headline card. */
export function repeatsDetail (a: Analysis): string {
  const h = a.headline
  if (h.n === 0) return 'no repeats recorded'
  const counts = REPEAT_STATUSES.filter((s) => h.statusCounts[s] > 0 && s !== 'ok').map((s) => `${h.statusCounts[s]} ${s}`)
  const head = `<b>${esc(h.kOk)}/${esc(h.n)} repeats ok</b>${counts.length > 0 ? ` (${esc(counts.join(', '))})` : ''}`
  const range = h.min !== undefined ? `, range [${esc(h.min)}, ${esc(h.max)}], spread ${esc(h.spread)}` : ''
  const list = h.repeats.map((r) => {
    const v = r.maxPlayers === undefined ? DASH : String(r.maxPlayers)
    return r.status === 'ok' ? esc(v) : `<span class="rs ${r.status}">${esc(v)} ${esc(r.status)}</span>`
  }).join(' · ')
  return `${head}${range}: ${list}`
}

function repeatsTable (a: Analysis): string {
  const h = a.headline
  if (h.n === 0) return ''
  const rows = h.repeats.map((r) => `<tr><td>${esc(r.repeat)}</td><td class="l"><span class="st ${r.status === 'ok' ? 'pass' : r.status === 'server_failed' ? 'fail' : 'invalid'}">${esc(r.status)}</span></td><td>${r.maxPlayers === undefined ? DASH : esc(r.maxPlayers)}</td><td>${r.status === 'ok' ? 'yes' : 'no'}</td><td class="reasons">${r.reasons.map(esc).join('<br>')}</td></tr>`).join('\n')
  return `<details class="repeats"${h.kOk < h.n ? ' open' : ''}><summary>Repeats (${esc(h.kOk)}/${esc(h.n)} ok)</summary>
<div class="scroll"><table>
<thead><tr><th>repeat</th><th class="l">status</th><th>max players</th><th>in median</th><th class="l">reasons</th></tr></thead>
<tbody>${rows}</tbody>
</table></div></details>`
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
<div class="label">Max players @ 20 TPS (median of ok repeats)</div>
<div class="value">${esc(value)}</div>
<div class="detail">${repeatsDetail(a)}</div>
${flagsHtml(a)}
${repeatsTable(a)}
</div>
<div class="tiles">
${tile('Memory per player', fmtBytes(d.memPerPlayer?.slope), r2Note(d.memPerPlayer?.r2, d.memPerPlayer?.n))}
${tile('Net tx per player', fmtRate(d.netTxPerPlayer?.slope), r2Note(d.netTxPerPlayer?.r2, d.netTxPerPlayer?.n))}
${tile('Main-thread util per player', d.utilPerPlayer === undefined ? DASH : `${fmt(d.utilPerPlayer.slope * 100, 2)} %`, r2Note(d.utilPerPlayer?.r2, d.utilPerPlayer?.n))}
${tile('Players at util 1.0 (extrapolated)', d.playersAtUtil1 === undefined ? DASH : fmt(d.playersAtUtil1, 0), 'where the util fit reaches a fully busy tick thread')}
${d.tickCpuPerPlayer !== undefined ? tile('Tick CPU per player', `${fmt(d.tickCpuPerPlayer.slope, 3)} ms/tick`, `${r2Note(d.tickCpuPerPlayer.r2, d.tickCpuPerPlayer.n)}; base ${fmt(d.tickCpuPerPlayer.intercept, 1)} ms/tick`) : ''}
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

function badge (level: 'ok' | 'warn' | 'bad', text: string): string {
  return ` <span class="flag ${level}">${esc(text)}</span>`
}

function codeItem (k: string, v: string | undefined, extra = ''): string {
  return `<div><dt>${esc(k)}</dt><dd>${v === undefined ? 'not recorded' : `<code>${esc(v)}</code>`}${extra}</dd></div>`
}

/** Provenance and environment: hashes, machine, harness, placement plan and gates. */
function provenanceSection (a: Analysis): string {
  const p = a.provenance ?? { gates: [] }
  const h = p.harness
  const pl = p.placement
  const mc = p.machine
  const machine = mc !== undefined
    ? [mc.cpuModel, mc.logical !== undefined ? `${mc.logical} logical${mc.physical !== undefined ? ` / ${mc.physical} physical` : ''}` : undefined, mc.ramGiB !== undefined ? `${mc.ramGiB} GiB` : undefined, mc.os].filter((x) => x !== undefined).join(' · ')
    : undefined
  const harness = h === undefined
    ? undefined
    : `${h.version ?? DASH}${h.git !== undefined ? ` @ ${h.git.slice(0, 12)}` : ''}${h.node !== undefined ? ` (node ${h.node})` : ''}`
  const harnessBadge = h?.dirty === true ? badge('bad', 'unofficial: dirty') : h?.dirty === false ? badge('ok', 'clean') : ''
  const kindBadge = pl?.kind === 'vcpu' ? badge('warn', 'vcpu') : pl?.kind === 'physical' ? badge('ok', 'physical') : ''
  const verifiedBadge = pl?.verified === true ? badge('ok', 'verified') : pl?.verified === false ? badge('bad', 'not verified') : ''
  const checkCls = (l: string): string => l === 'fail' ? 'fail' : l === 'warn' ? 'invalid' : 'pass'
  const checks = pl !== undefined && pl.checks.length > 0
    ? `<details><summary>Placement checks (${pl.checks.length})</summary><div class="scroll"><table><thead><tr><th class="l">check</th><th class="l">level</th><th class="l">summary</th></tr></thead><tbody>${pl.checks.map((c) => `<tr><td class="l"><code>${esc(c.id)}</code></td><td class="l"><span class="st ${checkCls(c.level)}">${esc(c.level)}</span></td><td class="reasons">${esc(c.summary)}</td></tr>`).join('')}</tbody></table></div></details>`
    : ''
  const gates = p.gates.length > 0
    ? `<h3>Gates</h3><dl class="meta">${p.gates.map(([k, v]) => `<div><dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`
    : ''
  const placement = pl === undefined
    ? '<p class="foot">No CPU placement recorded: server, bots and harness shared every CPU.</p>'
    : `<h3>CPU placement${kindBadge}${verifiedBadge}</h3>
<dl class="meta">
${dlItem('Kind', pl.kind)}
${dlItem('Method', pl.method)}
${dlItem('Server CPUs', pl.serverCpus)}
${dlItem('Bot CPUs', pl.botCpus)}
${dlItem('Server priority', pl.priority)}
${codeItem('Profile hash', pl.profileSha256)}
</dl>
${checks}`
  return `<section id="provenance" aria-label="Provenance and environment">
<h2>Provenance and environment</h2>
<dl class="meta">
${codeItem('Config hash', p.configSha256)}
${codeItem('Machine fingerprint', p.machineFingerprint, machine !== undefined && machine !== '' ? `<br><span class="foot">${esc(machine)}</span>` : '')}
${codeItem('Harness', harness, harnessBadge)}
${codeItem('BDS zip hash', p.bdsZipSha256)}
${codeItem('Probe pack hash', p.probePackSha256)}
${codeItem('bedboo commit', p.bedbooCommit)}
${codeItem('Analysis version (recorded)', firstAt(a.meta, [['analysisVersion']]))}
</dl>
${placement}
${gates}
</section>`
}

/** Threats to validity / disclosures box. */
export function threatsHtml (threats: readonly Threat[], publishable: boolean, title = 'Threats to validity'): string {
  if (threats.length === 0) return ''
  const cls = { bad: 'bad', warn: 'warn', info: 'info' }
  const label = { bad: 'blocks publishing', warn: 'warning', info: 'disclosure' }
  return `<section id="threats" class="threats${publishable ? '' : ' unpub'}" aria-label="${esc(title)}">
<h2>${esc(title)}${publishable ? '' : badge('bad', 'not publishable')}</h2>
<ul>${threats.map((t) => `<li class="${cls[t.level]}" data-threat="${esc(t.id)}"><span class="lvl">${label[t.level]}</span> ${esc(t.text)}</li>`).join('')}</ul>
</section>`
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
${extraScaling(a, withTip).join('\n')}
</div>
</section>`
}

/** Scaling charts of the newer measurements; each only when some step recorded it. */
function extraScaling (a: Analysis, withTip: (ss: Series[], unit: string, digits: number) => Series[]): string[] {
  const curves = a.curves
  const has = (m: CurveMetric): boolean => curves.some((c) => curveValues(c, m).length > 0)
  const out: string[] = []
  const fig = (id: string, title: string, series: Series[], chart: string, note = ''): string =>
    `<figure id="${id}"><h3>${esc(title)}</h3>${legend(series)}${chart}${note !== '' ? `<p class="foot">${esc(note)}</p>` : ''}</figure>`
  if (has('tickCpuMsPerTick')) {
    const ss = withTip(curveSeries(curves, 'tickCpuMsPerTick'), 'ms/tick', 2)
    const fit = a.derived.tickCpuPerPlayer
    const xs = a.steps.map((s) => s.players)
    if (fit !== undefined && xs.length > 0) {
      const x0 = Math.min(...xs)
      const x1 = Math.max(...xs)
      ss.push({ name: 'linear fit', slot: 'muted', dash: true, points: [[x0, fit.intercept + fit.slope * x0], [x1, fit.intercept + fit.slope * x1]] })
    }
    out.push(fig('chart-tickcpu', 'Tick CPU per tick', ss, lineChart({ id: 'sc-tickcpu', label: 'Tick-thread CPU ms per tick against players', xLabel: 'players', yLabel: 'ms / tick', series: ss, refLines: [{ value: 50, label: '50 ms budget' }], yInclude: [0], xInclude: [0] }),
      fit !== undefined ? `Slope ${fmt(fit.slope, 3)} ms/tick per player (R² ${fmt(fit.r2, 2)}): a capacity cost that does not saturate and transfers across machines better than utilisation.` : ''))
  }
  if (has('counterTps')) {
    const ss = withTip(curveSeries(curves, 'counterTps'), 'TPS', 2)
    const probe = curveValues(a.meanCurve, 'tps')
    if (probe.length > 0) ss.push({ name: 'probe TPS (mean)', slot: 'muted', dash: true, points: probe })
    out.push(fig('chart-counter-tps', 'Tick-counter TPS (script-free)', ss, lineChart({ id: 'sc-counter', label: 'Tick-counter TPS against players', xLabel: 'players', yLabel: 'TPS', series: ss, refLines: [{ value: 20, label: '20 TPS' }], yInclude: [16, 20], xInclude: [0] })))
  }
  if (has('viewT90')) {
    const ss = withTip(curveSeries(curves, 'viewT90', 1 / 1000), 's', 2)
    out.push(fig('chart-view', 'View load time (t90, median bot)', ss, lineChart({ id: 'sc-view', label: 'View load t90 against players', xLabel: 'players', yLabel: 's', series: ss, yInclude: [0], xInclude: [0] })))
  }
  if (has('chunksPerSec') || has('inViewMedian')) {
    const ss = withTip(curveSeries(curves, 'chunksPerSec'), 'chunks/s', 0)
    const iv = withTip(curveSeries(curves, 'inViewMedian'), 'in-view columns', 0)
    if (has('chunksPerSec')) out.push(fig('chart-chunks', 'Chunks delivered per second', ss, lineChart({ id: 'sc-chunks', label: 'Chunk columns per second against players', xLabel: 'players', yLabel: 'chunks / s', series: ss, yInclude: [0], xInclude: [0] })))
    if (has('inViewMedian')) out.push(fig('chart-inview', 'In-view chunk columns (median bot)', iv, lineChart({ id: 'sc-inview', label: 'In-view chunk columns against players', xLabel: 'players', yLabel: 'columns', series: iv, yInclude: [0], xInclude: [0] })))
  }
  if (has('foreignMean')) {
    const ss = withTip(curveSeries(curves, 'foreignMean'), 'cores', 2)
    out.push(fig('chart-foreign', 'Foreign CPU load during the hold', ss, lineChart({ id: 'sc-foreign', label: 'Foreign CPU load against players', xLabel: 'players', yLabel: 'cores', series: ss, yInclude: [0], xInclude: [0] })))
  }
  return out
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
    const counter = (tl.counterTps ?? []).filter(inW)
    if (counter.length > 0) tps.push({ name: 'tick-counter TPS', slot: 4, points: counter })
    const foreign: Series[] = [{ name: 'foreign CPU (cores)', slot: 5, points: (tl.foreign ?? []).filter(inW) }]
    const serverSet = (tl.serverSetForeign ?? []).filter(inW)
    if (serverSet.length > 0) foreign.push({ name: 'foreign on server CPUs (cores)', slot: 8, points: serverSet })
    const tickCpu: Series[] = [{ name: 'tick CPU per tick (ms)', slot: 7, points: (tl.tickCpu ?? []).filter(inW) }]
    const extra = [...(foreign[0]!.points.length > 0 ? foreign : []), ...(tickCpu[0]!.points.length > 0 ? tickCpu : [])]
    const util: Series[] = [{ name: 'main-thread util', slot: 2, points: tl.util.filter(inW).map(([x, y]) => [x, y * 100] as [number, number]) }]
    const players: Series[] = [{ name: 'players', slot: 3, points: tl.players.filter(inW) }]
    const title = tl.repeats.length > 1 ? `Repeat ${w.repeat}` : 'Run'
    parts.push(`<div class="repeat" id="timeline-r${esc(w.repeat)}">
<h3>${esc(title)}</h3>
${legend([...tps, ...util, ...players, ...extra], true)}
<div class="scroll"><div class="panels">
${lineChart({ ...common, id: `tl-${w.repeat}-tps`, label: `TPS over time, ${title}`, yLabel: 'TPS', series: tps, refLines: [{ value: 20, label: '20 TPS' }], yInclude: [16, 20], height: 200, width: 720 })}
${lineChart({ ...common, id: `tl-${w.repeat}-util`, label: `Main-thread utilisation over time, ${title}`, yLabel: 'util %', series: util, refLines: [{ value: 100, label: 'util 1.0' }], yInclude: [0, 100], height: 180, width: 720 })}
${lineChart({ ...common, id: `tl-${w.repeat}-players`, label: `Players over time, ${title}`, yLabel: 'players', series: players, yInclude: [0], height: 180, width: 720 })}
${tickCpu[0]!.points.length > 0 ? lineChart({ ...common, id: `tl-${w.repeat}-tickcpu`, label: `Tick CPU per tick over time, ${title}`, yLabel: 'ms / tick', series: tickCpu, refLines: [{ value: 50, label: '50 ms' }], yInclude: [0], height: 160, width: 720 }) : ''}
${foreign[0]!.points.length > 0 ? lineChart({ ...common, id: `tl-${w.repeat}-foreign`, label: `Foreign CPU load over time, ${title}`, yLabel: 'cores', series: foreign, yInclude: [0], height: 160, width: 720 }) : ''}
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

/** Per-step flags: settle capped, views incomplete, placement mismatch, tick thread by busiest. */
export function stepFlags (r: StepRow): string[] {
  const f: string[] = []
  if (r.settleCapped === true) f.push(`settle capped${r.settleSec !== undefined ? ` (${fmt(r.settleSec, 0)} s)` : ''}`)
  if (r.viewsIncomplete === true) f.push('views incomplete')
  if (r.placementVerified === false) f.push('placement mismatch')
  if (r.tickThreadSource === 'busiest') f.push('tick thread: busiest')
  return f
}

interface StepCol { th: string, td: (r: StepRow) => string, show: boolean }

function stepsSection (a: Analysis): string {
  const any = (f: (r: StepRow) => unknown): boolean => a.steps.some((r) => f(r) !== undefined)
  const cols: StepCol[] = [
    { th: 'counter TPS', td: (r) => fmt(r.counterTps, 2), show: any((r) => r.counterTps) },
    { th: 'counter low 5 s', td: (r) => fmt(r.counterTpsLow5, 2), show: any((r) => r.counterTpsLow5) },
    { th: 'tick CPU ms/tick', td: (r) => fmt(r.tickCpuMsPerTick, 2), show: any((r) => r.tickCpuMsPerTick) },
    { th: 'foreign cores', td: (r) => `${fmt(r.foreignMean, 2)}${r.foreignPeak10s !== undefined ? ` <span class="rng">peak ${fmt(r.foreignPeak10s, 2)}</span>` : ''}`, show: any((r) => r.foreignMean) },
    { th: 'in view', td: (r) => fmt(r.inViewMedian, 0), show: any((r) => r.inViewMedian) },
    { th: 'view t90 s', td: (r) => fmt(r.viewT90MsP50 === undefined ? undefined : r.viewT90MsP50 / 1000, 2), show: any((r) => r.viewT90MsP50) },
    { th: 'chunks/s', td: (r) => fmt(r.chunksPerSec, 0), show: any((r) => r.chunksPerSec) },
    { th: 'settle s', td: (r) => fmt(r.settleSec, 0), show: any((r) => r.settleSec) }
  ]
  const extra = cols.filter((c) => c.show)
  const showFlags = a.steps.some((r) => stepFlags(r).length > 0)
  const colspan = 18 + extra.length + (showFlags ? 1 : 0)
  const reasons = (r: StepRow): string => [
    ...r.invalidReasons.map((x) => `<span class="rs invalid">invalid: ${esc(x)}</span>`),
    ...r.failReasons.filter((x) => !r.invalid || !/loadgen saturated/.test(x)).map(esc)
  ].join('<br>')
  const rows = a.steps.map((r) => `<tr>
<td>${esc(r.repeat)}</td><td>${esc(r.index)}</td><td class="l">${esc(r.phase)}</td><td>${esc(r.players)}</td><td class="l">${statusCell(r)}</td>
<td>${fmt(r.tpsMean, 2)}</td><td>${fmt(r.tpsMin, 1)}</td><td>${fmt(r.tickP99, 1)}</td><td>${esc(r.over50)}</td><td>${esc(r.over100)}</td>
<td>${fmtPct(r.utilMean, 1)}</td><td>${fmt(r.cpuMean, 0)}</td><td>${r.rssMean === undefined ? DASH : `${fmt(r.rssMean / MiB, 0)} MiB`}</td><td>${fmt(r.rttP95, 1)}</td>
<td>${fmtRate(r.netRxBps)}</td><td>${fmtRate(r.netTxBps)}</td><td>${esc(r.botFailures)}</td>
${extra.map((c) => `<td>${c.td(r)}</td>`).join('')}${showFlags ? `<td class="l">${stepFlags(r).map((f) => `<span class="flag warn">${esc(f)}</span>`).join(' ')}</td>` : ''}
<td class="reasons">${reasons(r)}</td>
</tr>`).join('\n')
  return `<section id="steps" aria-label="Steps">
<h2>Steps</h2>
<div class="scroll">
<table>
<thead><tr>
<th>rep</th><th>#</th><th class="l">phase</th><th>players</th><th class="l">result</th>
<th>TPS mean</th><th>TPS min</th><th>tick p99 ms</th><th>&gt;50 ms</th><th>&gt;100 ms</th>
<th>util mean</th><th>CPU %</th><th>RSS</th><th>RTT p95 ms</th><th>net rx</th><th>net tx</th><th>bot fails</th>
${extra.map((c) => `<th>${esc(c.th)}</th>`).join('')}${showFlags ? '<th class="l">flags</th>' : ''}<th class="l">reasons</th>
</tr></thead>
<tbody>
${rows || `<tr><td class="l" colspan="${colspan}">No steps recorded.</td></tr>`}
</tbody>
</table>
</div>
</section>`
}

export function methodologyHtml (notes: string[] = []): string {
  return `<section id="methodology" class="foot" aria-label="Methodology">
<h2>Methodology</h2>
<p>The headline is the largest bot count that passed every criterion in a step, taken as the median over the <b>ok</b> repeats, each on a fresh instance. Each repeat ramps the bot count until the first failing step, then bisects between the last pass and the first fail. Steps measured while the load generator was saturated are invalid rather than failed.</p>
<ul>
<li><b>Repeat status.</b> A repeat is <code>ok</code>, <code>server_failed</code> (the server crashed, was stopped by a watchdog or ended the repeat early: a result about the server, shown as k/n ok, never dropped silently) or <code>invalid</code> (never ended, search unfinished, or flagged by the harness: says something about the harness or machine). Only ok repeats enter the median, the mean curves and the per-player fits.</li>
<li><b>TPS</b> comes from the Script API probe: ticks per ~1 s window, measured inside the server tick.</li>
<li><b>Main-thread utilisation</b> is the CPU share of the busiest server thread (OS sampling). Because BDS sleeps out the rest of each 50 ms tick it approximates MSPT / 50 ms. It cannot separate lock waits from sleep and does not include work offloaded to other threads.</li>
<li><b>Per-player figures</b> are least-squares slopes over the step means of all repeats. Utilisation is fitted on passing steps when possible, because it flattens near 1.0 once the tick thread is saturated. "Players at util 1.0" extrapolates that fit.</li>
<li><b>RSS per player</b> in the scaling chart is (RSS − fitted zero-player RSS) / players, so the fixed server baseline does not dominate low player counts. It converges on the memory-per-player slope.</li>
<li><b>RTT</b> is the tick-bound round trip of a scripted ping as seen by the bots, i.e. client-perceived lag.</li>
<li><b>Tick-counter TPS</b> is the server's own tick counter (<code>time query gametime</code>) read every few seconds from the console: a script-free cross-check of the probe TPS.</li>
<li><b>Tick CPU per tick</b> is tick-thread CPU time divided by ticks run, in ms. Unlike utilisation it does not saturate at 1.0, so its per-player slope is a capacity cost that compares across machines.</li>
<li><b>Foreign load</b> is machine CPU used by processes outside the server, the bots and the harness, in cores. Steps with too much of it are invalid.</li>
<li><b>View load</b>: in-view chunk columns per bot, time until a bot holds 90 % of them (t90) and chunks delivered per second, as seen by the bots.</li>
<li><b>Invalid steps</b> (loadgen saturated, interference, placement not verified, ...) are left out of the curves and fits; their reasons are listed in the steps table.</li>
<li>The timeline is downsampled for size. TPS shows the minimum of each bucket so dips stay visible.</li>
</ul>
${notes.length > 0 ? `<h3>Notes</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<p>Generated by bedperf, analysis version ${esc(ANALYSIS_VERSION)}.</p>
</section>`
}

/** Renders the self-contained HTML report for one run. */
export function renderHtml (a: Analysis): string {
  const body = `<header>
<h1>bedperf report: ${esc(a.name)}</h1>
<p class="sub">Run ${esc(a.runId)} · BDS ${esc(a.meta.bdsVersion)} · ${esc(a.config.scenario?.module ?? '')}</p>
</header>
${headlineSection(a)}
${threatsHtml(a.threats ?? [], a.publishable ?? true)}
${provenanceSection(a)}
${metaSection(a)}
${scalingSection(a)}
${timelineSection(a)}
${stepsSection(a)}
${methodologyHtml(a.notes)}`
  return page(`bedperf: ${a.name}`, body)
}
