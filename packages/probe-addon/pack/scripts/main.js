// @ts-check
// bedperf L1 probe entry point: wires probe-core.js to the stable @minecraft/server API.
import { Player, system, world } from '@minecraft/server'
import { DIMENSION_IDS, Probe } from './probe-core.js'

/** @type {Array<{ id: string, dimension: import('@minecraft/server').Dimension }> | undefined} */
let dims

const probe = new Probe({
  now: Date.now,
  currentTick: () => system.currentTick,
  playerCount: () => world.getAllPlayers().length,
  dimensions: () => {
    dims ??= DIMENSION_IDS.map(id => ({ id, dimension: world.getDimension(id) }))
    return dims
  },
  log: line => { console.log(line) }
})

system.afterEvents.scriptEventReceive.subscribe(ev => {
  const pongId = probe.onScriptEvent(ev.id, ev.message)
  if (pongId !== undefined && ev.sourceEntity instanceof Player) {
    try { ev.sourceEntity.sendMessage('BEDPERF|pong ' + pongId) } catch {}
  }
}, { namespaces: ['bedperf'] })

let started = false
function start () {
  if (started) return
  started = true
  system.runInterval(() => { probe.onTick() }, 1)
  probe.info('start')
}

// World APIs are unavailable during early execution; start sampling once the world is loaded.
world.afterEvents.worldLoad.subscribe(start)
// Fallback for a script (re)load into an already-loaded world (e.g. /reload), where worldLoad may not fire.
system.run(() => {
  try { world.getAllPlayers() } catch { return }
  start()
})
