/** HTML-escapes any value (also safe inside double-quoted attributes). */
export function esc (v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export const DASH = '–'

export const MiB = 1024 * 1024

function finite (v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v)
}

/** Fixed-point number, or a dash when missing. Trailing zeros are kept for column alignment. */
export function fmt (v: number | undefined, digits = 1): string {
  if (!finite(v)) return DASH
  const r = v.toFixed(digits)
  return r === '-0' || /^-0\.0*$/.test(r) ? r.slice(1) : r
}

/** Number with up to `digits` decimals, trailing zeros trimmed (axis ticks). */
export function fmtTick (v: number, digits = 2): string {
  if (!Number.isFinite(v)) return ''
  const r = Number(v.toFixed(digits))
  return String(Object.is(r, -0) ? 0 : r)
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

export function fmtBytes (v: number | undefined, digits = 1): string {
  if (!finite(v)) return DASH
  let x = Math.abs(v)
  let i = 0
  while (x >= 1024 && i < BYTE_UNITS.length - 1) { x /= 1024; i++ }
  return `${v < 0 ? '-' : ''}${x.toFixed(i === 0 ? 0 : digits)} ${BYTE_UNITS[i]}`
}

export function fmtRate (v: number | undefined): string {
  return finite(v) ? `${fmtBytes(v)}/s` : DASH
}

export function fmtPct (v: number | undefined, digits = 0): string {
  return finite(v) ? `${(v * 100).toFixed(digits)} %` : DASH
}

export function fmtDuration (sec: number): string {
  if (!Number.isFinite(sec)) return ''
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
