// build: every bot owns a private plot (a square spiral of plots around originX/originZ, so plot positions depend
// only on the bot index) on a platform at platformY, teleports there in creative mode and toggles random cells of the
// plot between `block` and air. Stresses block updates, their broadcast and (mode 'client') the server-authoritative
// item-use / block-break validation. Needs operator permission (gamemode, tp, fill, replaceitem).
import type { Scenario } from '@bedperf/core'
import {
  ABORTED, commandUntilOk, command, commonBotOptions, commonSetupCommands, enumParam, errorLogger, fillDone, idParam,
  isOutOfWorld, numParam, parseCommonSetup, raceAbort, randInt, ScenarioParamError, sleep, spiralCell, tryCommand,
  vec, withTimeout
} from '../common.ts'

export const defaults = {
  /** 'client': real place/dig packets (bot.placeBlock / bot.dig); 'command': /setblock as the bot. */
  mode: 'client' as BuildParams['mode'],
  /** Block placed and broken. */
  block: 'stone',
  /** Cells span [-plotRadius, plotRadius] around the plot centre (the centre column is the bot's). */
  plotRadius: 3,
  /** Distance between plot centres, blocks (≥ 2·plotRadius + 3). 16 keeps one plot per chunk column. */
  plotSpacing: 16,
  /** Plot grid origin (centre of bot 0's plot). */
  originX: 0,
  originZ: 0,
  /** Height of the plot surface; the platform is one block below. High enough to clear terrain. */
  platformY: 200,
  /** Delay between actions of one bot, ms. */
  intervalMs: 500,
  /** Give up on one place/dig after this long, ms. */
  actionTimeoutMs: 5000
}

export interface BuildParams {
  mode: 'client' | 'command'
  block: string
  plotRadius: number
  plotSpacing: number
  originX: number
  originZ: number
  platformY: number
  intervalMs: number
  actionTimeoutMs: number
}

export function parseParams (params: Record<string, unknown>): BuildParams {
  parseCommonSetup(params)
  commonBotOptions(params)
  const p: BuildParams = {
    mode: enumParam(params, 'mode', defaults.mode, ['client', 'command'] as const),
    block: idParam(params, 'block', defaults.block),
    plotRadius: numParam(params, 'plotRadius', defaults.plotRadius, { min: 1, max: 4, int: true }),
    plotSpacing: numParam(params, 'plotSpacing', defaults.plotSpacing, { min: 5, max: 1024, int: true }),
    originX: numParam(params, 'originX', defaults.originX, { min: -29_000_000, max: 29_000_000, int: true }),
    originZ: numParam(params, 'originZ', defaults.originZ, { min: -29_000_000, max: 29_000_000, int: true }),
    platformY: numParam(params, 'platformY', defaults.platformY, { min: -60, max: 316, int: true }),
    intervalMs: numParam(params, 'intervalMs', defaults.intervalMs, { min: 10, max: 600_000 }),
    actionTimeoutMs: numParam(params, 'actionTimeoutMs', defaults.actionTimeoutMs, { min: 100, max: 600_000 })
  }
  if (p.plotSpacing < 2 * p.plotRadius + 3) {
    throw new ScenarioParamError(`param plotSpacing: ${p.plotSpacing} < 2·plotRadius + 3 = ${2 * p.plotRadius + 3} (plots would touch)`)
  }
  return p
}

/** Centre block (x, z) of bot `index`'s plot. Deterministic and unique per index. */
export function plotCenter (index: number, p: Pick<BuildParams, 'plotSpacing' | 'originX' | 'originZ'>): { x: number, z: number } {
  const c = spiralCell(index)
  return { x: p.originX + c.x * p.plotSpacing, z: p.originZ + c.z * p.plotSpacing }
}

/** A random plot cell offset, never the centre column the bot stands in. */
export function randomCell (random: () => number, r: number): { dx: number, dz: number } {
  for (;;) {
    const dx = randInt(random, -r, r)
    const dz = randInt(random, -r, r)
    if (dx !== 0 || dz !== 0) return { dx, dz }
  }
}

