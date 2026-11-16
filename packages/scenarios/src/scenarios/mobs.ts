// mobs: every bot keeps `count` mobs (default zombies) summoned around itself and punches the nearest one every
// `attackIntervalMs`. Stresses mob AI (targeting, pathfinding), combat and entity updates. Bots stay in survival so
// the mobs actually hunt them, made invulnerable with Resistance 255 + Saturation. Needs operator permission.
//
// The bot's mobs carry the name tag `bpm<index>`: every `maintainSec` the bot pulls its strays (further than `radius`)
// back with /tp, counts its mobs with /testfor and summons the missing ones (kills are replaced at that point).
import type { Scenario } from '@bedperf/core'
import {
  boolParam, commonBotOptions, commonSetupCommands, enumParam, errorLogger, idParam, numParam, parseCommonSetup,
  randInt, sleep, testforCount, tryCommand, vec
} from '../common.ts'
import type { CommandResult } from '../common.ts'

export const defaults = {
  /** Mob type to summon. */
  mobType: 'zombie',
  /** Mobs kept alive around each bot. */
  count: 5,
  /** Delay between attacks, ms. */
  attackIntervalMs: 500,
  /** Max distance to attack, blocks. */
  attackRange: 3.5,
  /** Seconds between top-ups (count + re-summon + recall strays). */
  maintainSec: 10,
  /** Mobs further than this from their bot are teleported back, blocks. */
  radius: 24,
  /** Summon at a random offset up to this many blocks from the bot. */
  spawnRadius: 4,
  /** Bot game mode. 'survival' lets mobs target the bot; 'creative' makes them ignore it. */
  gamemode: 'survival' as MobsParams['gamemode'],
  /** Resistance 255 + Saturation on the bot so it never dies (survival only). */
  invulnerable: true,
  // common setup overrides: zombies burn at noon; difficulty must not be peaceful; no loot piling up
  time: 'midnight',
  difficulty: 'normal'
}

export interface MobsParams {
  mobType: string
  count: number
  attackIntervalMs: number
  attackRange: number
  maintainSec: number
  radius: number
  spawnRadius: number
  gamemode: 'survival' | 'creative' | 'adventure'
  invulnerable: boolean
}

export function parseParams (params: Record<string, unknown>): MobsParams {
  parseCommonSetup(params, { time: 'midnight', difficulty: 'normal' })
  commonBotOptions(params)
  return {
    mobType: idParam(params, 'mobType', defaults.mobType),
    count: numParam(params, 'count', defaults.count, { min: 0, max: 500, int: true }),
    attackIntervalMs: numParam(params, 'attackIntervalMs', defaults.attackIntervalMs, { min: 50, max: 600_000 }),
    attackRange: numParam(params, 'attackRange', defaults.attackRange, { min: 0.5, max: 16 }),
    maintainSec: numParam(params, 'maintainSec', defaults.maintainSec, { min: 1, max: 86_400 }),
    radius: numParam(params, 'radius', defaults.radius, { min: 4, max: 256 }),
    spawnRadius: numParam(params, 'spawnRadius', defaults.spawnRadius, { min: 1, max: 32, int: true }),
    gamemode: enumParam(params, 'gamemode', defaults.gamemode, ['survival', 'creative', 'adventure'] as const),
    invulnerable: boolParam(params, 'invulnerable', defaults.invulnerable)
  }
}

/** Name tag of bot `index`'s mobs. */
export function mobTag (index: number): string {
  return `bpm${index}`
}

const scenario: Scenario = {
  name: 'mobs',
  description: 'Each bot summons M mobs around itself and keeps attacking the nearest one (AI + combat).',
  serverSetup: params => [
    ...commonSetupCommands(parseCommonSetup(params, { time: 'midnight', difficulty: 'normal' })),
    'gamerule doMobLoot false'
  ],
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    const tag = mobTag(ctx.index)
    const sel = (extra: string): string => `@e[type=${p.mobType},name=${tag}${extra}]`

    await tryCommand(bot, ctx, `gamemode ${p.gamemode} @s`, signal)
    if (p.invulnerable && p.gamemode !== 'creative') {
      await tryCommand(bot, ctx, 'effect @s resistance 1000000 255 true', signal)
      await tryCommand(bot, ctx, 'effect @s saturation 1000000 255 true', signal)
    }

    const maintain = async (): Promise<void> => {
      await tryCommand(bot, ctx, `tp ${sel(`,rm=${p.radius}`)} @s`, signal)
      // a refused testfor (not "no targets") gives no count: skip the top-up rather than summon blindly
      const alive = testforCount(await tryCommand(bot, ctx, `testfor ${sel(`,r=${p.radius}`)}`, signal))
      if (alive === undefined || signal.aborted) return
      // summons go out together so the attack loop is not held up by one round trip per mob
      const summons: Array<Promise<CommandResult | undefined>> = []
      for (let i = alive; i < p.count; i++) {
        const dx = randInt(ctx.random, -p.spawnRadius, p.spawnRadius)
        const dz = randInt(ctx.random, -p.spawnRadius, p.spawnRadius)
        summons.push(tryCommand(bot, ctx, `summon ${p.mobType} "${tag}" ~${dx} ~1 ~${dz}`, signal))
      }
      const summoned = (await Promise.all(summons)).filter(r => r?.ok).length
      if (summoned > 0) ctx.log(`mobs: ${alive} alive, summoned ${summoned}`)
    }

    const onError = errorLogger(ctx, 'mobs attack')
    let attacks = 0
    let nextMaintain = 0
    await sleep(ctx.random() * 1000, signal)
    while (!signal.aborted) {
      const now = Date.now()
      if (now >= nextMaintain) {
        nextMaintain = now + p.maintainSec * 1000
        try { await maintain() } catch (err) { onError(err) }
      }
      try {
        const me = bot.entity.position
        const target = bot.nearestEntity(e => e.name === p.mobType && e.position.distanceTo(me) <= p.attackRange)
        if (target) {
          bot.lookAt(vec(bot, target.position.x, target.position.y + (target.height ?? 1.8) * 0.8, target.position.z), true).catch(() => {})
          bot.attack(target)
          attacks++
        }
      } catch (err) {
        onError(err)
      }
      await sleep(p.attackIntervalMs, signal)
    }
    ctx.log(`mobs: ${attacks} attacks`)
  }
}

export default scenario
