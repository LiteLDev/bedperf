// Builtin `idle` scenario: bots spawn and stand still until the fleet ends them.
import type { Scenario } from '@bedperf/core'

const idle: Scenario = {
  name: 'idle',
  description: 'Bots stand still at spawn; the per-connection baseline.',
  run: (_bot, _ctx, signal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

export default idle
