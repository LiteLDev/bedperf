# @bedperf/loadgen

Multi-process [bedboo](../../vendor/bedboo) bot fleet that implements the core `LoadGenerator` contract.
A controller assigns bot indices to forked worker processes, staggers joins and aggregates per-bot metrics
into `BotFleetStats`.

## API

```ts
import { BotFleet, IDLE_SCENARIO } from '@bedperf/loadgen'

const fleet = new BotFleet()
fleet.onStats(s => console.log(s.spawned, s.rttMs?.p50, s.loadgen.saturated))
await fleet.start({
  host: '127.0.0.1', port: 19132, version: '1.26.60',
  scenarioModule: IDLE_SCENARIO,          // or any module URL / package name with a default Scenario
  botsPerWorker: 10, joinIntervalMs: 100,
  usernamePrefix: 'bot', seed: 1, statsIntervalMs: 1000
})
await fleet.scaleTo(30)   // bots bot0..bot29
await fleet.scaleTo(10)   // ends bot29..bot10 (highest first)
await fleet.stop()
```

- `start(opts)` forks worker 0 and waits until it has loaded bedboo and the scenario module (rejects if that
  fails or takes longer than `readyTimeoutMs`). More workers are forked on demand as
  `ceil(n / botsPerWorker)` grows. Bot `i` always lives in worker `floor(i / botsPerWorker)`.
- `scaleTo(n, timeoutMs?)` ends bots `>= n` (highest index first, gracefully) and queues missing indices
  `< n` (lowest first). Joins go out one at a time every `joinIntervalMs` across the whole fleet. It
  resolves when no bot is queued, joining or leaving, or when the timeout elapses (default
  `60 s + queued × joinIntervalMs`). A join failure does not hold it up, so after it resolves check `spawned`
  and `joinFailures`. Failed or disconnected indices are retried only by the next `scaleTo` call. Workers
  that scale-down leaves without bots are stopped.
- `onStats(listener)` gets a `FleetStats` (a `BotFleetStats` superset) every `statsIntervalMs`.
- `stop()` ends every bot. Each worker gets `stopGraceMs` (default 10 s) and is killed if it is still alive
  after that. Workers also exit by themselves when their IPC channel to the controller closes, so a
  controller crash does not leave orphans behind.

Extra options (`BotFleetOptions extends LoadGenOptions`): `joinTimeoutMs` (60 s), `leaveTimeoutMs` (5 s),
`readyTimeoutMs` (60 s), `stopGraceMs`, `rtt: { sampleRatio, intervalMs, timeoutMs }`,
`saturation: { eventLoopP99Ms, cpuPct }`, `workerExecArgv`, `onLog`.
Tests can inject fake workers with `new BotFleet({ spawnWorker })` (see `src/fleet.test.ts`).

Builtin scenario: `IDLE_SCENARIO`. Bots spawn with bedboo's defaults (all plugins, physics on) and stand
still. Every bot is created with `auth: 'offline'`, `viewDistance: 'tiny'` and `logErrors: false`, plus the
scenario's `botOptions(params)`. `ctx.random` is mulberry32 seeded by a hash of `(seed, index)`.

## Metrics

