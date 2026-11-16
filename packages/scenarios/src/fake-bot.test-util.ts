// Test helpers: a stub bedboo Bot good enough to drive every scenario's run loop offline.
import type { Bot } from 'bedboo'
import type { ScenarioContext } from '@bedperf/core'

export class V3 {
  x: number
  y: number
  z: number
  constructor (x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z }
  distanceTo (o: V3): number { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
  offset (dx: number, dy: number, dz: number): V3 { return new V3(this.x + dx, this.y + dy, this.z + dz) }
}

export interface FakeBotOptions {
  /** 'ok': commands resolve after `commandDelayMs`; 'hang': they never resolve; 'reject': they reject. */
  commands?: 'ok' | 'hang' | 'reject'
  commandDelayMs?: number
  /** Delay of placeBlock / dig / flyTo, ms. */
  actionDelayMs?: number
}

export interface FakeBot {
  bot: Bot
  calls: { commands: string[], controls: Array<[string, boolean]>, looks: number, chats: string[], attacks: number, places: number, digs: number }
}

export function fakeBot (opts: FakeBotOptions = {}): FakeBot {
  const { commands = 'ok', commandDelayMs = 5, actionDelayMs = 20 } = opts
  const calls: FakeBot['calls'] = { commands: [], controls: [], looks: 0, chats: [], attacks: 0, places: 0, digs: 0 }
  const blocks = new Map<string, string>()
  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const mob = { name: 'zombie', height: 1.95, position: new V3(1, 64, 1) }
  const bot = {
    username: 'fake',
    entity: { position: new V3(0.5, 64, 0.5), height: 1.8 },
    entities: { 1: mob },
    setControlState: (c: string, s: boolean) => { calls.controls.push([c, s]) },
    clearControlStates: () => {},
    look: async () => { calls.looks++ },
    lookAt: async () => { calls.looks++ },
    chat: (m: string) => { calls.chats.push(m) },
    attack: () => { calls.attacks++ },
    nearestEntity: (f: (e: unknown) => boolean) => f(mob) ? mob : null,
    setQuickBarSlot: () => {},
    stopDigging: () => {},
    blockAt: (p: V3) => ({ name: p.y < 200 ? 'stone' : blocks.get(`${p.x},${p.y},${p.z}`) ?? 'air', position: p }),
    placeBlock: async (ref: { position: V3 }) => {
      await delay(actionDelayMs)
      const p = ref.position
      blocks.set(`${p.x},${p.y + 1},${p.z}`, 'stone')
      calls.places++
    },
    dig: async (b: { position: V3 }) => {
      await delay(actionDelayMs)
      blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`)
      calls.digs++
    },
    creative: {
      startFlying: () => {},
      stopFlying: () => {},
      flyTo: async () => { await delay(actionDelayMs) }
    },
    _bedrock: {
      commands: {
        request: (cmd: string) => {
          calls.commands.push(cmd)
          if (commands === 'hang') return new Promise(() => {})
          if (commands === 'reject') return delay(commandDelayMs).then(() => { throw new Error('boom') })
          return delay(commandDelayMs).then(() => ({ success_count: 1, output: [{ message_id: 'ok', success: true }] }))
        }
      }
    }
  }
  return { bot: bot as unknown as Bot, calls }
}

/** mulberry32: small deterministic PRNG returning [0, 1). */
export function seeded (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function fakeCtx (index: number, params: Record<string, unknown> = {}, logs: string[] = []): ScenarioContext {
  return { index, params, random: seeded(1234 + index), log: m => { logs.push(m) } }
}
