// Per-bot view-load tracking (pure, no bedboo dependency; the worker feeds it).
//
// A chunk column arrives when bedboo loads it (`chunkColumnLoad`) and leaves when bedboo unloads it
// (`chunkColumnUnload`: out of the publisher radius, or every column on a dimension change), so the tracker only
// holds the bot's current world. "In view" follows the bot: a loaded column counts when it lies within the server
// view radius + 1 chunks (Euclidean, in chunk units) of the bot's current chunk, so columns streamed for an
// earlier position do not count.
//
// Times are relative to the bot's view origin: its latest server teleport after spawn, or else the `start_game`
// packet. (On BDS every column of the join view arrives before bedboo's `spawn`, so spawn as the origin would make
// the join view load look instant.) Columns that were already loaded at the origin count as 0 ms.

/** Chunk count of the uniform view-load metric `viewTNMs` (the same for every server). */
export const VIEW_N = 80

export interface BotViewSample {
  /** Distinct chunk columns (dimension, x, z) ever received by this bot. */
  uniq: number
  /** Loaded columns currently in view (U). */
  inView: number
  /** Time from the view origin to the k-th in-view arrival, k = ceil(0.9·U); absent when U = 0. */
  t90Ms?: number
  /** Time from the view origin to the VIEW_N-th in-view arrival, or (censored) the time observed so far. */
  tNMs: number
  /** True when fewer than VIEW_N columns are in view: `tNMs` is a lower bound. */
  tNCensored: boolean
}

interface Loaded { x: number, z: number, t: number }

/** Column (x, z) is in view of a bot in chunk (cx, cz) with server radius `radius`. */
export function inView (x: number, z: number, cx: number, cz: number, radius: number): boolean {
  const dx = x - cx
  const dz = z - cz
  const r = radius + 1
  return dx * dx + dz * dz <= r * r
}

/** k for the t90 metric: ceil(0.9·U) in integers. */
export function t90Rank (u: number): number {
  return Math.floor((9 * u + 9) / 10)
}

export class ViewTracker {
  /** Loaded columns of the current world, in arrival order (Map iteration order = insertion order). */
  private readonly loaded = new Map<string, Loaded>()
  /** Every (dimension, x, z) ever received. */
  private readonly ever = new Set<string>()
  /** View origin (performance.now() ms), null until start_game or a teleport. */
  origin: number | null = null
  /** Server teleports seen after spawn. */
  teleports = 0

  /** start_game: the server starts streaming the world. Ignored once an origin is set. */
  startGame (t: number): void {
    if (this.origin === null) this.origin = t
  }

  /** A server teleport after spawn restarts the view clock. */
  teleport (t: number): void {
    this.teleports++
    this.origin = t
  }

  /** A column was loaded at `t`. Returns true on the first sighting of (dim, x, z) ever. */
  load (dim: string, x: number, z: number, t: number): boolean {
    const key = `${x},${z}`
    // a re-load of a column still loaded (a resend) keeps its first arrival
    if (!this.loaded.has(key)) this.loaded.set(key, { x, z, t })
    const id = `${dim}:${key}`
    if (this.ever.has(id)) return false
    this.ever.add(id)
    return true
  }

  unload (x: number, z: number): void {
    this.loaded.delete(`${x},${z}`)
  }

  get uniq (): number { return this.ever.size }

  /** Evaluate at `now` for a bot standing in chunk (cx, cz); `radius` Infinity counts every loaded column. */
  sample (cx: number, cz: number, radius: number, now: number): BotViewSample {
    const origin = this.origin ?? now
    // insertion order with performance.now() stamps: already ascending
    const arrivals: number[] = []
    for (const c of this.loaded.values()) {
      if (inView(c.x, c.z, cx, cz, radius)) arrivals.push(Math.max(0, c.t - origin))
    }
    const u = arrivals.length
    const out: BotViewSample = {
      uniq: this.ever.size,
      inView: u,
      tNMs: u >= VIEW_N ? arrivals[VIEW_N - 1]! : Math.max(0, now - origin),
      tNCensored: u < VIEW_N
    }
    if (u > 0) out.t90Ms = arrivals[t90Rank(u) - 1]!
    return out
  }
}
