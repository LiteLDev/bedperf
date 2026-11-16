// idle: bots stand still. The per-connection baseline: login, chunk sending, player_auth_input every tick.
import type { Scenario } from '@bedperf/core'
import { commonBotOptions, commonSetupCommands, parseCommonSetup, sleep } from '../common.ts'

export const defaults = {} satisfies Record<string, unknown>

export function parseParams (params: Record<string, unknown>): Record<string, never> {
  parseCommonSetup(params)
  commonBotOptions(params)
  return {}
}

const scenario: Scenario = {
  name: 'idle',
  description: 'Bots stand still after spawning; the per-connection baseline.',
  serverSetup: params => commonSetupCommands(parseCommonSetup(params)),
  botOptions: params => commonBotOptions(params),
  async run (_bot, _ctx, signal) {
    while (!signal.aborted) await sleep(60_000, signal)
  }
}

export default scenario
