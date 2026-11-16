# @bedperf/scenarios

Bot workloads for bedperf. Each scenario is a module in `src/scenarios/<name>.ts` whose `default` export implements
the core `Scenario` contract (`packages/core/src/scenario.ts`). The load generator imports it by file URL in each
worker, calls `botOptions(params)`, creates the bot, waits for spawn, then calls `run(bot, ctx, signal)`. The
orchestrator sends `serverSetup(params)` to the BDS console once before load.

## API

```ts
import { SCENARIOS, SCENARIO_NAMES, COMMON_PARAMS, scenarioModule, loadScenario } from '@bedperf/scenarios'

SCENARIOS.walk // { module: 'file:///…/src/scenarios/walk.ts', description, defaults: { radius: 32, … }, needsOperator: false }
scenarioModule('walk') // file URL → LoadGenOptions.scenarioModule
await loadScenario('walk') // the Scenario (also accepts any module specifier)
```

Each scenario module also exports `defaults` and `parseParams(params)`. `parseParams` fills in defaults and throws
`ScenarioParamError` for a bad value. `run` validates `ctx.params` the same way, so a bad config fails the first bot
instead of running a different workload.

## Common behaviour

- **Server setup.** Every scenario's `serverSetup` starts with
  `gamerule doDaylightCycle false`, `doWeatherCycle false` (plus `weather clear`), `doMobSpawning false`,
  `randomTickSpeed 1` and `time set noon`. Params `daylightCycle`, `weatherCycle`, `mobSpawning`, `randomTickSpeed`,
  `time` (`noon|midnight|day|night|sunrise|sunset`), `difficulty` and `extraSetup` (extra console commands) override
  them.
- **Bot options.** `viewDistance` (`far|normal|short|tiny` or chunks) is passed to bedboo when set. Otherwise the
  scenario returns `{}` and the load generator's defaults apply.
- **Abort.** `run` returns within milliseconds of `signal` aborting, even while a command, dig or placement is in
  flight. In-flight requests are dropped and never become unhandled rejections.
- **Robustness.** Per-action errors are caught and logged through `ctx.log`, rate-limited to the first 5 and then
  every 100th, and the loop keeps going. `run` throws only for invalid params.
- **Determinism.** All random choices use `ctx.random`. Plot positions and headings depend only on `ctx.index`.
  Bots start at a random phase within their interval so the fleet does not act in lockstep.
- **Permissions.** Scenarios with `needsOperator: true` send commands as the bot (`bot._bedrock.commands.request`).
  The orchestrator should set `default-player-permission-level=operator` in `server.properties` for them, or op the
  bots. `allow-cheats=true` is already in `REQUIRED_BOT_PROPERTIES`.

## Scenarios

| name | op | what the bots do | params (defaults) |
|---|---|---|---|
| `idle` | | Stand still. This is the per-connection baseline. | none |
| `walk` | | Random walk to targets uniform in the disc of radius `radius` around the spawn position. Uses `look` plus forward/sprint, jumps when progress stalls and re-targets when stuck. No pathfinder. | `radius` 32, `sprint` true, `jump` `stuck\|always\|never`, `checkIntervalMs` 500, `stuckMs` 2000, `maxLegSec` 30 |
| `explore` | yes | Each bot moves outward along heading `index × golden angle`, one step every `intervalSec`, with `/tp @s X ~ Z` at absolute X/Z so it does not drift. At `maxDistance` it starts a new leg from its start position on a new heading. `mode: 'fly'` uses `bot.creative.flyTo` instead (experimental). | `mode` `teleport`, `stepBlocks` 32, `intervalSec` 2, `maxDistance` 4096, `gamemode` `creative` |
| `build` | yes | Each bot gets a private plot. Plots are laid out on a square spiral around `originX/originZ`, `plotSpacing` apart, on a platform at `platformY`. The bot switches to creative, teleports to its plot, builds the platform and toggles random cells between `block` and air. `mode: 'client'` uses real `bot.placeBlock`/`bot.dig` packets. `'command'` uses `/setblock`. | `mode` `client`, `block` stone, `plotRadius` 3, `plotSpacing` 16, `originX/Z` 0, `platformY` 200, `intervalMs` 500, `actionTimeoutMs` 5000 |
| `chat` | | Each bot sends one chat message of exactly `payloadBytes` ASCII bytes every `intervalSec`. | `intervalSec` 5, `payloadBytes` 32 (1–256) |
| `mobs` | yes | Each bot keeps `count` mobs named `bpm<index>` around itself and attacks the nearest one within `attackRange` every `attackIntervalMs`. Every `maintainSec` it teleports strays back, counts its mobs with `/testfor` and summons any that are missing. Bots stay in survival so mobs target them. Resistance 255 and Saturation keep them alive. | `mobType` zombie, `count` 5, `attackIntervalMs` 500, `attackRange` 3.5, `maintainSec` 10, `radius` 24, `spawnRadius` 4, `gamemode` survival, `invulnerable` true; setup: `time` midnight, `difficulty` normal, `doMobLoot false` |
| `entity-stress` | yes (keeper) | Bots idle. The load is `count` mobs named `bpstress` in a walled pen on a sky platform inside a ticking area. Run it with a **fixed player count and a sweep over `count`**. | `entityType` zombie, `count` 100, `x/z` 0, `y` 200, `size` 32 (≤ 90), `maintainSec` 15, `keeperIndex` 0, `summonBatch` 32; setup: `time` midnight, `doMobLoot false` |

## Caveats

- **entity-stress setup.** `serverSetup` only adds the ticking area. BDS refuses `fill` and `summon` from the console
  right after `tickingarea add` (`Cannot place blocks outside of the world`) because the chunks load a few ticks
  later. So the keeper bot (`keeperIndex`) builds the pen and keeps the population at `count`. It summons missing
  mobs and kills the excess every `maintainSec`. At least that bot must be online. If `keeperIndex` is not below
  the fleet size, nothing is summoned (bot 0 logs this).
- **Zombies burn in daylight.** `mobs` and `entity-stress` therefore default to `time: 'midnight'`. Use a
  non-burning type (`husk`, `cow`, …) to run them at noon.
- **build platform.** `build` uses a platform at y 200 so it does not depend on terrain. A plot that already exists
  from an earlier session is reused, because a `fill` that changes nothing is not treated as a failure.
- **explore teleports.** They keep the bot's current Y. The bot is in creative, so landing inside terrain or above a
  drop does no damage. On a rejoin, the start position is wherever the bot spawns, usually its last position.
- **Chat length.** Messages longer than bedboo's `chatLengthLimit` (256) would be split into several packets, so
  `payloadBytes` is capped at 256.
