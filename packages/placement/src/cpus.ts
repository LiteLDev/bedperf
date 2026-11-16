/** Parse a kernel-style CPU list (`0-3,8,10-11`); empty text is an empty list. Sorted, unique. */
export function parseCpuList (text: string): number[] {
  const cpus = new Set<number>()
  for (const raw of text.trim().split(',')) {
    const part = raw.trim()
    if (part === '') continue
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) throw new Error(`invalid CPU list element ${JSON.stringify(part)} in ${JSON.stringify(text)}`)
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (hi < lo) throw new Error(`invalid CPU range ${JSON.stringify(part)}`)
    if (hi - lo > 4096) throw new Error(`CPU range ${JSON.stringify(part)} is too large`)
    for (let c = lo; c <= hi; c++) cpus.add(c)
  }
  return [...cpus].sort((a, b) => a - b)
}

/** Format CPUs as a compact kernel-style list (`0-3,8`). */
export function formatCpuList (cpus: Iterable<number>): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(',')
}

/** Validate explicit CPU indices and return them sorted and unique. */
export function normalizeCpus (cpus: readonly number[]): number[] {
  for (const c of cpus) {
    if (!Number.isInteger(c) || c < 0) throw new Error(`invalid CPU index ${c}`)
  }
  return [...new Set(cpus)].sort((a, b) => a - b)
}

/** CPUs set in a 64-bit affinity mask (as bigint or unsigned decimal string), offset by `base`. */
export function maskToCpus (mask: bigint | string, base = 0): number[] {
  let m = BigInt.asUintN(64, typeof mask === 'string' ? BigInt(mask) : mask)
  const out: number[] = []
  for (let bit = 0; m !== 0n; bit++, m >>= 1n) {
    if (m & 1n) out.push(base + bit)
  }
  return out
}

/** 64-bit affinity mask of CPUs 0..63 as an unsigned bigint. Throws for CPUs outside the first group. */
export function cpusToMask (cpus: readonly number[]): bigint {
  let mask = 0n
  for (const c of normalizeCpus(cpus)) {
    if (c >= 64) throw new Error(`CPU ${c} is outside the first processor group (0..63); affinity masks cannot reach it`)
    mask |= 1n << BigInt(c)
  }
  return mask
}

export function sameCpus (a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}