| field | how |
|---|---|
| `connected` / `spawned` | per-bot state from worker events (bedboo `connect` / `spawn`) |
| `joinFailures` | error, kick, `end` or `joinTimeoutMs` before spawn; a worker crash counts its joining bots |
| `unexpectedDisconnects` | `end` after spawn that the fleet did not ask for, a scenario that throws, or a worker crash (counts its spawned bots) |
| `joinLatencyMs` | `createBot()` to `spawn`, for joins completed in the interval. Unlike the core doc ("connect to spawn"), this includes the RakNet handshake. |
| `rttMs` | round trip of `bot._bedrock.commands.request('scriptevent bedperf:ping <id>')`, falling back to `testfor @s` if the server reports it unsuccessful. Probes run on an evenly spread `rtt.sampleRatio` of bots (default 10 %, always bot 0), each every `rtt.intervalMs` (default 5 s). Override per run with scenarioParams `rttSampleRatio` / `rttIntervalMs` / `rttTimeoutMs`. **Needs operator permission: set `default-player-permission-level=operator` (and `allow-cheats=true`).** |
| `correctionsPerSec` | deltas of `bot._bedrock.physics.stats().corrections` (0 if the physics plugin is off) |
| `rxBytesPerSec` | game-layer batches received (`client.handle` wrapped). This is after RakNet, still compressed, and excludes RakNet framing and ACKs. |
| `loadgen.eventLoopLagP99Ms` | max over workers of `monitorEventLoopDelay` p99 minus its 10 ms resolution. On Windows the floor is about 5-10 ms of timer jitter. |
| `loadgen.maxWorkerCpuPct` | max over workers of the **event-loop thread's** CPU (`process.threadCpuUsage()`), % of one core |
| `loadgen.saturated` | lag p99 > 50 ms, **or** JS-thread CPU > 85 %, **or** a worker that has not reported for 3 intervals plus 2 s |
| extras | `loadgen.bots`, `maxWorkerProcessCpuPct` and `totalCpuPct` (whole-process CPU including GC threads), `rssBytes`, `staleWorkers` |

## Sizing (measured)

Host: Core Ultra 7 265K (20 threads), Windows 11, Node 24.20. BDS 1.26.63.1 runs on the same host with a
default generated world, `idle` scenario with bedboo defaults (43 plugins, physics, `viewDistance: 'tiny'`).
Steady state starts about 20 s after the last spawn.

| bots/worker | JS-thread CPU / worker | process CPU / worker | RSS / worker | lag p99 | saturated |
|---|---|---|---|---|---|
| 10 (×3 workers) | ~45 % | ~200 % | ~840 MB | 10-15 ms | no |
| 20 | ~60 % | ~300 % | ~1.33 GB | ~15 ms | no |
| 50 | ~95 % | ~460 % | ~3.1 GB | 250-350 ms (RTT p50 rose from ~65 ms to ~200 ms) | yes |

- **Per idle bot:** about 15-20 % of a core of host CPU and about 65-85 MB RSS.
- **Bot RTT:** about 40-90 ms for `scriptevent` at low load on an idle server.
- **Join latency:** p50 is about 6.5 s for 10 bots and about 11 s for 30 bots joining 100 ms apart. Most of it is bedboo waiting for chunks and spawn while the worker decodes the first chunks.
- **Where the CPU goes:** most of the process CPU is V8's parallel GC helper threads, not the event loop. `--single-threaded-gc` cuts total CPU by roughly half but pushes event-loop lag to about 100 ms.
- **Saturation:** the flag watches the event-loop thread. Process and host CPU are reported separately, as `totalCpuPct`.
- **Recommendation:** use `botsPerWorker` of 10-20. Budget about 0.2 cores and 80 MB per bot on the load-generator host. A colocated fleet of 100 idle bots therefore needs about 20 cores, so for headline numbers run the fleet on a separate host. Lighter scenarios (fewer plugins or no physics through `botOptions`) should cost much less.

## Caveats

- Workers are forked from `src/worker.ts`. Node 24 runs it directly through type stripping, Windows included. Workers start with `execArgv: []` (no `--test` flags inherited).
- Scenario modules are imported inside workers. A bare package name resolves relative to this package, so pass file URLs for anything that is not a dependency of `@bedperf/loadgen`.
- An exception thrown by one bot (a plugin listener or a rejected promise) is logged and does not stop the worker. A worker crash is counted as bot failures, and the worker is re-forked for later joins. If it dies before it becomes ready, joins in its group fail fast for 10 s.
- The e2e test (`BEDPERF_E2E=1 node --test src/e2e.test.ts`) imports `@bedperf/testkit` by relative path, because testkit is not a dependency of this package.
