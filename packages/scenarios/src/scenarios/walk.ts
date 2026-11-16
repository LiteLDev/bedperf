// walk: random walk within `radius` blocks of where the bot spawned. Stresses movement validation and entity
// tracking (every bot's movement is broadcast to the bots that see it). No pathfinder: the bot looks at a random
// target, holds forward (and sprint), jumps when it stops making progress and re-targets when stuck.
import type { Scenario } from '@bedperf/core'
import {
  boolParam, commonBotOptions, commonSetupCommands, enumParam, errMsg, numParam, parseCommonSetup, sleep, yawTowards
} from '../common.ts'

export const defaults = {
  /** Max horizontal distance of targets from the spawn position, blocks. */
  radius: 32,
  /** Hold sprint while walking. */
  sprint: true,
  /** 'stuck': jump only when progress stalls; 'always': hold jump (bunny hop); 'never'. */
  jump: 'stuck' as WalkParams['jump'],
  /** How often the bot re-aims and checks progress, ms. Larger = less load-generator CPU. */
  checkIntervalMs: 500,
  /** A check window (this long) with less than 0.5 blocks of progress counts as stuck, ms. */
  stuckMs: 2000,
  /** Re-target after this many seconds on one leg even if not stuck. */
  maxLegSec: 30
}

export interface WalkParams {
  radius: number
  sprint: boolean
  jump: 'stuck' | 'always' | 'never'
  checkIntervalMs: number
  stuckMs: number
  maxLegSec: number
}

export function parseParams (params: Record<string, unknown>): WalkParams {
  parseCommonSetup(params)
  commonBotOptions(params)
  return {
    radius: numParam(params, 'radius', defaults.radius, { min: 1, max: 100_000 }),
    sprint: boolParam(params, 'sprint', defaults.sprint),
    jump: enumParam(params, 'jump', defaults.jump, ['stuck', 'always', 'never'] as const),
    checkIntervalMs: numParam(params, 'checkIntervalMs', defaults.checkIntervalMs, { min: 50, max: 60_000 }),
    stuckMs: numParam(params, 'stuckMs', defaults.stuckMs, { min: 100, max: 600_000 }),
    maxLegSec: numParam(params, 'maxLegSec', defaults.maxLegSec, { min: 1, max: 86_400 })
  }
}

/** Uniform random point in the disc of `radius` around (cx, cz). */
export function randomTarget (random: () => number, cx: number, cz: number, radius: number): { x: number, z: number } {
  const a = random() * 2 * Math.PI
  const d = radius * Math.sqrt(random())
  return { x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d }
}

const scenario: Scenario = {
  name: 'walk',
  description: 'Random walk within a radius of the spawn position (forward/sprint/jump, no pathfinder).',
  serverSetup: params => commonSetupCommands(parseCommonSetup(params)),
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    const start = bot.entity.position
    const cx = start.x
    const cz = start.z
    let target = randomTarget(ctx.random, cx, cz, p.radius)
    let legStart = Date.now()
    let windowStart = Date.now()
    let windowPos = { x: start.x, z: start.z }
    let stuckStrikes = 0
    let legs = 0

    const steer = (): void => {
      const pos = bot.entity.position
      bot.look(yawTowards(pos.x, pos.z, target.x, target.z), 0, true).catch(() => {})
    }
    const retarget = (): void => {
      target = randomTarget(ctx.random, cx, cz, p.radius)
      legStart = Date.now()
      stuckStrikes = 0
      legs++
    }

    try {
      bot.setControlState('forward', true)
      bot.setControlState('sprint', p.sprint)
      bot.setControlState('jump', p.jump === 'always')
      steer()
      while (!signal.aborted) {
        await sleep(p.checkIntervalMs, signal)
        if (signal.aborted) break
        try {
          const pos = bot.entity.position
          const now = Date.now()
          if (p.jump === 'stuck') bot.setControlState('jump', false)
          if (Math.hypot(target.x - pos.x, target.z - pos.z) < 1.5 || now - legStart > p.maxLegSec * 1000) {
            retarget()
          } else if (now - windowStart >= p.stuckMs) {
            const moved = Math.hypot(pos.x - windowPos.x, pos.z - windowPos.z)
            windowStart = now
            windowPos = { x: pos.x, z: pos.z }
            if (moved < 0.5) {
              stuckStrikes++
              if (stuckStrikes >= 2) retarget()
              else if (p.jump === 'stuck') bot.setControlState('jump', true)
            } else {
              stuckStrikes = 0
            }
          }
          // keep the movement controls held (a server correction or death may have reset them)
          bot.setControlState('forward', true)
          steer()
        } catch (err) {
          ctx.log(`walk: ${errMsg(err)}`)
        }
      }
    } finally {
      try { bot.clearControlStates() } catch {}
      ctx.log(`walk: ${legs} re-targets`)
    }
  }
}

export default scenario
