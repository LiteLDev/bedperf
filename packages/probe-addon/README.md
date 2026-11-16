# @bedperf/probe-addon

L1 probe: a Script API behavior pack (`pack/`) that measures the server tick from inside BDS and
logs `BEDPERF|{json}` records to stdout, plus a small host-side helper (`src/index.ts`).

Uses only stable `@minecraft/server` 2.11.0. No beta modules, experiments or `server-net`/`server-admin`.
BDS needs `content-log-console-output-enabled=true` (in core's `REQUIRED_BOT_PROPERTIES`), or
`console.log` never reaches stdout.

## Host API

```ts
import { packDir, installProbe, summarizeProbe, PROBE_PACK_UUID } from '@bedperf/probe-addon'

packDir()                                 // absolute path of pack/
installProbe(instanceDir, 'bedperf')      // copy into behavior_packs/ + enable in worlds/<level>/world_behavior_packs.json
summarizeProbe(records, { fromT, toT })   // aggregate ProbeSample windows (other records ignored)
```

- `installProbe` is idempotent. It replaces files rather than writing into them, so hard links into
  the BDS cache are never written through, and it works before the world exists. The pack goes in
  `behavior_packs/bedperf_bf8271af`, the same folder name testkit's `installBehaviorPack` uses.
- `summarizeProbe` returns `ProbeSummary`:
  - totals: `windows`, `durationMs`, `ticks`
  - `tps`: time-weighted, total ticks / total time
  - `windowTps` (a core `Summary`) and `windowTpsP1` (the "worst 1 % of windows" criterion)
  - tick intervals: tick-weighted `intervalMean`, `intervalMax`, and `Summary`s of the per-window
    `p95`/`p99`. Exact global percentiles cannot be recovered from window summaries.
  - lag counts: `over50`, `over100`, `over50Rate`
  - `players` and `entities` (entity totals) as `Summary`s

## Records (see `packages/core/src/probe.ts`)

| trigger | record |
|---|---|
| every `windowMs` (default 1000) of wall time | `sample`: tick, t, windowMs, ticks, tps, interval {mean,max,p50,p95,p99}, over50, over100, players; plus `entities` {total, byDimension, topTypes (top 10)} every `entityEvery` windows (default 5) |
| `/scriptevent bedperf:mark <label>` | `mark` |
| `/scriptevent bedperf:ping <id>` | `pong`. If a player sent it, that player also gets the chat message `BEDPERF\|pong <id>` |
| `/scriptevent bedperf:config {"windowMs":1000,"entityEvery":5,"entityBudgetMs":10}` | changes the config at runtime (any subset of the keys; `entityEvery: 0` turns entity sampling off) |
| `/scriptevent bedperf:info` | diagnostic line (below) |

The probe also logs plain diagnostic lines, `bedperf-probe {json}`, with the config, entity scan
cost (`lastEntityScanMs`, `maxEntityScanMs`) and `lastFlushMs`. It logs one at start, one on every
config change and one on every backoff. `parseProbeLine` ignores these lines.

Samples begin at `world.afterEvents.worldLoad`. Each window opens and closes on a tick timestamp,
so `ticks / windowMs` is exact for that span.

## Overhead

- Per tick: one `runInterval` callback that calls `Date.now()` and writes into a preallocated
  `Float64Array` (4096 slots), plus a few counter updates. It allocates nothing. Expected cost is
  well under 0.05 ms per tick.
- Per window: one in-place sort of ~20 numbers, `world.getAllPlayers()` and one `console.log`.
  `lastFlushMs` read 0 on the 1 ms clock.
- Entity sampling, every 5 windows by default: `getEntities()` on 3 dimensions, then a count by
  type. Its cost lands in the tick that closes the window. If a scan takes longer than
  `entityBudgetMs`, the sampling period doubles, up to 64x, and a diagnostic line reports it. It halves again after each scan that takes less than half the budget.
- Observed on an idle BDS 1.26.63.1 (Windows) in e2e: entity scan ≤ 1 ms, flush 0 ms, mean TPS 20.01.

## Caveats

- Script callbacks run inside the server tick, so the probe sees tick *start* jitter, not MSPT.
  True per-tick cost needs L2 (a LeviLamina mod).
- `Date.now()` has 1 ms resolution. On Windows, idle BDS paces ticks with the OS timer (~15.6 ms
  granularity), so idle intervals alternate between about 37 and 63 ms. That makes `over50` noisy
  on an idle server (about 20 % of ticks). Use `over100` and the TPS figures as lag signals.
- Entity counts cover loaded chunks only.
- The pack cannot import `@bedperf/core` at runtime. `pack/scripts/probe-core.js` duplicates the
  record encoding, and `src/probe-core.test.ts` checks it against core's `parseProbeLine` and types.

## Tests

- `corepack pnpm test`: unit tests for the pack logic (with a fake clock) and the host helper.
- `BEDPERF_E2E=1 node --test src/probe.e2e.test.ts`: real BDS on port 19230. It waits for 10+
  samples (asserts mean TPS 19–21 and an `entities` sample), sends a mark from the console, then has
  a bot send a ping. It checks the pong on stdout and the message to the bot, and prints the RTT
  and the probe's self-reported overhead.
