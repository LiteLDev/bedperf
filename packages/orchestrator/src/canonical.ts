// Deterministic serialisation of derived results (steps.json), shared by the engine and `recomputeRun`.

/** Round finite numbers to 4 decimals (NaN / Infinity become null, as in JSON) and sort object keys. */
function canonicalize (v: unknown): unknown {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    const r = Math.round(v * 1e4) / 1e4
    return Object.is(r, -0) ? 0 : r
  }
  if (Array.isArray(v)) return v.map(canonicalize)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = canonicalize(x)
    }
    return out
  }
  return v
}

/** Deterministic JSON: sorted keys, numbers rounded to 4 decimals, 2-space indent, LF, trailing newline. */
export function canonicalJson (v: unknown): string {
  return JSON.stringify(canonicalize(v), null, 2) + '\n'
}
