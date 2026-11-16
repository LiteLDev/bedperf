// entity-stress: bots idle; the load is `count` mobs kept in a walled pen on a sky platform inside a ticking area.
// Meant for a FIXED player count with a sweep over `count` (the entity count is the load, not the bots).
//
// serverSetup adds the ticking area. Console commands right after `tickingarea add` are refused (the chunks load a
// few ticks later), so the pen and the mobs are made by the "keeper" bot (`keeperIndex`, default bot 0) once it has
// spawned: it builds the pen (idempotent), then every `maintainSec` counts the mobs (name tag `bpstress`) and summons
// the missing ones / kills the excess. At least one bot (the keeper) must be online; it needs operator permission.
import type { Scenario } from '@bedperf/core'
import {
  commandUntilOk, commonBotOptions, commonSetupCommands, fillDone, idParam, isOutOfWorld, numParam, parseCommonSetup,
  sleep, testforCount, tryCommand
} from '../common.ts'

export const STRESS_TAG = 'bpstress'
export const TICKING_AREA = 'bedperf_stress'

export const defaults = {
  /** Entity type to summon. */
  entityType: 'zombie',
  /** Number of entities kept in the pen. The swept parameter. */
  count: 100,
  /** North-west corner of the pen (x, z) and its floor height (mobs stand at y). */
  x: 0,
  z: 0,
  y: 200,
  /** Inner side length of the square pen, blocks (2 … 90). */
  size: 32,
  /** Seconds between population checks. */
  maintainSec: 15,
  /** Bot index that builds the pen and keeps the population. */
  keeperIndex: 0,
  /** Summon commands in flight at once while filling the pen. */
  summonBatch: 32,
  // common setup override: zombies/skeletons burn at noon
  time: 'midnight'
}

export interface EntityStressParams {
  entityType: string
  count: number
  x: number
  z: number
  y: number
  size: number
  maintainSec: number
  keeperIndex: number
  summonBatch: number
}

export function parseParams (params: Record<string, unknown>): EntityStressParams {
  parseCommonSetup(params, { time: 'midnight' })
  commonBotOptions(params)
  return {
    entityType: idParam(params, 'entityType', defaults.entityType),
    count: numParam(params, 'count', defaults.count, { min: 0, max: 100_000, int: true }),
    x: numParam(params, 'x', defaults.x, { min: -29_000_000, max: 29_000_000, int: true }),
    z: numParam(params, 'z', defaults.z, { min: -29_000_000, max: 29_000_000, int: true }),
    y: numParam(params, 'y', defaults.y, { min: -60, max: 315, int: true }),
    // ≤ 90 keeps every pen fill under the 32768-block /fill limit
    size: numParam(params, 'size', defaults.size, { min: 2, max: 90, int: true }),
    maintainSec: numParam(params, 'maintainSec', defaults.maintainSec, { min: 1, max: 86_400 }),
    keeperIndex: numParam(params, 'keeperIndex', defaults.keeperIndex, { min: 0, int: true }),
    summonBatch: numParam(params, 'summonBatch', defaults.summonBatch, { min: 1, max: 1024, int: true })
  }
}

/** Pen geometry: inner area [x0, x1] × [z0, z1] at height y, walls one block outside it. */
export function penBounds (p: Pick<EntityStressParams, 'x' | 'z' | 'y' | 'size'>): { x0: number, z0: number, x1: number, z1: number, y: number } {
  return { x0: p.x, z0: p.z, x1: p.x + p.size - 1, z1: p.z + p.size - 1, y: p.y }
}

/** Commands (no slash; valid from console or as a player) that build the pen: floor, 3-high walls, cleared inside. */
export function penCommands (p: Pick<EntityStressParams, 'x' | 'z' | 'y' | 'size'>): string[] {
  const b = penBounds(p)
  const [wx0, wz0, wx1, wz1] = [b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1]
  return [
    `fill ${wx0} ${b.y - 1} ${wz0} ${wx1} ${b.y - 1} ${wz1} stone`,
    `fill ${wx0} ${b.y} ${wz0} ${wx1} ${b.y + 2} ${wz1} glass hollow`,
    `fill ${b.x0} ${b.y} ${b.z0} ${b.x1} ${b.y + 3} ${b.z1} air`
  ]
}

const scenario: Scenario = {
  name: 'entity-stress',
  description: 'Bots idle; N entities are kept in a pen in a ticking area. Use with a fixed player count and sweep N.',
  serverSetup: params => {
    const p = parseParams(params)
    const b = penBounds(p)
    return [
      ...commonSetupCommands(parseCommonSetup(params, { time: 'midnight' })),
      'gamerule doMobLoot false',
      `tickingarea remove ${TICKING_AREA}`,
      `tickingarea add ${b.x0 - 1} ${b.y} ${b.z0 - 1} ${b.x1 + 1} ${b.y} ${b.z1 + 1} ${TICKING_AREA} true`
    ]
  },
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    if (ctx.index !== p.keeperIndex) {
      if (ctx.index === 0) ctx.log(`entity-stress: population kept by bot ${p.keeperIndex}; nothing is summoned until it is online`)
      while (!signal.aborted) await sleep(60_000, signal)
      return
    }
    const b = penBounds(p)
    const sel = `@e[type=${p.entityType},name=${STRESS_TAG}]`
    for (const cmd of penCommands(p)) {
      // a fill that changes nothing (pen already built) counts as done; retry only while the area is not loaded
      const ok = await commandUntilOk(bot, ctx, cmd, signal, { attempts: 60, done: fillDone, retryIf: isOutOfWorld })
      if (!ok && !signal.aborted) ctx.log(`entity-stress: pen command failed: /${cmd}`)
    }
    let lastCount = -1
    while (!signal.aborted) {
      // a refused testfor (not "no targets") gives no count: skip the top-up rather than summon blindly
      const n = testforCount(await tryCommand(bot, ctx, `testfor ${sel}`, signal, 30_000))
      if (n !== undefined) {
        if (n !== lastCount) ctx.log(`entity-stress: ${n}/${p.count} ${p.entityType}`)
        lastCount = n
        if (n > p.count) {
          await tryCommand(bot, ctx, `kill @e[type=${p.entityType},name=${STRESS_TAG},c=${n - p.count}]`, signal)
        }
        let missing = p.count - n
        while (missing > 0 && !signal.aborted) {
          const batch: Promise<unknown>[] = []
          for (let i = 0; i < Math.min(missing, p.summonBatch); i++) {
            const x = b.x0 + 0.5 + ctx.random() * (b.x1 - b.x0)
            const z = b.z0 + 0.5 + ctx.random() * (b.z1 - b.z0)
            batch.push(tryCommand(bot, ctx, `summon ${p.entityType} "${STRESS_TAG}" ${x.toFixed(2)} ${b.y} ${z.toFixed(2)}`, signal, 30_000))
          }
          missing -= batch.length
          await Promise.all(batch)
        }
      }
      await sleep(p.maintainSec * 1000, signal)
    }
  }
}

export default scenario
