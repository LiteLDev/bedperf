import { esc, fmtTick } from './format.ts'
import { niceTicks } from './math.ts'
import type { StepBand } from './types.ts'

export interface Series {
  name: string
  /** Categorical slot 1..8 (CSS var --s1..--s8), or 'muted' for reference/fit lines. */
  slot: number | 'muted'
  points: ReadonlyArray<readonly [number, number]>
  markers?: boolean
  dash?: boolean
  /** Native tooltip text per marker. */
  tip?: (x: number, y: number) => string
}

export interface RefLine {
  value: number
  label: string
}

export interface ChartOptions {
  /** Unique id prefix for clip paths. */
  id: string
  /** Accessible name. */
  label: string
  xLabel: string
  yLabel: string
  series: Series[]
  refLines?: RefLine[]
  /** Shaded x ranges; `title` replaces the default "<players> players: <status>" tooltip. */
  bands?: ReadonlyArray<Pick<StepBand, 't0' | 't1' | 'status' | 'players'> & { title?: string }>
  /** Values the axis must include (e.g. 0, or 20 for TPS). */
  xInclude?: number[]
  yInclude?: number[]
  /** Fixed x domain (overrides data range). */
  xDomain?: [number, number]
  xFormat?: (v: number) => string
  yFormat?: (v: number) => string
  width?: number
  height?: number
  xTicks?: number
  yTicks?: number
  /** Explicit x tick positions (used with `xDomain`, e.g. time ticks). */
  xTickValues?: (min: number, max: number) => number[]
}

const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400]

/** Tick positions in seconds at round m:ss / h:mm:ss steps. */
export function timeTicks (min: number, max: number, target = 6): number[] {
  const span = Math.max(1, max - min)
  const step = TIME_STEPS.find((s) => span / s <= target) ?? Math.ceil(span / target / 3600) * 3600
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v)
  return out
}

const n2 = (v: number): string => fmtTick(v, 2)

