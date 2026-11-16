// chat: every bot sends a chat message of `payloadBytes` bytes every `intervalSec` seconds. The server fans each
// message out to every player, so the cost grows with players² — a network/broadcast stress. Needs no permission.
import type { Scenario } from '@bedperf/core'
import { commonBotOptions, commonSetupCommands, errorLogger, numParam, parseCommonSetup, sleep } from '../common.ts'

/** bedboo splits longer messages into several chat packets (its chatLengthLimit default on Bedrock). */
export const MAX_PAYLOAD_BYTES = 256

export const defaults = {
  /** Seconds between messages of one bot. */
  intervalSec: 5,
  /** Message size, bytes (ASCII). 1 … 256. */
  payloadBytes: 32
}

export interface ChatParams {
  intervalSec: number
  payloadBytes: number
}

export function parseParams (params: Record<string, unknown>): ChatParams {
  parseCommonSetup(params)
  commonBotOptions(params)
  return {
    intervalSec: numParam(params, 'intervalSec', defaults.intervalSec, { min: 0.05, max: 3600 }),
    payloadBytes: numParam(params, 'payloadBytes', defaults.payloadBytes, { min: 1, max: MAX_PAYLOAD_BYTES, int: true })
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Message `seq` of bot `index`: `<index>:<seq> ` followed by deterministic filler, exactly `bytes` ASCII bytes
 * (truncated when the prefix alone is longer). Never starts with '/', so it is never sent as a command.
 */
export function chatPayload (index: number, seq: number, bytes: number, random: () => number): string {
  let s = `${index}:${seq} `
  while (s.length < bytes) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return s.slice(0, bytes)
}

const scenario: Scenario = {
  name: 'chat',
  description: 'Each bot sends a chat message of K bytes every N seconds (broadcast fan-out).',
  serverSetup: params => commonSetupCommands(parseCommonSetup(params)),
  botOptions: params => commonBotOptions(params),
  async run (bot, ctx, signal) {
    const p = parseParams(ctx.params)
    const onError = errorLogger(ctx, 'chat')
    let seq = 0
    // spread the fleet over the interval instead of sending in bursts
    await sleep(ctx.random() * p.intervalSec * 1000, signal)
    while (!signal.aborted) {
      try {
        bot.chat(chatPayload(ctx.index, seq, p.payloadBytes, ctx.random))
        seq++
      } catch (err) {
        onError(err)
      }
      await sleep(p.intervalSec * 1000, signal)
    }
    ctx.log(`chat: ${seq} messages sent`)
  }
}

export default scenario