const scenario: Scenario = {
  name: 'build',
  description: 'Bots place and break blocks in private plots on a sky platform (client packets or /setblock).',
  serverSetup: params => commonSetupCommands(parseCommonSetup(params)),
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    const { x: cx, z: cz } = plotCenter(ctx.index, p)
    const y = p.platformY
    const r = p.plotRadius

    // --- plot setup: creative, held block, teleport (loads the chunk), platform, clear cells, stand on it
    await tryCommand(bot, ctx, 'gamemode creative @s', signal)
    if (p.mode === 'client') await tryCommand(bot, ctx, `replaceitem entity @s slot.hotbar 0 ${p.block} 64`, signal)
    await tryCommand(bot, ctx, `tp @s ${cx + 0.5} ${y + 1} ${cz + 0.5}`, signal)
    // a fill that changed nothing (plot set up by an earlier session) counts as done; retry only while unloaded
    const fillOpts = { done: fillDone, retryIf: isOutOfWorld }
    const platformOk = await commandUntilOk(bot, ctx, `fill ${cx - r - 1} ${y - 1} ${cz - r - 1} ${cx + r + 1} ${y - 1} ${cz + r + 1} ${p.block}`, signal, fillOpts)
    await commandUntilOk(bot, ctx, `fill ${cx - r} ${y} ${cz - r} ${cx + r} ${y + 2} ${cz + r} air`, signal, fillOpts)
    await tryCommand(bot, ctx, `tp @s ${cx + 0.5} ${y} ${cz + 0.5}`, signal)
    if (signal.aborted) return
    if (!platformOk) ctx.log(`build: platform at ${cx} ${y - 1} ${cz} not built; actions will fail`)
    if (p.mode === 'client') {
      try { bot.setQuickBarSlot(0) } catch (err) { ctx.log(`build: setQuickBarSlot: ${String(err)}`) }
    }

    // --- place/break loop
    const placed = new Set<string>() // fallback state when the client has no block data for a cell
    const onError = errorLogger(ctx, 'build')
    let places = 0
    let breaks = 0
    let errors = 0
    await sleep(ctx.random() * p.intervalMs, signal)
    while (!signal.aborted) {
      const began = Date.now()
      const { dx, dz } = randomCell(ctx.random, r)
      const x = cx + dx
      const z = cz + dz
      const key = `${x},${z}`
      try {
        const known = bot.blockAt(vec(bot, x, y, z))
        const filled = known ? known.name !== 'air' : placed.has(key)
        if (p.mode === 'command') {
          const res = await command(bot, `setblock ${x} ${y} ${z} ${filled ? 'air' : p.block}`, signal)
          if (res === ABORTED) break
          if (!res.ok && res.messageId !== 'commands.setblock.noChange') throw new Error(`setblock refused (${res.messageId})`)
        } else if (filled) {
          if (!known) throw new Error(`no block data at ${x} ${y} ${z}`)
          // on abort or timeout, release the break so it cannot overlap the next action
          const stop = (): void => { try { bot.stopDigging() } catch {} }
          const res = await raceAbort(withTimeout(bot.dig(known, true), p.actionTimeoutMs, 'dig'), signal)
            .catch((err: unknown) => { stop(); throw err })
          if (res === ABORTED) { stop(); break }
        } else {
          const ref = bot.blockAt(vec(bot, x, y - 1, z))
          if (!ref || ref.name === 'air') throw new Error(`no platform block at ${x} ${y - 1} ${z}`)
          const res = await raceAbort(withTimeout(bot.placeBlock(ref, vec(bot, 0, 1, 0)), p.actionTimeoutMs, 'placeBlock'), signal)
          if (res === ABORTED) break
        }
        if (filled) { placed.delete(key); breaks++ } else { placed.add(key); places++ }
      } catch (err) {
        if (signal.aborted) break
        errors = onError(err)
      }
      await sleep(Math.max(0, p.intervalMs - (Date.now() - began)), signal)
    }
    ctx.log(`build: ${places} placed, ${breaks} broken, ${errors} errors`)
  }
}

export default scenario