/** Renders an inline-SVG line chart with axes, ticks, grid, reference lines and shaded bands. */
export function lineChart (o: ChartOptions): string {
  const W = o.width ?? 480
  const H = o.height ?? 270
  const m = { l: 56, r: 14, t: 12, b: 44 }
  const pw = W - m.l - m.r
  const ph = H - m.t - m.b
  const xf = o.xFormat ?? ((v: number) => fmtTick(v))
  const yf = o.yFormat ?? ((v: number) => fmtTick(v))

  const pts = o.series.flatMap((s) => s.points).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  const xs = [...pts.map((p) => p[0]), ...(o.xInclude ?? [])]
  const ys = [...pts.map((p) => p[1]), ...(o.yInclude ?? []), ...(o.refLines ?? []).map((r) => r.value)]
  const parts: string[] = []
  parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}" xmlns="http://www.w3.org/2000/svg">`)

  if (pts.length === 0) {
    parts.push(`<rect class="plot-bg" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>`)
    parts.push(`<text class="empty" x="${m.l + pw / 2}" y="${m.t + ph / 2}" text-anchor="middle">No data</text>`)
    parts.push('</svg>')
    return parts.join('')
  }

  const xt = o.xDomain !== undefined
    ? { min: o.xDomain[0], max: o.xDomain[1], ticks: (o.xTickValues ?? ((a: number, b: number) => niceTicks(a, b, o.xTicks ?? 6).ticks))(o.xDomain[0], o.xDomain[1]).filter((t) => t >= o.xDomain![0] && t <= o.xDomain![1]) }
    : niceTicks(Math.min(...xs), Math.max(...xs), o.xTicks ?? 6)
  const yt = niceTicks(Math.min(...ys), Math.max(...ys), o.yTicks ?? 5)
  const xSpan = xt.max - xt.min || 1
  const ySpan = yt.max - yt.min || 1
  const X = (v: number): number => m.l + ((v - xt.min) / xSpan) * pw
  const Y = (v: number): number => m.t + ph - ((v - yt.min) / ySpan) * ph
  const clip = `${o.id}-clip`

  parts.push(`<defs><clipPath id="${esc(clip)}"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath></defs>`)
  parts.push(`<rect class="plot-bg" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>`)

  // Step bands.
  if (o.bands !== undefined && o.bands.length > 0) {
    parts.push(`<g clip-path="url(#${esc(clip)})">`)
    for (const b of o.bands) {
      // Inset by 1 unit so adjacent steps stay visually separate.
      const x0 = X(Math.max(b.t0, xt.min)) + 1
      const x1 = X(Math.min(b.t1, xt.max)) - 1
      if (!(x1 > x0)) continue
      parts.push(`<rect class="band band-${b.status}" x="${n2(x0)}" y="${m.t}" width="${n2(x1 - x0)}" height="${ph}"><title>${esc(b.title ?? `${b.players} players: ${b.status}`)}</title></rect>`)
    }
    parts.push('</g>')
  }

  // Grid + y ticks.
  parts.push('<g class="grid">')
  for (const t of yt.ticks) parts.push(`<line x1="${m.l}" x2="${m.l + pw}" y1="${n2(Y(t))}" y2="${n2(Y(t))}"/>`)
  parts.push('</g><g class="tick">')
  for (const t of yt.ticks) parts.push(`<text x="${m.l - 6}" y="${n2(Y(t) + 4)}" text-anchor="end">${esc(yf(t))}</text>`)
  for (const t of xt.ticks) {
    parts.push(`<line class="tick-mark" x1="${n2(X(t))}" x2="${n2(X(t))}" y1="${m.t + ph}" y2="${m.t + ph + 4}"/>`)
    parts.push(`<text x="${n2(X(t))}" y="${m.t + ph + 18}" text-anchor="middle">${esc(xf(t))}</text>`)
  }
  parts.push('</g>')
  parts.push(`<line class="axis" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`)
  parts.push(`<text class="axis-label" x="${m.l + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xLabel)}</text>`)
  parts.push(`<text class="axis-label" transform="translate(14 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle">${esc(o.yLabel)}</text>`)

  // Reference lines.
  for (const r of o.refLines ?? []) {
    if (r.value < yt.min || r.value > yt.max) continue
    const y = n2(Y(r.value))
    parts.push(`<line class="ref" x1="${m.l}" x2="${m.l + pw}" y1="${y}" y2="${y}"/>`)
    parts.push(`<text class="ref-label" x="${m.l + pw - 4}" y="${n2(Y(r.value) - 4)}" text-anchor="end">${esc(r.label)}</text>`)
  }

  // Series.
  parts.push(`<g clip-path="url(#${esc(clip)})">`)
  for (const s of o.series) {
    const sp = s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    if (sp.length === 0) continue
    const cls = `series ${s.slot === 'muted' ? 'sm' : `s${s.slot}`}${s.dash === true ? ' dash' : ''}`
    if (sp.length > 1) {
      const d = sp.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n2(X(x))} ${n2(Y(y))}`).join('')
      parts.push(`<path class="${cls}" d="${d}"/>`)
    }
    if (s.markers === true || sp.length === 1) {
      parts.push(`<g class="${cls} markers">`)
      for (const [x, y] of sp) {
        const tip = s.tip !== undefined ? `<title>${esc(s.tip(x, y))}</title>` : ''
        parts.push(`<circle cx="${n2(X(x))}" cy="${n2(Y(y))}" r="4">${tip}</circle>`)
      }
      parts.push('</g>')
    }
  }
  parts.push('</g></svg>')
  return parts.join('')
}

/** HTML legend for a set of series (and optional band swatches). */
export function legend (series: ReadonlyArray<Pick<Series, 'name' | 'slot' | 'dash'>>, bands = false): string {
  const items = series.map((s) => {
    const cls = s.slot === 'muted' ? 'sm' : `s${s.slot}`
    return `<li><span class="sw line ${cls}${s.dash === true ? ' dash' : ''}"></span>${esc(s.name)}</li>`
  })
  if (bands) {
    items.push('<li><span class="sw box band-pass"></span>step passed</li>')
    items.push('<li><span class="sw box band-fail"></span>step failed</li>')
    items.push('<li><span class="sw box band-invalid"></span>invalid (loadgen saturated)</li>')
  }
  return `<ul class="legend">${items.join('')}</ul>`
}
