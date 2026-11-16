// explore: every bot travels outward along its own heading (bot index × golden angle) so the server keeps
// generating, lighting, saving and sending new chunks. Default mode teleports `stepBlocks` every `intervalSec`
// (deterministic; needs operator permission); 'fly' uses creative flight (bot.creative.flyTo, experimental).
import type { Scenario } from '@bedperf/core'
import {
  ABORTED, coord, commonBotOptions, commonSetupCommands, directionAngle, enumParam, errMsg, numParam,
  parseCommonSetup, raceAbort, ScenarioParamError, sleep, tryCommand, vec
} from '../common.ts'

export const defaults = {
  /** 'teleport' (/tp @s X ~ Z) or 'fly' (bot.creative.flyTo; experimental). */
  mode: 'teleport' as ExploreParams['mode'],
  /** Distance advanced per step, blocks. 32 = 2 chunks. */
  stepBlocks: 32,
  /** Seconds between steps. */
  intervalSec: 2,
  /** On reaching this distance from the start, start a new outward leg from the start on a fresh heading. */
  maxDistance: 4096,
  /** Game mode set on the bot first (creative: no fall/suffocation damage after a teleport). 'keep' leaves it. */
  gamemode: 'creative' as ExploreParams['gamemode']
}

export interface ExploreParams {
  mode: 'teleport' | 'fly'
  stepBlocks: number
  intervalSec: number
  maxDistance: number
  gamemode: 'creative' | 'survival' | 'spectator' | 'keep'
}

export function parseParams (params: Record<string, unknown>): ExploreParams {
  parseCommonSetup(params)
  commonBotOptions(params)
  const p: ExploreParams = {
    mode: enumParam(params, 'mode', defaults.mode, ['teleport', 'fly'] as const),
    stepBlocks: numParam(params, 'stepBlocks', defaults.stepBlocks, { min: 1, max: 10_000 }),
    intervalSec: numParam(params, 'intervalSec', defaults.intervalSec, { min: 0.05, max: 3600 }),
    maxDistance: numParam(params, 'maxDistance', defaults.maxDistance, { min: 1, max: 29_000_000 }),
    gamemode: enumParam(params, 'gamemode', defaults.gamemode, ['creative', 'survival', 'spectator', 'keep'] as const)
  }
  if (p.mode === 'fly' && p.gamemode !== 'creative') throw new ScenarioParamError('param gamemode: mode "fly" needs gamemode "creative"')
  return p
}

/** Max legs per bot before headings could repeat another bot's (bot i, leg L uses the heading of i + L·LEG_STRIDE). */
const LEG_STRIDE = 7919

/**
 * Target (absolute x, z) of step `step` (1-based) on leg `leg` of bot `index`, starting from (x0, z0). Each leg runs
 * outward from the start until `maxDistance`; then the next leg starts over on a fresh golden-angle heading.
 */
export function exploreTarget (index: number, step: number, p: Pick<ExploreParams, 'stepBlocks' | 'maxDistance'>, x0: number, z0: number): { x: number, z: number, leg: number } {
  const perLeg = Math.max(1, Math.floor(p.maxDistance / p.stepBlocks))
  const leg = Math.floor((step - 1) / perLeg)
  const k = ((step - 1) % perLeg) + 1
  const a = directionAngle(index + leg * LEG_STRIDE)
  const d = k * p.stepBlocks
  return { x: Math.floor(x0 + Math.cos(a) * d) + 0.5, z: Math.floor(z0 + Math.sin(a) * d) + 0.5, leg }
}

const scenario: Scenario = {
  name: 'explore',
  description: 'Bots move outward on distinct headings (teleport steps by default) to force chunk generation.',
  serverSetup: params => commonSetupCommands(parseCommonSetup(params)),
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    const x0 = bot.entity.position.x
    const z0 = bot.entity.position.z
    if (p.gamemode !== 'keep') await tryCommand(bot, ctx, `gamemode ${p.gamemode} @s`, signal)
    // spread the fleet's steps over the interval instead of stepping in lockstep
    await sleep(ctx.random() * p.intervalSec * 1000, signal)
    let step = 0
    let failures = 0
    while (!signal.aborted) {
      step++
      const t = exploreTarget(ctx.index, step, p, x0, z0)
      const began = Date.now()
      try {
        if (p.mode === 'teleport') {
          const r = await tryCommand(bot, ctx, `tp @s ${coord(t.x)} ~ ${coord(t.z)}`, signal)
          if (!signal.aborted && !r?.ok) failures++
        } else {
          bot.creative.startFlying()
          const pos = bot.entity.position
          const r = await raceAbort(bot.creative.flyTo(vec(bot, t.x, pos.y, t.z)), signal)
          if (r === ABORTED) bot.creative.stopFlying()
        }
      } catch (err) {
        failures++
        if (!signal.aborted) ctx.log(`explore step ${step}: ${errMsg(err)}`)
      }
      await sleep(Math.max(0, p.intervalSec * 1000 - (Date.now() - began)), signal)
    }
    ctx.log(`explore: ${step} steps, ${failures} failed`)
  }
}

export default scenario
